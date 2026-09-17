import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma, PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Actor } from "../src/server/auth";
import type { PlayIdentity, PlayRoomDto } from "../src/domain/play";
import type {
  PlayAllocationPolicy,
  PlayAllocationState,
} from "../src/server/play-allocation";

// Fixtures and migrations stay in a disposable schema; no production model is used.
const password = existsSync(".local/database-password")
  ? readFileSync(".local/database-password", "utf8").trim()
  : "";
const baseUrl =
  process.env.DATABASE_URL ??
  `postgresql://study_local:${encodeURIComponent(password)}@127.0.0.1:55432/clone_study`;
const schema = "play_allocation_test_" + process.pid;
const admin = new PrismaClient({ datasourceUrl: baseUrl });
let db: PrismaClient;
let api: typeof import("../src/server/play");
const originalFetch = globalThis.fetch;
const persona = {
  displayName: "小林",
  bio: "喜欢周末爬山",
  style: "简短、口语，不用敬语",
  memories: "上次一起去海边吃了面",
  examplesText: "朋友：今天吃啥\n我：随便整点面吧",
};
type Guest = { roomId: string; tokenHash: string };
type Game = { actor: Actor; guest: Guest; mode: PlayIdentity };
const asJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value));
const rejectsCode = (promise: Promise<unknown>, code: string) =>
  assert.rejects(
    promise,
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === code,
  );

async function host() {
  const actor: Actor = {
    id: "play-target-" + randomUUID(),
    role: "TARGET",
    pseudonym: "分配测试主人",
  };
  await db.participant.create({
    data: {
      ...actor,
      account: {
        create: {
          username: "allocation_" + randomUUID().slice(0, 20),
          passwordHash: "test-fixture-not-a-login",
        },
      },
    },
  });
  await api.savePlayPersona(actor, persona);
  await api.heartbeatPlayHost(actor, true);
  return actor;
}

function plan(first: PlayIdentity): PlayAllocationState {
  return {
    version: "five-game-mix-v1",
    blockId: randomUUID().replaceAll("-", ""),
    order:
      first === "HUMAN"
        ? ["HUMAN", "AI", "AI", "AI", "AI"]
        : ["AI", "HUMAN", "AI", "AI", "AI"],
    nextIndex: 0,
  };
}

async function setPlan(actor: Actor, state: PlayAllocationState) {
  await db.playPersona.update({
    where: { ownerId: actor.id },
    data: { allocationState: asJson(state) },
  });
}

async function stateFor(actor: Actor) {
  const row = await db.playPersona.findUniqueOrThrow({
    where: { ownerId: actor.id },
  });
  return row.allocationState as unknown as PlayAllocationState;
}

async function policyFor(roomId: string) {
  const row = await db.playRoom.findUniqueOrThrow({ where: { id: roomId } });
  return (
    row.personaSnapshot as unknown as { allocationPolicy: PlayAllocationPolicy }
  ).allocationPolicy;
}

function assertNoAllocation(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert(
      ![
        "allocationState",
        "allocationPolicy",
        "blockId",
        "order",
        "nextIndex",
        "slot",
      ].includes(key),
      `Internal allocation field escaped a DTO: ${key}`,
    );
    assertNoAllocation(child);
  }
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
  assertNoAllocation(room);
}

async function createGame(actor: Actor): Promise<Game> {
  await api.heartbeatPlayHost(actor, true);
  const created = await api.createPlayRoom(actor);
  assertNoAllocation(created);
  const token = new URL(created.url).hash.split("token=")[1];
  assert(token);
  assertNoAllocation(await api.inspectPlayInvitation(token));
  const joined = await api.joinPlayRoom({
    token,
    nickname: "朋友",
    consent: true,
  });
  assertBlind(joined.room);
  return {
    actor,
    guest: {
      roomId: joined.room.id,
      tokenHash: createHash("sha256").update(joined.guestToken).digest("hex"),
    },
    mode: created.room.mode,
  };
}

async function prompt(game: Game, turn: number) {
  return api.sendPlayMessage(game.guest, {
    text: `问题 ${turn}`,
    idempotencyKey: randomUUID(),
  });
}

async function reply(game: Game, turn: number, key = randomUUID()) {
  if (game.mode === "HUMAN")
    await api.replyPlayRoom(game.actor, {
      roomId: game.guest.roomId,
      text: `回答 ${turn}`,
      idempotencyKey: key,
    });
  else await api.runPendingPlayReply(game.guest.roomId);
  return key;
}

async function completeTurns(game: Game, count = 5) {
  for (let turn = 1; turn <= count; turn++) {
    await prompt(game, turn);
    await reply(game, turn);
  }
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
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://model.example/v1/chat/completions");
    return Response.json({
      choices: [
        { message: { content: "嗯，那就一起去呗" }, finish_reason: "stop" },
      ],
    });
  };
});

after(async () => {
  globalThis.fetch = originalFetch;
  await db?.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$disconnect();
});

test("ten real games keep each five-game quota, limit AI streaks, and conceal the plan", async () => {
  const actor = await host();
  const modes: PlayIdentity[] = [];
  const blocks: string[] = [];
  for (let index = 0; index < 10; index++) {
    const game = await createGame(actor);
    const initial = await stateFor(actor);
    const policy = await policyFor(game.guest.roomId);
    assert.equal(initial.nextIndex, index % 5);
    assert.equal(policy.slot, (index % 5) + 1);
    assert.equal(policy.blockId, initial.blockId);
    assert.equal(game.mode, initial.order[index % 5]);
    blocks.push(policy.blockId);
    modes.push(game.mode);
    for (let turn = 1; turn <= 5; turn++) {
      assertBlind((await prompt(game, turn)).room);
      await reply(game, turn);
      assertBlind(await api.getPlayRoom(game.guest));
      const current = await stateFor(actor);
      assert.equal(current.nextIndex, initial.nextIndex + Number(turn === 5));
      assert.equal(
        (
          await db.playRoom.findUniqueOrThrow({
            where: { id: game.guest.roomId },
          })
        ).mode,
        game.mode,
      );
    }
    const revealed = await api.guessPlayRoom(game.guest, {
      guess: game.mode,
      reason: "测试",
    });
    assert.equal(revealed.room.result?.answer, game.mode);
    assertNoAllocation(revealed);
    const home = await api.getPlayHome(actor);
    assertNoAllocation(home);
    assert(!JSON.stringify(home).includes(initial.blockId));
    assert.equal(home.stats.completed, index + 1);
  }
  for (const offset of [0, 5]) {
    const humans = modes
      .slice(offset, offset + 5)
      .filter((mode) => mode === "HUMAN").length;
    assert(humans === 1 || humans === 2);
    assert.equal(new Set(blocks.slice(offset, offset + 5)).size, 1);
  }
  assert.notEqual(blocks[0], blocks[5]);
  let aiStreak = 0;
  for (const mode of modes) {
    aiStreak = mode === "AI" ? aiStreak + 1 : 0;
    assert(
      aiStreak <= 4,
      "A block boundary must not extend an AI streak beyond four games",
    );
  }
});

test("cancelled and erased unfinished games reserve the same identity; persona saves preserve it", async () => {
  const actor = await host();
  const first = await createGame(actor);
  const initial = await stateFor(actor);
  const policy = await policyFor(first.guest.roomId);
  await completeTurns(first, 2);
  await api.cancelPlayRoom(actor, first.guest.roomId);
  assert.deepEqual(await stateFor(actor), initial);
  await api.savePlayPersona(actor, {
    ...persona,
    bio: "喜欢周末爬山，也喜欢散步",
  });
  assert.deepEqual(await stateFor(actor), initial);

  const second = await createGame(actor);
  assert.equal(second.mode, first.mode);
  assert.deepEqual(await policyFor(second.guest.roomId), policy);
  await completeTurns(second, 3);
  await api.deletePlayData(second.guest);
  assert.deepEqual(await stateFor(actor), initial);

  const third = await createGame(actor);
  assert.equal(third.mode, first.mode);
  assert.deepEqual(await policyFor(third.guest.roomId), policy);
  await api.cancelPlayRoom(actor, third.guest.roomId);
});

test("human and AI slots advance atomically on reply five, never on retries or later erasure", async () => {
  const actor = await host();
  await setPlan(actor, plan("HUMAN"));
  for (const expectedMode of ["HUMAN", "AI"] as const) {
    const game = await createGame(actor);
    assert.equal(game.mode, expectedMode);
    const initial = await stateFor(actor);
    for (let turn = 1; turn <= 4; turn++) {
      await prompt(game, turn);
      await reply(game, turn);
      assert.deepEqual(await stateFor(actor), initial);
    }
    await prompt(game, 5);
    assert.deepEqual(await stateFor(actor), initial);
    const key = randomUUID();
    await Promise.all([reply(game, 5, key), reply(game, 5, key)]);
    await reply(game, 5, key);
    const advanced = { ...initial, nextIndex: initial.nextIndex + 1 };
    assert.deepEqual(await stateFor(actor), advanced);
    const stored = await db.playRoom.findUniqueOrThrow({
      where: { id: game.guest.roomId },
    });
    assert.equal(stored.status, "GUESSING");
    assert.equal(stored.turnsCompleted, 5);
    assert.equal(
      await db.playMessage.count({
        where: { roomId: stored.id, speaker: "SOURCE" },
      }),
      5,
    );
    await api.guessPlayRoom(game.guest, { guess: game.mode, reason: "完成" });
    assert.deepEqual(await stateFor(actor), advanced);
    await api.deletePlayData(game.guest);
    await api.deletePlayData(game.guest);
    assert.deepEqual(await stateFor(actor), advanced);
  }
});

test("invalid room policies and allocation state roll back the final source reply", async () => {
  for (const mode of ["HUMAN", "AI"] as const) {
    for (const corruption of ["policy", "state"] as const) {
      const actor = await host();
      await setPlan(actor, plan(mode));
      const game = await createGame(actor);
      assert.equal(game.mode, mode);
      await completeTurns(game, 4);
      await prompt(game, 5);
      if (corruption === "policy") {
        const stored = await db.playRoom.findUniqueOrThrow({
          where: { id: game.guest.roomId },
        });
        const snapshot = stored.personaSnapshot as Prisma.JsonObject;
        await db.playRoom.update({
          where: { id: stored.id },
          data: {
            personaSnapshot: asJson({
              ...snapshot,
              allocationPolicy: {
                ...(snapshot.allocationPolicy as Prisma.JsonObject),
                slot: 2,
              },
            }),
          },
        });
      } else {
        await db.playPersona.update({
          where: { ownerId: actor.id },
          data: {
            allocationState: asJson({
              ...(await stateFor(actor)),
              nextIndex: 6,
            }),
          },
        });
      }
      const beforeReply = await stateFor(actor);
      if (mode === "HUMAN") await rejectsCode(reply(game, 5), "INVALID_STATE");
      else await reply(game, 5);
      const stored = await db.playRoom.findUniqueOrThrow({
        where: { id: game.guest.roomId },
      });
      assert.equal(stored.status, mode === "AI" ? "CANCELLED" : "ACTIVE");
      assert.equal(stored.turnsCompleted, 4);
      assert.equal(stored.nextSequence, 10);
      assert.equal(
        await db.playMessage.count({
          where: { roomId: stored.id, speaker: "SOURCE" },
        }),
        4,
      );
      assert.deepEqual(await stateFor(actor), beforeReply);
    }
  }
});

test("a room predating allocation keeps its identity without consuming a new plan", async () => {
  const actor = await host();
  await setPlan(actor, plan("HUMAN"));
  const legacy = await createGame(actor);
  const stored = await db.playRoom.findUniqueOrThrow({
    where: { id: legacy.guest.roomId },
  });
  const snapshot = { ...(stored.personaSnapshot as Prisma.JsonObject) };
  delete snapshot.allocationPolicy;
  await db.playRoom.update({
    where: { id: stored.id },
    data: { personaSnapshot: asJson(snapshot) },
  });
  const newPlan = plan("AI");
  await setPlan(actor, newPlan);
  await completeTurns(legacy);
  assert.deepEqual(await stateFor(actor), newPlan);
  assert.equal(
    (await db.playRoom.findUniqueOrThrow({ where: { id: stored.id } })).mode,
    "HUMAN",
  );
  await api.guessPlayRoom(legacy.guest, { guess: "HUMAN", reason: "旧局" });
  const next = await createGame(actor);
  assert.equal(next.mode, "AI");
  assert.equal((await policyFor(next.guest.roomId)).slot, 1);
  assert.deepEqual(await stateFor(actor), newPlan);
  await api.cancelPlayRoom(actor, next.guest.roomId);
});

test("four or more old completed AI games force the first new allocation slot to human", async () => {
  const actor = await host();
  await db.playPersona.update({
    where: { ownerId: actor.id },
    data: { allocationState: Prisma.DbNull },
  });
  await db.playRoom.createMany({
    data: Array.from({ length: 5 }, (_, index) => ({
      ownerId: actor.id,
      mode: "AI",
      status: "REVEALED",
      personaSnapshot: asJson(persona),
      turnsCompleted: 5,
      nextSequence: 11,
      guess: "AI",
      createdAt: new Date(Date.now() - (5 - index) * 60_000),
      revealedAt: new Date(Date.now() - (5 - index) * 60_000 + 30_000),
      expiresAt: new Date(Date.now() + 86_400_000),
    })),
  });
  const game = await createGame(actor);
  assert.equal(game.mode, "HUMAN");
  const state = await stateFor(actor);
  assert.equal(state.order[0], "HUMAN");
  assert.equal(state.nextIndex, 0);
  assert.equal((await policyFor(game.guest.roomId)).slot, 1);
  await api.cancelPlayRoom(actor, game.guest.roomId);
});
