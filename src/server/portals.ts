import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import {
  Prisma,
  type Participant,
  type EnrollmentInvitation,
} from "@prisma/client";
import { prisma } from "./db";
import type { Actor, Role } from "./auth";
import { allowedOrigin, GatewayError } from "./http";

export type Portal = "research" | "target" | "friend";
type Payload = Record<string, unknown>;
type Tx = Prisma.TransactionClient;
export const PORTAL_CONSENT_VERSION = "enrollment-v1";
export const FRIEND_LIMIT = 3;
const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const iso = (date: Date | null) => date?.toISOString() ?? null;
function requireValue(
  value: unknown,
  code = "INVALID_INPUT",
  status = 422,
): asserts value {
  if (!value) throw new GatewayError(status, code);
}
const asActor = (p: Participant): Actor => ({
  id: p.id,
  role: p.role as Role,
  pseudonym: p.pseudonym,
});
export const portalForRole = (role: string): Portal =>
  role === "TARGET" ? "target" : role === "FRIEND" ? "friend" : "research";
const ownRooms = (actor: Actor) => ({
  OR: [{ targetId: actor.id }, { friendId: actor.id }],
});

// All enrollment/room/consent mutations share a transaction lock. This small-cohort
// boundary makes quota consumption, stop/withdraw, and message delivery atomic.
async function mutation<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(70624003)::text`;
        return fn(tx);
      },
      { maxWait: 10000, timeout: 15000 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw new GatewayError(409, "ACCOUNT_UNAVAILABLE");
    throw error;
  }
}
async function realActor(tx: Tx, actor: Actor) {
  const p = await tx.participant.findUnique({
    where: { id: actor?.id },
    include: { account: { select: { id: true, username: true } } },
  });
  requireValue(
    p?.active &&
      p.account &&
      p.role === actor.role &&
      !p.id.startsWith("demo-"),
    "FORBIDDEN",
    403,
  );
  return p;
}
async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string,
  metadata: Prisma.InputJsonValue = {},
) {
  await tx.auditEvent.create({
    data: { actorId: actor.id, action, entityType, entityId, metadata },
  });
}
function username(value: unknown) {
  requireValue(typeof value === "string");
  const normalized = value.trim().toLowerCase();
  requireValue(/^[a-z0-9][a-z0-9._-]{2,39}$/.test(normalized));
  return normalized;
}
function password(value: unknown) {
  requireValue(
    typeof value === "string" && value.length >= 12 && value.length <= 128,
  );
  return value;
}
function pseudonym(value: unknown) {
  requireValue(typeof value === "string");
  const result = value.trim();
  requireValue(
    result.length >= 1 &&
      result.length <= 40 &&
      !/[\u0000-\u001f\u007f]/.test(result),
  );
  return result;
}
async function derivePassword(secret: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      secret,
      salt,
      64,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
async function hashPassword(secret: string) {
  const salt = randomBytes(24).toString("hex");
  return `scrypt-v1$${salt}$${(await derivePassword(secret, salt)).toString("hex")}`;
}
async function validPassword(secret: string, encoded?: string) {
  const parts = encoded?.split("$");
  const validEncoding =
    parts?.length === 3 &&
    parts[0] === "scrypt-v1" &&
    /^[a-f0-9]{48}$/.test(parts[1]) &&
    /^[a-f0-9]{128}$/.test(parts[2]);
  const salt = validEncoding ? parts[1] : "0".repeat(48);
  const expected = Buffer.from(
    validEncoding ? parts[2] : "0".repeat(128),
    "hex",
  );
  const actual = await derivePassword(secret, salt);
  return !!validEncoding && timingSafeEqual(actual, expected);
}
const loopback = (host: string) =>
  ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host);
function bootstrapConfigured() {
  return (
    process.env.PORTAL_BOOTSTRAP_ENABLED === "true" &&
    loopback(process.env.APP_HOST ?? "127.0.0.1") &&
    loopback(new URL(allowedOrigin()).hostname)
  );
}
export async function getPortalStatus() {
  return {
    bootstrapAvailable:
      bootstrapConfigured() &&
      (await prisma.account.count({
        where: { participantId: { not: { startsWith: "play-target-" } } },
      })) === 0,
    consentVersion: PORTAL_CONSENT_VERSION,
    modelStatus: "NOT_CONNECTED",
    formalStudyStatus: "NOT_ACTIVATED",
  };
}
export async function initializeResearchAccount(
  payload: Payload,
  context: { localBootstrap: boolean },
) {
  requireValue(
    context.localBootstrap === true && bootstrapConfigured(),
    "REQUEST_REJECTED",
    403,
  );
  const name = username(payload.username),
    alias = pseudonym(payload.pseudonym);
  const passwordHash = await hashPassword(password(payload.password));
  return mutation(async (tx) => {
    requireValue(
      (await tx.account.count({
        where: { participantId: { not: { startsWith: "play-target-" } } },
      })) === 0,
      "BOOTSTRAP_CLOSED",
      409,
    );
    const p = await tx.participant.create({
      data: {
        id: randomUUID(),
        role: "RESEARCHER",
        pseudonym: alias,
        account: { create: { username: name, passwordHash } },
      },
    });
    const actor = asActor(p);
    await audit(
      tx,
      actor,
      "PORTAL_RESEARCHER_INITIALIZED",
      "Participant",
      p.id,
    );
    return actor;
  });
}
/** A game host reuses the account/session layer, without enrolling in a study. */
export async function registerPlayHost(payload: Payload) {
  const name = username(payload.username);
  const alias = pseudonym(payload.pseudonym);
  const passwordHash = await hashPassword(password(payload.password));
  return mutation(async (tx) => {
    const participant = await tx.participant.create({
      data: {
        id: `play-target-${randomUUID()}`,
        role: "TARGET",
        pseudonym: alias,
        account: { create: { username: name, passwordHash } },
      },
    });
    const actor = asActor(participant);
    await audit(
      tx,
      actor,
      "PLAY_HOST_REGISTERED",
      "Participant",
      participant.id,
    );
    return actor;
  });
}

export async function authenticateAccount(payload: Payload) {
  const name =
    typeof payload.username === "string" &&
    /^[a-z0-9][a-z0-9._-]{2,39}$/.test(payload.username.trim().toLowerCase())
      ? payload.username.trim().toLowerCase()
      : "";
  const secret =
    typeof payload.password === "string" && payload.password.length <= 128
      ? payload.password
      : "";
  const a = await prisma.account.findUnique({
    where: { username: name },
    include: { participant: true },
  });
  const verified = await validPassword(secret, a?.passwordHash);
  requireValue(
    verified &&
      a?.participant.active &&
      ["RESEARCHER", "ANALYST", "TARGET", "FRIEND"].includes(
        a.participant.role,
      ) &&
      portalForRole(a.participant.role) === payload.portal,
    "INVALID_CREDENTIALS",
    401,
  );
  return asActor(a.participant);
}
async function latestConsent(tx: Tx, participantId: string) {
  return tx.consent.findFirst({
    where: { participantId },
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
  });
}
async function consentGranted(tx: Tx, participantId: string) {
  const c = await latestConsent(tx, participantId);
  return !!(
    c?.participation &&
    !c.revokedAt &&
    c.version === PORTAL_CONSENT_VERSION
  );
}
async function writeConsent(tx: Tx, actor: Actor, participation: boolean) {
  const previous = await latestConsent(tx, actor.id);
  const recordedAt = new Date(
    Math.max(Date.now(), (previous?.recordedAt.getTime() ?? 0) + 1),
  );
  return tx.consent.create({
    data: {
      participantId: actor.id,
      participation,
      version: PORTAL_CONSENT_VERSION,
      recordedAt,
      revokedAt: participation ? null : recordedAt,
    },
  });
}
function invitationState(i: EnrollmentInvitation) {
  return i.acceptedAt
    ? "ACCEPTED"
    : i.revokedAt
      ? "REVOKED"
      : i.expiresAt <= new Date()
        ? "EXPIRED"
        : "PENDING";
}
function invitationDto(i: EnrollmentInvitation) {
  return {
    id: i.id,
    kind: i.kind,
    status: invitationState(i),
    targetId: i.targetId,
    createdAt: iso(i.createdAt),
    expiresAt: iso(i.expiresAt),
    acceptedAt: iso(i.acceptedAt),
  };
}
function tokenHash(token: unknown) {
  requireValue(
    typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token),
    "INVITATION_UNAVAILABLE",
    404,
  );
  return hash(token);
}
async function availableInvitation(tx: Tx, token: unknown) {
  const i = await tx.enrollmentInvitation.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { createdBy: true, target: true },
  });
  requireValue(
    i &&
      invitationState(i) === "PENDING" &&
      i.createdBy.active &&
      (!i.target || i.target.active),
    "INVITATION_UNAVAILABLE",
    404,
  );
  if (i.target)
    requireValue(
      await consentGranted(tx, i.target.id),
      "INVITATION_UNAVAILABLE",
      404,
    );
  return i;
}
export async function inspectInvitation(token: string) {
  const i = await availableInvitation(prisma, token);
  return {
    kind: i.kind,
    portal: portalForRole(i.kind),
    expiresAt: iso(i.expiresAt),
    inviterPseudonym: i.kind === "FRIEND" ? i.target!.pseudonym : "研究团队",
    consentVersion: PORTAL_CONSENT_VERSION,
  };
}
export async function createInvitation(actor: Actor, payload: Payload) {
  return mutation(async (tx) => {
    await realActor(tx, actor);
    const kind = payload.kind;
    requireValue(
      actor.role === "RESEARCHER"
        ? kind === "TARGET" || kind === "ANALYST"
        : actor.role === "TARGET" && kind === "FRIEND",
      "FORBIDDEN",
      403,
    );
    // A target can invite only into their own pair. Caller supplied target IDs
    // are never accepted as a way to enroll a friend into another cohort.
    requireValue(
      payload.targetId === undefined || payload.targetId === actor.id,
      "FORBIDDEN",
      403,
    );
    if (kind === "FRIEND") {
      requireValue(await consentGranted(tx, actor.id), "CONSENT_REQUIRED", 409);
      const consumed = await tx.enrollmentInvitation.count({
        where: {
          targetId: actor.id,
          OR: [
            { acceptedAt: { not: null } },
            {
              acceptedAt: null,
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
          ],
        },
      });
      requireValue(consumed < FRIEND_LIMIT, "FRIEND_LIMIT_REACHED", 409);
    }
    const token = randomBytes(32).toString("base64url");
    const i = await tx.enrollmentInvitation.create({
      data: {
        tokenHash: hash(token),
        kind: kind as string,
        createdById: actor.id,
        targetId: kind === "FRIEND" ? actor.id : null,
        expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS),
      },
    });
    await audit(
      tx,
      actor,
      "PORTAL_INVITATION_CREATED",
      "EnrollmentInvitation",
      i.id,
      { kind: i.kind },
    );
    return {
      ...invitationDto(i),
      token,
      path: `/${portalForRole(i.kind)}/join#token=${token}`,
    };
  });
}
export async function revokeInvitation(actor: Actor, payload: Payload) {
  return mutation(async (tx) => {
    await realActor(tx, actor);
    requireValue(typeof payload.id === "string");
    const i = await tx.enrollmentInvitation.findUnique({
      where: { id: payload.id },
    });
    requireValue(
      i &&
        i.createdById === actor.id &&
        ["TARGET", "RESEARCHER"].includes(actor.role),
      "NOT_FOUND",
      404,
    );
    requireValue(!i.acceptedAt, "INVITATION_ALREADY_ACCEPTED", 409);
    await tx.enrollmentInvitation.update({
      where: { id: i.id },
      data: { revokedAt: new Date() },
    });
    await audit(
      tx,
      actor,
      "PORTAL_INVITATION_REVOKED",
      "EnrollmentInvitation",
      i.id,
    );
    return { ok: true };
  });
}
export async function registerFromInvitation(payload: Payload) {
  const name = username(payload.username),
    alias = pseudonym(payload.pseudonym);
  tokenHash(payload.token);
  const c = payload.consent as Record<string, unknown> | undefined;
  const passwordHash = await hashPassword(password(payload.password));
  return mutation(async (tx) => {
    const i = await availableInvitation(tx, payload.token);
    requireValue(
      payload.portal === undefined || payload.portal === portalForRole(i.kind),
      "INVITATION_UNAVAILABLE",
      404,
    );
    if (i.kind !== "ANALYST")
      requireValue(
        c?.participation === true && c.version === PORTAL_CONSENT_VERSION,
        "CONSENT_REQUIRED",
        422,
      );
    const p = await tx.participant.create({
      data: {
        id: randomUUID(),
        role: i.kind,
        pseudonym: alias,
        account: { create: { username: name, passwordHash } },
      },
    });
    const actor = asActor(p);
    if (i.kind !== "ANALYST") await writeConsent(tx, actor, true);
    await tx.enrollmentInvitation.update({
      where: { id: i.id },
      data: { acceptedById: p.id, acceptedAt: new Date() },
    });
    if (i.kind === "FRIEND")
      await tx.preparationRoom.create({
        data: { targetId: i.targetId!, friendId: p.id },
      });
    await audit(
      tx,
      actor,
      "PORTAL_INVITATION_ACCEPTED",
      "EnrollmentInvitation",
      i.id,
      {
        kind: i.kind,
        consentVersion:
          i.kind === "ANALYST" ? "NOT_APPLICABLE" : PORTAL_CONSENT_VERSION,
      },
    );
    return actor;
  });
}
const roomRelations = {
  target: { select: { id: true, pseudonym: true, active: true } },
  friend: { select: { id: true, pseudonym: true, active: true } },
};
type RoomWithPeople = Prisma.PreparationRoomGetPayload<{
  include: typeof roomRelations;
}>;
function roomDto(room: RoomWithPeople, actor: Actor) {
  const peer = room.targetId === actor.id ? room.friend : room.target;
  return {
    id: room.id,
    kind: "HUMAN_PREPARATION",
    status: room.status,
    peer: { id: peer.id, pseudonym: peer.pseudonym },
    targetPseudonym: room.target.pseudonym,
    friendPseudonym: room.friend.pseudonym,
    stoppedByMe: room.stoppedById === actor.id,
    createdAt: iso(room.createdAt),
    updatedAt: iso(room.updatedAt),
  };
}
async function participantRoom(tx: Tx, actor: Actor, id: string) {
  await realActor(tx, actor);
  requireValue(
    actor.role === "TARGET" || actor.role === "FRIEND",
    "FORBIDDEN",
    403,
  );
  const room = await tx.preparationRoom.findUnique({
    where: { id },
    include: roomRelations,
  });
  requireValue(
    room && (room.targetId === actor.id || room.friendId === actor.id),
    "NOT_FOUND",
    404,
  );
  return room;
}
async function pairConsents(tx: Tx, room: RoomWithPeople) {
  return (
    room.target.active &&
    room.friend.active &&
    (await consentGranted(tx, room.targetId)) &&
    (await consentGranted(tx, room.friendId))
  );
}
export async function listRooms(actor: Actor) {
  await realActor(prisma, actor);
  requireValue(["TARGET", "FRIEND"].includes(actor.role), "FORBIDDEN", 403);
  const rooms = await prisma.preparationRoom.findMany({
    where: ownRooms(actor),
    include: roomRelations,
    orderBy: { updatedAt: "desc" },
  });
  return { rooms: rooms.map((room) => roomDto(room, actor)) };
}
export async function getRoom(actor: Actor, id: string) {
  // Reads are serialized too: a withdrawal that has committed cannot race a
  // history response assembled using an earlier participation decision.
  return mutation(async (tx) => {
    const room = await participantRoom(tx, actor, id);
    const hasConsent = await pairConsents(tx, room);
    const messages = hasConsent
      ? await tx.preparationMessage.findMany({
          where: { roomId: id },
          orderBy: { sequence: "desc" },
          take: 1000,
        })
      : [];
    messages.reverse();
    return {
      room: roomDto(room, actor),
      canSend: hasConsent && room.status === "ACTIVE",
      consentRequired: !hasConsent,
      hasEarlierMessages: messages.length > 0 && messages[0].sequence > 1,
      messages: messages.map((m) => ({
        id: m.id,
        sequence: m.sequence,
        mine: m.authorId === actor.id,
        authorPseudonym:
          m.authorId === room.targetId
            ? room.target.pseudonym
            : room.friend.pseudonym,
        text: m.text,
        createdAt: iso(m.createdAt),
        destroyed: !!m.destroyedAt,
      })),
    };
  });
}
export async function sendRoomMessage(actor: Actor, payload: Payload) {
  requireValue(
    typeof payload.roomId === "string" &&
      typeof payload.text === "string" &&
      payload.text.trim().length > 0 &&
      payload.text.length <= 4000 &&
      !/\u0000/.test(payload.text),
  );
  requireValue(
    typeof payload.idempotencyKey === "string" &&
      /^[A-Za-z0-9_-]{16,80}$/.test(payload.idempotencyKey),
  );
  const roomId = payload.roomId,
    text = payload.text.trim(),
    key = payload.idempotencyKey;
  return mutation(async (tx) => {
    const room = await participantRoom(tx, actor, roomId);
    requireValue(await pairConsents(tx, room), "CONSENT_REQUIRED", 409);
    const previous = await tx.preparationMessage.findUnique({
      where: {
        roomId_authorId_idempotencyKey: {
          roomId,
          authorId: actor.id,
          idempotencyKey: key,
        },
      },
    });
    if (previous) {
      requireValue(previous.text === text, "IDEMPOTENCY_CONFLICT", 409);
      return {
        ok: true,
        messageId: previous.id,
        sequence: previous.sequence,
        duplicate: true,
      };
    }
    requireValue(room.status === "ACTIVE", "ROOM_NOT_ACTIVE", 409);
    const message = await tx.preparationMessage.create({
      data: {
        roomId,
        authorId: actor.id,
        sequence: room.nextSequence,
        idempotencyKey: key,
        text,
      },
    });
    await tx.preparationRoom.update({
      where: { id: roomId },
      data: { nextSequence: { increment: 1 }, updatedAt: new Date() },
    });
    await audit(tx, actor, "PORTAL_MESSAGE_SENT", "PreparationRoom", roomId, {
      sequence: message.sequence,
    });
    return {
      ok: true,
      messageId: message.id,
      sequence: message.sequence,
      duplicate: false,
    };
  });
}
export async function controlRoom(actor: Actor, payload: Payload) {
  requireValue(
    typeof payload.roomId === "string" &&
      ["pause", "resume", "end"].includes(String(payload.action)),
  );
  const roomId = payload.roomId,
    action = payload.action;
  return mutation(async (tx) => {
    const room = await participantRoom(tx, actor, roomId);
    requireValue(
      !["ENDED", "WITHDRAWN"].includes(room.status),
      "ROOM_NOT_ACTIVE",
      409,
    );
    if (action === "resume") {
      requireValue(
        room.status === "PAUSED" && room.stoppedById === actor.id,
        "ONLY_PAUSER_CAN_RESUME",
        403,
      );
      requireValue(await pairConsents(tx, room), "CONSENT_REQUIRED", 409);
    }
    // A peer cannot replace the original pause ownership by pausing again.
    if (action === "pause" && room.status === "PAUSED")
      return { ok: true, status: "PAUSED" };
    const status =
      action === "pause" ? "PAUSED" : action === "resume" ? "ACTIVE" : "ENDED";
    await tx.preparationRoom.update({
      where: { id: roomId },
      data: {
        status,
        stoppedById: action === "resume" ? null : actor.id,
        stoppedAt: action === "resume" ? null : new Date(),
      },
    });
    await audit(tx, actor, `PORTAL_ROOM_${status}`, "PreparationRoom", roomId);
    return { ok: true, status };
  });
}
async function stopParticipation(tx: Tx, actor: Actor) {
  await writeConsent(tx, actor, false);
  const result = await tx.preparationRoom.updateMany({
    where: { ...ownRooms(actor), status: { not: "WITHDRAWN" } },
    data: { status: "WITHDRAWN", stoppedById: actor.id, stoppedAt: new Date() },
  });
  await tx.enrollmentInvitation.updateMany({
    where: { createdById: actor.id, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}
export async function savePortalConsent(actor: Actor, payload: Payload) {
  requireValue(typeof payload.participation === "boolean");
  return mutation(async (tx) => {
    await realActor(tx, actor);
    requireValue(["TARGET", "FRIEND"].includes(actor.role), "FORBIDDEN", 403);
    // Withdrawal is final for existing pairs; opting in again cannot reactivate them.
    if (payload.participation) await writeConsent(tx, actor, true);
    else await stopParticipation(tx, actor);
    await audit(tx, actor, "PORTAL_CONSENT_UPDATED", "Participant", actor.id, {
      participation: payload.participation as boolean,
      version: PORTAL_CONSENT_VERSION,
    });
    return {
      ok: true,
      participation: payload.participation,
      consentVersion: PORTAL_CONSENT_VERSION,
    };
  });
}
export async function withdrawPortal(actor: Actor, payload: Payload) {
  requireValue(typeof payload.destroyContent === "boolean");
  return mutation(async (tx) => {
    await realActor(tx, actor);
    requireValue(["TARGET", "FRIEND"].includes(actor.role), "FORBIDDEN", 403);
    const roomCount = await stopParticipation(tx, actor);
    const rooms = await tx.preparationRoom.findMany({
      where: ownRooms(actor),
      select: { id: true },
    });
    const roomIds = rooms.map((r) => r.id);
    const request = await tx.withdrawalRequest.create({
      data: {
        participantId: actor.id,
        mode: payload.destroyContent
          ? "CONTENT_DESTRUCTION"
          : "ANALYSIS_EXCLUSION",
        scope: "PORTAL_PREPARATION",
        affectedCounts: {},
      },
    });
    let destroyed = 0;
    if (payload.destroyContent) {
      const messages = await tx.preparationMessage.findMany({
        where: { roomId: { in: roomIds }, destroyedAt: null },
        select: { id: true, text: true },
      });
      for (const m of messages)
        await tx.deletionTombstone.upsert({
          where: {
            entityType_entityId: {
              entityType: "PreparationMessage",
              entityId: m.id,
            },
          },
          create: {
            requestId: request.id,
            entityType: "PreparationMessage",
            entityId: m.id,
            contentHash: m.text ? hash(m.text) : null,
          },
          update: {},
        });
      destroyed = (
        await tx.preparationMessage.updateMany({
          where: { roomId: { in: roomIds }, destroyedAt: null },
          data: { text: null, destroyedAt: new Date() },
        })
      ).count;
    }
    await tx.withdrawalRequest.update({
      where: { id: request.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        affectedCounts: { rooms: roomCount, messages: destroyed },
      },
    });
    await audit(
      tx,
      actor,
      "PORTAL_PARTICIPATION_WITHDRAWN",
      "WithdrawalRequest",
      request.id,
      {
        destroyContent: payload.destroyContent as boolean,
        rooms: roomCount,
        messages: destroyed,
      },
    );
    return {
      ok: true,
      requestId: request.id,
      affectedRooms: roomCount,
      destroyedMessages: destroyed,
    };
  });
}
export async function updateProfile(actor: Actor, payload: Payload) {
  const alias = pseudonym(payload.pseudonym);
  requireValue(
    typeof payload.timezone === "string" && payload.timezone.length <= 80,
  );
  try {
    new Intl.DateTimeFormat("en", { timeZone: payload.timezone });
  } catch {
    throw new GatewayError(422, "INVALID_INPUT");
  }
  const timezone = payload.timezone;
  return mutation(async (tx) => {
    await realActor(tx, actor);
    const p = await tx.participant.update({
      where: { id: actor.id },
      data: { pseudonym: alias, timezone },
    });
    await audit(tx, actor, "PORTAL_PROFILE_UPDATED", "Participant", actor.id);
    return { ok: true, actor: asActor(p), timezone: p.timezone };
  });
}
export async function getPortalHome(actor: Actor) {
  const p = await realActor(prisma, actor);
  const base = {
    actor: asActor(p),
    username: p.account!.username,
    timezone: p.timezone,
    portal: portalForRole(p.role),
    cohort: "REAL_ENROLLMENT",
    modelStatus: "NOT_CONNECTED",
    formalStudyStatus: "NOT_ACTIVATED",
    consentVersion: PORTAL_CONSENT_VERSION,
  };
  if (["RESEARCHER", "ANALYST"].includes(actor.role)) {
    const [participants, rooms, invitations] = await Promise.all([
      prisma.participant.findMany({
        where: {
          account: { isNot: null },
          id: { not: { startsWith: "play-target-" } },
        },
        select: {
          id: true,
          role: true,
          pseudonym: true,
          active: true,
          createdAt: true,
          consents: {
            orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
            take: 1,
            select: { participation: true, version: true },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.preparationRoom.findMany({
        select: {
          id: true,
          targetId: true,
          friendId: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { messages: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      actor.role === "RESEARCHER"
        ? prisma.enrollmentInvitation.findMany({
            where: { createdById: actor.id },
            orderBy: { createdAt: "desc" },
            take: 200,
          })
        : Promise.resolve([]),
    ]);
    return {
      ...base,
      participants: participants.map((person) => ({
        id: person.id,
        role: person.role,
        pseudonym: person.pseudonym,
        active: person.active,
        participation: person.consents[0]?.participation ?? null,
        createdAt: iso(person.createdAt),
      })),
      rooms: rooms.map((room) => ({
        id: room.id,
        targetId: room.targetId,
        friendId: room.friendId,
        status: room.status,
        messageCount: room._count.messages,
        createdAt: iso(room.createdAt),
        updatedAt: iso(room.updatedAt),
      })),
      invitations: invitations.map(invitationDto),
      stats: {
        targets: participants.filter((x) => x.role === "TARGET").length,
        friends: participants.filter((x) => x.role === "FRIEND").length,
        rooms: rooms.length,
        activeRooms: rooms.filter((r) => r.status === "ACTIVE").length,
      },
    };
  }
  const [roomList, invitations, consent, used] = await Promise.all([
    listRooms(actor),
    prisma.enrollmentInvitation.findMany({
      where: { createdById: actor.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    latestConsent(prisma, actor.id),
    prisma.enrollmentInvitation.count({
      where: {
        targetId: actor.id,
        OR: [
          { acceptedAt: { not: null } },
          { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        ],
      },
    }),
  ]);
  return {
    ...base,
    ...roomList,
    invitations: invitations.map(invitationDto),
    participation: !!(consent?.participation && !consent.revokedAt),
    friendLimit: FRIEND_LIMIT,
    friendSlotsRemaining: Math.max(0, FRIEND_LIMIT - used),
  };
}
