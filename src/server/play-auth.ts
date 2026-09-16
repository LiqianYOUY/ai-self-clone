import { createHash } from "node:crypto";
import { allowedOrigin, GatewayError } from "./http";

export interface PlayGuest {
  roomId: string;
  tokenHash: string;
}

const COOKIE_PREFIX = "play_guest_";
export const hashPlayToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const validRoomId = (id: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(id);

export function getPlayGuest(request: Request, roomId: string): PlayGuest {
  if (!validRoomId(roomId)) throw new GatewayError(404, "NOT_FOUND");
  const cookies = request.headers.get("cookie") ?? "";
  if (cookies.length > 12_288)
    throw new GatewayError(401, "AUTHENTICATION_REQUIRED");
  const name = `${COOKIE_PREFIX}${roomId}`;
  for (const part of cookies.split(";")) {
    const [key, token] = part.trim().split("=");
    if (key === name && /^[a-f0-9]{64}$/.test(token ?? ""))
      return { roomId, tokenHash: hashPlayToken(token) };
  }
  throw new GatewayError(401, "AUTHENTICATION_REQUIRED");
}

function serialize(name: string, value: string, age: number): string {
  return `${name}=${value}; Path=/api/play; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(allowedOrigin()).protocol === "https:" ? "; Secure" : ""}`;
}

/** Keep up to eight room capabilities without exposing them to JavaScript. */
export function playGuestCookieHeaders(
  request: Request,
  roomId: string,
  token: string,
  expiresAt: Date,
): Headers {
  const headers = new Headers();
  const currentName = `${COOKIE_PREFIX}${roomId}`;
  const existing = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim().split("=")[0])
    .filter(
      (name) =>
        name.startsWith(COOKIE_PREFIX) &&
        validRoomId(name.slice(COOKIE_PREFIX.length)) &&
        name !== currentName,
    );
  for (const name of existing.slice(0, Math.max(0, existing.length - 7)))
    headers.append("Set-Cookie", serialize(name, "", 0));
  headers.append(
    "Set-Cookie",
    serialize(
      currentName,
      token,
      Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    ),
  );
  return headers;
}
