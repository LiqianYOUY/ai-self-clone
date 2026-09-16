import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Actor } from "../src/server/auth";
import type { PlayIdentity, PlayRoomDto } from "../src/domain/play";

// Every integration record belongs to this disposable schema, never the app schema.
const password = existsSync(".local/database-password")
  ? readFileSync(".local/database-password", "utf8").trim()
  : "";
const baseUrl =
  process.env.DATABASE_URL ??
  `postgresql://study_local:${encodeURIComponent(password)}@127.0.0.1:55432/clone_study`;
const schema = "play_test_" + process.pid;
const admin = new PrismaClient({ datasourceUrl: baseUrl });
let db: PrismaClient;
let api: typeof import("../src/server/play");
const originalFetch = globalThis.fetch;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const persona = {
  displayName: "小林",
  bio: "喜欢周末爬山",
  style: "简短、口语，不用敬语",
  memories: "上次一起去海边吃了面",
  examplesText: "朋友：今天吃啥\n我：随便整点面吧",
};
type Guest = { roomId: string; tokenHash: string };
const gameOrigin = "http://127.0.0.1:3000";
const gameRequest = (action: string, payload: unknown, cookie = "") =>
  new Request(gameOrigin + "/api/play", {
    method: "POST",
    headers: { origin: gameOrigin, "content-type": "application/json", cookie },
    body: JSON.stringify({ action, payload }),
  });
async function hostCookie(actor: Actor) {
  const { createPortalSession } = await import("../src/server/auth");
  const response = await createPortalSession(
    new Request(gameOrigin),
    "target",
    actor,
  );
  return response.headers.getSetCookie()[0].split(";")[0];
}
const rejectsCode = (promise: Promise<unknown>, code: string) =>
  assert.rejects(
    promise,
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === code,
  );
function assertBlind(dto: PlayRoomDto) {
  assert.deepEqual(
    Object.keys(dto).sort(),
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
  assert.equal(dto.result, null);
  for (const message of dto.messages)
    assert.deepEqual(
      Object.keys(message).sort(),
      ["id", "speaker", "text", "sequence"].sort(),
    );
}
async function host() {
  const id = "play-target-" + randomUUID();
  const actor: Actor = { id, role: "TARGET", pseudonym: "主人" };
  await db.participant.create({
    data: {
      ...actor,
      account: {
        create: {
          username: "host_" + randomUUID().slice(0, 20),
          passwordHash: "test-fixture-not-a-login",
        },
      },
    },
  });
  await api.savePlayPersona(actor, persona);
  await api.heartbeatPlayHost(actor, true);
  return actor;
}
async function room(mode: PlayIdentity = "HUMAN", owner?: Actor) {
  const actor = owner ?? (await host());
  await api.heartbeatPlayHost(actor, true);
  const created = await api.createPlayRoom(actor);
  // Branch control is a fixture-only DB operation; production accepts no mode.
  await db.playRoom.update({ where: { id: created.room.id }, data: { mode } });
  const token = new URL(created.url, "http://127.0.0.1:3000").hash.split(
    "token=",
  )[1];
  assert(token, "Invitation secret must live in the fragment");
  const joined = await api.joinPlayRoom({
    token,
    nickname: "朋友",
    consent: true,
  });
  const guest: Guest = {
    roomId: joined.room.id,
    tokenHash: digest(joined.guestToken),
  };
  return { actor, guest, created, joined, token };
}
async function complete(mode: PlayIdentity, owner?: Actor) {
  const state = await room(mode, owner);
  for (let turn = 0; turn < 5; turn++) {
    await api.sendPlayMessage(state.guest, {
      text: `问题 ${turn}`,
      idempotencyKey: randomUUID(),
    });
    if (mode === "HUMAN")
      await api.replyPlayRoom(state.actor, {
        roomId: state.guest.roomId,
        text: `回答 ${turn}`,
        idempotencyKey: randomUUID(),
      });
    else await api.runPendingPlayReply(state.guest.roomId);
  }
  return state;
}

before(async () => {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString();
  process.env.APP_ORIGIN = "http://127.0.0.1:3000";
  process.env.PLAY_MODEL_BASE_URL = "https://model.example/v1";
  process.env.PLAY_MODEL_PROVIDER = "compatible";
  process.env.PLAY_MODEL_API_KEY = "test-key-never-sent";
  process.env.PLAY_MODEL_NAME = "test-model";
  const binary = path.resolve(
    "node_modules/@prisma/engines/schema-engine-darwin-arm64",
  );
  execFileSync(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",
      "migrate",
      "deploy",
      "--schema",
      "prisma/schema.prisma",
    ],
    {
      env: {
        ...process.env,
        ...(existsSync(binary) ? { PRISMA_SCHEMA_ENGINE_BINARY: binary } : {}),
      },
      stdio: "pipe",
    },
  );
  db = (await import("../src/server/db")).prisma;
  api = await import("../src/server/play");
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        { message: { content: "嗯，那就一起去呗" }, finish_reason: "stop" },
      ],
    });
});
after(async () => {
  globalThis.fetch = originalFetch;
  await db?.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$disconnect();
});

test("self-registered game accounts cannot set their role or close study bootstrap", async () => {
  const portals = await import("../src/server/portals");
  process.env.PORTAL_BOOTSTRAP_ENABLED = "true";
  process.env.APP_HOST = "127.0.0.1";
  const secret = "test-game-account-password";
  const actor = await portals.registerPlayHost({
    username: "Game.Host",
    password: secret,
    pseudonym: "游戏主人",
    role: "RESEARCHER",
  });
  assert.equal(actor.role, "TARGET");
  assert(actor.id.startsWith("play-target-"));
  const account = await db.account.findUniqueOrThrow({
    where: { participantId: actor.id },
  });
  assert(account.passwordHash.startsWith("scrypt-v1$"));
  assert(!account.passwordHash.includes(secret));
  assert.equal(
    (
      await portals.authenticateAccount({
        username: "game.host",
        password: secret,
        portal: "target",
      })
    ).id,
    actor.id,
  );
  await rejectsCode(
    portals.authenticateAccount({
      username: "game.host",
      password: secret,
      portal: "research",
    }),
    "INVALID_CREDENTIALS",
  );
  assert.equal((await portals.getPortalStatus()).bootstrapAvailable, true);
  assert.equal(
    await db.consent.count({ where: { participantId: actor.id } }),
    0,
  );
  assert.equal(await db.preparationRoom.count(), 0);
  assert.equal(await db.session.count(), 0);
});

test("one concurrent room wins; identity and persona snapshot remain fixed", async () => {
  const actor = await host();
  const results = await Promise.allSettled(
    [1, 2, 3].map(() => api.createPlayRoom(actor)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const stored = await db.playRoom.findFirstOrThrow({
    where: { ownerId: actor.id },
  });
  assert(["HUMAN", "AI"].includes(stored.mode));
  const snapshot = stored.personaSnapshot as {
    styleProfile?: { sourceHash: string; samples: unknown[] };
  };
  assert.equal(snapshot.styleProfile?.samples.length, 1);
  assert.match(snapshot.styleProfile!.sourceHash, /^[a-f0-9]{64}$/);
  await api.savePlayPersona(actor, { ...persona, memories: "后来的新记忆" });
  const unchanged = await db.playRoom.findUniqueOrThrow({
    where: { id: stored.id },
  });
  assert.equal(unchanged.mode, stored.mode);
  assert.deepEqual(unchanged.personaSnapshot, stored.personaSnapshot);
  await api.cancelPlayRoom(actor, stored.id);
});

test("saving distills only the selected speaker and a changed corpus creates a new frozen version", async () => {
  const actor = await host();
  const saved = await api.savePlayPersona(actor, {
    ...persona,
    exampleSpeaker: "老王",
    examplesText:
      "小王：今天怎么样？\n老王：还行\n小王：出来吃饭吗？\n老王：走呗",
  });
  assert.equal(saved.styleSummary.sampleCount, 2);
  assert.equal(saved.styleSummary.pairedExampleCount, 2);
  assert.equal(saved.styleSummary.medianLength, 2);
  assert.equal(saved.styleSummary.emojiRate, 0);
  const home = await api.getPlayHome(actor);
  assert.equal(home.styleSummary?.sourceHash, saved.styleSummary.sourceHash);
  const record = await db.playPersona.findUniqueOrThrow({
    where: { ownerId: actor.id },
  });
  assert(record.styleProfile);
  const created = await api.createPlayRoom(actor);
  const before = await db.playRoom.findUniqueOrThrow({
    where: { id: created.room.id },
  });
  const changed = await api.savePlayPersona(actor, {
    ...saved.persona,
    examplesText: saved.persona.examplesText + "\n小王：几点？\n老王：六点呗",
  });
  assert.notEqual(
    changed.styleSummary.sourceHash,
    saved.styleSummary.sourceHash,
  );
  assert.deepEqual(
    (await db.playRoom.findUniqueOrThrow({ where: { id: created.room.id } }))
      .personaSnapshot,
    before.personaSnapshot,
  );
  await api.cancelPlayRoom(actor, created.room.id);
});

test("unrecognized speakers are visible to the host and cannot silently become an AI persona", async () => {
  const actor = await host();
  const saved = await api.savePlayPersona(actor, {
    ...persona,
    exampleSpeaker: "不存在",
    examplesText: "甲：你好\n乙：哈喽",
  });
  assert.equal(saved.styleSummary.status, "needs_examples");
  await rejectsCode(api.createPlayRoom(actor), "PERSONA_EXAMPLES_REQUIRED");
  await rejectsCode(
    api.previewPlayPersona(actor, {
      messages: [{ speaker: "FRIEND", text: "你好" }],
    }),
    "PERSONA_EXAMPLES_REQUIRED",
  );
});

test("private rehearsal uses saved evidence without storing messages or changing experimental statistics", async () => {
  const actor = await host();
  const home = await api.getPlayHome(actor);
  const counts = [await db.playRoom.count(), await db.playMessage.count()];
  const profile = await db.playPersona.findUniqueOrThrow({
    where: { ownerId: actor.id },
  });
  const preview = await api.previewPlayPersona(actor, {
    messages: [{ speaker: "FRIEND", text: "吃啥" }],
  });
  assert.equal(preview.reply, "嗯，那就一起去呗");
  assert.equal(preview.styleSummary.sourceHash, home.styleSummary?.sourceHash);
  assert.deepEqual(
    [await db.playRoom.count(), await db.playMessage.count()],
    counts,
  );
  assert.deepEqual(
    await db.playPersona.findUniqueOrThrow({ where: { ownerId: actor.id } }),
    profile,
  );
  assert.deepEqual((await api.getPlayHome(actor)).stats, home.stats);
  const { POST } = await import("../src/app/api/play/route");
  const unauthorized = await POST(
    gameRequest("preview_persona", {
      messages: [{ speaker: "FRIEND", text: "吃啥" }],
    }),
  );
  assert.equal(unauthorized.status, 401);
  const allowed = await POST(
    gameRequest(
      "preview_persona",
      { messages: [{ speaker: "FRIEND", text: "吃啥" }] },
      await hostCookie(actor),
    ),
  );
  assert.equal(allowed.status, 200);
});

test("invitation is consumed exactly once under a race and guest credential is hashed", async () => {
  const actor = await host();
  const created = await api.createPlayRoom(actor);
  const token = new URL(created.url).hash.split("token=")[1];
  const outcomes = await Promise.allSettled(
    [1, 2, 3].map(() =>
      api.joinPlayRoom({ token, nickname: "好友", consent: true }),
    ),
  );
  const successes = outcomes.filter((r) => r.status === "fulfilled");
  assert.equal(successes.length, 1);
  const joined = (
    successes[0] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof api.joinPlayRoom>>
    >
  ).value;
  const stored = await db.playRoom.findUniqueOrThrow({
    where: { id: created.room.id },
  });
  assert.equal(stored.guestHash, digest(joined.guestToken));
  assert.notEqual(stored.guestHash, joined.guestToken);
  await rejectsCode(api.inspectPlayInvitation(token), "INVITATION_INVALID");
  assertBlind(joined.room);
  await api.cancelPlayRoom(actor, stored.id);
});

test("missing consent cannot consume an invitation, and expired invitations cannot join", async () => {
  const actor = await host();
  const created = await api.createPlayRoom(actor);
  const token = new URL(created.url).hash.split("token=")[1];
  await rejectsCode(
    api.joinPlayRoom({
      token,
      nickname: "朋友",
      consent: false as unknown as true,
    }),
    "INVALID_INPUT",
  );
  assert.equal(
    (await api.inspectPlayInvitation(token)).hostName,
    persona.displayName,
  );
  await db.playRoom.update({
    where: { id: created.room.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await rejectsCode(
    api.joinPlayRoom({ token, nickname: "朋友", consent: true }),
    "INVITATION_INVALID",
  );
  assert.equal(
    (await db.playRoom.findUniqueOrThrow({ where: { id: created.room.id } }))
      .guestHash,
    null,
  );
});

test("joining over HTTP returns only the blind room and binds future reads to its HttpOnly cookie", async () => {
  const route = await import("../src/app/api/play/route");
  const actor = await host();
  const created = await api.createPlayRoom(actor);
  const token = new URL(created.url).hash.split("token=")[1];
  const response = await route.POST(
    new Request("http://127.0.0.1:3000/api/play", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "join_room",
        payload: { token, nickname: "朋友", consent: true },
      }),
    }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["room"]);
  assertBlind(body.room);
  const cookie = response.headers.getSetCookie()[0];
  assert.match(cookie, /; HttpOnly;/);
  const rawCookie = cookie.split(";")[0];
  const get = await route.GET(
    new Request(
      `http://127.0.0.1:3000/api/play?view=room&roomId=${created.room.id}`,
      { headers: { cookie: rawCookie } },
    ),
  );
  assert.equal(get.status, 200);
  assertBlind((await get.json()).room);
  const withoutCookie = await route.GET(
    new Request(
      `http://127.0.0.1:3000/api/play?view=room&roomId=${created.room.id}`,
    ),
  );
  assert.equal(withoutCookie.status, 401);
  await api.cancelPlayRoom(actor, created.room.id);
});

test("both identities expose the same friend fields; another room and another host are inaccessible", async () => {
  const human = await room("HUMAN"),
    ai = await room("AI");
  for (const state of [human, ai])
    assertBlind(await api.getPlayRoom(state.guest));
  await rejectsCode(
    api.getPlayRoom({ ...human.guest, roomId: ai.guest.roomId }),
    "NOT_FOUND",
  );
  await rejectsCode(
    api.replyPlayRoom(ai.actor, {
      roomId: human.guest.roomId,
      text: "越权",
      idempotencyKey: randomUUID(),
    }),
    "NOT_FOUND",
  );
  await api.sendPlayMessage(ai.guest, {
    text: "有人吗",
    idempotencyKey: randomUUID(),
  });
  await rejectsCode(
    api.replyPlayRoom(ai.actor, {
      roomId: ai.guest.roomId,
      text: "本人代回AI",
      idempotencyKey: randomUUID(),
    }),
    "INVALID_STATE",
  );
  assert.equal(
    await db.playMessage.count({
      where: { roomId: ai.guest.roomId, speaker: "SOURCE" },
    }),
    0,
  );
});

test("five ordered human turns enforce turn-taking, concurrent idempotency and a single final guess", async () => {
  const { actor, guest } = await room();
  await rejectsCode(
    api.replyPlayRoom(actor, {
      roomId: guest.roomId,
      text: "抢答",
      idempotencyKey: randomUUID(),
    }),
    "INVALID_STATE",
  );
  await rejectsCode(
    api.guessPlayRoom(guest, { guess: "HUMAN", reason: "太早" }),
    "INVALID_STATE",
  );
  for (let turn = 0; turn < 5; turn++) {
    const input = { text: `朋友提问 ${turn}`, idempotencyKey: randomUUID() };
    await Promise.all([1, 2, 3].map(() => api.sendPlayMessage(guest, input)));
    await rejectsCode(
      api.sendPlayMessage(guest, { ...input, text: "同一个key换正文" }),
      "IDEMPOTENCY_CONFLICT",
    );
    await rejectsCode(
      api.sendPlayMessage(guest, {
        text: "还没回复又问",
        idempotencyKey: randomUUID(),
      }),
      "INVALID_STATE",
    );
    const response = {
      roomId: guest.roomId,
      text: `本人回答 ${turn}`,
      idempotencyKey: randomUUID(),
    };
    await Promise.all([1, 2, 3].map(() => api.replyPlayRoom(actor, response)));
    const dto = await api.getPlayRoom(guest);
    assertBlind(dto);
    assert.equal(dto.turnsCompleted, turn + 1);
    assert.equal(dto.messages.length, (turn + 1) * 2);
  }
  const beforeGuess = await api.getPlayRoom(guest);
  assert.equal(beforeGuess.status, "GUESSING");
  assert.deepEqual(
    beforeGuess.messages.map((m) => m.sequence),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.deepEqual(
    beforeGuess.messages.map((m) => m.speaker),
    Array.from({ length: 10 }, (_, i) => (i % 2 ? "SOURCE" : "FRIEND")),
  );
  await rejectsCode(
    api.sendPlayMessage(guest, {
      text: "第六轮",
      idempotencyKey: randomUUID(),
    }),
    "INVALID_STATE",
  );
  const guesses = await Promise.allSettled(
    (["HUMAN", "AI"] as const).map((guess) =>
      api.guessPlayRoom(guest, { guess, reason: "像平时的语气" }),
    ),
  );
  assert.equal(guesses.filter((r) => r.status === "fulfilled").length, 1);
  const revealed = await api.getPlayRoom(guest);
  assert.equal(revealed.status, "REVEALED");
  assert.equal(revealed.result?.answer, "HUMAN");
  await rejectsCode(
    api.guessPlayRoom(guest, {
      guess: revealed.result?.guess === "AI" ? "HUMAN" : "AI",
      reason: "改答案",
    }),
    "IDEMPOTENCY_CONFLICT",
  );
  await api.guessPlayRoom(guest, {
    guess: revealed.result!.guess,
    reason: "不能修改的理由",
  });
  assert.equal((await api.getPlayRoom(guest)).result?.reason, "像平时的语气");
});

test("AI processing is claimed once across concurrent workers and duplicate friend sends", async () => {
  const { guest } = await room("AI");
  let calls = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      choices: [{ message: { content: "可以啊" }, finish_reason: "stop" }],
    });
  };
  try {
    const input = { text: "明天一起吃饭", idempotencyKey: randomUUID() };
    await Promise.all([1, 2, 3].map(() => api.sendPlayMessage(guest, input)));
    await Promise.all(
      [1, 2, 3].map(() => api.runPendingPlayReply(guest.roomId)),
    );
    assert.equal(calls, 1);
    const dto = await api.getPlayRoom(guest);
    assertBlind(dto);
    assert.equal(dto.turnsCompleted, 1);
    assert.equal(dto.messages.length, 2);
  } finally {
    globalThis.fetch = previous;
  }
});

test("host timeout cancels both identities with the same public state", async () => {
  for (const mode of ["HUMAN", "AI"] as const) {
    const { actor, guest } = await room(mode);
    await db.playPersona.update({
      where: { ownerId: actor.id },
      data: { heartbeatAt: new Date(Date.now() - 120_000) },
    });
    const dto = await api.getPlayRoom(guest);
    assertBlind(dto);
    assert.equal(dto.status, "CANCELLED");
    await api.sendPlayMessage(guest, {
      text: "断线后发送",
      idempotencyKey: randomUUID(),
    });
    await api.guessPlayRoom(guest, { guess: mode, reason: "断线" });
    assert.equal(
      await db.playMessage.count({ where: { roomId: guest.roomId } }),
      0,
    );
    assertBlind(await api.getPlayRoom(guest));
  }
});

test("host polling retains waiting and active rooms with null or unexpired pending timestamps", async () => {
  for (const mode of ["HUMAN", "AI"] as const) {
    const actor = await host();
    const created = await api.createPlayRoom(actor);
    const roomId = created.room.id;
    await db.playRoom.update({ where: { id: roomId }, data: { mode } });
    const token = new URL(created.url).hash.split("token=")[1];
    async function visible(status: "WAITING" | "ACTIVE", pending: boolean) {
      const stored = await db.playRoom.findUniqueOrThrow({
        where: { id: roomId },
      });
      assert.equal(stored.pendingSince !== null, pending);
      const home = await api.getPlayHome(actor);
      assert.ok(home.activeRoom, `${mode} ${status} pending=${pending}`);
      assert.equal(home.activeRoom.id, roomId);
      assert.equal(home.activeRoom.status, status);
      assert.equal(home.activeRoom.mode, mode);
      assert.equal(
        home.activeRoom.waitingFor,
        status === "WAITING" ? null : pending ? "SOURCE" : "FRIEND",
      );
      assert.deepEqual(home.recentRooms, []);
      assert.equal(home.stats.cancelled, 0);
      assert.deepEqual(
        await db.playRoom.findUniqueOrThrow({ where: { id: roomId } }),
        stored,
      );
    }
    await visible("WAITING", false);
    const joined = await api.joinPlayRoom({
      token,
      nickname: "朋友",
      consent: true,
    });
    const guest: Guest = { roomId, tokenHash: digest(joined.guestToken) };
    await visible("ACTIVE", false);
    await api.sendPlayMessage(guest, {
      text: "周末去哪里？",
      idempotencyKey: randomUUID(),
    });
    await visible("ACTIVE", true);
    if (mode === "HUMAN")
      await api.replyPlayRoom(actor, {
        roomId,
        text: "海边走走呗",
        idempotencyKey: randomUUID(),
      });
    else await api.runPendingPlayReply(roomId);
    await visible("ACTIVE", false);
  }
});

test("polling reads expire rooms without waiting for the transition lock or writing", async () => {
  const { actor, guest } = await room("AI");
  await api.sendPlayMessage(guest, {
    text: "等回复",
    idempotencyKey: randomUUID(),
  });
  const stored = await db.playRoom.update({
    where: { id: guest.roomId },
    data: {
      pendingSince: new Date(Date.now() - api.PLAY_REPLY_TIMEOUT_MS - 1000),
    },
  });
  let acquired!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(70624004)::text`;
      acquired();
      await released;
    },
    { timeout: 10000 },
  );
  await ready;
  const reading = Promise.all([api.getPlayHome(actor), api.getPlayRoom(guest)]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [home, friend] = await Promise.race([
      reading,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Polling waited for the global transition lock")),
          3000,
        );
      }),
    ]);
    assert.equal(home.activeRoom, null);
    assert.equal(home.recentRooms[0].id, guest.roomId);
    assert.equal(home.recentRooms[0].status, "CANCELLED");
    assert.equal(home.stats.cancelled, 1);
    assert.equal(home.stats.completed, 0);
    assert.equal(friend.status, "CANCELLED");
    assert.equal(friend.waitingFor, null);
    assertBlind(friend);
    assert.deepEqual(
      await db.playRoom.findUniqueOrThrow({ where: { id: guest.roomId } }),
      stored,
    );
  } finally {
    clearTimeout(timer);
    release();
    await locked;
    await Promise.allSettled([reading]);
  }
  // A later mutation persists exactly the cancellation the readers projected.
  await api.heartbeatPlayHost(actor, true);
  assert.equal(
    (await db.playRoom.findUniqueOrThrow({ where: { id: guest.roomId } }))
      .status,
    "CANCELLED",
  );
  assert.equal((await api.getPlayHome(actor)).stats.cancelled, 1);
});

test("read-only expiry covers offline, deleted and disabled hosts without weakening access checks", async () => {
  for (const cause of [
    "heartbeat",
    "offline",
    "deleted",
    "disabled",
    "expired",
  ] as const) {
    const { actor, guest } = await room();
    if (cause === "deleted") {
      await db.playPersona.delete({ where: { ownerId: actor.id } });
    } else if (cause === "disabled") {
      await db.participant.update({
        where: { id: actor.id },
        data: { active: false },
      });
    } else if (cause === "expired") {
      await db.playRoom.update({
        where: { id: guest.roomId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
    } else {
      await db.playPersona.update({
        where: { ownerId: actor.id },
        data: {
          heartbeatAt:
            cause === "offline"
              ? null
              : new Date(Date.now() - api.PLAY_HOST_TIMEOUT_MS - 1000),
        },
      });
    }
    const stored = await db.playRoom.findUniqueOrThrow({
      where: { id: guest.roomId },
    });
    if (cause === "expired") {
      await rejectsCode(api.getPlayRoom(guest), "NOT_FOUND");
    } else {
      const friend = await api.getPlayRoom(guest);
      assert.equal(friend.status, "CANCELLED", cause);
      assertBlind(friend);
    }
    await rejectsCode(
      api.getPlayRoom({ ...guest, tokenHash: digest("wrong credential") }),
      "NOT_FOUND",
    );
    if (cause === "disabled") {
      await rejectsCode(api.getPlayHome(actor), "FORBIDDEN");
    } else {
      const home = await api.getPlayHome(actor);
      assert.equal(home.activeRoom, null, cause);
      assert.equal(home.recentRooms[0].status, "CANCELLED", cause);
      assert.equal(home.stats.cancelled, 1, cause);
    }
    assert.deepEqual(
      await db.playRoom.findUniqueOrThrow({ where: { id: guest.roomId } }),
      stored,
      cause,
    );
  }
});

test("persisted pending-turn timeout and explicit host departure cancel human and AI games", async () => {
  for (const mode of ["HUMAN", "AI"] as const) {
    const { actor, guest } = await room(mode);
    await api.sendPlayMessage(guest, {
      text: "等回复",
      idempotencyKey: randomUUID(),
    });
    await db.playRoom.update({
      where: { id: guest.roomId },
      data: {
        pendingSince: new Date(Date.now() - api.PLAY_REPLY_TIMEOUT_MS - 1000),
      },
    });
    await api.heartbeatPlayHost(actor, true);
    assert.equal((await api.getPlayRoom(guest)).status, "CANCELLED");
    assert.equal(
      await db.playMessage.count({
        where: { roomId: guest.roomId, speaker: "SOURCE" },
      }),
      0,
    );
    const next = await room(mode, actor);
    await api.heartbeatPlayHost(actor, false);
    assert.equal((await api.getPlayRoom(next.guest)).status, "CANCELLED");
    if (mode === "HUMAN")
      await api.replyPlayRoom(actor, {
        roomId: next.guest.roomId,
        text: "迟到的本人回答",
        idempotencyKey: randomUUID(),
      });
    else await api.runPendingPlayReply(next.guest.roomId);
    assert.equal(
      await db.playMessage.count({ where: { roomId: next.guest.roomId } }),
      0,
    );
  }
});

test("provider failure cancels without a model error or an identity reveal", async () => {
  const { guest } = await room("AI");
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("secret model endpoint failed");
  };
  try {
    await api.sendPlayMessage(guest, {
      text: "周末干啥",
      idempotencyKey: randomUUID(),
    });
    await api.runPendingPlayReply(guest.roomId);
    const dto = await api.getPlayRoom(guest);
    assertBlind(dto);
    assert.equal(dto.status, "CANCELLED");
    assert(!JSON.stringify(dto).includes("secret model"));
    assert.equal(dto.messages.filter((m) => m.speaker === "SOURCE").length, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test("a delayed model result cannot write after a friend leaves", async () => {
  const { guest } = await room("AI");
  const previous = globalThis.fetch;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async () => {
    entered();
    await pending;
    return Response.json({
      choices: [{ message: { content: "太晚才生成" }, finish_reason: "stop" }],
    });
  };
  try {
    await api.sendPlayMessage(guest, {
      text: "稍后见",
      idempotencyKey: randomUUID(),
    });
    const running = api.runPendingPlayReply(guest.roomId);
    await started;
    await api.leavePlayRoom(guest);
    release();
    await running;
    assert.equal(
      await db.playMessage.count({
        where: { roomId: guest.roomId, speaker: "SOURCE" },
      }),
      0,
    );
    assert.equal((await api.getPlayRoom(guest)).status, "CANCELLED");
  } finally {
    release?.();
    globalThis.fetch = previous;
  }
});

test("statistics use separate AI/human denominators and exclude cancellations", async () => {
  const actor = await host();
  assert.deepEqual((await api.getPlayHome(actor)).stats, {
    completed: 0,
    cancelled: 0,
    aiRounds: 0,
    humanRounds: 0,
    aiFooledRate: null,
    humanRecognizedRate: null,
  });
  for (const [mode, guess] of [
    ["AI", "HUMAN"],
    ["AI", "AI"],
    ["HUMAN", "HUMAN"],
  ] as const) {
    const state = await complete(mode, actor);
    await api.guessPlayRoom(state.guest, { guess, reason: "测试判断" });
  }
  const cancelled = await room("AI", actor);
  await api.leavePlayRoom(cancelled.guest);
  assert.deepEqual((await api.getPlayHome(actor)).stats, {
    completed: 3,
    cancelled: 1,
    aiRounds: 2,
    humanRounds: 1,
    aiFooledRate: 0.5,
    humanRecognizedRate: 1,
  });
});

test("a friend's deletion erases only their room and messages, clears only its cookie, and is replay-safe", async () => {
  const route = await import("../src/app/api/play/route");
  const first = await complete("HUMAN");
  await api.guessPlayRoom(first.guest, {
    guess: "HUMAN",
    reason: "私人的判断理由",
  });
  const other = await room("HUMAN", first.actor);
  await api.sendPlayMessage(other.guest, {
    text: "另一局保留",
    idempotencyKey: randomUUID(),
  });
  const retained = await db.playRoom.findUniqueOrThrow({
    where: { id: other.guest.roomId },
    include: { messages: true },
  });
  const guestCookie = `play_guest_${first.guest.roomId}=${first.joined.guestToken}`;
  const cookie = `${guestCookie}; play_guest_${other.guest.roomId}=${other.joined.guestToken}; ${await hostCookie(first.actor)}`;

  const foreign = await route.POST(
    gameRequest(
      "delete_data",
      { roomId: other.guest.roomId },
      `play_guest_${other.guest.roomId}=${first.joined.guestToken}`,
    ),
  );
  assert.equal(foreign.status, 404);
  assert.equal(
    await db.playRoom.count({
      where: { id: { in: [first.guest.roomId, other.guest.roomId] } },
    }),
    2,
  );

  for (let retry = 0; retry < 2; retry++) {
    const response = await route.POST(
      gameRequest("delete_data", { roomId: first.guest.roomId }, cookie),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true });
    const cleared = response.headers.getSetCookie();
    assert.equal(cleared.length, 1);
    assert.equal(
      cleared[0],
      `play_guest_${first.guest.roomId}=; Path=/api/play; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
  }
  assert.equal(
    await db.playRoom.findUnique({ where: { id: first.guest.roomId } }),
    null,
  );
  assert.equal(
    await db.playMessage.count({ where: { roomId: first.guest.roomId } }),
    0,
  );
  await rejectsCode(api.getPlayRoom(first.guest), "NOT_FOUND");
  await rejectsCode(
    api.inspectPlayInvitation(first.token),
    "INVITATION_INVALID",
  );
  assert.deepEqual(
    await db.playRoom.findUniqueOrThrow({
      where: { id: other.guest.roomId },
      include: { messages: true },
    }),
    retained,
  );
  assert.ok(
    await db.playPersona.findUnique({ where: { ownerId: first.actor.id } }),
  );
  assert.equal(
    (await api.getPlayHome(first.actor)).activeRoom?.id,
    other.guest.roomId,
  );
});

test("account deletion authenticates the owner and erases persona, rooms, messages, credentials, sessions and registration audit IDs", async () => {
  const route = await import("../src/app/api/play/route");
  const portals = await import("../src/server/portals");
  const actor = await portals.registerPlayHost({
    username: "erase_" + randomUUID().slice(0, 16),
    password: "synthetic-erasure-password",
    pseudonym: "不公开的昵称",
  });
  await api.savePlayPersona(actor, persona);
  const first = await complete("HUMAN", actor);
  await api.guessPlayRoom(first.guest, {
    guess: "HUMAN",
    reason: "不保留的理由",
  });
  const next = await room("AI", actor);
  await api.sendPlayMessage(next.guest, {
    text: "正在等待的私聊",
    idempotencyKey: randomUUID(),
  });
  const cookie = await hostCookie(actor);
  const oldOtherSession = await hostCookie(actor);
  assert.equal(
    await db.authSession.count({ where: { participantId: actor.id } }),
    2,
  );
  assert.equal(await db.auditEvent.count({ where: { actorId: actor.id } }), 1);
  const preserved = await room("HUMAN");
  const preservedRoom = await db.playRoom.findUniqueOrThrow({
    where: { id: preserved.guest.roomId },
  });

  assert.equal(
    (await route.POST(gameRequest("delete_account", {}))).status,
    401,
  );
  assert.equal(
    (
      await route.POST(
        gameRequest(
          "delete_account",
          { actorId: actor.id },
          await hostCookie(preserved.actor),
        ),
      )
    ).status,
    422,
  );
  assert.ok(await db.participant.findUnique({ where: { id: actor.id } }));
  const response = await route.POST(gameRequest("delete_account", {}, cookie));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true });
  assert.deepEqual(response.headers.getSetCookie(), [
    "clone_target_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
  ]);
  assert.equal(
    await db.participant.findUnique({ where: { id: actor.id } }),
    null,
  );
  assert.equal(
    await db.account.count({ where: { participantId: actor.id } }),
    0,
  );
  assert.equal(
    await db.authSession.count({ where: { participantId: actor.id } }),
    0,
  );
  assert.equal(await db.playPersona.count({ where: { ownerId: actor.id } }), 0);
  assert.equal(await db.playRoom.count({ where: { ownerId: actor.id } }), 0);
  assert.equal(
    await db.playMessage.count({
      where: { roomId: { in: [first.guest.roomId, next.guest.roomId] } },
    }),
    0,
  );
  assert.equal(
    await db.auditEvent.count({
      where: { OR: [{ actorId: actor.id }, { entityId: actor.id }] },
    }),
    0,
  );
  assert.equal(
    (await route.POST(gameRequest("delete_account", {}, oldOtherSession)))
      .status,
    401,
  );
  assert.deepEqual(await api.deletePlayAccount(actor), { deleted: true });
  await rejectsCode(api.getPlayRoom(first.guest), "NOT_FOUND");
  await rejectsCode(api.getPlayRoom(next.guest), "NOT_FOUND");
  assert.ok(
    await db.account.findUnique({
      where: { participantId: preserved.actor.id },
    }),
  );
  assert.deepEqual(
    await db.playRoom.findUniqueOrThrow({
      where: { id: preserved.guest.roomId },
    }),
    preservedRoom,
  );
});

test("late model completion or failure cannot recreate data after guest or account deletion", async () => {
  for (const scope of ["guest", "account"] as const) {
    for (const outcome of ["success", "failure"] as const) {
      const state = await room("AI");
      const previous = globalThis.fetch;
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((done) => {
        entered = done;
      });
      const pending = new Promise<void>((done) => {
        release = done;
      });
      let running: Promise<void> | undefined;
      globalThis.fetch = async () => {
        entered();
        await pending;
        if (outcome === "failure")
          throw new Error("synthetic provider failure");
        return Response.json({
          choices: [
            {
              message: { content: "删除之后的迟到回复" },
              finish_reason: "stop",
            },
          ],
        });
      };
      try {
        await api.sendPlayMessage(state.guest, {
          text: "删除前的提问",
          idempotencyKey: randomUUID(),
        });
        running = api.runPendingPlayReply(state.guest.roomId);
        await started;
        const erase = () =>
          scope === "guest"
            ? api.deletePlayData(state.guest)
            : api.deletePlayAccount(state.actor);
        assert.deepEqual(await Promise.all([erase(), erase()]), [
          { deleted: true },
          { deleted: true },
        ]);
        release();
        await running;
        await api.runPendingPlayReply(state.guest.roomId);
        assert.equal(
          await db.playRoom.findUnique({ where: { id: state.guest.roomId } }),
          null,
        );
        assert.equal(
          await db.playMessage.count({ where: { roomId: state.guest.roomId } }),
          0,
        );
        assert.equal(
          await db.participant.count({ where: { id: state.actor.id } }),
          scope === "account" ? 0 : 1,
        );
      } finally {
        release();
        await running;
        globalThis.fetch = previous;
      }
    }
  }
});

test("game credentials cannot create a research portal session while game authentication still works", async () => {
  const portals = await import("../src/server/portals");
  const portalRoute = await import("../src/app/api/portal/route");
  const playRoute = await import("../src/app/api/play/route");
  const username = "separate_" + randomUUID().slice(0, 16);
  const password = "synthetic-separation-password";
  const actor = await portals.registerPlayHost({
    username,
    password,
    pseudonym: "游戏匿名昵称",
  });
  const request = (url: string) =>
    new Request(gameOrigin + url, {
      method: "POST",
      headers: {
        origin: gameOrigin,
        "content-type": "application/json",
        "x-study-portal": "target",
      },
      body: JSON.stringify({
        action: "login",
        payload: { username, password },
      }),
    });
  const denied = await portalRoute.POST(request("/api/portal"));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "FORBIDDEN");
  assert.equal(denied.headers.get("set-cookie"), null);
  assert.equal(
    await db.authSession.count({ where: { participantId: actor.id } }),
    0,
  );
  const allowed = await playRoute.POST(request("/api/play"));
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).actor.id, actor.id);
  assert.equal(
    await db.authSession.count({ where: { participantId: actor.id } }),
    1,
  );
  assert.equal(
    await db.consent.count({ where: { participantId: actor.id } }),
    0,
  );
});

test("research target credentials and sessions cannot enter the game, while their research portal still works", async () => {
  const portals = await import("../src/server/portals");
  const portalRoute = await import("../src/app/api/portal/route");
  const playRoute = await import("../src/app/api/play/route");
  const staff = await portals.initializeResearchAccount(
    {
      username: "boundary_admin",
      password: "synthetic-boundary-password",
      pseudonym: "合成研究员",
    },
    { localBootstrap: true },
  );
  const invite = await portals.createInvitation(staff, { kind: "TARGET" });
  const credentials = {
    username: "boundary_target",
    password: "synthetic-target-password",
  };
  const actor = await portals.registerFromInvitation({
    ...credentials,
    token: invite.token,
    pseudonym: "独立研究对象",
    portal: "target",
    consent: { participation: true, version: "enrollment-v1" },
  });
  assert(!actor.id.startsWith("play-target-"));
  const denied = await playRoute.POST(gameRequest("login", credentials));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "FORBIDDEN");
  assert.equal(denied.headers.get("set-cookie"), null);
  assert.equal(
    await db.authSession.count({ where: { participantId: actor.id } }),
    0,
  );
  const login = await portalRoute.POST(
    new Request(gameOrigin + "/api/portal", {
      method: "POST",
      headers: {
        origin: gameOrigin,
        "content-type": "application/json",
        "x-study-portal": "target",
      },
      body: JSON.stringify({ action: "login", payload: credentials }),
    }),
  );
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  for (const view of ["me", "home"]) {
    const response = await portalRoute.GET(
      new Request(gameOrigin + "/api/portal?view=" + view, {
        headers: { "x-study-portal": "target", cookie },
      }),
    );
    assert.equal(response.status, 200);
  }
  assert.equal(
    (
      await playRoute.GET(
        new Request(gameOrigin + "/api/play?view=home", {
          headers: { cookie },
        }),
      )
    ).status,
    403,
  );
  for (const [action, payload] of [
    ["save_persona", persona],
    ["heartbeat", { online: true }],
    ["create_room", {}],
    ["delete_account", {}],
  ] as const)
    assert.equal(
      (await playRoute.POST(gameRequest(action, payload, cookie))).status,
      403,
      action,
    );
  await rejectsCode(api.savePlayPersona(actor, persona), "FORBIDDEN");
  await rejectsCode(api.createPlayRoom(actor), "FORBIDDEN");
  assert.equal(await db.playPersona.count({ where: { ownerId: actor.id } }), 0);
  assert.equal(await db.playRoom.count({ where: { ownerId: actor.id } }), 0);
  assert.equal(
    await db.consent.count({ where: { participantId: actor.id } }),
    1,
  );
  assert.ok(
    await db.account.findUnique({ where: { participantId: actor.id } }),
  );
});

test("end-of-analysis purge previews by default and erases only game-prefix accounts when explicitly confirmed", async () => {
  const researcher: Actor = {
    id: "enrolled-target-" + randomUUID(),
    role: "TARGET",
    pseudonym: "独立研究参与者",
  };
  await db.participant.create({
    data: {
      ...researcher,
      account: {
        create: {
          username: "research_" + randomUUID().slice(0, 12),
          passwordHash: "synthetic-test",
        },
      },
    },
  });
  // An old, unrelated fixture proves purge selection is based on ownership,
  // even though current game gateways now reject research participant accounts.
  await db.playPersona.create({
    data: { ownerId: researcher.id, ...persona, savedAt: new Date() },
  });
  const legacy = await db.playRoom.create({
    data: {
      ownerId: researcher.id,
      mode: "HUMAN",
      status: "CANCELLED",
      personaSnapshot: { ...persona },
      expiresAt: new Date(Date.now() + 60_000),
      messages: {
        create: {
          speaker: "FRIEND",
          sequence: 1,
          idempotencyKey: randomUUID(),
          text: "不属于游戏前缀的记录",
        },
      },
    },
  });
  const retained = { guest: { roomId: legacy.id } };
  const before = await db.playRoom.findUniqueOrThrow({
    where: { id: retained.guest.roomId },
    include: { messages: true },
  });
  await rejectsCode(api.deletePlayAccount(researcher), "FORBIDDEN");
  const preview = await api.purgePlayData();
  assert.equal(preview.dryRun, true);
  assert.ok(
    preview.participants > 0 &&
      preview.personas > 0 &&
      preview.rooms > 0 &&
      preview.messages > 0,
  );
  const gameCount = await db.participant.count({
    where: { id: { startsWith: "play-target-" }, role: "TARGET" },
  });
  assert.equal(gameCount, preview.participants);
  const cli = (args: string[]) =>
    execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/purge-play-data.ts", ...args],
      { env: process.env, encoding: "utf8", stdio: "pipe" },
    );
  const dryRun = cli([]);
  assert.match(dryRun, /Dry run/);
  assert.match(dryRun, /"dryRun": true/);
  assert(!dryRun.includes(researcher.id) && !dryRun.includes(persona.bio));
  assert.throws(() => cli(["--confirm-purg"]));
  assert.equal(
    await db.participant.count({
      where: { id: { startsWith: "play-target-" }, role: "TARGET" },
    }),
    gameCount,
  );
  const erased = cli(["--confirm-purge"]);
  assert.match(erased, /"dryRun": false/);
  assert.equal(
    await db.participant.count({
      where: { id: { startsWith: "play-target-" }, role: "TARGET" },
    }),
    0,
  );
  assert.equal(
    await db.playPersona.count({
      where: { ownerId: { startsWith: "play-target-" } },
    }),
    0,
  );
  assert.equal(
    await db.playRoom.count({
      where: { ownerId: { startsWith: "play-target-" } },
    }),
    0,
  );
  assert.equal(
    await db.account.count({
      where: { participantId: { startsWith: "play-target-" } },
    }),
    0,
  );
  assert.equal(
    await db.authSession.count({
      where: { participantId: { startsWith: "play-target-" } },
    }),
    0,
  );
  assert.equal(
    await db.auditEvent.count({
      where: {
        OR: [
          { actorId: { startsWith: "play-target-" } },
          {
            entityType: "Participant",
            entityId: { startsWith: "play-target-" },
          },
        ],
      },
    }),
    0,
  );
  assert.deepEqual(
    await db.playRoom.findUniqueOrThrow({
      where: { id: retained.guest.roomId },
      include: { messages: true },
    }),
    before,
  );
  assert.deepEqual(await api.purgePlayData(true), {
    dryRun: false,
    participants: 0,
    personas: 0,
    rooms: 0,
    messages: 0,
    accounts: 0,
    sessions: 0,
    auditEvents: 0,
  });
});
