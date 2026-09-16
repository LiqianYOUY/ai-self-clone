import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "./db";
import {
  allowedOrigin,
  assertMutationRequest,
  enforceRateLimit,
  GatewayError,
  jsonResponse,
} from "./http";

export const ROLES = ["RESEARCHER", "FRIEND", "TARGET", "ANALYST"] as const;
export type Role = (typeof ROLES)[number];
export type Actor = { id: string; role: Role; pseudonym: string };
export const PORTALS = ["research", "target", "friend"] as const;
export type Portal = (typeof PORTALS)[number];
export const SESSION_COOKIE = "clone_study_session";
export const PORTAL_COOKIES: Record<Portal, string> = {
  research: "clone_research_session",
  target: "clone_target_session",
  friend: "clone_friend_session",
};
const MAX_AGE_SECONDS = 8 * 60 * 60;
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

function sessionToken(request: Request, cookieName = SESSION_COOKIE): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie || cookie.length > 8192) return null;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookieName) {
      const token = value.join("=");
      return /^[a-f0-9]{64}$/.test(token) ? token : null;
    }
  }
  return null;
}

export function requestPortal(request: Request): Portal {
  const portal = request.headers.get("x-study-portal");
  if (!PORTALS.includes(portal as Portal))
    throw new GatewayError(400, "REQUEST_REJECTED");
  return portal as Portal;
}

export function roleMatchesPortal(role: string, portal: Portal): boolean {
  return portal === "research"
    ? role === "RESEARCHER" || role === "ANALYST"
    : portal === "target"
      ? role === "TARGET"
      : role === "FRIEND";
}

export async function getActor(request: Request, portal?: Portal): Promise<Actor | null> {
  const selected = portal ?? (request.headers.has("x-study-portal") ? requestPortal(request) : undefined);
  const token = sessionToken(request, selected ? PORTAL_COOKIES[selected] : SESSION_COOKIE);
  if (!token) return null;
  const session = await prisma.authSession.findUnique({
    where: { tokenHash: hash(token) },
    include: { participant: true },
  });
  if (
    !session ||
    session.expiresAt <= new Date() ||
    !session.participant.active ||
    (session.portal ?? null) !== (selected ?? null)
  )
    return null;
  const participant = session.participant;
  if (!ROLES.includes(participant.role as Role)) return null;
  if (selected && !roleMatchesPortal(participant.role, selected)) return null;
  return {
    id: participant.id,
    role: participant.role as Role,
    pseudonym: participant.pseudonym,
  };
}

export async function getPortalActor(request: Request, portal = requestPortal(request)) {
  return getActor(request, portal);
}

export async function requireActor(request: Request): Promise<Actor> {
  const actor = await getActor(request);
  if (!actor) throw new GatewayError(401, "AUTHENTICATION_REQUIRED");
  enforceRateLimit(`actor:${actor.id}`, 180);
  return actor;
}

function secureCookie(): boolean {
  return new URL(allowedOrigin()).protocol === "https:";
}
function cookieValue(token: string, age = MAX_AGE_SECONDS, cookieName = SESSION_COOKIE): string {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookie() ? "; Secure" : ""}`;
}

/** Each portal has an independent persisted session, including within one browser. */
export async function createPortalSession(
  request: Request,
  portal: Portal,
  actor: Actor,
): Promise<Response> {
  if (!roleMatchesPortal(actor.role, portal) || actor.id.startsWith("demo-"))
    throw new GatewayError(403, "FORBIDDEN");
  const account = await prisma.account.findUnique({
    where: { participantId: actor.id },
    include: { participant: true },
  });
  if (!account?.participant.active || !roleMatchesPortal(account.participant.role, portal))
    throw new GatewayError(401, "AUTHENTICATION_REQUIRED");
  const previous = sessionToken(request, PORTAL_COOKIES[portal]);
  if (previous)
    await prisma.authSession.deleteMany({ where: { tokenHash: hash(previous), portal } });
  const token = randomBytes(32).toString("hex");
  await prisma.authSession.create({
    data: {
      tokenHash: hash(token),
      participantId: account.participantId,
      portal,
      expiresAt: new Date(Date.now() + MAX_AGE_SECONDS * 1000),
    },
  });
  await prisma.authSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return jsonResponse(
    { actor: { id: account.participant.id, role: account.participant.role, pseudonym: account.participant.pseudonym }, portal },
    200,
    { "Set-Cookie": cookieValue(token, MAX_AGE_SECONDS, PORTAL_COOKIES[portal]) },
  );
}

export async function logoutPortal(request: Request, portal = requestPortal(request)): Promise<Response> {
  assertMutationRequest(request);
  const token = sessionToken(request, PORTAL_COOKIES[portal]);
  if (token)
    await prisma.authSession.deleteMany({ where: { tokenHash: hash(token), portal } });
  return jsonResponse({ actor: null, portal }, 200, {
    "Set-Cookie": cookieValue("", 0, PORTAL_COOKIES[portal]),
  });
}

/** Synthetic role switching is never a production authentication adapter. */
function requireDemoAccess(request: Request): void {
  if (process.env.STUDY_MODE !== "synthetic")
    throw new GatewayError(403, "REQUEST_REJECTED");
  const configuredSecret = process.env.DEMO_ACCESS_TOKEN;
  if (configuredSecret) {
    const provided = request.headers.get("x-demo-access-token") ?? "";
    const left = Buffer.from(hash(provided));
    const right = Buffer.from(hash(configuredSecret));
    if (configuredSecret.length < 24 || !timingSafeEqual(left, right))
      throw new GatewayError(403, "REQUEST_REJECTED");
    return;
  }
  const bindHost = process.env.APP_HOST ?? "127.0.0.1";
  const configured = new URL(allowedOrigin());
  const loopback = (host: string) =>
    ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host);
  if (!loopback(bindHost) || !loopback(configured.hostname))
    throw new GatewayError(403, "REQUEST_REJECTED");
}

export async function loginDemo(
  request: Request,
  role: Role | string,
  participantId?: string,
): Promise<Response> {
  assertMutationRequest(request);
  requireDemoAccess(request);
  enforceRateLimit("demo-login", 90);
  if (!ROLES.includes(role as Role))
    throw new GatewayError(400, "REQUEST_REJECTED");
  if (participantId && !/^demo-[A-Za-z0-9_-]{1,100}$/.test(participantId))
    throw new GatewayError(400, "REQUEST_REJECTED");
  const participant = await prisma.participant.findFirst({
    where: { role, active: true, id: participantId ?? { startsWith: "demo-" } },
    orderBy: { id: "asc" },
  });
  if (!participant) throw new GatewayError(401, "AUTHENTICATION_REQUIRED");
  const previous = sessionToken(request);
  if (previous)
    await prisma.authSession.deleteMany({
      where: { tokenHash: hash(previous) },
    });
  const token = randomBytes(32).toString("hex");
  await prisma.authSession.create({
    data: {
      tokenHash: hash(token),
      participantId: participant.id,
      expiresAt: new Date(Date.now() + MAX_AGE_SECONDS * 1000),
    },
  });
  await prisma.authSession.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return jsonResponse(
    {
      actor: {
        id: participant.id,
        role: participant.role,
        pseudonym: participant.pseudonym,
      },
      mode: "synthetic",
    },
    200,
    { "Set-Cookie": cookieValue(token) },
  );
}

export async function logout(request: Request): Promise<Response> {
  assertMutationRequest(request);
  const token = sessionToken(request);
  if (token)
    await prisma.authSession.deleteMany({ where: { tokenHash: hash(token) } });
  return jsonResponse({ actor: null }, 200, {
    "Set-Cookie": cookieValue("", 0),
  });
}

export { assertMutationRequest } from "./http";
