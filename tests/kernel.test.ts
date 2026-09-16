import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Actor } from "../src/domain/types";
import { nearDuplicate } from "../src/domain/privacy";

const password = existsSync(".local/database-password")
  ? readFileSync(".local/database-password", "utf8").trim()
  : "";
const baseUrl =
  process.env.DATABASE_URL ??
  `postgresql://study_local:${encodeURIComponent(password)}@127.0.0.1:55432/clone_study`;
const schema = "kernel_test_" + process.pid;
const admin = new PrismaClient({ datasourceUrl: baseUrl });
let db: PrismaClient;
let engine: typeof import("../src/server/engine");
const actor = (role: Actor["role"], n = 1): Actor => ({
  id:
    role === "RESEARCHER"
      ? "demo-researcher"
      : role === "ANALYST"
        ? "demo-analyst"
        : `demo-${role.toLowerCase()}-${String(n).padStart(2, "0")}`,
  role,
  pseudonym: "合成测试",
});
const researcher = actor("RESEARCHER");
function rejectsCode(p: Promise<unknown>, code: string) {
  return assert.rejects(p, (e: any) => e.code === code);
}
async function activeSession(friendNumber: number, condition: "HUMAN" | "AI") {
  const s = await db.session.findFirstOrThrow({
    where: {
      dyad: { friendId: actor("FRIEND", friendNumber).id },
      privateCondition: condition,
      destroyedAt: null,
    },
    orderBy: { index: "desc" },
  });
  await db.session.update({ where: { id: s.id }, data: { status: "READY" } });
  await engine.controlSession(researcher, { sessionId: s.id, action: "start" });
  return s.id;
}
before(async () => {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString();
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
  await (await import("../src/server/seed")).seedStudy();
  engine = await import("../src/server/engine");
});
after(async () => {
  await db?.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$disconnect();
});

test("PostgreSQL seed has full frozen 12 × 3 × 6 allocation and database constraints", async () => {
  assert.equal(await db.session.count(), 216);
  assert.equal(await db.dyad.count(), 36);
  assert.equal(await db.participant.count({ where: { role: "TARGET" } }), 12);
  assert.equal(await db.participant.count({ where: { role: "FRIEND" } }), 36);
  const d = await db.dyad.findFirstOrThrow({ include: { sessions: true } });
  assert.equal(d.sessions.filter((s) => s.privateCondition === "AI").length, 3);
  const seedCorpus = await db.corpusItem.findMany({
    where: { source: "SYNTHETIC_FIXTURE" },
  });
  for (const left of seedCorpus)
    for (const right of seedCorpus)
      if (
        left.targetId === right.targetId &&
        left.partition !== right.partition
      )
        assert.equal(
          nearDuplicate(left.text!, right.text!),
          false,
          `Independent seed partitions must not repeat ${left.id} / ${right.id}`,
        );
  await assert.rejects(
    db.session.update({
      where: { id: d.sessions[0].id },
      data: {
        privateCondition:
          d.sessions[0].privateCondition === "AI" ? "HUMAN" : "AI",
      },
    }),
  );
  await assert.rejects(
    db.session.update({ where: { id: d.sessions[0].id }, data: { index: 8 } }),
  );
  await assert.rejects(
    db.study.update({
      where: { id: "synthetic-study" },
      data: { mode: "LIVE" },
    }),
  );
});
test("Synthetic seed upgrade only repairs exact original fixtures and preserves authored data", async () => {
  const { seedStudy, hashText } = await import("../src/server/seed");
  const targetId = actor("TARGET", 2).id;
  const fixture = await db.corpusItem.findFirstOrThrow({
    where: {
      targetId,
      partition: "HOLDOUT",
      source: "SYNTHETIC_FIXTURE",
      text: "试着用一句话描述风经过窗边的感觉。",
    },
  });
  const originalText = "哈哈，这个电影我也觉得还不错（合成练习样本）";
  await db.corpusItem.update({
    where: { id: fixture.id },
    data: { text: originalText, contentHash: hashText(originalText) },
  });
  const authored = await db.corpusItem.create({
    data: {
      targetId,
      partition: "HOLDOUT",
      source: "TARGET_PASTE",
      text: originalText,
      contentHash: hashText(originalText),
      riskCodes: [],
    },
  });
  const calibration = await db.calibrationAnswer.findUniqueOrThrow({
    where: {
      targetId_questionId: { targetId, questionId: "calibration-15" },
    },
  });
  await db.calibrationAnswer.update({
    where: { id: calibration.id },
    data: { questionId: "q15" },
  });
  const authoredCalibration = await db.calibrationAnswer.create({
    data: {
      targetId,
      questionId: "q14",
      answer: "用户自己修改过的合成校准答案",
    },
  });
  const frozenBefore = await db.personaVersion.findMany({
    where: { targetId, status: "FROZEN" },
  });
  await seedStudy();
  assert.equal(
    (await db.corpusItem.findUniqueOrThrow({ where: { id: fixture.id } })).text,
    "试着用一句话描述风经过窗边的感觉。",
  );
  assert.equal(
    (await db.corpusItem.findUniqueOrThrow({ where: { id: authored.id } }))
      .text,
    originalText,
  );
  assert.equal(
    (
      await db.calibrationAnswer.findUniqueOrThrow({
        where: { id: calibration.id },
      })
    ).questionId,
    "calibration-15",
  );
  assert.equal(
    (
      await db.calibrationAnswer.findUniqueOrThrow({
        where: { id: authoredCalibration.id },
      })
    ).questionId,
    "q14",
  );
  assert.deepEqual(
    await db.personaVersion.findMany({ where: { targetId, status: "FROZEN" } }),
    frozenBefore,
  );
  const auditCount = await db.auditEvent.count({
    where: { action: "SYNTHETIC_SEED_FIXTURES_UPGRADED" },
  });
  await seedStudy();
  assert.equal(
    await db.auditEvent.count({
      where: { action: "SYNTHETIC_SEED_FIXTURES_UPGRADED" },
    }),
    auditCount,
  );
});
test("Friend DTO is a strict whitelist; cross-dyad and Target AI content are denied", async () => {
  const friend = actor("FRIEND");
  const list = await engine.getSessions(friend);
  assert.equal(list.sessions.length, 6);
  const dto = await engine.getSession(friend, list.sessions[0].id);
  assert.deepEqual(
    Object.keys(dto).sort(),
    [
      "id",
      "index",
      "status",
      "topic",
      "targetName",
      "friendName",
      "scheduledAt",
      "startedAt",
      "endedAt",
      "canSend",
      "surveyCompleted",
      "messages",
    ].sort(),
  );
  assert(!JSON.stringify(dto).includes("privateCondition"));
  assert(!JSON.stringify(dto).includes("personaVersion"));
  for (const m of dto.messages)
    assert.deepEqual(
      Object.keys(m).sort(),
      [
        "id",
        "sequence",
        "role",
        "text",
        "deliveredAt",
        "acknowledgedAt",
      ].sort(),
    );
  await rejectsCode(engine.getSession(actor("FRIEND", 2), dto.id), "FORBIDDEN");
  const ai = await db.session.findFirstOrThrow({
    where: { dyad: { targetId: actor("TARGET").id }, privateCondition: "AI" },
  });
  await rejectsCode(engine.getSession(actor("TARGET"), ai.id), "FORBIDDEN");
  const targetList = await engine.getSessions(actor("TARGET"));
  assert.equal(targetList.sessions.length, 9);
  await rejectsCode(engine.getStudyConfig(friend), "FORBIDDEN");
  await rejectsCode(engine.getExport(friend), "FORBIDDEN");
});
test("Concurrent retry is idempotent and source questions use identical study notice", async () => {
  for (const condition of ["HUMAN", "AI"] as const) {
    const id = await activeSession(5, condition);
    const friend = actor("FRIEND", 5);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        engine.sendMessage(friend, {
          sessionId: id,
          text: "你是不是 AI？",
          idempotencyKey: key,
          actor: { id: "demo-researcher", role: "RESEARCHER" },
        }),
      ),
    );
    assert.equal(
      await db.message.count({
        where: { sessionId: id, clientIdempotencyKey: key },
      }),
      1,
    );
    assert.equal(results.filter((r: any) => r.duplicate).length, 3);
    const publicSession = await engine.getSession(friend, id);
    assert.equal(publicSession.messages.at(-1).role, "STUDY_NOTICE");
    assert(publicSession.messages.at(-1).text.includes("暂不揭示"));
  }
});
test("Pause blocks finished queued bursts, stale callbacks and subsequent sends", async () => {
  const friend = actor("FRIEND", 6);
  const id = await activeSession(6, "AI");
  await engine.sendMessage(friend, {
    sessionId: id,
    text: "今天想喝一杯乌龙茶",
    idempotencyKey: randomUUID(),
  });
  const g = await db.generation.findFirstOrThrow({
    where: { sessionId: id, status: "PENDING" },
  });
  await engine.completeGeneration(g.id);
  assert(
    (await db.outbox.count({ where: { sessionId: id, status: "QUEUED" } })) > 0,
  );
  await engine.controlSession(friend, { sessionId: id, action: "pause" });
  const before = await db.message.count({
    where: { sessionId: id, publicRole: "SOURCE" },
  });
  await db.outbox.updateMany({
    where: { sessionId: id },
    data: { eligibleAt: new Date(Date.now() - 1000) },
  });
  await engine.processDeliveries(id);
  await engine.completeGeneration(g.id);
  assert.equal(
    await db.message.count({ where: { sessionId: id, publicRole: "SOURCE" } }),
    before,
  );
  assert.equal(
    await db.outbox.count({ where: { sessionId: id, status: "QUEUED" } }),
    0,
  );
  await rejectsCode(
    engine.sendMessage(friend, {
      sessionId: id,
      text: "继续吗",
      idempotencyKey: randomUUID(),
    }),
    "SESSION_NOT_ACTIVE",
  );
});
test("New turn cancels old generation and delivered versus acknowledged remain distinct", async () => {
  const friend = actor("FRIEND", 7);
  const id = await activeSession(7, "AI");
  await engine.sendMessage(friend, {
    sessionId: id,
    text: "聊聊今天吧",
    idempotencyKey: randomUUID(),
  });
  const old = await db.generation.findFirstOrThrow({
    where: { sessionId: id, status: "PENDING" },
  });
  await engine.sendMessage(friend, {
    sessionId: id,
    text: "其实想聊一聊茶",
    idempotencyKey: randomUUID(),
  });
  await engine.completeGeneration(old.id);
  assert.equal(await db.outbox.count({ where: { generationId: old.id } }), 0);
  const current = await db.generation.findFirstOrThrow({
    where: { sessionId: id, status: "PENDING" },
  });
  await engine.completeGeneration(current.id);
  await db.outbox.updateMany({
    where: { generationId: current.id },
    data: { eligibleAt: new Date(Date.now() - 1000) },
  });
  await engine.processDeliveries(id);
  const m = await db.message.findFirstOrThrow({
    where: { sessionId: id, publicRole: "SOURCE" },
    orderBy: { sequence: "desc" },
  });
  assert(m.generatedAt);
  assert(m.deliveredAt);
  assert.equal(m.acknowledgedAt, null);
  await engine.ackMessage(friend, { sessionId: id, messageId: m.id });
  assert(
    (await db.message.findUniqueOrThrow({ where: { id: m.id } }))
      .acknowledgedAt,
  );
});
test("Safety pauses both Human and AI before exposing dangerous input", async () => {
  for (const source of ["HUMAN", "AI"] as const) {
    const friend = actor("FRIEND", 8);
    const id = await activeSession(8, source);
    const before = await db.message.count({
      where: { sessionId: id, publicRole: "FRIEND" },
    });
    await engine.sendMessage(friend, {
      sessionId: id,
      text: "我现在想自杀，准备伤害自己",
      idempotencyKey: randomUUID(),
    });
    assert.equal(
      (await db.session.findUniqueOrThrow({ where: { id } })).status,
      "PAUSED_SAFETY",
    );
    assert.equal(
      await db.message.count({
        where: { sessionId: id, publicRole: "FRIEND" },
      }),
      before,
    );
    assert.equal(
      await db.safetyEvent.count({ where: { sessionId: id, status: "OPEN" } }),
      1,
    );
    await rejectsCode(
      engine.sendMessage(friend, {
        sessionId: id,
        text: "普通文字",
        idempotencyKey: randomUUID(),
      }),
      "SESSION_NOT_ACTIVE",
    );
  }
});
test("Corpus approval and build exclude HOLDOUT and enforce near-duplicate partitions", async () => {
  const target = actor("TARGET", 12);
  const hold = "合成独立留出：傍晚喜欢画蓝色的植物。";
  await engine.importCorpus(target, { texts: [hold], partition: "HOLDOUT" });
  await rejectsCode(
    engine.importCorpus(target, { texts: [hold + "！"], partition: "BUILD" }),
    "PARTITION_LEAKAGE",
  );
  await engine.importCorpus(target, {
    texts: ["请联系 synthetic@example.com"],
    partition: "BUILD",
  });
  const risky = await db.corpusItem.findFirstOrThrow({
    where: { targetId: target.id, text: "请联系 synthetic@example.com" },
  });
  await rejectsCode(
    engine.approveCorpus(target, { id: risky.id }),
    "PRIVACY_REVIEW_REQUIRED",
  );
  const build = await engine.buildPersona(target);
  const p = await db.personaVersion.findUniqueOrThrow({
    where: { id: build.persona.id },
  });
  const holdItem = await db.corpusItem.findFirstOrThrow({
    where: { targetId: target.id, text: hold },
  });
  assert(!(p.buildCorpusIds as string[]).includes(holdItem.id));
  await engine.freezePersona(target, { id: p.id });
  await assert.rejects(
    db.personaVersion.update({
      where: { id: p.id },
      data: { style: { tampered: true } },
    }),
  );
});
test("Offline is same-stimulus, no original dyad and dual sharing revocation is immediate", async () => {
  const friend = actor("FRIEND");
  const available = await engine.getOffline(friend);
  assert(available.assignments.length > 0);
  for (const a of available.assignments) {
    assert(!("targetId" in a));
    assert(!("privateCondition" in a));
    assert(!("stimulusId" in a));
    const internal = await db.offlineAssignment.findUniqueOrThrow({
      where: { id: a.id },
      include: {
        stimulus: { include: { session: { include: { dyad: true } } } },
      },
    });
    assert.notEqual(internal.stimulus.session.dyad.friendId, friend.id);
  }
  const a = available.assignments.find(
    (a) => a.familiarityRole === "UNFAMILIAR",
  )!;
  assert(a);
  await rejectsCode(
    engine.submitOffline(friend, {
      assignmentId: a.id,
      guess: "AI",
      confidence: 65,
      naturalness: 4,
      personLikeness: 3,
    }),
    "INVALID_INPUT",
  );
  const internal = await db.offlineAssignment.findUniqueOrThrow({
    where: { id: a.id },
    include: {
      stimulus: { include: { session: { include: { dyad: true } } } },
    },
  });
  const targetId = internal.stimulus.session.dyad.targetId;
  await engine.saveConsent(
    { id: targetId, role: "TARGET", pseudonym: "合成" },
    {
      participation: true,
      aiProcessing: true,
      corpusUse: true,
      secondarySharing: {
        familiarRaters: true,
        unfamiliarRaters: false,
        targetReview: true,
      },
    },
  );
  assert(
    !(await engine.getOffline(friend)).assignments.some((x) => x.id === a.id),
  );
  await rejectsCode(
    engine.submitOffline(friend, {
      assignmentId: a.id,
      guess: "AI",
      confidence: 65,
      naturalness: 4,
    }),
    "INELIGIBLE",
  );
});
test("Analysis exclusion differs from destruction; restored snapshots obey tombstones", async () => {
  const friend = actor("FRIEND", 10);
  const id = await activeSession(10, "HUMAN");
  await engine.sendMessage(friend, {
    sessionId: id,
    text: "合成删除演练正文",
    idempotencyKey: randomUUID(),
  });
  const m = await db.message.findFirstOrThrow({
    where: { sessionId: id, publicRole: "FRIEND" },
  });
  const exported = await engine.getExport(researcher);
  assert.equal(exported.files.length, 6);
  await engine.requestWithdrawal(friend, {
    mode: "ANALYSIS_EXCLUSION",
    scope: "SESSION",
    sessionId: id,
  });
  assert.equal(
    (await db.message.findUniqueOrThrow({ where: { id: m.id } })).text,
    "合成删除演练正文",
  );
  await engine.requestWithdrawal(friend, {
    mode: "CONTENT_DESTRUCTION",
    scope: "SESSION",
    sessionId: id,
  });
  assert.equal(
    (await db.message.findUniqueOrThrow({ where: { id: m.id } })).text,
    null,
  );
  assert.equal(
    (
      await db.exportManifest.findUniqueOrThrow({
        where: { id: exported.manifest.id },
      })
    ).status,
    "INVALIDATED",
  );
  await db.message.update({
    where: { id: m.id },
    data: { text: "模拟旧备份复活正文", destroyedAt: null },
  });
  await engine.reapplyDeletionTombstones();
  assert.equal(
    (await db.message.findUniqueOrThrow({ where: { id: m.id } })).text,
    null,
  );
  const log = JSON.stringify(await db.auditEvent.findMany());
  assert(!log.includes("合成删除演练正文"));
  assert(!log.includes("模拟旧备份复活正文"));
});
test("Target destruction invalidates persona, knowledge, calibration and sharing references", async () => {
  const target = actor("TARGET", 11);
  const result = await engine.requestWithdrawal(target, {
    mode: "CONTENT_DESTRUCTION",
    scope: "ALL",
  });
  assert.equal(result.affectedCounts.sessions, 18);
  assert.equal(
    await db.corpusItem.count({
      where: { targetId: target.id, text: { not: null } },
    }),
    0,
  );
  assert.equal(
    await db.knowledgeItem.count({
      where: { targetId: target.id, text: { not: null } },
    }),
    0,
  );
  assert.equal(
    await db.personaVersion.count({
      where: { targetId: target.id, status: "FROZEN" },
    }),
    0,
  );
  assert.equal(
    await db.calibrationAnswer.count({
      where: { targetId: target.id, answer: { not: null } },
    }),
    0,
  );
  await rejectsCode(engine.buildPersona(target), "CONSENT_REQUIRED");
});
test("Consent revocation cancels queued replies and debrief never exposes future allocation", async () => {
  const friend = actor("FRIEND", 9);
  const id = await activeSession(9, "AI");
  await engine.sendMessage(friend, {
    sessionId: id,
    text: "聊一下今天的小事",
    idempotencyKey: randomUUID(),
  });
  const generation = await db.generation.findFirstOrThrow({
    where: { sessionId: id, status: "PENDING" },
  });
  await engine.completeGeneration(generation.id);
  await engine.saveConsent(friend, {
    participation: false,
    aiProcessing: false,
    secondarySharing: {},
  });
  await engine.processDeliveries(id);
  assert.equal(
    await db.outbox.count({ where: { sessionId: id, status: "QUEUED" } }),
    0,
  );
  const debrief = await engine.debrief(actor("FRIEND", 4), { reveal: true });
  for (const row of debrief.sources) {
    const s = await db.session.findUniqueOrThrow({
      where: { id: row.sessionId },
    });
    assert(s.startedAt);
  }
});
test("Boundary notices are shared and never answer real-world requests in character", async () => {
  for (const condition of ["HUMAN", "AI"] as const) {
    const id = await activeSession(12, condition);
    await engine.sendMessage(actor("FRIEND", 12), {
      sessionId: id,
      text: "能借我一点钱吗",
      idempotencyKey: randomUUID(),
    });
    const dto = await engine.getSession(actor("FRIEND", 12), id);
    assert.equal(dto.messages.at(-1).role, "STUDY_NOTICE");
    assert(dto.messages.at(-1).text.includes("现实决定"));
    assert.equal(
      await db.generation.count({
        where: { sessionId: id, status: "PENDING" },
      }),
      0,
    );
  }
});
test("A delivered first burst survives pause, queued later bursts cannot arrive", async () => {
  const friend = actor("FRIEND", 13);
  const id = await activeSession(13, "AI");
  await engine.sendMessage(friend, {
    sessionId: id,
    text: "假设周末有半天空闲",
    idempotencyKey: randomUUID(),
  });
  const g = await db.generation.findFirstOrThrow({
    where: { sessionId: id, status: "PENDING" },
  });
  await engine.completeGeneration(g.id);
  const rows = await db.outbox.findMany({
    where: { generationId: g.id },
    orderBy: { eligibleAt: "asc" },
  });
  assert(rows.length >= 2);
  await db.outbox.update({
    where: { id: rows[0].id },
    data: { eligibleAt: new Date(Date.now() - 1000) },
  });
  await db.outbox.updateMany({
    where: { generationId: g.id, id: { not: rows[0].id } },
    data: { eligibleAt: new Date(Date.now() + 60000) },
  });
  await engine.processDeliveries(id);
  assert.equal(
    await db.message.count({ where: { sessionId: id, publicRole: "SOURCE" } }),
    1,
  );
  await engine.controlSession(friend, { sessionId: id, action: "end" });
  await db.outbox.updateMany({
    where: { generationId: g.id },
    data: { eligibleAt: new Date(Date.now() - 1000) },
  });
  await engine.processDeliveries(id);
  assert.equal(
    await db.message.count({ where: { sessionId: id, publicRole: "SOURCE" } }),
    1,
  );
  assert.equal(
    (await db.outbox.findUniqueOrThrow({ where: { id: rows[0].id } })).status,
    "DELIVERED",
  );
});
test("Persisted generation jobs are recovered by worker without an in-memory callback", async () => {
  const id = await activeSession(14, "AI");
  const s = await db.session.findUniqueOrThrow({ where: { id } });
  const turnId = randomUUID();
  await db.session.update({ where: { id }, data: { currentTurnId: turnId } });
  const g = await db.generation.create({
    data: {
      sessionId: id,
      epoch: s.epoch,
      turnId,
      sourceVersion: s.personaVersionId!,
      triggeredAt: new Date(Date.now() - 10000),
    },
  });
  await engine.processDeliveries(id);
  assert.equal(
    (await db.generation.findUniqueOrThrow({ where: { id: g.id } })).status,
    "COMPLETED",
  );
});
test("Debrief persists opt-in reveal while temporal IOS windows enforce skipping correctly", async () => {
  const friend = actor("FRIEND", 15);
  const d = await db.dyad.findFirstOrThrow({ where: { friendId: friend.id } });
  await rejectsCode(
    engine.saveRelationship(friend, {
      dyadId: d.id,
      timepoint: "PRE_DEBRIEF",
      ios: 5,
    }),
    "TIMEPOINT_CLOSED",
  );
  await rejectsCode(
    engine.saveRelationship(friend, {
      dyadId: d.id,
      timepoint: "POST_DEBRIEF",
      ios: 5,
    }),
    "TIMEPOINT_CLOSED",
  );
  const id = await activeSession(15, "HUMAN");
  const result = await engine.debrief(friend, { sessionId: id, reveal: true });
  assert.equal(result.sources.length, 1);
  assert.equal((await engine.getSession(friend, id)).revealedSource, "HUMAN");
  await engine.saveRelationship(friend, {
    dyadId: d.id,
    timepoint: "POST_DEBRIEF",
    ios: null,
  });
  assert.equal(
    (
      await db.relationshipTimepoint.findFirstOrThrow({
        where: { dyadId: d.id, timepoint: "POST_DEBRIEF" },
      })
    ).ios,
    null,
  );
});
test("Calibration saves validated BUILD data and builder records calibration provenance", async () => {
  const development = await import("../src/server/onboarding");
  const target = actor("TARGET", 3);
  await db.calibrationAnswer.deleteMany({
    where: { targetId: target.id, questionId: "calibration-01" },
  });
  await rejectsCode(
    development.saveCalibration(target, {
      questionId: "calibration-01",
      answer: "邮箱 synthetic@example.com",
    }),
    "INVALID_INPUT",
  );
  await development.saveCalibration(target, {
    questionId: "calibration-01",
    answer: "合成校准：喜欢用简短语气词，自然说你好呀。",
  });
  await rejectsCode(
    development.saveCalibration(target, {
      questionId: "calibration-01",
      answer: "试着覆盖已经提交的回答",
    }),
    "LOCKED",
  );
  const answer = await db.calibrationAnswer.findUniqueOrThrow({
    where: {
      targetId_questionId: {
        targetId: target.id,
        questionId: "calibration-01",
      },
    },
  });
  assert.equal(answer.partition, "BUILD");
  const built = await engine.buildPersona(target);
  const p = await db.personaVersion.findUniqueOrThrow({
    where: { id: built.persona.id },
  });
  assert.equal((p.style as any).calibrationCount, 15);
  assert(
    await db.dataLineage.findFirst({
      where: {
        parentType: "CalibrationAnswer",
        parentId: answer.id,
        childType: "PersonaVersion",
        childId: p.id,
      },
    }),
  );
  assert(
    !JSON.stringify(await db.auditEvent.findMany()).includes("自然说你好呀"),
  );
  await rejectsCode(
    development.saveCalibration(actor("FRIEND"), {
      questionId: "calibration-02",
      answer: "合成内容",
    }),
    "FORBIDDEN",
  );
});
test("Practice timing binds actor, rejects spoofed duration and never persists input content", async () => {
  const development = await import("../src/server/onboarding");
  const target = actor("TARGET", 4);
  const practice = await development.beginPractice(target);
  await rejectsCode(
    development.finishPractice(actor("TARGET", 5), {
      token: practice.token,
      firstInputToSendMs: 0,
      device: "COMPUTER",
    }),
    "INVALID_INPUT",
  );
  await rejectsCode(
    development.finishPractice(target, {
      token: practice.token,
      firstInputToSendMs: 999999,
      device: "COMPUTER",
    }),
    "INVALID_INPUT",
  );
  const result = await development.finishPractice(target, {
    token: practice.token,
    firstInputToSendMs: 0,
    device: "COMPUTER",
    text: "练习秘密正文应当被忽略",
  });
  assert.equal(result.support, "LOW_SUPPORT");
  assert(result.responseMs >= 0);
  await rejectsCode(
    development.finishPractice(target, {
      token: practice.token,
      firstInputToSendMs: 0,
      device: "COMPUTER",
    }),
    "INVALID_INPUT",
  );
  assert(
    !JSON.stringify(await db.baselineSample.findMany()).includes(
      "练习秘密正文",
    ),
  );
  assert(
    !JSON.stringify(await db.auditEvent.findMany()).includes("练习秘密正文"),
  );
  assert.equal(
    (await engine.getOnboarding(target)).baseline.status,
    "LOW_SUPPORT",
  );
});
test("DEV preview rejects HOLDOUT, caps practice count, and cannot preview frozen versions", async () => {
  const development = await import("../src/server/onboarding");
  const target = actor("TARGET", 5);
  const built = await engine.buildPersona(target);
  const hold = await db.corpusItem.findFirstOrThrow({
    where: { targetId: target.id, partition: "HOLDOUT" },
  });
  await rejectsCode(
    development.previewPersona(target, {
      personaId: built.persona.id,
      prompt: hold.text,
    }),
    "PARTITION_LEAKAGE",
  );
  const result = await development.previewPersona(target, {
    personaId: built.persona.id,
    prompt: "合成开发提问：假设周末有空，你想做什么？",
  });
  assert.equal(result.previewCount, 1);
  assert(result.bursts.length > 0);
  assert(
    await db.corpusItem.findFirst({
      where: {
        targetId: target.id,
        partition: "DEV",
        text: "合成开发提问：假设周末有空，你想做什么？",
      },
    }),
  );
  await db.personaVersion.update({
    where: { id: built.persona.id },
    data: { previewCount: 10 },
  });
  await rejectsCode(
    development.previewPersona(target, {
      personaId: built.persona.id,
      prompt: "合成开发提问：聊聊电影",
    }),
    "LOCKED",
  );
  await engine.freezePersona(target, { id: built.persona.id });
  await rejectsCode(
    development.previewPersona(target, {
      personaId: built.persona.id,
      prompt: "合成开发提问：聊聊电影",
    }),
    "PERSONA_REQUIRED",
  );
});
