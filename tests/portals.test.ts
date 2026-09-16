import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Actor } from "../src/server/auth";

const localPassword = existsSync(".local/database-password")
  ? readFileSync(".local/database-password", "utf8").trim()
  : "";
const baseUrl =
  process.env.DATABASE_URL ??
  `postgresql://study_local:${encodeURIComponent(localPassword)}@127.0.0.1:55432/clone_study`;
const schema = "portal_test_" + process.pid;
const admin = new PrismaClient({ datasourceUrl: baseUrl });
let db: PrismaClient;
let api: typeof import("../src/server/portals");
let researcher: Actor;
const secret = "a-long-local-password-2026";
const registration = (token: string, extra: Record<string, unknown> = {}) => ({
  token,
  username: "member_" + randomUUID().replaceAll("-", "").slice(0, 16),
  password: secret,
  pseudonym: "测试参与者",
  consent: { participation: true, version: "enrollment-v1" },
  ...extra,
});
const rejectsCode = (p: Promise<unknown>, code: string) =>
  assert.rejects(
    p,
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === code,
  );
async function enrollTarget() {
  const invitation = await api.createInvitation(researcher, { kind: "TARGET" });
  return api.registerFromInvitation(registration(invitation.token));
}
async function enrollPair() {
  const target = await enrollTarget();
  const invitation = await api.createInvitation(target, { kind: "FRIEND" });
  const friend = await api.registerFromInvitation(
    registration(invitation.token),
  );
  const room = (await api.listRooms(target)).rooms[0];
  return { target, friend, room };
}
before(async () => {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString();
  process.env.PORTAL_BOOTSTRAP_ENABLED = "true";
  process.env.APP_HOST = "127.0.0.1";
  process.env.APP_ORIGIN = "http://127.0.0.1:3000";
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
  api = await import("../src/server/portals");
  await db.participant.create({
    data: {
      id: "demo-researcher",
      role: "RESEARCHER",
      pseudonym: "合成研究员",
    },
  });
});
after(async () => {
  await db?.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$disconnect();
});

test("Bootstrap requires explicit local authorization and concurrent attempts create one researcher", async () => {
  const payload = {
    username: "principal",
    password: secret,
    pseudonym: "研究员",
  };
  await rejectsCode(
    api.initializeResearchAccount(payload, { localBootstrap: false }),
    "REQUEST_REJECTED",
  );
  process.env.APP_HOST = "0.0.0.0";
  await rejectsCode(
    api.initializeResearchAccount(payload, { localBootstrap: true }),
    "REQUEST_REJECTED",
  );
  process.env.APP_HOST = "127.0.0.1";
  assert.equal((await api.getPortalStatus()).bootstrapAvailable, true);
  const attempts = await Promise.allSettled(
    [1, 2].map((n) =>
      api.initializeResearchAccount(
        { ...payload, username: "principal" + n },
        { localBootstrap: true },
      ),
    ),
  );
  const success = attempts.filter(
    (r): r is PromiseFulfilledResult<Actor> => r.status === "fulfilled",
  );
  assert.equal(success.length, 1);
  assert.equal(await db.account.count(), 1);
  researcher = success[0].value;
  assert.equal(researcher.role, "RESEARCHER");
  assert(!researcher.id.startsWith("demo-"));
  assert.equal((await api.getPortalStatus()).bootstrapAvailable, false);
  await rejectsCode(
    api.createInvitation(
      { id: "demo-researcher", role: "RESEARCHER", pseudonym: "合成研究员" },
      { kind: "TARGET" },
    ),
    "FORBIDDEN",
  );
  assert(
    !JSON.stringify(await api.getPortalHome(researcher)).includes(
      "demo-researcher",
    ),
  );
});

test("Credentials are normalized, salted, never exposed, and bound to the correct portal", async () => {
  const invitation = await api.createInvitation(researcher, { kind: "TARGET" });
  const payload = registration(invitation.token, { username: "Case.Name" });
  const actor = await api.registerFromInvitation(payload);
  const account = await db.account.findUniqueOrThrow({
    where: { username: "case.name" },
  });
  assert(account.passwordHash.startsWith("scrypt-v1$"));
  assert(!account.passwordHash.includes(secret));
  assert.equal(
    (
      await api.authenticateAccount({
        username: "  CASE.NAME ",
        password: secret,
        portal: "target",
      })
    ).id,
    actor.id,
  );
  for (const values of [
    { username: "case.name", password: "wrong", portal: "target" },
    { username: "missing", password: secret, portal: "target" },
    { username: "case.name", password: secret, portal: "research" },
  ])
    await rejectsCode(api.authenticateAccount(values), "INVALID_CREDENTIALS");
  const another = await api.createInvitation(researcher, { kind: "TARGET" });
  await rejectsCode(
    api.registerFromInvitation(
      registration(another.token, { username: "CASE.NAME" }),
    ),
    "ACCOUNT_UNAVAILABLE",
  );
  assert.equal((await api.inspectInvitation(another.token)).kind, "TARGET");
  assert(
    !JSON.stringify(await api.getPortalHome(actor)).includes("passwordHash"),
  );
});

test("Invitation authority fixes roles; missing consent and wrong portal cannot consume a token", async () => {
  const invite = await api.createInvitation(researcher, { kind: "TARGET" });
  await rejectsCode(
    api.registerFromInvitation(
      registration(invite.token, {
        consent: { participation: false, version: "enrollment-v1" },
      }),
    ),
    "CONSENT_REQUIRED",
  );
  await rejectsCode(
    api.registerFromInvitation(
      registration(invite.token, { portal: "research" }),
    ),
    "INVITATION_UNAVAILABLE",
  );
  const target = await api.registerFromInvitation(
    registration(invite.token, { role: "RESEARCHER" }),
  );
  assert.equal(target.role, "TARGET");
  const consent = await db.consent.findFirstOrThrow({
    where: { participantId: target.id },
  });
  assert.equal(consent.aiProcessing, false);
  assert.equal(consent.corpusUse, false);
  assert.equal(consent.quotation, false);
  await rejectsCode(
    api.createInvitation(target, { kind: "ANALYST" }),
    "FORBIDDEN",
  );
  await rejectsCode(
    api.createInvitation({ ...target, role: "RESEARCHER" }, { kind: "TARGET" }),
    "FORBIDDEN",
  );
  await rejectsCode(
    api.createInvitation(researcher, { kind: "RESEARCHER" }),
    "FORBIDDEN",
  );
  const analystInvite = await api.createInvitation(researcher, {
    kind: "ANALYST",
  });
  const analyst = await api.registerFromInvitation(
    registration(analystInvite.token, { consent: undefined }),
  );
  assert.equal(analyst.role, "ANALYST");
  await rejectsCode(
    api.createInvitation(analyst, { kind: "TARGET" }),
    "FORBIDDEN",
  );
});

test("Opaque invitations expire, revoke and accept once under a race", async () => {
  const expired = await api.createInvitation(researcher, { kind: "TARGET" });
  await db.enrollmentInvitation.update({
    where: { id: expired.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await rejectsCode(
    api.inspectInvitation(expired.token),
    "INVITATION_UNAVAILABLE",
  );
  await rejectsCode(
    api.registerFromInvitation(registration(expired.token)),
    "INVITATION_UNAVAILABLE",
  );
  const revoked = await api.createInvitation(researcher, { kind: "TARGET" });
  await api.revokeInvitation(researcher, { id: revoked.id });
  await rejectsCode(
    api.registerFromInvitation(registration(revoked.token)),
    "INVITATION_UNAVAILABLE",
  );
  const once = await api.createInvitation(researcher, { kind: "TARGET" });
  assert(once.path.startsWith("/target/join#token="));
  const outcomes = await Promise.allSettled(
    [1, 2].map(() => api.registerFromInvitation(registration(once.token))),
  );
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  await rejectsCode(
    api.inspectInvitation(once.token),
    "INVITATION_UNAVAILABLE",
  );
  const stored = await db.enrollmentInvitation.findUniqueOrThrow({
    where: { id: once.id },
  });
  assert.notEqual(stored.tokenHash, once.token);
});

test("Friend quota counts accepted plus pending invites atomically and cannot redirect target ownership", async () => {
  const target = await enrollTarget(),
    other = await enrollTarget();
  await rejectsCode(
    api.createInvitation(target, { kind: "FRIEND", targetId: other.id }),
    "FORBIDDEN",
  );
  const attempts = await Promise.allSettled(
    Array.from({ length: 7 }, () =>
      api.createInvitation(target, { kind: "FRIEND" }),
    ),
  );
  const accepted = attempts.filter(
    (
      x,
    ): x is PromiseFulfilledResult<
      Awaited<ReturnType<typeof api.createInvitation>>
    > => x.status === "fulfilled",
  );
  assert.equal(accepted.length, 3);
  const friend = await api.registerFromInvitation(
    registration(accepted[0].value.token),
  );
  await rejectsCode(
    api.createInvitation(target, { kind: "FRIEND" }),
    "FRIEND_LIMIT_REACHED",
  );
  await rejectsCode(
    api.revokeInvitation(other, { id: accepted[1].value.id }),
    "NOT_FOUND",
  );
  await api.revokeInvitation(target, { id: accepted[1].value.id });
  await api.createInvitation(target, { kind: "FRIEND" });
  const rooms = (await api.listRooms(friend)).rooms;
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].peer.id, target.id);
  assert.equal(await db.session.count(), 0);
  assert.equal(await db.dyad.count(), 0);
});

test("Room membership excludes staff and other pairs; sends are ordered and idempotent", async () => {
  const { target, friend, room } = await enrollPair();
  const outsider = await enrollTarget();
  await rejectsCode(api.getRoom(outsider, room.id), "NOT_FOUND");
  await rejectsCode(api.getRoom(researcher, room.id), "FORBIDDEN");
  const payload = {
    roomId: room.id,
    text: "准备聊天的一条消息",
    idempotencyKey: randomUUID(),
  };
  const sent = await Promise.all(
    Array.from({ length: 5 }, () => api.sendRoomMessage(target, payload)),
  );
  assert.equal(new Set(sent.map((m) => m.messageId)).size, 1);
  assert.equal(sent.filter((m) => !m.duplicate).length, 1);
  await rejectsCode(
    api.sendRoomMessage(target, { ...payload, text: "不同正文" }),
    "IDEMPOTENCY_CONFLICT",
  );
  await Promise.all(
    Array.from({ length: 5 }, (_, n) =>
      api.sendRoomMessage(friend, {
        roomId: room.id,
        text: "好友 " + n,
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  const dto = await api.getRoom(friend, room.id);
  assert.deepEqual(
    dto.messages.map((m) => m.sequence),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(dto.messages[0].mine, false);
  assert.equal(dto.messages[1].mine, true);
  const overview = JSON.stringify(await api.getPortalHome(researcher));
  assert(!overview.includes(payload.text));
  assert(
    !JSON.stringify(await db.auditEvent.findMany()).includes(payload.text),
  );
  assert.equal(await db.generation.count(), 0);
});

test("Either endpoint can stop; only the pauser resumes and end is permanent", async () => {
  const { target, friend, room } = await enrollPair();
  await api.controlRoom(friend, { roomId: room.id, action: "pause" });
  await api.controlRoom(target, { roomId: room.id, action: "pause" });
  await rejectsCode(
    api.controlRoom(target, { roomId: room.id, action: "resume" }),
    "ONLY_PAUSER_CAN_RESUME",
  );
  for (const actor of [target, friend])
    await rejectsCode(
      api.sendRoomMessage(actor, {
        roomId: room.id,
        text: "暂停后的消息",
        idempotencyKey: randomUUID(),
      }),
      "ROOM_NOT_ACTIVE",
    );
  await api.controlRoom(friend, { roomId: room.id, action: "resume" });
  await api.controlRoom(target, { roomId: room.id, action: "end" });
  assert.equal((await api.getRoom(friend, room.id)).canSend, false);
  await rejectsCode(
    api.controlRoom(friend, { roomId: room.id, action: "resume" }),
    "ROOM_NOT_ACTIVE",
  );
});

test("Consent revocation prevents both endpoints reading/sending and disables outstanding invitations", async () => {
  const { target, friend, room } = await enrollPair();
  const outstanding = await api.createInvitation(target, { kind: "FRIEND" });
  await api.sendRoomMessage(friend, {
    roomId: room.id,
    text: "同意撤回前",
    idempotencyKey: randomUUID(),
  });
  await api.savePortalConsent(target, { participation: false });
  assert.equal((await api.getRoom(friend, room.id)).messages.length, 0);
  await rejectsCode(
    api.sendRoomMessage(friend, {
      roomId: room.id,
      text: "不可发送",
      idempotencyKey: randomUUID(),
    }),
    "CONSENT_REQUIRED",
  );
  await rejectsCode(
    api.inspectInvitation(outstanding.token),
    "INVITATION_UNAVAILABLE",
  );
  await api.savePortalConsent(target, { participation: true });
  assert.equal((await api.getRoom(friend, room.id)).canSend, false);
  await rejectsCode(
    api.controlRoom(target, { roomId: room.id, action: "resume" }),
    "ROOM_NOT_ACTIVE",
  );
});

test("Withdrawal destroys paired content with a durable restoration tombstone", async () => {
  const { target, friend, room } = await enrollPair();
  await api.sendRoomMessage(target, {
    roomId: room.id,
    text: "自己的正文",
    idempotencyKey: randomUUID(),
  });
  const response = await api.sendRoomMessage(friend, {
    roomId: room.id,
    text: "好友的正文",
    idempotencyKey: randomUUID(),
  });
  const result = await api.withdrawPortal(target, { destroyContent: true });
  assert.equal(result.destroyedMessages, 2);
  assert.equal(
    await db.preparationMessage.count({
      where: { roomId: room.id, text: { not: null } },
    }),
    0,
  );
  await db.preparationMessage.update({
    where: { id: response.messageId },
    data: { text: "旧备份恢复正文", destroyedAt: null },
  });
  assert.equal(
    (
      await db.preparationMessage.findUniqueOrThrow({
        where: { id: response.messageId },
      })
    ).text,
    null,
  );
  assert.equal((await api.getRoom(friend, room.id)).room.status, "WITHDRAWN");
  assert.equal(
    await db.deletionTombstone.count({
      where: { requestId: result.requestId },
    }),
    2,
  );
});

test("Profile edits only touch current account and validate pseudonym/timezone", async () => {
  const target = await enrollTarget();
  const result = await api.updateProfile(target, {
    pseudonym: "新化名",
    timezone: "Asia/Shanghai",
    id: researcher.id,
    role: "RESEARCHER",
  });
  assert.equal(result.actor.role, "TARGET");
  assert.equal(result.actor.id, target.id);
  assert.equal(result.actor.pseudonym, "新化名");
  await rejectsCode(
    api.updateProfile(target, { pseudonym: "", timezone: "Asia/Shanghai" }),
    "INVALID_INPUT",
  );
  await rejectsCode(
    api.updateProfile(target, {
      pseudonym: "正常化名",
      timezone: "Not/A_Timezone",
    }),
    "INVALID_INPUT",
  );
});

test("Synthetic overview, audit, withdrawal and restore queries exclude real portal identities and metadata", async () => {
  const engine = await import("../src/server/engine");
  const demoResearcher: Actor = {
    id: "demo-researcher",
    role: "RESEARCHER",
    pseudonym: "合成研究员",
  };
  const realTarget = await enrollTarget();
  await db.study.create({
    data: {
      id: "synthetic-study",
      name: "合成研究",
      seed: "test",
      algorithmVersion: "test",
      assignmentHash: "test",
      balance: {},
      config: {},
    },
  });
  await db.participant.createMany({
    data: [
      { id: "demo-target-isolation", role: "TARGET", pseudonym: "合成Target" },
      { id: "demo-friend-isolation", role: "FRIEND", pseudonym: "合成Friend" },
    ],
  });
  await db.corpusItem.createMany({
    data: [
      {
        targetId: "demo-target-isolation",
        partition: "BUILD",
        text: "合成语料",
        contentHash: "demo-hash",
        riskCodes: [],
        reviewStatus: "APPROVED",
      },
      {
        targetId: realTarget.id,
        partition: "BUILD",
        text: "real-private-corpus",
        contentHash: "real-hash",
        riskCodes: [],
        reviewStatus: "APPROVED",
      },
    ],
  });
  const legacyRealWithdrawal = await db.withdrawalRequest.create({
    data: {
      participantId: realTarget.id,
      mode: "ANALYSIS_EXCLUSION",
      scope: "ALL",
      affectedCounts: { note: "real-private-metadata" },
    },
  });
  const demoWithdrawal = await db.withdrawalRequest.create({
    data: {
      participantId: "demo-target-isolation",
      mode: "ANALYSIS_EXCLUSION",
      scope: "ALL",
      affectedCounts: {},
    },
  });
  await db.auditEvent.create({
    data: {
      actorId: researcher.id,
      action: "SYNTHETIC_REVIEW",
      entityType: "Study",
      entityId: "synthetic-study",
      metadata: {},
    },
  });
  for (const staff of [researcher, demoResearcher]) {
    const dashboard = await engine.getDashboard(staff);
    assert.equal(dashboard.stats.targets, 1);
    assert.equal(dashboard.stats.friends, 1);
    assert(!JSON.stringify(dashboard.activity).includes("PORTAL_"));
    const onboarding = await engine.getOnboarding(staff);
    assert.equal(onboarding.summary?.targets, 1);
    assert.equal(onboarding.counts.BUILD, 1);
    const audit = JSON.stringify(await engine.getAudit(staff));
    assert(!audit.includes("PORTAL_"));
    assert(!audit.includes(realTarget.id));
    assert(!audit.includes(researcher.id));
    const withdrawals = await engine.getWithdrawals(staff);
    assert(withdrawals.requests.some((x) => x.id === demoWithdrawal.id));
    assert(!withdrawals.requests.some((x) => x.id === legacyRealWithdrawal.id));
    assert(!JSON.stringify(withdrawals).includes("real-private-metadata"));
  }
  await rejectsCode(engine.getConsent(realTarget), "FORBIDDEN");
  await rejectsCode(engine.getOnboarding(realTarget), "FORBIDDEN");
  const manifest = await db.exportManifest.create({
    data: {
      actorId: "demo-researcher",
      datasetNames: [],
      participantIds: [],
      checksums: {},
    },
  });
  assert.equal((await engine.reapplyDeletionTombstones()).tombstones, 0);
  assert.equal(
    (await db.exportManifest.findUniqueOrThrow({ where: { id: manifest.id } }))
      .status,
    "VALID",
  );
});
