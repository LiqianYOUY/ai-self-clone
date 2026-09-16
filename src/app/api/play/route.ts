import { after } from "next/server";
import { z } from "zod";
import {
  createPortalSession,
  getPortalActor,
  logoutPortal,
  type Actor,
} from "@/server/auth";
import { getPlayGuest, playGuestCookieHeaders } from "@/server/play-auth";
import {
  assertMutationRequest,
  enforceRateLimit,
  GatewayError,
  jsonResponse,
  readJson,
  requestRateKey,
} from "@/server/http";
import { authenticateAccount, registerPlayHost } from "@/server/portals";
import {
  cancelPlayRoom,
  createPlayRoom,
  getPlayHome,
  getPlayRoom,
  guessPlayRoom,
  heartbeatPlayHost,
  inspectPlayInvitation,
  joinPlayRoom,
  leavePlayRoom,
  playMessageSchema,
  playPersonaSchema,
  replyPlayRoom,
  runPendingPlayReply,
  savePlayPersona,
  sendPlayMessage,
} from "@/server/play";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 90;

const roomId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const token = z.string().regex(/^[a-f0-9]{64}$/);
const empty = z.object({}).strict();
const credentials = z
  .object({
    username: z.string().min(1).max(80),
    password: z.string().min(1).max(128),
  })
  .strict();
const roomPayload = z.object({ roomId }).strict();
const command = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("register"),
      payload: credentials
        .extend({ pseudonym: z.string().trim().min(1).max(40) })
        .strict(),
    })
    .strict(),
  z.object({ action: z.literal("login"), payload: credentials }).strict(),
  z.object({ action: z.literal("logout"), payload: empty }).strict(),
  z
    .object({ action: z.literal("save_persona"), payload: playPersonaSchema })
    .strict(),
  z
    .object({
      action: z.literal("heartbeat"),
      payload: z.object({ online: z.boolean() }).strict(),
    })
    .strict(),
  z.object({ action: z.literal("create_room"), payload: empty }).strict(),
  z
    .object({
      action: z.literal("inspect_invite"),
      payload: z.object({ token }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("join_room"),
      payload: z
        .object({
          token,
          nickname: z.string().trim().min(1).max(40),
          consent: z.literal(true),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("send_message"),
      payload: playMessageSchema.extend({ roomId }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("reply"),
      payload: playMessageSchema.extend({ roomId }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("guess"),
      payload: z
        .object({
          roomId,
          guess: z.enum(["HUMAN", "AI"]),
          reason: z.string().trim().max(2000),
        })
        .strict(),
    })
    .strict(),
  z.object({ action: z.literal("cancel"), payload: roomPayload }).strict(),
  z.object({ action: z.literal("leave"), payload: roomPayload }).strict(),
]);
const errors: Record<string, string> = {
  AUTHENTICATION_REQUIRED: "请先登录，或通过邀请链接进入这局聊天。",
  INVALID_CREDENTIALS: "账号或密码不正确。",
  FORBIDDEN: "当前账号无法执行这项操作。",
  NOT_FOUND: "这局聊天不存在或已不可用。",
  INVALID_INPUT: "请检查输入内容。",
  INVALID_STATE: "当前状态无法执行这项操作，请刷新后重试。",
  REQUEST_REJECTED: "请求未完成，请检查输入和当前状态。",
  TRY_AGAIN_LATER: "操作过于频繁，请稍后再试。",
  INVITATION_INVALID: "邀请已使用、取消或过期，请朋友发来新的邀请。",
  ACCOUNT_UNAVAILABLE: "这个账号名称不可用，请使用其他名称。",
  ACCOUNT_EXISTS: "这个账号名称不可用，请使用其他名称。",
  PROVIDER_NOT_CONFIGURED: "请先完成模型配置，再创建邀请。",
  PROVIDER_UNAVAILABLE: "模型暂时不可用，请检查本地模型服务后重试。",
  PERSONA_REQUIRED: "请先保存你的分身资料。",
  HOST_OFFLINE: "请先开启在线接待。",
  ROOM_EXISTS: "请先结束或取消当前这局聊天。",
  IDEMPOTENCY_CONFLICT: "这次操作已提交，内容不能再次改变。",
};
function safeError(error: unknown): Response {
  const controlled = error instanceof GatewayError;
  const code =
    controlled && Object.hasOwn(errors, error.code)
      ? error.code
      : "REQUEST_REJECTED";
  return jsonResponse(
    { error: errors[code], code },
    controlled ? error.status : 500,
  );
}
async function requireHost(request: Request): Promise<Actor> {
  const actor = await getPortalActor(request, "target");
  if (!actor) throw new GatewayError(401, "AUTHENTICATION_REQUIRED");
  enforceRateLimit(`play-host:${actor.id}`, 180);
  return actor;
}

export async function GET(request: Request): Promise<Response> {
  try {
    enforceRateLimit(`play-read:${requestRateKey(request)}`, 180);
    const url = new URL(request.url);
    const view = url.searchParams.get("view") ?? "home";
    const permitted = view === "home" ? ["view"] : ["view", "roomId"];
    if ([...url.searchParams.keys()].some((key) => !permitted.includes(key)))
      throw new GatewayError(400, "REQUEST_REJECTED");
    if (view === "home")
      return jsonResponse(
        await getPlayHome(await getPortalActor(request, "target")),
      );
    if (view === "room") {
      const parsed = roomId.safeParse(url.searchParams.get("roomId"));
      if (!parsed.success) throw new GatewayError(400, "INVALID_INPUT");
      return jsonResponse({
        room: await getPlayRoom(getPlayGuest(request, parsed.data)),
      });
    }
    throw new GatewayError(400, "REQUEST_REJECTED");
  } catch (error) {
    return safeError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertMutationRequest(request);
    const parsed = command.safeParse(await readJson(request, 131_072));
    if (!parsed.success) throw new GatewayError(422, "INVALID_INPUT");
    const body = parsed.data;

    if (body.action === "register" || body.action === "login") {
      enforceRateLimit("play-account-access", 40);
      enforceRateLimit(`play-account-access:${requestRateKey(request)}`, 20);
      const actor =
        body.action === "register"
          ? await registerPlayHost(body.payload)
          : await authenticateAccount({ ...body.payload, portal: "target" });
      return await createPortalSession(request, "target", actor);
    }
    if (body.action === "inspect_invite") {
      enforceRateLimit("play-invitation-preview", 120);
      return jsonResponse(await inspectPlayInvitation(body.payload.token));
    }
    if (body.action === "join_room") {
      enforceRateLimit("play-invitation-join", 60);
      const joined = await joinPlayRoom(body.payload);
      return jsonResponse(
        { room: joined.room },
        200,
        playGuestCookieHeaders(
          request,
          joined.room.id,
          joined.guestToken,
          joined.expiresAt,
        ),
      );
    }
    if (["send_message", "guess", "leave"].includes(body.action)) {
      // Branch only on the public command. Both source modes have the same response path.
      if (body.action === "send_message") {
        const { roomId: id, ...input } = body.payload;
        const guest = getPlayGuest(request, id);
        enforceRateLimit(`play-guest:${guest.tokenHash}`, 90);
        const result = await sendPlayMessage(guest, input);
        after(async () => {
          try {
            await runPendingPlayReply(id);
          } catch {
            /* Persisted timeout cancels interrupted jobs on the next poll. */
          }
        });
        return jsonResponse(result);
      }
      if (body.action === "guess") {
        const { roomId: id, ...input } = body.payload;
        return jsonResponse(
          await guessPlayRoom(getPlayGuest(request, id), input),
        );
      }
      if (body.action === "leave")
        return jsonResponse(
          await leavePlayRoom(getPlayGuest(request, body.payload.roomId)),
        );
    }

    const actor = await requireHost(request);
    switch (body.action) {
      case "logout":
        await heartbeatPlayHost(actor, false);
        return await logoutPortal(request, "target");
      case "heartbeat":
        return jsonResponse(
          await heartbeatPlayHost(actor, body.payload.online),
        );
      case "save_persona":
        return jsonResponse(await savePlayPersona(actor, body.payload));
      case "create_room":
        return jsonResponse(await createPlayRoom(actor));
      case "reply":
        return jsonResponse(await replyPlayRoom(actor, body.payload));
      case "cancel":
        return jsonResponse(await cancelPlayRoom(actor, body.payload.roomId));
      default:
        throw new GatewayError(400, "REQUEST_REJECTED");
    }
  } catch (error) {
    return safeError(error);
  }
}
