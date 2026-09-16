import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import {
  ensureLocalModelService,
  localModelConfiguration,
  type LocalModelService,
} from "./local-model-runtime";

const root = resolve(process.cwd());
let database: EmbeddedPostgres | undefined;
let application: ChildProcess | undefined;
let localModel: LocalModelService | null = null;
let localModelStarting: Promise<LocalModelService | null> | null = null;
const localModelAbort = new AbortController();
let stopping = false;
let stage = "configuration";

function run(script: string, args: string[] = []): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolveRun() : reject(new Error("Setup command failed")),
    );
  });
}

async function stop() {
  if (stopping) return;
  stopping = true;
  localModelAbort.abort();
  if (application && application.exitCode === null) {
    application.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolveStop) =>
        application!.once("exit", () => resolveStop()),
      ),
      new Promise<void>((resolveStop) => setTimeout(resolveStop, 5000)),
    ]);
  }
  const pendingModel = await localModelStarting?.catch(() => null);
  await (localModel ?? pendingModel)?.stop();
  if (database) await database.stop().catch(() => undefined);
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
    await database.start();
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
  stage = "application";
  application = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  application.once("error", async () => {
    await stop();
    process.exit(1);
  });
  application.once("exit", async (code) => {
    if (stopping) return;
    await stop();
    process.exit(code ?? 0);
  });
}
process.once("SIGINT", async () => {
  await stop();
  process.exit(0);
});
process.once("SIGTERM", async () => {
  await stop();
  process.exit(0);
});
main().catch(async () => {
  console.error(
    `[study] Local startup failed during ${stage}. Check port 55432/3000 and supported PostgreSQL binaries, or set an external DATABASE_URL.`,
  );
  await stop();
  process.exit(1);
});
