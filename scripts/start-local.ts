import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import {
  ensureLocalModelService,
  localModelConfiguration,
  type LocalModelService,
} from "./local-model-runtime";

// This supervisor owns shutdown. The library's concurrent signal hook stops
// PostgreSQL before the app and can overwrite the supervisor's failure status.
const requireFromPostgres = createRequire(
  createRequire(import.meta.url).resolve("embedded-postgres"),
);
const postgresExitHook = requireFromPostgres("async-exit-hook") as {
  unhookEvent: (event: string) => void;
};
for (const event of [
  "exit",
  "beforeExit",
  "message",
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGBREAK",
])
  postgresExitHook.unhookEvent(event);

const root = resolve(process.cwd());
let database: EmbeddedPostgres | undefined;
let application: ChildProcess | undefined;
const ownedChildren = new Set<ChildProcess>();
let localModel: LocalModelService | null = null;
let localModelStarting: Promise<LocalModelService | null> | null = null;
const localModelAbort = new AbortController();
let stopping = false;
let shutdown: Promise<void> | undefined;
let failureExitCode = 0;
let stage = "configuration";

export function applicationExitStatus(code: number | null): number {
  // Node reports null when a child is killed by a signal, including the OOM
  // killer. This must trigger systemd's Restart=on-failure.
  return code ?? 1;
}

/** A required owned database exiting after readiness must fail the service. */
export function watchOwnedDatabaseExit(
  child: ChildProcess,
  isStopping: () => boolean,
  onFailure: () => void,
): void {
  const exited = () => {
    if (!isStopping()) onFailure();
  };
  if (child.exitCode !== null || child.signalCode !== null) exited();
  else child.once("exit", exited);
}

/** Only call with a child spawned by this supervisor, never a discovered PID. */
export async function stopOwnedChild(
  child: ChildProcess,
  graceMs = 5000,
  processGroup = true,
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const send = (signal: NodeJS.Signals) => {
    try {
      if (processGroup && process.platform !== "win32")
        process.kill(-child.pid!, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const stopped = new Promise<void>((done) => child.once("exit", () => done()));
  send("SIGTERM");
  const timer = setTimeout(() => send("SIGKILL"), graceMs);
  try {
    await stopped;
  } finally {
    clearTimeout(timer);
    // The group can outlive its leader if a descendant ignores SIGTERM.
    if (processGroup && process.platform !== "win32") send("SIGKILL");
  }
}

function ensureRunning() {
  if (stopping) throw new Error("Startup interrupted");
}

function trackChild(child: ChildProcess): ChildProcess {
  ownedChildren.add(child);
  child.once("exit", () => ownedChildren.delete(child));
  child.once("error", () => ownedChildren.delete(child));
  return child;
}

function run(script: string, args: string[] = []): Promise<void> {
  ensureRunning();
  return new Promise((resolveRun, reject) => {
    const child = trackChild(
      spawn(process.execPath, [script, ...args], {
        cwd: root,
        env: process.env,
        stdio: "inherit",
        detached: process.platform !== "win32",
      }),
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolveRun() : reject(new Error("Setup command failed")),
    );
  });
}

function stop(): Promise<void> {
  if (shutdown) return shutdown;
  stopping = true;
  localModelAbort.abort();
  shutdown = (async () => {
    await Promise.all([...ownedChildren].map((child) => stopOwnedChild(child)));
    const pendingModel = await localModelStarting?.catch(() => null);
    // A reused Ollama service has a no-op stop; only our own group is stopped.
    await (localModel ?? pendingModel)?.stop();
    if (database) {
      // The pinned library waits forever if its child already exited and has
      // no shutdown timeout. Keep the exact owned ChildProcess, never look up
      // a PID from disk or signal a potentially unrelated PostgreSQL service.
      const postgres = (database as unknown as { process?: ChildProcess })
        .process;
      if (
        postgres?.pid &&
        postgres.exitCode === null &&
        postgres.signalCode === null
      ) {
        const force = setTimeout(() => {
          if (postgres.exitCode === null && postgres.signalCode === null)
            postgres.kill("SIGKILL");
        }, 5000);
        try {
          await database.stop();
        } finally {
          clearTimeout(force);
        }
      }
    }
  })();
  return shutdown;
}

async function main() {
  process.env.NEXT_TELEMETRY_DISABLED = "1";
  // Use the already installed Prisma engines on macOS; this also avoids a
  // global engine cache write in restricted local development environments.
  if (process.platform === "darwin") {
    const suffix = process.arch === "arm64" ? "darwin-arm64" : "darwin";
    const schemaEngine = join(
      root,
      "node_modules/@prisma/engines",
      `schema-engine-${suffix}`,
    );
    const queryEngine = join(
      root,
      "node_modules/@prisma/engines",
      `libquery_engine-${suffix}.dylib.node`,
    );
    if (existsSync(schemaEngine))
      process.env.PRISMA_SCHEMA_ENGINE_BINARY ??= schemaEngine;
    if (existsSync(queryEngine))
      process.env.PRISMA_QUERY_ENGINE_LIBRARY ??= queryEngine;
  }
  if (process.env.STUDY_MODE && process.env.STUDY_MODE !== "synthetic")
    throw new Error("Only synthetic local development is supported");
  process.env.STUDY_MODE = "synthetic";
  process.env.APP_HOST ??= "127.0.0.1";
  process.env.PORT ??= "3000";
  process.env.APP_ORIGIN ??= `http://127.0.0.1:${process.env.PORT}`;
  // First researcher setup is available only on a local loopback installation.
  // The portal service also verifies the origin and an empty account table.
  process.env.PORTAL_BOOTSTRAP_ENABLED ??= [
    "127.0.0.1",
    "localhost",
    "::1",
  ].includes(process.env.APP_HOST)
    ? "true"
    : "false";
  if (!process.env.DATABASE_URL) {
    stage = "local database";
    const local = join(root, ".local");
    const databaseDir = join(local, "postgres");
    await mkdir(local, { recursive: true, mode: 0o700 });
    const credentialFile = join(local, "database-password");
    const password = existsSync(credentialFile)
      ? (await readFile(credentialFile, "utf8")).trim()
      : randomBytes(32).toString("hex");
    if (!existsSync(credentialFile))
      await writeFile(credentialFile, password, { mode: 0o600, flag: "wx" });
    database = new EmbeddedPostgres({
      databaseDir,
      user: "study_local",
      password,
      port: 55432,
      persistent: true,
      authMethod: "scram-sha-256",
      postgresFlags: [
        "-h",
        "127.0.0.1",
        "-c",
        "log_statement=none",
        "-c",
        "log_min_error_statement=panic",
      ],
      onLog: () => undefined,
      onError: () => undefined,
      createPostgresUser: false,
    });
    if (!existsSync(join(databaseDir, "PG_VERSION")))
      await database.initialise();
    ensureRunning();
    await database.start();
    const postgres = (database as unknown as { process?: ChildProcess })
      .process;
    if (!postgres) throw new Error("Local database process is unavailable");
    watchOwnedDatabaseExit(
      postgres,
      () => stopping,
      () => {
        failureExitCode = 1;
        console.error(
          "[study] Local database stopped unexpectedly; restarting the service.",
        );
        void stop()
          .catch(() => undefined)
          .finally(() => process.exit(1));
      },
    );
    ensureRunning();
    const client = database.getPgClient("postgres", "127.0.0.1");
    await client.connect();
    try {
      const present = await client.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        ["clone_study"],
      );
      if (!present.rowCount)
        await client.query('CREATE DATABASE "clone_study"');
    } finally {
      await client.end();
    }
    process.env.DATABASE_URL = `postgresql://study_local:${password}@127.0.0.1:55432/clone_study?schema=public`;
  }
  ensureRunning();
  stage = "Prisma generation";
  await run(join(root, "node_modules/prisma/build/index.js"), ["generate"]);
  stage = "database migration";
  await run(join(root, "node_modules/prisma/build/index.js"), [
    "migrate",
    "deploy",
  ]);
  stage = "synthetic seed";
  await run("--import", ["tsx", "scripts/seed.ts"]);
  stage = "local model";
  ensureRunning();
  const modelConfig = localModelConfiguration(root);
  if (modelConfig) {
    try {
      localModelStarting = ensureLocalModelService(
        modelConfig,
        undefined,
        localModelAbort.signal,
      );
      localModel = await localModelStarting;
      console.log(
        localModel
          ? `[model] ${localModel.owned ? "Started" : "Reusing"} local Ollama; model availability is shown in /play.`
          : "[model] No local Ollama runtime found. Run npm run model:setup to prepare it.",
      );
    } catch (error) {
      console.warn(
        `[model] ${error instanceof Error ? error.message : "Local model startup failed."} The app will show model setup status.`,
      );
    }
  }
  ensureRunning();
  stage = "application";
  application = trackChild(
    spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    }),
  );
  application.once("error", async () => {
    await stop();
    process.exit(1);
  });
  application.once("exit", async (code) => {
    if (stopping) return;
    await stop();
    process.exit(applicationExitStatus(code));
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, async () => {
      await stop();
      process.exit(failureExitCode);
    });
  main().catch(async () => {
    const interrupted = stopping;
    if (!interrupted)
      console.error(
        `[study] Local startup failed during ${stage}. Check the configured application/database ports and supported PostgreSQL binaries, or set an external DATABASE_URL.`,
      );
    await stop();
    process.exit(failureExitCode || (interrupted ? 0 : 1));
  });
}
