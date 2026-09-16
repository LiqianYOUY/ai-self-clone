/** Non-destructive synthetic gateway / Socket.IO smoke against a running app. */
import assert from "node:assert/strict";
import { io, type Socket } from "socket.io-client";

const origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
const passed: string[] = [];
const sockets: Socket[] = [];
const checked = (name: string) => {
  passed.push(name);
  console.log(`PASS ${name}`);
};
async function login(role: string, participantId?: string) {
  const response = await fetch(`${origin}/api/auth`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(process.env.DEMO_ACCESS_TOKEN
        ? { "x-demo-access-token": process.env.DEMO_ACCESS_TOKEN }
        : {}),
    },
    body: JSON.stringify({ role, ...(participantId ? { participantId } : {}) }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /clone_study_session=[a-f0-9]{64};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  return cookie.split(";")[0];
}
const get = async (cookie: string, view: string, id?: string) =>
  fetch(`${origin}/api/study?view=${view}${id ? `&id=${id}` : ""}`, {
    headers: { cookie },
  });
function noPrivateKeys(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(
      !/^(condition|privateCondition|provider|providerId|model|modelId|sourceVersion|epoch|seed|quota|assignmentHash|remainingQuota)$/i.test(
        key,
      ),
      `Private DTO key ${key}`,
    );
    noPrivateKeys(item);
  }
}
function connect(cookie: string, transport: "websocket" | "polling") {
  return new Promise<Socket>((resolve, reject) => {
    const socket = io(origin, {
      path: "/socket.io",
      transports: [transport],
      extraHeaders: { origin, cookie },
      reconnection: false,
      timeout: 5000,
    });
    sockets.push(socket);
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}
async function watch(socket: Socket, sessionId: string) {
  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("No public socket projection received")),
      6000,
    );
    socket.once("session:update", (projection) => {
      clearTimeout(timeout);
      resolve(projection);
    });
    socket.emit("session:watch", { sessionId });
  });
}
async function main() {
  assert.equal((await fetch(`${origin}/api/study?view=sessions`)).status, 401);
  checked("anonymous research read rejected with 401");
  for (const hostileOrigin of ["", "https://attacker.example"]) {
    assert.equal(
      (
        await fetch(`${origin}/api/auth`, {
          method: "POST",
          headers: {
            origin: hostileOrigin,
            "content-type": "application/json",
          },
          body: '{"role":"RESEARCHER"}',
        })
      ).status,
      403,
    );
  }
  checked("missing and cross-origin login rejected with 403");
  const friend = await login("FRIEND", "demo-friend-01");
  const researcher = await login("RESEARCHER");
  checked("synthetic identities use opaque HttpOnly SameSite cookies");
  const friendSessions = await (await get(friend, "sessions")).json();
  noPrivateKeys(friendSessions);
  assert.equal(friendSessions.sessions.length, 6);
  const selected = friendSessions.sessions[0].id;
  const projection = await (await get(friend, "session", selected)).json();
  noPrivateKeys(projection);
  assert.ok(
    projection.messages.every((message: { role: string }) =>
      ["FRIEND", "SOURCE", "STUDY_NOTICE"].includes(message.role),
    ),
  );
  checked("friend session and message DTOs contain only neutral public fields");
  const all = await (await get(researcher, "sessions")).json();
  const ownIds = new Set(
    friendSessions.sessions.map((session: { id: string }) => session.id),
  );
  const other = all.sessions.find(
    (session: { id: string }) => !ownIds.has(session.id),
  ).id;
  assert.equal((await get(friend, "session", other)).status, 403);
  assert.equal((await get(friend, "study")).status, 403);
  checked("cross-dyad and study-assignment access rejected with 403");
  const forged = await fetch(`${origin}/api/study`, {
    method: "POST",
    headers: { origin, cookie: friend, "content-type": "application/json" },
    body: JSON.stringify({
      action: "controlSession",
      payload: {
        sessionId: selected,
        action: "start",
        actor: { id: "demo-researcher", role: "RESEARCHER" },
      },
    }),
  });
  assert.equal(forged.status, 400);
  checked("request body cannot replace the authenticated actor");
  const webSocket = await connect(friend, "websocket");
  assert.deepEqual(await watch(webSocket, selected), projection);
  checked("WebSocket uses the same authorized public DTO as HTTP");
  const refused = await new Promise<{ ok: boolean }>((resolve) =>
    webSocket.emit("session:watch", { sessionId: other }, resolve),
  );
  assert.equal(refused.ok, false);
  checked("WebSocket rechecks cross-dyad authorization per subscription");
  const pollingSocket = await connect(friend, "polling");
  assert.deepEqual(await watch(pollingSocket, selected), projection);
  checked("Socket.IO polling fallback preserves the same public DTO");
  const disconnected = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Socket did not revalidate revoked login")),
      5000,
    );
    pollingSocket.once("disconnect", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  assert.equal(
    (
      await fetch(`${origin}/api/auth`, {
        method: "DELETE",
        headers: { origin, cookie: friend },
      })
    ).status,
    200,
  );
  assert.equal((await get(friend, "sessions")).status, 401);
  await disconnected;
  checked("logout revokes persisted cookie and active socket authorization");
  await fetch(`${origin}/api/auth`, {
    method: "DELETE",
    headers: { origin, cookie: researcher },
  });
  console.log(
    `Runtime smoke: ${passed.length}/${passed.length} passed; no study records modified.`,
  );
}
main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Runtime smoke failed",
    );
    process.exitCode = 1;
  })
  .finally(() => sockets.forEach((socket) => socket.disconnect()));
