/** Run tests or named npm scripts with an owned, disposable PostgreSQL cluster. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

// The bundled package's exit hook forces beforeExit to status 0 and races our
// cleanup on signals. This entry point owns shutdown so failures stay failures.
const requireFromPostgres = createRequire(
  createRequire(import.meta.url).resolve("embedded-postgres"),
);
const postgresExitHook = requireFromPostgres("async-exit-hook") as {
  unhookEvent: (event: string) => void;
};
for (const event of ["beforeExit", "SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"])
  postgresExitHook.unhookEvent(event);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scripts = process.argv.slice(2).filter((argument) => argument !== "--");
let database: EmbeddedPostgres | undefined;
let databaseStarted = false;
let temporaryDirectory: string | undefined;
let child: ChildProcess | undefined;
let stoppingChild: Promise<void> | undefined;
let interrupted = 0;
let stage = "configuration";

function ensureRunning() {
  if (interrupted) throw new Error("Interrupted");
}

function signalChild(signal: NodeJS.Signals) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    // npm scripts may launch a shell and a server; stop the owned process group.
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function stopChild(): Promise<void> {
  if (stoppingChild) return stoppingChild;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  stoppingChild = (async () => {
    const stopped = new Promise<void>((done) =>
      child!.once("exit", () => done()),
    );
    signalChild("SIGTERM");
    const timer = setTimeout(() => signalChild("SIGKILL"), 5000);
    try {
      await stopped;
    } finally {
      clearTimeout(timer);
    }
  })();
  return stoppingChild;
}

async function run(
  command: string,
  arguments_: string[],
  env: NodeJS.ProcessEnv,
) {
  ensureRunning();
  child = spawn(command, arguments_, {
    cwd: root,
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  await new Promise<void>((done, reject) => {
    child!.once("error", reject);
    child!.once("exit", (code, signal) => {
      if (code === 0) done();
      else reject(new Error(`Command exited ${code ?? signal}`));
    });
  });
  child = undefined;
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  return new Promise((done, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve a temporary database port"));
        return;
      }
      probe.close((error) => (error ? reject(error) : done(address.port)));
    });
  });
}

async function main() {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  for (const script of scripts) {
    if (!/^[a-zA-Z0-9:_-]+$/.test(script) || !manifest.scripts?.[script])
      throw new Error(`Unknown npm script: ${script}`);
    if (manifest.scripts[script].includes("run-isolated"))
      throw new Error("The isolated runner cannot recursively invoke itself");
    if (manifest.scripts[script].includes("clean.mjs"))
      throw new Error(
        "Run cache cleanup after the isolated runner has stopped",
      );
  }
  ensureRunning();
  stage = "temporary directory creation";
  const cache = join(root, ".cache", "testing");
  await mkdir(cache, { recursive: true });
  temporaryDirectory = await mkdtemp(join(cache, "postgres-"));
  stage = "temporary port selection";
  const port = await availablePort();
  const password = randomBytes(32).toString("hex");
  const databaseDirectory = join(temporaryDirectory, "data");
  database = new EmbeddedPostgres({
    databaseDir: databaseDirectory,
    user: "study_test",
    password,
    port,
    persistent: true,
    authMethod: "scram-sha-256",
    postgresFlags: [
      "-h",
      "127.0.0.1",
      "-k",
      temporaryDirectory,
      "-c",
      "log_statement=none",
      "-c",
      "log_min_error_statement=panic",
    ],
    onLog: () => undefined,
    onError: () => undefined,
    createPostgresUser: false,
  });
  stage = "temporary PostgreSQL initialization";
  await database.initialise();
  ensureRunning();
  stage = "temporary PostgreSQL startup";
  await database.start();
  databaseStarted = true;
  ensureRunning();
  const client = database.getPgClient("postgres", "127.0.0.1");
  await client.connect();
  try {
    await client.query('CREATE DATABASE "clone_study_test"');
  } finally {
    await client.end();
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: `postgresql://study_test:${password}@127.0.0.1:${port}/clone_study_test?schema=public`,
    STUDY_MODE: "synthetic",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  if (process.platform === "darwin") {
    const suffix = process.arch === "arm64" ? "darwin-arm64" : "darwin";
    const schemaEngine = join(
      root,
      `node_modules/@prisma/engines/schema-engine-${suffix}`,
    );
    const queryEngine = join(
      root,
      `node_modules/@prisma/engines/libquery_engine-${suffix}.dylib.node`,
    );
    if (existsSync(schemaEngine))
      env.PRISMA_SCHEMA_ENGINE_BINARY = schemaEngine;
    if (existsSync(queryEngine)) env.PRISMA_QUERY_ENGINE_LIBRARY = queryEngine;
  }
  console.log("[test] Started a disposable PostgreSQL database on loopback.");
  stage = "temporary database migration";
  await run(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",
      "migrate",
      "deploy",
      "--schema",
      "prisma/schema.prisma",
    ],
    env,
  );
  if (scripts.length) {
    for (const script of scripts) {
      stage = `npm run ${script}`;
      const npmCli = process.env.npm_execpath;
      if (npmCli) await run(process.execPath, [npmCli, "run", script], env);
      else
        await run(
          process.platform === "win32" ? "npm.cmd" : "npm",
          ["run", script],
          env,
        );
    }
  } else {
    const tests = (await readdir(join(root, "tests")))
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .map((name) => join("tests", name));
    if (!tests.length) throw new Error("No test files found");
    stage = "all test suites";
    await run(process.execPath, ["--import", "tsx", "--test", ...tests], env);
  }
}

process.on("SIGINT", () => {
  interrupted = 130;
  void stopChild();
});
process.on("SIGTERM", () => {
  interrupted = 143;
  void stopChild();
});
process.on("SIGHUP", () => {
  interrupted = 129;
  void stopChild();
});

main()
  .catch((error) => {
    const detail =
      stage === "configuration" && error instanceof Error
        ? ` ${error.message}`
        : (error as NodeJS.ErrnoException | undefined)?.code
          ? ` (${(error as NodeJS.ErrnoException).code})`
          : "";
    console.error(`[test] Failed during ${stage}.${detail}`);
    process.exitCode = interrupted || 1;
  })
  .finally(async () => {
    try {
      await stopChild();
      if (databaseStarted) await database!.stop();
      if (temporaryDirectory)
        await rm(temporaryDirectory, { recursive: true, force: true });
      if (database)
        console.log(
          "[test] Stopped PostgreSQL and removed the temporary database.",
        );
    } catch {
      console.error(
        "[test] Cleanup failed; inspect .cache/testing before cleaning it.",
      );
      process.exitCode = 1;
    }
    process.exit(Number(process.exitCode ?? interrupted));
  });
