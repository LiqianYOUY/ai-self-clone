import { randomBytes, randomInt } from "node:crypto";
import { Prisma, type PlayPersona, type PlayRoom } from "@prisma/client";
import { z } from "zod";
import {
  PLAY_TURNS,
  type PlayHomeDto,
  type PlayHostRoomDto,
  type PlayIdentity,
  type PlayInvitationDto,
  type PlayPersonaInput,
  type PlayRoomDto,
  type PlaySpeaker,
  type PlayStatus,
} from "@/domain/play";
import type { Actor } from "./auth";
import { prisma } from "./db";
import { allowedOrigin, GatewayError } from "./http";
import { hashPlayToken, type PlayGuest } from "./play-auth";
import {
  checkPlayProvider,
  generatePlayReply,
  isPlayProviderConfigured,
} from "./play-provider";

export const PLAY_HOST_TIMEOUT_MS = 90_000;
export const PLAY_REPLY_TIMEOUT_MS = 120_000;
export const PLAY_INVITE_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const PLAY_CONSENT_VERSION = "play-v1";
const OPEN_STATUSES = ["WAITING", "ACTIVE", "GUESSING"];
type Tx = Prisma.TransactionClient;
const messageInclude = { messages: { orderBy: { sequence: "asc" as const } } };
type RoomWithMessages = Prisma.PlayRoomGetPayload<{
  include: typeof messageInclude;
}>;

const cleanText = (maximum: number, minimum = 0) =>
  z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .refine(
      (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
    );
export const playPersonaSchema = z
  .object({
    displayName: cleanText(40, 1),
    bio: cleanText(2000, 1),
    style: cleanText(2000, 1),
    memories: cleanText(4000),
    examplesText: cleanText(16000, 1),
  })
  .strict();
export const playMessageSchema = z
  .object({
    text: cleanText(2000, 1),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  })
  .strict();
const roomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GatewayError(422, "INVALID_INPUT");
  return result.data;
}
function requireValue(
  value: unknown,
  code = "INVALID_STATE",
  status = 409,
): asserts value {
  if (!value) throw new GatewayError(status, code);
}

/** One lock keeps the small MVP's host, invite, turn and cancellation transitions atomic. */
async function mutation<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(70624004)::text`;
        await expireRooms(tx);
        return fn(tx);
      },
      { maxWait: 10000, timeout: 15000 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw new GatewayError(409, "INVALID_STATE");
    throw error;
  }
}

/** Reads and writes use the same restart-safe expiry rules for both identities. */
function expiredRoomWhere(now: Date): Prisma.PlayRoomWhereInput {
  return {
    status: { in: OPEN_STATUSES },
    OR: [
      { expiresAt: { lte: now } },
      { owner: { active: false } },
      { owner: { playPersona: { is: null } } },
      { owner: { playPersona: { heartbeatAt: null } } },
      {
        owner: {
          playPersona: {
            heartbeatAt: {
              lte: new Date(now.getTime() - PLAY_HOST_TIMEOUT_MS),
            },
          },
        },
      },
      {
        pendingSince: {
          lte: new Date(now.getTime() - PLAY_REPLY_TIMEOUT_MS),
        },
      },
    ],
  };
}

async function expireRooms(tx: Tx) {
  const now = new Date();
  await tx.playRoom.updateMany({
    where: expiredRoomWhere(now),
    data: {
      status: "CANCELLED",
      cancelledAt: now,
      inviteHash: null,
      pendingTurn: null,
      pendingSince: null,
      generationClaimedAt: null,
    },
  });
}

async function requireHost(tx: Tx, actor: Actor) {
  requireValue(
    actor?.role === "TARGET" && !actor.id.startsWith("demo-"),
    "FORBIDDEN",
    403,
  );
  const owner = await tx.participant.findUnique({
    where: { id: actor.id },
    include: { account: true },
  });
  requireValue(
    owner?.active && owner.account && owner.role === "TARGET",
    "FORBIDDEN",
    403,
  );
  return owner;
}

function personaInput(persona: PlayPersona): PlayPersonaInput {
  return {
    displayName: persona.displayName,
    bio: persona.bio,
    style: persona.style,
    memories: persona.memories,
    examplesText: persona.examplesText,
  };
}
const isOnline = (persona: PlayPersona | null, now = Date.now()) =>
  !!persona?.heartbeatAt &&
  persona.heartbeatAt.getTime() > now - PLAY_HOST_TIMEOUT_MS;

function publicRoom(room: RoomWithMessages): PlayRoomDto {
  const snapshot = room.personaSnapshot as unknown as PlayPersonaInput;
  return {
    id: room.id,
    hostName: snapshot.displayName,
    friendName: room.guestName,
    status: room.status as PlayStatus,
    turnsCompleted: room.turnsCompleted,
    maxTurns: PLAY_TURNS,
    waitingFor:
      room.status === "ACTIVE"
        ? room.pendingTurn
          ? "SOURCE"
          : "FRIEND"
        : null,
    messages: room.messages.map((message) => ({
      id: message.id,
      speaker: message.speaker as PlaySpeaker,
      text: message.text,
      sequence: message.sequence,
    })),
    result:
      room.status === "REVEALED" && room.guess
        ? {
            answer: room.mode as PlayIdentity,
            guess: room.guess as PlayIdentity,
            correct: room.mode === room.guess,
            reason: room.reason ?? "",
          }
        : null,
  };
}
function hostRoom(room: RoomWithMessages): PlayHostRoomDto {
  return { ...publicRoom(room), mode: room.mode as PlayIdentity };
}
async function loadedRoom(tx: Tx, id: string) {
  const room = await tx.playRoom.findUnique({
    where: { id },
    include: messageInclude,
  });
  requireValue(room, "NOT_FOUND", 404);
  return room;
}
async function guestRoom(tx: Tx, guest: PlayGuest) {
  checked(roomIdSchema, guest.roomId);
  const room = await loadedRoom(tx, guest.roomId);
  requireValue(
    room.guestHash &&
      room.guestHash === guest.tokenHash &&
      room.expiresAt.getTime() > Date.now(),
    "NOT_FOUND",
    404,
  );
  return room;
}

export async function getPlayHome(actor: Actor | null): Promise<PlayHomeDto> {
  const empty: PlayHomeDto = {
    actor: null,
    persona: null,
    providerReady: false,
    online: false,
    activeRoom: null,
    recentRooms: [],
    stats: {
      completed: 0,
      cancelled: 0,
      aiRounds: 0,
      humanRounds: 0,
      aiFooledRate: null,
      humanRecognizedRate: null,
    },
  };
  if (!actor) return empty;
  // Model details are host-only, and network readiness checks never hold a DB lock.
  const providerStatus = await checkPlayProvider();
  empty.providerReady = providerStatus.ready;
  empty.providerStatus = providerStatus;
  // Polling never acquires the transition lock or writes expiry updates. A single
  // snapshot keeps active/history/statistics consistent while mutations continue.
  return prisma.$transaction(
    async (tx) => {
      const now = new Date();
      const expired = expiredRoomWhere(now);
      const owner = await requireHost(tx, actor);
      const persona = await tx.playPersona.findUnique({
        where: { ownerId: actor.id },
      });
      const activeRoom = await tx.playRoom.findFirst({
        where: {
          ownerId: actor.id,
          status: { in: OPEN_STATUSES },
          NOT: expired,
        },
        include: messageInclude,
      });
      const recentRooms = await tx.playRoom.findMany({
        where: {
          ownerId: actor.id,
          OR: [{ status: { in: ["REVEALED", "CANCELLED"] } }, expired],
        },
        orderBy: { createdAt: "desc" },
        take: 12,
        include: messageInclude,
      });
      const counts = await tx.playRoom.groupBy({
        by: ["status", "mode", "guess"],
        where: { ownerId: actor.id, status: { in: ["REVEALED", "CANCELLED"] } },
        _count: { _all: true },
      });
      let aiFooled = 0,
        humanRecognized = 0;
      const stats = {
        ...empty.stats,
        cancelled: await tx.playRoom.count({
          where: { ownerId: actor.id, ...expired },
        }),
      };
      for (const group of counts) {
        const n = group._count._all;
        if (group.status === "CANCELLED") stats.cancelled += n;
        if (group.status !== "REVEALED") continue;
        stats.completed += n;
        if (group.mode === "AI") {
          stats.aiRounds += n;
          if (group.guess === "HUMAN") aiFooled += n;
        } else {
          stats.humanRounds += n;
          if (group.guess === "HUMAN") humanRecognized += n;
        }
      }
      stats.aiFooledRate = stats.aiRounds ? aiFooled / stats.aiRounds : null;
      stats.humanRecognizedRate = stats.humanRounds
        ? humanRecognized / stats.humanRounds
        : null;
      return {
        ...empty,
        actor: { id: owner.id, pseudonym: owner.pseudonym },
        persona: persona?.savedAt ? personaInput(persona) : null,
        online: isOnline(persona, now.getTime()),
        activeRoom: activeRoom ? hostRoom(activeRoom) : null,
        recentRooms: recentRooms.map((room) =>
          hostRoom(
            OPEN_STATUSES.includes(room.status)
              ? { ...room, status: "CANCELLED" }
              : room,
          ),
        ),
        stats,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function savePlayPersona(actor: Actor, input: PlayPersonaInput) {
  const data = checked(playPersonaSchema, input);
  return mutation(async (tx) => {
    await requireHost(tx, actor);
    const saved = await tx.playPersona.upsert({
      where: { ownerId: actor.id },
      create: { ownerId: actor.id, ...data, savedAt: new Date() },
      update: { ...data, savedAt: new Date() },
    });
    return { persona: personaInput(saved) };
  });
}

export async function heartbeatPlayHost(actor: Actor, online: boolean) {
  checked(z.boolean(), online);
  return mutation(async (tx) => {
    await requireHost(tx, actor);
    await tx.playPersona.upsert({
      where: { ownerId: actor.id },
      create: { ownerId: actor.id, heartbeatAt: online ? new Date() : null },
      update: { heartbeatAt: online ? new Date() : null },
    });
    if (!online)
      await tx.playRoom.updateMany({
        where: { ownerId: actor.id, status: { in: OPEN_STATUSES } },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          inviteHash: null,
          pendingTurn: null,
          pendingSince: null,
          generationClaimedAt: null,
        },
      });
    return { online };
  });
}

export async function createPlayRoom(actor: Actor) {
  requireValue(isPlayProviderConfigured(), "PROVIDER_NOT_CONFIGURED", 409);
  requireValue((await checkPlayProvider()).ready, "PROVIDER_UNAVAILABLE", 409);
  return mutation(async (tx) => {
    await requireHost(tx, actor);
    const persona = await tx.playPersona.findUnique({
      where: { ownerId: actor.id },
    });
    requireValue(persona?.savedAt, "PERSONA_REQUIRED", 409);
    requireValue(isOnline(persona), "HOST_OFFLINE", 409);
    requireValue(
      !(await tx.playRoom.findFirst({
        where: { ownerId: actor.id, status: { in: OPEN_STATUSES } },
      })),
      "ROOM_EXISTS",
      409,
    );
    const token = randomBytes(32).toString("hex");
    const room = await tx.playRoom.create({
      data: {
        ownerId: actor.id,
        mode: randomInt(2) === 0 ? "HUMAN" : "AI",
        inviteHash: hashPlayToken(token),
        personaSnapshot: { ...personaInput(persona) },
        expiresAt: new Date(Date.now() + PLAY_INVITE_LIFETIME_MS),
      },
      include: messageInclude,
    });
    return {
      url: `${allowedOrigin()}/play/join#token=${token}`,
      room: hostRoom(room),
    };
  });
}

export async function inspectPlayInvitation(
  token: string,
): Promise<PlayInvitationDto> {
  checked(tokenSchema, token);
  return mutation(async (tx) => {
    const room = await tx.playRoom.findUnique({
      where: { inviteHash: hashPlayToken(token) },
    });
    requireValue(
      room?.status === "WAITING" && room.expiresAt.getTime() > Date.now(),
      "INVITATION_INVALID",
      404,
    );
    return {
      hostName: (room.personaSnapshot as unknown as PlayPersonaInput)
        .displayName,
      expiresAt: room.expiresAt.toISOString(),
    };
  });
}

/** The raw guest token is returned only to the server route for an HttpOnly cookie. */
export async function joinPlayRoom(input: {
  token: string;
  nickname: string;
  consent: true;
}) {
  const data = checked(
    z
      .object({
        token: tokenSchema,
        nickname: cleanText(40, 1),
        consent: z.literal(true),
      })
      .strict(),
    input,
  );
  return mutation(async (tx) => {
    const room = await tx.playRoom.findUnique({
      where: { inviteHash: hashPlayToken(data.token) },
    });
    requireValue(
      room?.status === "WAITING" && room.expiresAt.getTime() > Date.now(),
      "INVITATION_INVALID",
      404,
    );
    const guestToken = randomBytes(32).toString("hex");
    const joined = await tx.playRoom.update({
      where: { id: room.id },
      data: {
        inviteHash: null,
        guestHash: hashPlayToken(guestToken),
        guestName: data.nickname,
        status: "ACTIVE",
        consentedAt: new Date(),
        consentVersion: PLAY_CONSENT_VERSION,
      },
      include: messageInclude,
    });
    return {
      room: publicRoom(joined),
      guestToken,
      expiresAt: joined.expiresAt,
    };
  });
}

export async function getPlayRoom(guest: PlayGuest): Promise<PlayRoomDto> {
  return prisma.$transaction(
    async (tx) => {
      const now = new Date();
      const room = await guestRoom(tx, guest);
      const expired = await tx.playRoom.count({
        where: { id: room.id, ...expiredRoomWhere(now) },
      });
      return publicRoom(expired ? { ...room, status: "CANCELLED" } : room);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function sendPlayMessage(
  guest: PlayGuest,
  input: { text: string; idempotencyKey: string },
) {
  const data = checked(playMessageSchema, input);
  return mutation(async (tx) => {
    const room = await guestRoom(tx, guest);
    const duplicate = room.messages.find(
      (item) =>
        item.speaker === "FRIEND" &&
        item.idempotencyKey === data.idempotencyKey,
    );
    if (duplicate) {
      requireValue(duplicate.text === data.text, "IDEMPOTENCY_CONFLICT");
      return { room: publicRoom(room) };
    }
    if (room.status === "CANCELLED") return { room: publicRoom(room) };
    requireValue(
      room.status === "ACTIVE" &&
        room.pendingTurn === null &&
        room.turnsCompleted < PLAY_TURNS,
    );
    await tx.playMessage.create({
      data: {
        roomId: room.id,
        speaker: "FRIEND",
        sequence: room.nextSequence,
        ...data,
      },
    });
    const updated = await tx.playRoom.update({
      where: { id: room.id },
      data: {
        nextSequence: { increment: 1 },
        pendingTurn: room.turnsCompleted + 1,
        pendingSince: new Date(),
        generationClaimedAt: null,
      },
      include: messageInclude,
    });
    return { room: publicRoom(updated) };
  });
}

async function commitReply(
  tx: Tx,
  room: PlayRoom,
  text: string,
  idempotencyKey: string,
) {
  await tx.playMessage.create({
    data: {
      roomId: room.id,
      speaker: "SOURCE",
      sequence: room.nextSequence,
      text,
      idempotencyKey,
    },
  });
  return tx.playRoom.update({
    where: { id: room.id },
    data: {
      nextSequence: { increment: 1 },
      turnsCompleted: { increment: 1 },
      status: room.turnsCompleted + 1 === PLAY_TURNS ? "GUESSING" : "ACTIVE",
      pendingTurn: null,
      pendingSince: null,
      generationClaimedAt: null,
    },
    include: messageInclude,
  });
}

export async function replyPlayRoom(
  actor: Actor,
  input: { roomId: string; text: string; idempotencyKey: string },
) {
  const { roomId, ...data } = checked(
    playMessageSchema.extend({ roomId: roomIdSchema }).strict(),
    input,
  );
  return mutation(async (tx) => {
    await requireHost(tx, actor);
    const room = await loadedRoom(tx, roomId);
    requireValue(room.ownerId === actor.id, "NOT_FOUND", 404);
    requireValue(room.mode === "HUMAN");
    const duplicate = room.messages.find(
      (item) =>
        item.speaker === "SOURCE" &&
        item.idempotencyKey === data.idempotencyKey,
    );
    if (duplicate) {
      requireValue(duplicate.text === data.text, "IDEMPOTENCY_CONFLICT");
      return { room: hostRoom(room) };
    }
    if (room.status === "CANCELLED") return { room: hostRoom(room) };
    requireValue(room.status === "ACTIVE" && room.pendingTurn !== null);
    return {
      room: hostRoom(
        await commitReply(tx, room, data.text, data.idempotencyKey),
      ),
    };
  });
}

/** Called after the common ACK for both room modes; no model metadata crosses the route. */
export async function runPendingPlayReply(roomId: string): Promise<void> {
  const job = await mutation(async (tx) => {
    const room = await tx.playRoom.findUnique({
      where: { id: roomId },
      include: messageInclude,
    });
    if (
      !room ||
      room.status !== "ACTIVE" ||
      room.mode !== "AI" ||
      room.pendingTurn === null ||
      room.generationClaimedAt
    )
      return null;
    await tx.playRoom.update({
      where: { id: room.id },
      data: { generationClaimedAt: new Date() },
    });
    return {
      roomId: room.id,
      turn: room.pendingTurn,
      persona: room.personaSnapshot as unknown as PlayPersonaInput,
      messages: room.messages.map((message) => ({
        speaker: message.speaker as PlaySpeaker,
        text: message.text,
      })),
    };
  });
  if (!job) return;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    PLAY_REPLY_TIMEOUT_MS - 1000,
  );
  try {
    const text = checked(
      cleanText(2000, 1),
      await generatePlayReply(
        { persona: job.persona, messages: job.messages },
        { signal: controller.signal },
      ),
    );
    await mutation(async (tx) => {
      const current = await tx.playRoom.findUnique({
        where: { id: job.roomId },
      });
      if (
        !current ||
        current.status !== "ACTIVE" ||
        current.mode !== "AI" ||
        current.pendingTurn !== job.turn ||
        !current.generationClaimedAt ||
        controller.signal.aborted
      )
        return;
      await commitReply(tx, current, text, `generated_turn_${job.turn}`);
    });
  } catch {
    await mutation(async (tx) => {
      const current = await tx.playRoom.findUnique({
        where: { id: job.roomId },
      });
      if (current?.status === "ACTIVE" && current.pendingTurn === job.turn)
        await tx.playRoom.update({
          where: { id: current.id },
          data: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            inviteHash: null,
            pendingTurn: null,
            pendingSince: null,
            generationClaimedAt: null,
          },
        });
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function guessPlayRoom(
  guest: PlayGuest,
  input: { guess: PlayIdentity; reason: string },
) {
  const data = checked(
    z
      .object({ guess: z.enum(["HUMAN", "AI"]), reason: cleanText(2000) })
      .strict(),
    input,
  );
  return mutation(async (tx) => {
    const room = await guestRoom(tx, guest);
    if (room.status === "REVEALED") {
      requireValue(room.guess === data.guess, "IDEMPOTENCY_CONFLICT");
      return { room: publicRoom(room) };
    }
    if (room.status === "CANCELLED") return { room: publicRoom(room) };
    requireValue(
      room.status === "GUESSING" &&
        room.turnsCompleted === PLAY_TURNS &&
        room.messages.length === PLAY_TURNS * 2 &&
        room.pendingTurn === null,
    );
    const revealed = await tx.playRoom.update({
      where: { id: room.id },
      data: {
        status: "REVEALED",
        guess: data.guess,
        reason: data.reason,
        revealedAt: new Date(),
      },
      include: messageInclude,
    });
    return { room: publicRoom(revealed) };
  });
}

async function cancelRoom(tx: Tx, room: RoomWithMessages) {
  if (!OPEN_STATUSES.includes(room.status)) return room;
  return tx.playRoom.update({
    where: { id: room.id },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      inviteHash: null,
      pendingTurn: null,
      pendingSince: null,
      generationClaimedAt: null,
    },
    include: messageInclude,
  });
}
export async function cancelPlayRoom(actor: Actor, roomId: string) {
  checked(roomIdSchema, roomId);
  return mutation(async (tx) => {
    await requireHost(tx, actor);
    const room = await loadedRoom(tx, roomId);
    requireValue(room.ownerId === actor.id, "NOT_FOUND", 404);
    return { room: hostRoom(await cancelRoom(tx, room)) };
  });
}
export async function leavePlayRoom(guest: PlayGuest) {
  return mutation(async (tx) => ({
    room: publicRoom(await cancelRoom(tx, await guestRoom(tx, guest))),
  }));
}
