/** Real HTTP portal smoke in a disposable schema and a separate loopback server. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

type Portal = "research" | "target" | "friend";
type Data = Record<string, any>;
const checks: string[] = [];
let stage = "configuration";
const checked = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const port = Number(process.env.PORTALS_SMOKE_PORT ?? 3301);
const origin = `http://127.0.0.1:${port}`;
const schema = `portal_http_${process.pid}_${randomBytes(5).toString("hex")}`;
const prefix = `portal_smoke_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const consent = { participation: true, version: "enrollment-v1" };
const jar = new Map<string, string>();
let admin: PrismaClient | undefined;
let db: PrismaClient | undefined;
let server: ChildProcess | undefined;
let schemaCreated = false;
let serverError = false;

function cookieHeader(cookies = jar) { return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; "); }
function storeCookie(response: Response, cookies: Map<string, string>) {
  const header = response.headers.get("set-cookie");
  if (!header) return;
  const pair = header.split(";")[0];
  const separator = pair.indexOf("=");
  const name = pair.slice(0, separator), value = pair.slice(separator + 1);
  assert.match(name, /^clone_(research|target|friend)_session$/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\//);
  if (value) { assert.match(value, /^[a-f0-9]{64}$/); cookies.set(name, value); }
  else cookies.delete(name);
}
async function command(portal: Portal, action: string, payload: Data = {}, expected = 200, cookies = jar) {
  const response = await fetch(origin + "/api/portal", {
    method: "POST", headers: { origin, "content-type": "application/json", "x-study-portal": portal, cookie: cookieHeader(cookies) },
    body: JSON.stringify({ action, payload }), signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, expected, `${portal} ${action} status`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data: Data = await response.json();
  storeCookie(response, cookies);
  assert.ok(!JSON.stringify(data).includes("passwordHash"));
  assert.ok(!JSON.stringify(data).includes("tokenHash"));
  return data;
}
async function get(portal: Portal, view: string, params: Record<string, string> = {}, expected = 200, cookies = jar) {
  const response = await fetch(origin + "/api/portal?" + new URLSearchParams({ view, ...params }), {
    headers: { "x-study-portal": portal, cookie: cookieHeader(cookies) }, signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, expected, `${portal} ${view} status`);
  return await response.json() as Data;
}
async function migrate(env: NodeJS.ProcessEnv) {
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "prisma/schema.prisma"], { env, stdio: "ignore" });
    child.once("error", () => reject(new Error("Migration process failed")));
    child.once("exit", code => code === 0 ? done() : reject(new Error("Migration failed")));
  });
}
async function main() {
  assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535 && port !== 3000, "Smoke must use a separate unprivileged port");
  const localPassword = process.env.DATABASE_URL ? "" : (await readFile(".local/database-password", "utf8")).trim();
  const base = new URL(process.env.DATABASE_URL ?? `postgresql://study_local:${encodeURIComponent(localPassword)}@127.0.0.1:55432/clone_study?schema=public`);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Smoke is restricted to a local test database");
  admin = new PrismaClient({ datasourceUrl: base.toString() });
  stage = "create disposable schema";
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  base.searchParams.set("schema", schema);
  db = new PrismaClient({ datasourceUrl: base.toString() });
  const buildDirectory = process.env.PORTALS_SMOKE_BUILD_DIR;
  const env: NodeJS.ProcessEnv = {
    ...process.env, DATABASE_URL: base.toString(), NODE_ENV: buildDirectory ? "production" : "development",
    APP_HOST: "127.0.0.1", APP_ORIGIN: origin, PORT: String(port), STUDY_MODE: "synthetic",
    PORTAL_BOOTSTRAP_ENABLED: "true", NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: buildDirectory ?? ".next-portals-test",
  };
  const suffix = process.arch === "arm64" ? "darwin-arm64" : "darwin";
  const schemaEngine = resolve(`node_modules/@prisma/engines/schema-engine-${suffix}`);
  const queryEngine = resolve(`node_modules/@prisma/engines/libquery_engine-${suffix}.dylib.node`);
  if (process.platform === "darwin" && existsSync(schemaEngine)) env.PRISMA_SCHEMA_ENGINE_BINARY = schemaEngine;
  if (process.platform === "darwin" && existsSync(queryEngine)) env.PRISMA_QUERY_ENGINE_LIBRARY = queryEngine;
  stage = "migrate disposable schema";
  await migrate(env);
  stage = "start isolated HTTP server";
  server = spawn(process.execPath, ["--import", "tsx", "server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.on("data", () => undefined);
  server.stderr?.on("data", () => undefined);
  server.once("error", () => { serverError = true; });
  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline && !serverError && server.exitCode === null) {
    try { ready = (await fetch(origin + "/api/health", { signal: AbortSignal.timeout(1500) })).status === 200; } catch { /* Startup is asynchronous. */ }
    if (ready) break;
    await delay(250);
  }
  assert.ok(ready, "Isolated server readiness");
  checked("separate loopback server and migrated disposable schema");

  stage = "bootstrap and researcher cookie";
  assert.equal((await get("research", "me")).bootstrapAvailable, true);
  assert.equal((await get("target", "me")).bootstrapAvailable, false);
  const researcher = (await command("research", "bootstrap", { username: prefix + "_r", password, pseudonym: prefix + "_researcher" })).actor;
  assert.equal(researcher.role, "RESEARCHER");
  assert.equal((await get("research", "me")).bootstrapAvailable, false);
  await command("research", "bootstrap", { username: prefix + "_r2", password, pseudonym: prefix + "_another" }, 409);
  checked("one-time researcher bootstrap and opaque research login");

  stage = "target invitation and registration";
  const targetInvite = await command("research", "invite", { kind: "TARGET" });
  assert.match(targetInvite.path, /^\/target\/join#token=/);
  const preview = await command("target", "inspectInvitation", { token: targetInvite.token });
  assert.equal(preview.kind, "TARGET");
  await command("friend", "inspectInvitation", { token: targetInvite.token }, 403);
  const target = (await command("target", "register", { token: targetInvite.token, username: prefix + "_t", password, pseudonym: prefix + "_target", consent })).actor;
  assert.equal(target.role, "TARGET");
  await command("target", "register", { token: targetInvite.token, username: prefix + "_again", password, pseudonym: prefix + "_again", consent }, 404);
  checked("single-use Target invite with portal checks and explicit consent");

  stage = "friend invitation and all portal sessions";
  const friendInvite = await command("target", "invite", { kind: "FRIEND" });
  assert.match(friendInvite.path, /^\/friend\/join#token=/);
  const friend = (await command("friend", "register", { token: friendInvite.token, username: prefix + "_f", password, pseudonym: prefix + "_friend", consent })).actor;
  assert.equal(friend.role, "FRIEND");
  assert.equal(jar.size, 3);
  assert.equal((await get("research", "me")).actor.id, researcher.id);
  assert.equal((await get("target", "me")).actor.id, target.id);
  assert.equal((await get("friend", "me")).actor.id, friend.id);
  assert.equal(await db.authSession.count(), 3);
  checked("three independent portal cookies coexist in one browser jar");

  stage = "private bidirectional human chat";
  const targetHome = await get("target", "home");
  const roomId = targetHome.rooms[0].id;
  assert.equal((await get("friend", "home")).rooms[0].id, roomId);
  assert.equal(targetHome.modelStatus, "NOT_CONNECTED");
  assert.equal(targetHome.formalStudyStatus, "NOT_ACTIVATED");
  const firstKey = randomUUID();
  const first = await command("target", "send", { roomId, text: "准备聊天：这是本人发送的消息。", idempotencyKey: firstKey });
  const repeated = await command("target", "send", { roomId, text: "准备聊天：这是本人发送的消息。", idempotencyKey: firstKey });
  assert.equal(first.messageId, repeated.messageId);
  assert.equal(repeated.duplicate, true);
  await command("friend", "send", { roomId, text: "已收到，这是朋友本人回复。", idempotencyKey: randomUUID() });
  const targetRoom = await get("target", "room", { id: roomId });
  const friendRoom = await get("friend", "room", { id: roomId });
  assert.equal(targetRoom.messages.length, 2);
  assert.deepEqual(targetRoom.messages.map((m: Data) => m.mine), [true, false]);
  assert.deepEqual(friendRoom.messages.map((m: Data) => m.mine), [false, true]);
  assert.equal(targetRoom.room.kind, "HUMAN_PREPARATION");
  assert.equal(await db.generation.count(), 0);
  assert.equal(await db.session.count(), 0);
  assert.equal(await db.message.count(), 0);
  const audit = JSON.stringify(await db.auditEvent.findMany());
  assert.ok(!audit.includes("这是本人发送的消息"));
  checked("bidirectional ordered human chat, idempotency, no AI or formal study records");

  stage = "cross-room and staff privacy";
  const friend2Jar = new Map<string, string>();
  const friend2Invite = await command("target", "invite", { kind: "FRIEND" });
  await command("friend", "register", { token: friend2Invite.token, username: prefix + "_f2", password, pseudonym: prefix + "_friend2", consent }, 200, friend2Jar);
  await get("friend", "room", { id: roomId }, 404, friend2Jar);
  await command("friend", "send", { roomId, text: "不应进入别人的聊天", idempotencyKey: randomUUID() }, 404, friend2Jar);
  await get("research", "room", { id: roomId }, 403);
  const researchHome = await get("research", "home");
  assert.ok(!JSON.stringify(researchHome).includes("这是本人发送的消息"));
  assert.ok(!("messages" in researchHome.rooms[0]));
  const legacy = await fetch(origin + "/api/study?view=export", { headers: { "x-study-portal": "target", cookie: cookieHeader() } });
  assert.equal(legacy.status, 403);
  checked("another friend and research staff cannot read room text; real participants cannot enter legacy study");

  stage = "pause owner and resume";
  await command("target", "pause", { roomId });
  await command("friend", "send", { roomId, text: "暂停后不应发送", idempotencyKey: randomUUID() }, 409);
  await command("friend", "resume", { roomId }, 403);
  await command("target", "resume", { roomId });
  await command("friend", "send", { roomId, text: "恢复后继续真人聊天。", idempotencyKey: randomUUID() });
  checked("pause stops messages and only the pausing participant can resume");

  stage = "withdraw and durable destruction";
  const withdrawal = await command("friend", "withdraw", { destroyContent: true });
  assert.equal(withdrawal.destroyedMessages, 3);
  assert.equal(jar.has("clone_friend_session"), false);
  assert.equal(jar.size, 2);
  assert.equal((await get("research", "me")).actor.id, researcher.id);
  assert.equal((await get("target", "me")).actor.id, target.id);
  assert.equal((await get("friend", "me")).actor, null);
  const withdrawn = await get("target", "room", { id: roomId });
  assert.equal(withdrawn.room.status, "WITHDRAWN");
  assert.equal(withdrawn.canSend, false);
  assert.equal(withdrawn.messages.length, 0);
  assert.equal(await db.preparationMessage.count({ where: { roomId, text: { not: null } } }), 0);
  await command("friend", "login", { username: prefix + "_f", password });
  await command("friend", "consent", { participation: true });
  await command("friend", "resume", { roomId }, 409);
  await command("friend", "send", { roomId, text: "撤回后不应重开旧房间", idempotencyKey: randomUUID() }, 409);
  checked("withdrawal clears one portal login, destroys text and cannot reopen the old room");

  stage = "public schema isolation";
  const publicRows = await admin.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count(*) AS count FROM public."Participant" WHERE "pseudonym" LIKE $1', prefix + "%");
  assert.equal(Number(publicRows[0].count), 0);
  assert.equal(await db.account.count(), 4);
  assert.equal(await db.generation.count(), 0);
  checked("all four test accounts stayed in the disposable schema; public contains none");
  console.log(`Portal HTTP smoke: ${checks.length}/${checks.length} passed.`);
}

async function cleanup() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise<void>(done => server!.once("exit", () => done()));
    server.kill("SIGTERM");
    await Promise.race([exited, delay(5000)]);
    if (server.exitCode === null && server.signalCode === null) { server.kill("SIGKILL"); await Promise.race([exited, delay(1000)]); }
  }
  await db?.$disconnect();
  if (admin && schemaCreated) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin?.$disconnect();
}
main().catch(() => {
  // Never print connection credentials, cookies, invitation tokens or request bodies.
  console.error(`Portal HTTP smoke failed during: ${stage}.`);
  process.exitCode = 1;
}).finally(async () => {
  try { await cleanup(); } catch { console.error("Portal smoke cleanup failed; inspect disposable portal_http_ schema."); process.exitCode = 1; }
});
