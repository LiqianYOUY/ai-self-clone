/** Real local-model HTTP smoke: two five-turn games in a disposable DB schema. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import type { PlayIdentity, PlayRoomDto } from "../src/domain/play";

type Data = Record<string, any>;
type Cookie = { value: string; path: string; expiresAt: number | null };
type Jar = Map<string, Cookie>;
const port = 3305;
const origin = `http://127.0.0.1:${port}`;
const buildDirectory = ".next-build";
const schema = `play_http_${process.pid}_${randomBytes(5).toString("hex")}`;
const username = `play_smoke_${randomBytes(6).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const localModel = process.env.PLAY_SMOKE_MODEL ?? "qwen3.5:4b";
const localBase = process.env.PLAY_SMOKE_OLLAMA_URL ?? "http://127.0.0.1:11434";
const hostCookies: Jar = new Map();
const checks: string[] = [];
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
let stage = "configuration";
let admin: PrismaClient | undefined;
let db: PrismaClient | undefined;
let server: ChildProcess | undefined;
let schemaCreated = false;
let serverError = false;
let serverReadyMessage = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let heartbeatWork: Promise<void> | undefined;
let heartbeatError = false;
const abort = new AbortController();

function checked(name: string) {
  checks.push(name);
  console.log(`PASS ${name}`);
}

function cookieHeader(cookies: Jar, path = "/api/play") {
  return [...cookies.entries()]
    .filter(
      ([, c]) =>
        (c.expiresAt === null || c.expiresAt > Date.now()) &&
        (path === c.path ||
          path.startsWith(c.path.endsWith("/") ? c.path : c.path + "/")),
    )
    .map(([name, c]) => `${name}=${c.value}`)
    .join("; ");
}

function storeCookies(response: Response, cookies: Jar) {
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(";").map((part) => part.trim());
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator),
      value = pair.slice(separator + 1);
    assert.match(name, /^(clone_target_session|play_guest_[A-Za-z0-9_-]+)$/);
    assert(attributes.includes("HttpOnly"));
    assert(attributes.includes("SameSite=Strict"));
    const path = attributes.find((part) => part.startsWith("Path="))?.slice(5);
    assert.equal(path, name.startsWith("play_guest_") ? "/api/play" : "/");
    const maxAge = attributes
      .find((part) => part.startsWith("Max-Age="))
      ?.slice(8);
    if (!value || Number(maxAge) <= 0) {
      cookies.delete(name);
      continue;
    }
    assert.match(value, /^[a-f0-9]{64}$/);
    cookies.set(name, {
      value,
      path,
      expiresAt:
        maxAge === undefined ? null : Date.now() + Number(maxAge) * 1000,
    });
  }
}

async function responseData(
  response: Response,
  cookies: Jar,
  expected = 200,
): Promise<Data> {
  assert.equal(response.status, expected, "HTTP status");
  assert.equal(response.headers.get("cache-control"), "no-store");
  storeCookies(response, cookies);
  const data: Data = await response.json();
  const serialized = JSON.stringify(data);
  for (const forbidden of [
    "passwordHash",
    "tokenHash",
    "guestToken",
    "guestHash",
    "inviteHash",
  ])
    assert(!serialized.includes(`\"${forbidden}\"`));
  return data;
}

async function command(
  action: string,
  payload: Data = {},
  cookies = hostCookies,
  expected = 200,
) {
  const response = await fetch(origin + "/api/play", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: cookieHeader(cookies),
    },
    body: JSON.stringify({ action, payload }),
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
  });
  return responseData(response, cookies, expected);
}

async function get(
  view: "home" | "room",
  cookies = hostCookies,
  roomId?: string,
  expected = 200,
) {
  const params = new URLSearchParams({ view, ...(roomId ? { roomId } : {}) });
  const response = await fetch(origin + "/api/play?" + params, {
    headers: { cookie: cookieHeader(cookies) },
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
  });
  return responseData(response, cookies, expected);
}

function assertBlind(room: PlayRoomDto) {
  assert.deepEqual(
    Object.keys(room).sort(),
    [
      "id",
      "hostName",
      "friendName",
      "status",
      "turnsCompleted",
      "maxTurns",
      "waitingFor",
      "messages",
      "result",
    ].sort(),
  );
  assert.equal(room.result, null);
  for (const message of room.messages) {
    assert.deepEqual(
      Object.keys(message).sort(),
      ["id", "speaker", "text", "sequence"].sort(),
    );
    assert.equal(typeof message.text, "string");
    assert(message.text.trim().length > 0);
  }
}

async function availablePort() {
  await new Promise<void>((done, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(new Error("Isolated smoke port unavailable")),
    );
    probe.listen(port, "127.0.0.1", () =>
      probe.close((error) => (error ? reject(error) : done())),
    );
  });
}

async function migrate(env: NodeJS.ProcessEnv) {
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
      { env, stdio: "ignore" },
    );
    child.once("error", () => reject(new Error("Migration process failed")));
    child.once("exit", (code) =>
      code === 0 ? done() : reject(new Error("Migration failed")),
    );
  });
}

async function waitForTurn(
  roomId: string,
  turn: number,
  cookies: Jar,
): Promise<PlayRoomDto> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    assert(!heartbeatError, "Host heartbeat failed");
    assert(!abort.signal.aborted, "Smoke interrupted");
    const room = (await get("room", cookies, roomId)).room as PlayRoomDto;
    assertBlind(room);
    assert.notEqual(
      room.status,
      "CANCELLED",
      "Game cancelled before the model replied",
    );
    if (room.turnsCompleted === turn) return room;
    assert.equal(room.turnsCompleted, turn - 1);
    await delay(1000);
  }
  throw new Error("Reply not delivered within 90 seconds");
}

async function playGame(mode: PlayIdentity, ownerId: string) {
  stage = `${mode} invite and guest cookie`;
  await command("heartbeat", { online: true });
  const invitation = await command("create_room");
  const url = new URL(invitation.url);
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, "/play/join");
  assert.equal(url.search, "");
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  assert.match(token ?? "", /^[a-f0-9]{64}$/);
  const roomId: string = invitation.room.id;
  const stored = await db!.playRoom.findUniqueOrThrow({
    where: { id: roomId },
  });
  assert.equal(
    stored.ownerId,
    ownerId,
    "HTTP server must use our isolated schema",
  );
  // This fixture-only DB write chooses a branch; the production API accepts no mode.
  await db!.playRoom.update({ where: { id: roomId }, data: { mode } });
  const guestCookies: Jar = new Map();
  const preview = await command("inspect_invite", { token }, guestCookies);
  assert.deepEqual(
    Object.keys(preview).sort(),
    ["hostName", "expiresAt"].sort(),
  );
  const joined = await command(
    "join_room",
    { token, nickname: "合成朋友", consent: true },
    guestCookies,
  );
  assert.deepEqual(Object.keys(joined), ["room"]);
  assertBlind(joined.room);
  assert.equal(guestCookies.size, 1);
  assert(guestCookies.has(`play_guest_${roomId}`));
  assert.equal(
    cookieHeader(guestCookies, "/play"),
    "",
    "Guest capability is only sent to the game API",
  );
  await command("inspect_invite", { token }, guestCookies, 404);
  await get("room", new Map(), roomId, 401);
  assert.equal((await get("home")).activeRoom.mode, mode);
  checked(`${mode}: single-use invitation and cookie-bound blind room`);

  const questions = [
    "周末想去哪？",
    "吃饭想吃什么？",
    "还记得我们上次去海边吗？",
    "你平时怎么和朋友约时间？",
    "那我们下次怎么安排？",
  ];
  const humanReplies = [
    "去海边走走呗",
    "整碗面吧",
    "记得啊，上回风还挺大",
    "一般就问你啥时候有空",
    "周六下午见呗",
  ];
  for (let index = 0; index < 5; index++) {
    const turn = index + 1;
    stage = `${mode} turn ${turn}: send and background reply`;
    const input = {
      roomId,
      text: questions[index],
      idempotencyKey: randomUUID(),
    };
    const first = await command("send_message", input, guestCookies);
    assertBlind(first.room);
    const friendMessage = first.room.messages.find(
      (message: Data) =>
        message.speaker === "FRIEND" && message.sequence === index * 2 + 1,
    );
    assert(friendMessage);
    const repeated = await command("send_message", input, guestCookies);
    assertBlind(repeated.room);
    assert.equal(
      repeated.room.messages.find(
        (message: Data) => message.sequence === index * 2 + 1,
      )?.id,
      friendMessage.id,
    );
    if (mode === "HUMAN") {
      await command("reply", {
        roomId,
        text: humanReplies[index],
        idempotencyKey: randomUUID(),
      });
    }
    const started = Date.now();
    const room = await waitForTurn(roomId, turn, guestCookies);
    assert.equal(room.messages.length, turn * 2);
    assert.equal(room.messages.at(-1)?.speaker, "SOURCE");
    assert.equal(room.status, turn === 5 ? "GUESSING" : "ACTIVE");
    assert.deepEqual(
      room.messages.map((message) => message.sequence),
      Array.from({ length: turn * 2 }, (_, i) => i + 1),
    );
    assert.deepEqual(
      room.messages.map((message) => message.speaker),
      Array.from({ length: turn * 2 }, (_, i) => (i % 2 ? "SOURCE" : "FRIEND")),
    );
    assert(
      !/<\/?(?:think|analysis|reasoning)>/i.test(room.messages.at(-1)!.text),
    );
    const persisted = await db!.playRoom.findUniqueOrThrow({
      where: { id: roomId },
    });
    assert.equal(persisted.mode, mode);
    assert.equal(persisted.pendingTurn, null);
    if (mode === "HUMAN")
      assert.equal(room.messages.at(-1)?.text, humanReplies[index]);
    console.log(
      `PASS ${mode}: turn ${turn}/5 delivered (${((Date.now() - started) / 1000).toFixed(1)}s polling)`,
    );
  }
  checked(`${mode}: five ordered turns and duplicate messages persist once`);

  stage = `${mode} guess and immutable reveal`;
  await command(
    "send_message",
    { roomId, text: "第六轮不能再问", idempotencyKey: randomUUID() },
    guestCookies,
    409,
  );
  // Choose HUMAN in both branches to exercise both statistics numerators.
  const result = await command(
    "guess",
    { roomId, guess: "HUMAN", reason: "合成测试：像熟悉的语气" },
    guestCookies,
  );
  assert.equal(result.room.status, "REVEALED");
  assert.deepEqual(result.room.result, {
    answer: mode,
    guess: "HUMAN",
    correct: mode === "HUMAN",
    reason: "合成测试：像熟悉的语气",
  });
  await command(
    "guess",
    { roomId, guess: "AI", reason: "不能修改答案" },
    guestCookies,
    409,
  );
  assert.equal(await db!.playMessage.count({ where: { roomId } }), 10);
  checked(`${mode}: sixth turn blocked and identity revealed only after guess`);
}

async function main() {
  stage = "production build (.next-build/BUILD_ID)";
  assert(
    existsSync(resolve(buildDirectory, "BUILD_ID")),
    "Build the production app first",
  );
  stage = "unused isolated loopback port 3305";
  await availablePort();
  stage = "local Ollama readiness: requested model must already be installed";
  const ollama = new URL(localBase);
  assert(["127.0.0.1", "localhost", "[::1]"].includes(ollama.hostname));
  assert.equal(ollama.protocol, "http:");
  assert(
    !ollama.username && !ollama.password && !ollama.search && !ollama.hash,
  );
  assert(!/(?:^|[:/-])cloud(?:$|[:/-])/i.test(localModel));
  const response = await fetch(ollama.origin + "/api/tags", {
    signal: AbortSignal.timeout(3000),
    redirect: "error",
  });
  assert.equal(response.status, 200);
  const tags = await response.json();
  const wanted = localModel.includes(":") ? localModel : `${localModel}:latest`;
  assert(
    Array.isArray(tags.models) &&
      tags.models.some(
        (item: Data) =>
          (item.name === wanted || item.model === wanted) &&
          !item.remote_host &&
          !item.remote_model,
      ),
    "Requested local model is not installed; smoke must not skip AI",
  );
  checked(
    "real Ollama model is installed locally; no cloud provider or API key",
  );

  const localPassword = process.env.DATABASE_URL
    ? ""
    : (await readFile(".local/database-password", "utf8")).trim();
  const base = new URL(
    process.env.DATABASE_URL ??
      `postgresql://study_local:${encodeURIComponent(localPassword)}@127.0.0.1:55432/clone_study?schema=public`,
  );
  assert(
    ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname),
    "Only a local database is allowed",
  );
  admin = new PrismaClient({ datasourceUrl: base.toString() });
  stage = "create disposable schema";
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  base.searchParams.set("schema", schema);
  db = new PrismaClient({ datasourceUrl: base.toString() });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: base.toString(),
    NODE_ENV: "production",
    NEXT_DIST_DIR: buildDirectory,
    APP_HOST: "127.0.0.1",
    APP_ORIGIN: origin,
    PORT: String(port),
    STUDY_MODE: "synthetic",
    NEXT_TELEMETRY_DISABLED: "1",
    PORTAL_BOOTSTRAP_ENABLED: "false",
    PLAY_MODEL_PROVIDER: "ollama",
    PLAY_MODEL_BASE_URL: ollama.origin,
    PLAY_MODEL_NAME: localModel,
    PLAY_MODEL_API_KEY: "",
  };
  const suffix = process.arch === "arm64" ? "darwin-arm64" : "darwin";
  const schemaEngine = resolve(
    `node_modules/@prisma/engines/schema-engine-${suffix}`,
  );
  const queryEngine = resolve(
    `node_modules/@prisma/engines/libquery_engine-${suffix}.dylib.node`,
  );
  if (process.platform === "darwin" && existsSync(schemaEngine))
    env.PRISMA_SCHEMA_ENGINE_BINARY = schemaEngine;
  if (process.platform === "darwin" && existsSync(queryEngine))
    env.PRISMA_QUERY_ENGINE_LIBRARY = queryEngine;
  stage = "migrate disposable schema";
  await migrate(env);
  stage = "start isolated production HTTP server";
  server = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => {
    if (chunk.toString().includes(`ready at ${origin}`))
      serverReadyMessage = true;
  });
  server.stderr?.on("data", () => undefined);
  server.once("error", () => {
    serverError = true;
  });
  const deadline = Date.now() + 45_000;
  let ready = false;
  while (
    Date.now() < deadline &&
    !serverError &&
    server.exitCode === null &&
    !abort.signal.aborted
  ) {
    if (serverReadyMessage) {
      try {
        ready =
          (
            await fetch(origin + "/api/health", {
              signal: AbortSignal.timeout(1500),
            })
          ).status === 200;
      } catch {
        /* Child server startup is asynchronous. */
      }
    }
    if (ready) break;
    await delay(250);
  }
  assert(ready, "Our isolated child server must become ready");
  checked(
    "production build and custom HTTP server use a disposable migrated schema",
  );

  stage = "self-registration and persona setup";
  const registration = await command("register", {
    username,
    password,
    pseudonym: "合成游戏主人",
  });
  const ownerId: string = registration.actor.id;
  assert(ownerId.startsWith("play-target-"));
  assert.equal(registration.actor.role, "TARGET");
  assert.equal(
    (await db.account.findUniqueOrThrow({ where: { participantId: ownerId } }))
      .username,
    username,
  );
  await command("save_persona", {
    displayName: "小林（合成角色）",
    bio: "这是测试生成的虚构人物，喜欢吃面和周末散步。",
    style: "使用中文短句，像熟人聊天，常说‘呗’‘行啊’，不使用条目和客服腔。",
    memories: "虚构共同经历：和朋友去过海边，那天风很大，后来吃了面。",
    examplesText:
      "朋友：今天吃啥？\n我：整碗面吧\n朋友：周末出去吗？\n我：行啊，海边走走呗\n朋友：几点见？\n我：三点吧，不急",
  });
  await command("heartbeat", { online: true });
  const home = await get("home");
  assert.equal(home.providerReady, true);
  assert.equal(home.providerStatus.kind, "ollama");
  assert.equal(home.providerStatus.model, localModel);
  heartbeat = setInterval(() => {
    if (heartbeatWork || abort.signal.aborted) return;
    heartbeatWork = command("heartbeat", { online: true })
      .then(() => undefined)
      .catch(() => {
        heartbeatError = true;
      })
      .finally(() => {
        heartbeatWork = undefined;
      });
  }, 10_000);
  checked("host cookie, synthetic persona and real local provider readiness");
  await playGame("HUMAN", ownerId);
  await playGame("AI", ownerId);

  stage = "separate statistics denominators and database isolation";
  assert(!heartbeatError);
  const final = await get("home");
  assert.equal(final.activeRoom, null);
  assert.deepEqual(final.stats, {
    completed: 2,
    cancelled: 0,
    aiRounds: 1,
    humanRounds: 1,
    aiFooledRate: 1,
    humanRecognizedRate: 1,
  });
  assert.equal(await db.playRoom.count({ where: { status: "REVEALED" } }), 2);
  assert.equal(await db.playMessage.count(), 20);
  assert.equal(await db.session.count(), 0);
  assert.equal(await db.preparationRoom.count(), 0);
  const publicRows = await admin.$queryRawUnsafe<Array<{ count: bigint }>>(
    'SELECT count(*) AS count FROM public."Participant" WHERE "id" = $1',
    ownerId,
  );
  assert.equal(Number(publicRows[0].count), 0);
  checked(
    "two completed games, separate rates and no public or research records",
  );
  console.log(
    `Play HTTP smoke: ${checks.length}/${checks.length} checks passed; 10/10 turns delivered, including 5 real local AI replies.`,
  );
  if (process.env.PLAY_SMOKE_HOLD === "true") {
    stage = "holding successful isolated smoke for visual inspection";
    console.log(`Temporary visual QA server: ${origin}/play`);
    // Explicit opt-in: these credentials were generated for this disposable schema only.
    console.log(`Temporary synthetic login: ${username}`);
    console.log(`Temporary synthetic password: ${password}`);
    console.log(
      "Press Ctrl+C to stop this server and remove its disposable schema.",
    );
    if (!abort.signal.aborted)
      await new Promise<void>((done) =>
        abort.signal.addEventListener("abort", () => done(), { once: true }),
      );
  }
}

async function cleanup() {
  if (heartbeat) clearInterval(heartbeat);
  abort.abort();
  await heartbeatWork;
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
  await db?.$disconnect();
  if (admin && schemaCreated)
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin?.$disconnect();
}

process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
main()
  .catch(() => {
    // Never print DB credentials, cookies, invitation tokens, request bodies or model text.
    console.error(
      `Play HTTP smoke failed during: ${stage}. AI is never skipped when unavailable.`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch {
      console.error(
        `Play smoke cleanup failed; inspect only disposable schema ${schema}.`,
      );
      process.exitCode = 1;
    }
  });
