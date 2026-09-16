/** Disposable browser QA fixture. Never provisions accounts in public. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const port = Number(process.env.PORTAL_UI_PREVIEW_PORT ?? 3302);
const origin = `http://127.0.0.1:${port}`;
const schema = `portal_ui_${process.pid}_${randomBytes(5).toString("hex")}`;
const fixturePassword = "disposable-ui-fixture-2026";
const users = {
  researcher: "preview_researcher",
  target: "preview_target",
  friend: "preview_friend",
  analyst: "preview_analyst",
};
let admin: PrismaClient | undefined;
let database: PrismaClient | undefined;
let server: ChildProcess | undefined;
let schemaCreated = false;
let cleaning: Promise<void> | undefined;
let stopping = false;
let stage = "configuration";
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function cleanup(): Promise<void> {
  if (cleaning) return cleaning;
  stopping = true;
  cleaning = (async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((done) =>
        server!.once("exit", () => done()),
      );
      server.kill("SIGTERM");
      await Promise.race([exited, delay(5000)]);
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
        await Promise.race([exited, delay(1000)]);
      }
    }
    await database?.$disconnect();
    if (admin && schemaCreated)
      await admin.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      );
    await admin?.$disconnect();
  })();
  return cleaning;
}

async function migrate() {
  await new Promise<void>((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        "node_modules/prisma/build/index.js",
        "migrate",
        "deploy",
        "--schema",
        "prisma/schema.prisma",
      ],
      { env: process.env, stdio: "ignore" },
    );
    child.once("error", () => reject(new Error("Migration process failed")));
    child.once("exit", (code) =>
      code === 0 ? done() : reject(new Error("Migration failed")),
    );
  });
}

async function main() {
  if (process.env.PORTAL_UI_PREVIEW !== "true")
    throw new Error("Opt-in required");
  if (!Number.isInteger(port) || port <= 1024 || port > 65535 || port === 3000)
    throw new Error("Separate port required");
  const localPassword = process.env.DATABASE_URL
    ? ""
    : (await readFile(".local/database-password", "utf8")).trim();
  const url = new URL(
    process.env.DATABASE_URL ??
      `postgresql://study_local:${encodeURIComponent(localPassword)}@127.0.0.1:55432/clone_study?schema=public`,
  );
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("Local database required");
  admin = new PrismaClient({ datasourceUrl: url.toString() });
  stage = "create isolated schema";
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString();
  process.env.APP_HOST = "127.0.0.1";
  process.env.APP_ORIGIN = origin;
  process.env.PORT = String(port);
  process.env.PORTAL_BOOTSTRAP_ENABLED = "true";
  process.env.STUDY_MODE = "synthetic";
  process.env.NEXT_TELEMETRY_DISABLED = "1";
  Object.assign(process.env, {
    NODE_ENV: process.env.PORTAL_UI_PREVIEW_BUILD_DIR
      ? "production"
      : "development",
  });
  process.env.NEXT_DIST_DIR =
    process.env.PORTAL_UI_PREVIEW_BUILD_DIR ?? ".next-portals-preview";
  if (process.platform === "darwin") {
    const suffix = process.arch === "arm64" ? "darwin-arm64" : "darwin";
    const schemaEngine = resolve(
      `node_modules/@prisma/engines/schema-engine-${suffix}`,
    );
    const queryEngine = resolve(
      `node_modules/@prisma/engines/libquery_engine-${suffix}.dylib.node`,
    );
    if (existsSync(schemaEngine))
      process.env.PRISMA_SCHEMA_ENGINE_BINARY = schemaEngine;
    if (existsSync(queryEngine))
      process.env.PRISMA_QUERY_ENGINE_LIBRARY = queryEngine;
  }
  stage = "migrate isolated schema";
  await migrate();
  database = (await import("../src/server/db")).prisma;
  const portals = await import("../src/server/portals");
  stage = "create disposable UI accounts";
  const consent = { participation: true, version: "enrollment-v1" };
  const researcher = await portals.initializeResearchAccount(
    {
      username: users.researcher,
      password: fixturePassword,
      pseudonym: "测试研究员",
    },
    { localBootstrap: true },
  );
  const targetInvitation = await portals.createInvitation(researcher, {
    kind: "TARGET",
  });
  const target = await portals.registerFromInvitation({
    token: targetInvitation.token,
    username: users.target,
    password: fixturePassword,
    pseudonym: "测试本人",
    portal: "target",
    consent,
  });
  const friendInvitation = await portals.createInvitation(target, {
    kind: "FRIEND",
  });
  const friend = await portals.registerFromInvitation({
    token: friendInvitation.token,
    username: users.friend,
    password: fixturePassword,
    pseudonym: "测试好友",
    portal: "friend",
    consent,
  });
  const analystInvitation = await portals.createInvitation(researcher, {
    kind: "ANALYST",
  });
  await portals.registerFromInvitation({
    token: analystInvitation.token,
    username: users.analyst,
    password: fixturePassword,
    pseudonym: "测试分析员",
    portal: "research",
  });
  const roomId = (await portals.listRooms(target)).rooms[0].id;
  await portals.sendRoomMessage(target, {
    roomId,
    text: "你好，这是一条用于界面检查的合成问候。",
    idempotencyKey: randomUUID(),
  });
  await portals.sendRoomMessage(friend, {
    roomId,
    text: "收到！我们可以在这个测试空间聊聊今天的小事。",
    idempotencyKey: randomUUID(),
  });
  await portals.sendRoomMessage(target, {
    roomId,
    text: "我今天整理了书桌，也给窗边的植物浇了水。",
    idempotencyKey: randomUUID(),
  });
  const unusedTarget = await portals.createInvitation(researcher, {
    kind: "TARGET",
  });
  const unusedFriend = await portals.createInvitation(target, {
    kind: "FRIEND",
  });
  stage = "start isolated UI server";
  server = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => undefined);
  server.stderr?.on("data", () => undefined);
  server.once("error", () => {
    void terminate(1);
  });
  server.once("exit", () => {
    if (!stopping) void terminate(1);
  });
  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline && !stopping && server.exitCode === null) {
    try {
      ready =
        (
          await fetch(origin + "/api/health", {
            signal: AbortSignal.timeout(1500),
          })
        ).status === 200;
    } catch {
      /* Waiting for the isolated server. */
    }
    if (ready) break;
    await delay(250);
  }
  if (!ready) throw new Error("Preview readiness failed");
  console.log(
    "Disposable portal UI fixture ready; accounts exist only in a temporary schema.",
  );
  console.log(`Research: ${origin}/research — ${users.researcher}`);
  console.log(`Target: ${origin}/target — ${users.target}`);
  console.log(`Friend: ${origin}/friend — ${users.friend}`);
  console.log(`Analyst: ${origin}/research — ${users.analyst}`);
  console.log(`Disposable fixture password: ${fixturePassword}`);
  console.log(`Unconsumed Target invitation: ${origin}${unusedTarget.path}`);
  console.log(`Unconsumed Friend invitation: ${origin}${unusedFriend.path}`);
  console.log(
    "Press Ctrl+C to stop this server and drop its temporary schema. Port 3000 is unchanged.",
  );
}

async function terminate(code: number) {
  try {
    await cleanup();
    console.log(
      "Disposable portal UI server stopped and temporary schema removed.",
    );
  } catch {
    console.error(
      "Preview cleanup failed; inspect disposable portal_ui_ schema.",
    );
    code = 1;
  }
  process.exit(code);
}
process.once("SIGINT", () => {
  void terminate(0);
});
process.once("SIGTERM", () => {
  void terminate(0);
});
process.once("SIGHUP", () => {
  void terminate(0);
});
main().catch(async () => {
  console.error(
    `Portal UI preview failed during: ${stage}. No credentials were printed.`,
  );
  await terminate(1);
});
