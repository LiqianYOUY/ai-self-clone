import {
  createPortalSession,
  getPortalActor,
  logoutPortal,
  requestPortal,
  type Actor,
  type Portal,
} from "@/server/auth";
import {
  allowedOrigin,
  assertMutationRequest,
  enforceRateLimit,
  GatewayError,
  jsonResponse,
  readJson,
  requestRateKey,
} from "@/server/http";
import {
  authenticateAccount,
  controlRoom,
  createInvitation,
  getPortalHome,
  getPortalStatus,
  getRoom,
  initializeResearchAccount,
  inspectInvitation,
  listRooms,
  registerFromInvitation,
  revokeInvitation,
  savePortalConsent,
  sendRoomMessage,
  updateProfile,
  withdrawPortal,
} from "@/server/portals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const messages: Record<string, string> = {
  AUTHENTICATION_REQUIRED: "请先登录当前入口。",
  INVALID_CREDENTIALS: "账号或密码不正确，请重新输入。",
  FORBIDDEN: "当前账号没有执行此操作的权限。",
  NOT_FOUND: "内容不存在或已不可用。",
  INVALID_INPUT: "请检查输入内容。",
  VALIDATION_ERROR: "请检查输入内容。",
  REQUEST_REJECTED: "操作未完成，请检查输入和当前状态。",
  TRY_AGAIN_LATER: "操作过于频繁，请稍后再试。",
  INVITATION_INVALID: "邀请已使用、撤销或过期，请申请新的邀请。",
  INVITATION_UNAVAILABLE: "邀请已使用、撤销或过期，请申请新的邀请。",
  INVITATION_ALREADY_ACCEPTED: "邀请已被接受，无法撤销。",
  INVITATION_LIMIT: "有效邀请数量已达上限，请先撤销不再需要的邀请。",
  FRIEND_LIMIT_REACHED: "好友名额已用完，请先撤销未使用的邀请。",
  ACCOUNT_EXISTS: "这个账号名称不可用，请使用其他名称。",
  ACCOUNT_UNAVAILABLE: "这个账号名称不可用，请使用其他名称。",
  BOOTSTRAP_UNAVAILABLE: "管理员初始化已关闭，请使用已有账号或邀请登录。",
  BOOTSTRAP_CLOSED: "管理员初始化已关闭，请使用已有账号或邀请登录。",
  CONSENT_REQUIRED: "请先阅读并同意参与说明。",
  INVALID_STATE: "当前状态不允许这项操作，请刷新后重试。",
  SESSION_NOT_ACTIVE: "聊天已暂停或结束，消息未发送。",
  ROOM_NOT_ACTIVE: "聊天已暂停或结束，消息未发送。",
  ONLY_PAUSER_CAN_RESUME: "需要由暂停聊天的一方恢复聊天。",
  IDEMPOTENCY_CONFLICT: "消息内容已改变，请重新发送。",
};

function safeError(error: unknown): Response {
  const controlled = error instanceof GatewayError;
  const code =
    controlled && Object.hasOwn(messages, error.code)
      ? error.code
      : "REQUEST_REJECTED";
  return jsonResponse(
    { error: messages[code], code },
    controlled ? error.status : 500,
  );
}

function localBootstrapRequest(request: Request): boolean {
  const loopback = (host: string) =>
    ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host);
  return (
    loopback(new URL(request.url).hostname) &&
    loopback(new URL(allowedOrigin()).hostname) &&
    loopback(process.env.APP_HOST ?? "127.0.0.1")
  );
}

async function requirePortalActor(
  request: Request,
  portal: Portal,
): Promise<Actor> {
  const actor = await getPortalActor(request, portal);
  if (!actor) throw new GatewayError(401, "AUTHENTICATION_REQUIRED");
  rejectPlayActor(actor);
  enforceRateLimit(`portal-actor:${actor.id}`, 180);
  return actor;
}

function rejectPlayActor(actor: Actor | null) {
  if (actor?.id.startsWith("play-target-"))
    throw new GatewayError(403, "FORBIDDEN");
}

/** Gateway schemas reject additional keys before any domain mutation. */
function payloadRecord(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new GatewayError(400, "REQUEST_REJECTED");
  return value as Record<string, unknown>;
}

function string(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || !value.length || value.length > maximum)
    throw new GatewayError(400, "INVALID_INPUT");
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new GatewayError(400, "INVALID_INPUT");
  return value;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const portal = requestPortal(request);
    enforceRateLimit(`portal-read:${requestRateKey(request)}`, 180);
    const url = new URL(request.url);
    const view = url.searchParams.get("view") ?? "me";
    if (view === "me") {
      const actor = await getPortalActor(request, portal);
      rejectPlayActor(actor);
      const status = await getPortalStatus();
      return jsonResponse({
        actor,
        portal,
        ...status,
        bootstrapAvailable:
          portal === "research" &&
          localBootstrapRequest(request) &&
          status.bootstrapAvailable,
      });
    }
    // Invitation secrets belong in same-origin request bodies, never request URLs.
    if (view === "invitation") throw new GatewayError(400, "REQUEST_REJECTED");
    const actor = await requirePortalActor(request, portal);
    if (view === "home") return jsonResponse(await getPortalHome(actor));
    if (view === "rooms") return jsonResponse(await listRooms(actor));
    if (view === "room")
      return jsonResponse(
        await getRoom(actor, string(url.searchParams.get("id"), 100)),
      );
    throw new GatewayError(400, "REQUEST_REJECTED");
  } catch (error) {
    return safeError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertMutationRequest(request);
    const portal = requestPortal(request);
    const body = payloadRecord(await readJson(request, 16_384), [
      "action",
      "payload",
    ]);
    const action = string(body.action, 40);
    const payload = body.payload ?? {};
    // Game sessions must not create research consent or preparation records.
    // Keep this boundary local to the portal; /api/play still uses target auth.
    rejectPlayActor(await getPortalActor(request, portal));

    if (action === "inspectInvitation") {
      enforceRateLimit("portal-invitation-preview", 120);
      const data = payloadRecord(payload, ["token"]);
      const invitation = await inspectInvitation(string(data.token, 128));
      if (invitation.portal !== portal)
        throw new GatewayError(403, "FORBIDDEN");
      return jsonResponse(invitation);
    }

    if (["bootstrap", "register", "login"].includes(action)) {
      // A global cap also bounds attempts that rotate attacker-controlled cookies.
      enforceRateLimit("portal-account-access", 40);
      enforceRateLimit(`portal-account-access:${requestRateKey(request)}`, 20);
      if (action === "login") {
        const data = payloadRecord(payload, ["username", "password"]);
        const actor = await authenticateAccount({
          username: string(data.username, 80),
          password: string(data.password, 256),
          portal,
        });
        rejectPlayActor(actor);
        return await createPortalSession(request, portal, actor);
      }
      if (action === "bootstrap") {
        if (portal !== "research") throw new GatewayError(403, "FORBIDDEN");
        const data = payloadRecord(payload, [
          "username",
          "password",
          "pseudonym",
        ]);
        const actor = await initializeResearchAccount(
          {
            username: string(data.username, 80),
            password: string(data.password, 256),
            pseudonym: string(data.pseudonym, 80),
          },
          { localBootstrap: localBootstrapRequest(request) },
        );
        return await createPortalSession(request, portal, actor);
      }
      const data = payloadRecord(payload, [
        "token",
        "username",
        "password",
        "pseudonym",
        "consent",
      ]);
      let consent:
        { participation: true; version: "enrollment-v1" } | undefined;
      if (portal !== "research" || data.consent !== undefined) {
        const input = payloadRecord(data.consent, ["participation", "version"]);
        if (input.participation !== true || input.version !== "enrollment-v1")
          throw new GatewayError(400, "CONSENT_REQUIRED");
        consent = { participation: true, version: "enrollment-v1" };
      }
      const actor = await registerFromInvitation({
        token: string(data.token, 128),
        username: string(data.username, 80),
        password: string(data.password, 256),
        pseudonym: string(data.pseudonym, 80),
        consent,
        portal,
      });
      return await createPortalSession(request, portal, actor);
    }
    if (action === "logout") {
      payloadRecord(payload, []);
      return await logoutPortal(request, portal);
    }
    const actor = await requirePortalActor(request, portal);
    if (action === "invite") {
      const data = payloadRecord(payload, ["kind"]);
      if (!["TARGET", "ANALYST", "FRIEND"].includes(data.kind as string))
        throw new GatewayError(400, "INVALID_INPUT");
      return jsonResponse(
        await createInvitation(actor, {
          kind: data.kind as "TARGET" | "ANALYST" | "FRIEND",
        }),
      );
    }
    if (action === "revoke") {
      const data = payloadRecord(payload, ["id"]);
      return jsonResponse(
        await revokeInvitation(actor, { id: string(data.id, 100) }),
      );
    }
    if (action === "profile") {
      const data = payloadRecord(payload, ["pseudonym", "timezone"]);
      return jsonResponse(
        await updateProfile(actor, {
          pseudonym: string(data.pseudonym, 80),
          timezone: string(data.timezone, 100),
        }),
      );
    }
    if (action === "send") {
      const data = payloadRecord(payload, ["roomId", "text", "idempotencyKey"]);
      return jsonResponse(
        await sendRoomMessage(actor, {
          roomId: string(data.roomId, 100),
          text: string(data.text, 4000),
          idempotencyKey: string(data.idempotencyKey, 100),
        }),
      );
    }
    if (action === "pause" || action === "resume" || action === "end") {
      const data = payloadRecord(payload, ["roomId"]);
      return jsonResponse(
        await controlRoom(actor, { roomId: string(data.roomId, 100), action }),
      );
    }
    if (action === "consent") {
      const data = payloadRecord(payload, ["participation"]);
      return jsonResponse(
        await savePortalConsent(actor, {
          participation: boolean(data.participation),
        }),
      );
    }
    if (action === "withdraw") {
      const data = payloadRecord(payload, ["destroyContent"]);
      const result = await withdrawPortal(actor, {
        destroyContent: boolean(data.destroyContent),
      });
      const response = await logoutPortal(request, portal);
      return jsonResponse(result, 200, {
        "Set-Cookie": response.headers.get("Set-Cookie")!,
      });
    }
    throw new GatewayError(400, "REQUEST_REJECTED");
  } catch (error) {
    return safeError(error);
  }
}
