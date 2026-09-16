import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Actor } from "../src/domain/types";

const password = existsSync(".local/database-password")
  ? readFileSync(".local/database-password", "utf8").trim()
  : "";
const baseUrl =
  process.env.DATABASE_URL ??
  `postgresql://study_local:${encodeURIComponent(password)}@127.0.0.1:55432/clone_study`;
const schema = "evaluation_test_" + process.pid;
const admin = new PrismaClient({ datasourceUrl: baseUrl });
let db: PrismaClient;
let evaluation: typeof import("../src/server/evaluation");
const participant = (role: Actor["role"], n = 1): Actor => ({
  id:
    role === "RESEARCHER"
      ? "demo-researcher"
      : role === "ANALYST"
        ? "demo-analyst"
        : `demo-${role.toLowerCase()}-${String(n).padStart(2, "0")}`,
  role,
  pseudonym: "合成测试",
});
const rejectCode = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: any) => error.code === code);
const itemFor = (
  result: Awaited<ReturnType<typeof evaluation.getEvaluations>>,
  stimulusId: string,
  track = "MATCHED",
) =>
  result.items.find(
    (item) => item.stimulusId === stimulusId && item.track === track,
  ) as any;

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
  evaluation = await import("../src/server/evaluation");
});
after(async () => {
  await db?.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$disconnect();
});

async function fixture(targetNumber: number, source: "HUMAN" | "AI" = "AI") {
  const target = participant("TARGET", targetNumber);
  const session = await db.session.findFirstOrThrow({
    where: { dyad: { targetId: target.id }, privateCondition: source },
    include: { dyad: true },
    orderBy: { index: "desc" },
  });
  await db.session.update({
    where: { id: session.id },
    data: { status: "ENDED", startedAt: new Date(), endedAt: new Date() },
  });
  const max = await db.message.aggregate({
    where: { sessionId: session.id },
    _max: { sequence: true },
  });
  const text = "合成片段：如果有半天空闲，我想去公园散步。";
  const message = await db.message.create({
    data: {
      sessionId: session.id,
      sequence: (max._max.sequence ?? 0) + 1,
      publicRole: "SOURCE",
      text,
      epoch: session.epoch,
      deliveredAt: new Date(),
      status: "DELIVERED",
    },
  });
  const stimulus = await db.stimulusExcerpt.create({
    data: {
      sessionId: session.id,
      text,
      context: "朋友：假设空出半天，我们可以聊聊轻松的活动选项。",
      sourceMessageIds: [message.id],
      privateCondition: source,
      contextVersion: "synthetic-fixed-context-v1",
      eligibilityRuleVersion: "synthetic-fixed-rule-v1",
      status: "APPROVED",
    },
  });
  const friend: Actor = {
    id: session.dyad.friendId,
    role: "FRIEND",
    pseudonym: "合成朋友",
  };
  return { target, friend, session, stimulus };
}
async function completeBlock(target: Actor) {
  await db.session.updateMany({
    where: { dyad: { targetId: target.id } },
    data: { status: "ENDED", endedAt: new Date() },
  });
}
async function approvals(
  f: Awaited<ReturnType<typeof fixture>>,
  scope: "MATCHED_CONTEXT" | "ECOLOGICAL_TARGET_REVIEW" = "MATCHED_CONTEXT",
) {
  await evaluation.approveExcerptSharing(f.friend, {
    stimulusId: f.stimulus.id,
    scope,
    approved: true,
  });
  await evaluation.approveExcerptSharing(f.target, {
    stimulusId: f.stimulus.id,
    scope,
    approved: true,
  });
  await evaluation.getEvaluations(f.target);
  await evaluation.getEvaluations(f.friend);
}
let first: Awaited<ReturnType<typeof fixture>>;

test("Target cannot see AI content until every dyad in full block ends and exact Friend approval exists", async () => {
  first = await fixture(1);
  let friendView = itemFor(
    await evaluation.getEvaluations(first.friend),
    first.stimulus.id,
  );
  assert(friendView);
  assert.equal(friendView.sourceDisclosed, false);
  assert(!("source" in friendView));
  assert(!("contextHash" in friendView));
  await evaluation.approveExcerptSharing(first.friend, {
    stimulusId: first.stimulus.id,
    scope: "MATCHED_CONTEXT",
    approved: true,
  });
  assert(
    !itemFor(await evaluation.getEvaluations(first.target), first.stimulus.id),
  );
  await rejectCode(
    evaluation.approveExcerptSharing(first.target, {
      stimulusId: first.stimulus.id,
      scope: "MATCHED_CONTEXT",
      approved: true,
    }),
    "INELIGIBLE",
  );
  await db.session.updateMany({
    where: { dyadId: first.session.dyadId },
    data: { status: "ENDED", endedAt: new Date() },
  });
  assert(
    !itemFor(await evaluation.getEvaluations(first.target), first.stimulus.id),
  );
  await completeBlock(first.target);
  const targetPreview = itemFor(
    await evaluation.getEvaluations(first.target),
    first.stimulus.id,
  );
  assert(targetPreview);
  assert.equal(targetPreview.sourceDisclosed, false);
  await evaluation.approveExcerptSharing(first.target, {
    stimulusId: first.stimulus.id,
    scope: "MATCHED_CONTEXT",
    approved: true,
  });
  const targetView = itemFor(
    await evaluation.getEvaluations(first.target),
    first.stimulus.id,
  );
  friendView = itemFor(
    await evaluation.getEvaluations(first.friend),
    first.stimulus.id,
  );
  assert.equal(targetView.sourceDisclosed, true);
  assert.equal(friendView.sourceDisclosed, true);
  assert.equal(targetView.source, friendView.source);
  assert.equal(targetView.context, friendView.context);
  assert.equal(targetView.excerpt, friendView.excerpt);
  assert.equal(targetView.contextVersion, friendView.contextVersion);
});

test("matched ratings are independent and immutable, no Target predictions leak to Friend", async () => {
  await evaluation.submitMatched(first.target, {
    stimulusId: first.stimulus.id,
    track: "MATCHED",
    likeness: 5,
    predictedFriendRating: 2,
    endorsement: "YES",
  });
  const friendBefore = itemFor(
    await evaluation.getEvaluations(first.friend),
    first.stimulus.id,
  );
  assert.equal(friendBefore.ownRating, null);
  assert(!JSON.stringify(friendBefore).includes("predictedFriendRating"));
  await rejectCode(
    evaluation.submitMatched(first.friend, {
      stimulusId: first.stimulus.id,
      track: "MATCHED",
      likeness: 1,
      predictedFriendRating: 5,
    }),
    "INVALID_INPUT",
  );
  await evaluation.submitMatched(first.friend, {
    stimulusId: first.stimulus.id,
    track: "MATCHED",
    likeness: 1,
  });
  await rejectCode(
    evaluation.submitMatched(first.friend, {
      stimulusId: first.stimulus.id,
      track: "MATCHED",
      likeness: 4,
    }),
    "FROZEN",
  );
  const targetAfter = itemFor(
    await evaluation.getEvaluations(first.target),
    first.stimulus.id,
  );
  assert.equal(targetAfter.ownRating.likeness, 5);
  const rows = await db.matchedRating.findMany({
    where: { stimulusId: first.stimulus.id, track: "MATCHED" },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].contextHash, rows[1].contextHash);
  assert(rows.every((r) => r.sourceDisclosed));
  await assert.rejects(
    db.stimulusExcerpt.update({
      where: { id: first.stimulus.id },
      data: { context: "试图在提交后替换上下文" },
    }),
  );
});

test("per-excerpt scope and global consent revocation immediately remove access and block pending submissions", async () => {
  const f = await fixture(3);
  await completeBlock(f.target);
  await approvals(f);
  await evaluation.approveExcerptSharing(f.friend, {
    stimulusId: f.stimulus.id,
    scope: "MATCHED_CONTEXT",
    approved: false,
  });
  assert(!itemFor(await evaluation.getEvaluations(f.target), f.stimulus.id));
  await rejectCode(
    evaluation.submitMatched(f.target, {
      stimulusId: f.stimulus.id,
      track: "MATCHED",
      likeness: 4,
    }),
    "INELIGIBLE",
  );
  await evaluation.approveExcerptSharing(f.friend, {
    stimulusId: f.stimulus.id,
    scope: "MATCHED_CONTEXT",
    approved: true,
  });
  await db.consent.create({
    data: {
      participantId: f.friend.id,
      participation: true,
      aiProcessing: true,
      targetReview: false,
    },
  });
  assert(!itemFor(await evaluation.getEvaluations(f.target), f.stimulus.id));
  await rejectCode(
    evaluation.submitMatched(f.friend, {
      stimulusId: f.stimulus.id,
      track: "MATCHED",
      likeness: 4,
    }),
    "INELIGIBLE",
  );
});

test("ecological track collects only Target follow-up and retains original live-blind Friend observation", async () => {
  const f = await fixture(4, "HUMAN");
  await completeBlock(f.target);
  await db.liveSurvey.create({
    data: {
      sessionId: f.session.id,
      participantId: f.friend.id,
      likeness: 3,
      relationalFit: 4,
      answers: { synthetic: true },
    },
  });
  await approvals(f, "ECOLOGICAL_TARGET_REVIEW");
  const friendView = itemFor(
    await evaluation.getEvaluations(f.friend),
    f.stimulus.id,
    "ECOLOGICAL",
  );
  assert.equal(friendView.sourceDisclosed, false);
  assert.equal(friendView.canSubmit, false);
  assert.equal(friendView.liveObservation.likeness, 3);
  assert.equal(friendView.liveObservation.sourceDisclosed, false);
  const targetView = itemFor(
    await evaluation.getEvaluations(f.target),
    f.stimulus.id,
    "ECOLOGICAL",
  );
  assert(!("liveObservation" in targetView));
  assert.equal(targetView.source, "HUMAN");
  await rejectCode(
    evaluation.submitMatched(f.friend, {
      stimulusId: f.stimulus.id,
      track: "ECOLOGICAL",
      likeness: 3,
    }),
    "FORBIDDEN",
  );
  await evaluation.submitMatched(f.target, {
    stimulusId: f.stimulus.id,
    track: "ECOLOGICAL",
    likeness: null,
    endorsement: "UNSURE",
  });
  assert.equal(
    (
      await db.matchedRating.findFirstOrThrow({
        where: { stimulusId: f.stimulus.id },
      })
    ).likeness,
    null,
  );
});

test("cross-dyad, forged role, ambiguous privacy, safety and deleted excerpts are denied", async () => {
  await rejectCode(
    evaluation.approveExcerptSharing(participant("FRIEND", 36), {
      stimulusId: first.stimulus.id,
      scope: "MATCHED_CONTEXT",
      approved: true,
    }),
    "FORBIDDEN",
  );
  await rejectCode(
    evaluation.getEvaluations({ ...first.friend, role: "TARGET" }),
    "FORBIDDEN",
  );
  await rejectCode(
    evaluation.getEvaluations(participant("RESEARCHER")),
    "FORBIDDEN",
  );
  const f = await fixture(5);
  await completeBlock(f.target);
  await db.safetyEvent.create({
    data: {
      sessionId: f.session.id,
      reasonCode: "SYNTHETIC_RISK",
      status: "RESOLVED",
    },
  });
  assert(!itemFor(await evaluation.getEvaluations(f.friend), f.stimulus.id));
  await rejectCode(
    evaluation.approveExcerptSharing(f.friend, {
      stimulusId: f.stimulus.id,
      scope: "MATCHED_CONTEXT",
      approved: true,
    }),
    "INELIGIBLE",
  );
  const g = await fixture(6);
  await completeBlock(g.target);
  await db.stimulusExcerpt.update({
    where: { id: g.stimulus.id },
    data: { context: "synthetic@example.test" },
  });
  assert(!itemFor(await evaluation.getEvaluations(g.friend), g.stimulus.id));
  const h = await fixture(7);
  await completeBlock(h.target);
  await approvals(h);
  await db.stimulusExcerpt.update({
    where: { id: h.stimulus.id },
    data: {
      text: null,
      context: null,
      sourceMessageIds: [],
      status: "DESTROYED",
      destroyedAt: new Date(),
    },
  });
  assert(!itemFor(await evaluation.getEvaluations(h.target), h.stimulus.id));
  await rejectCode(
    evaluation.submitMatched(h.target, {
      stimulusId: h.stimulus.id,
      track: "MATCHED",
      likeness: 5,
    }),
    "INELIGIBLE",
  );
});

test("metadata overview has no excerpts or answers and only staff roles can read it", async () => {
  const overview = await evaluation.getEvaluationOverview(
    participant("RESEARCHER"),
  );
  assert(overview.stats.completedMatchedPairs >= 1);
  assert.equal(overview.policy.textIncluded, false);
  assert.deepEqual(Object.keys(overview).sort(), ["policy", "stats"]);
  assert(!JSON.stringify(overview).includes("合成片段"));
  await evaluation.getEvaluationOverview(participant("ANALYST"));
  await rejectCode(
    evaluation.getEvaluationOverview(participant("FRIEND")),
    "FORBIDDEN",
  );
});
