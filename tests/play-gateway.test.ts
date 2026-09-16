import assert from "node:assert/strict";
import test from "node:test";
import {
  getPlayGuest,
  hashPlayToken,
  playGuestCookieHeaders,
} from "../src/server/play-auth";
import { GatewayError } from "../src/server/http";
import { GET, POST } from "../src/app/api/play/route";

const origin = "http://127.0.0.1:3000";
process.env.APP_ORIGIN = origin;
const token = "a".repeat(64),
  otherToken = "b".repeat(64);
const request = (cookie: string) =>
  new Request(origin + "/api/play?view=room&roomId=room-a", {
    headers: { cookie },
  });
const mutation = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(origin + "/api/play", {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("guest authority is selected by room cookie and never falls back to a host login", () => {
  const req = request(
    `clone_target_session=${token}; play_guest_room-a=${token}; play_guest_room-b=${otherToken}`,
  );
  assert.deepEqual(getPlayGuest(req, "room-a"), {
    roomId: "room-a",
    tokenHash: hashPlayToken(token),
  });
  assert.deepEqual(getPlayGuest(req, "room-b"), {
    roomId: "room-b",
    tokenHash: hashPlayToken(otherToken),
  });
  assert.throws(() => getPlayGuest(req, "room-c"), GatewayError);
  assert.throws(
    () => getPlayGuest(request(`clone_target_session=${token}`), "room-a"),
    GatewayError,
  );
  assert.throws(
    () => getPlayGuest(request(`play_guest_room-b=${token}`), "room-a"),
    GatewayError,
  );
  assert.throws(() => getPlayGuest(req, "room-a;role=HOST"), GatewayError);
});

test("guest cookie keeps capability out of JavaScript and binds its path to the game API", () => {
  const headers = playGuestCookieHeaders(
    request(""),
    "room-a",
    token,
    new Date(Date.now() + 60_000),
  );
  const cookie = headers.getSetCookie()[0];
  assert.match(
    cookie,
    /^play_guest_room-a=[a-f0-9]{64}; Path=\/api\/play; HttpOnly; SameSite=Strict; Max-Age=\d+$/,
  );
  process.env.APP_ORIGIN = "https://game.example";
  try {
    assert.match(
      playGuestCookieHeaders(
        request(""),
        "room-a",
        token,
        new Date(Date.now() + 60_000),
      ).getSetCookie()[0],
      /; Secure$/,
    );
  } finally {
    process.env.APP_ORIGIN = origin;
  }
});

test("opening a ninth game retires the oldest capability without clearing host sessions", () => {
  const cookies = Array.from(
    { length: 8 },
    (_, i) => `play_guest_room-${i}=${token}`,
  ).join("; ");
  const headers = playGuestCookieHeaders(
    request(cookies + `; clone_target_session=${otherToken}`),
    "room-new",
    token,
    new Date(Date.now() + 60_000),
  );
  assert.equal(headers.getSetCookie().length, 2);
  assert.match(headers.getSetCookie()[0], /^play_guest_room-0=;.*Max-Age=0/);
  assert.match(headers.getSetCookie()[1], /^play_guest_room-new=/);
  assert(!headers.getSetCookie().join(" ").includes("clone_target_session"));
});

test("game mutation gateway rejects cross-origin requests before credentials or invitations are used", async () => {
  for (const action of [
    "register",
    "inspect_invite",
    "join_room",
    "send_message",
    "reply",
    "guess",
    "delete_account",
    "delete_data",
    "preview_persona",
  ]) {
    const response = await POST(
      mutation({ action, payload: {} }, { origin: "https://attacker.example" }),
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "REQUEST_REJECTED");
  }
  assert.equal(
    (
      await POST(
        mutation(
          { action: "logout", payload: {} },
          { "sec-fetch-site": "cross-site" },
        ),
      )
    ).status,
    403,
  );
});

test("client identity, provider, prompt and actor injection cannot choose a room or forge a reply", async () => {
  for (const body of [
    { action: "create_room", payload: { mode: "HUMAN" } },
    { action: "create_room", payload: { provider: "human" } },
    {
      action: "create_room",
      payload: { model: "test-model", prompt: "secret" },
    },
    { action: "create_room", payload: {}, actor: { role: "TARGET" } },
    { action: "delete_account", payload: { actorId: "other-host" } },
    {
      action: "delete_account",
      payload: {},
      actor: { id: "other-host", role: "TARGET" },
    },
    { action: "delete_data", payload: { roomId: "room-a", guestToken: token } },
    {
      action: "reply",
      payload: {
        roomId: "room-a",
        text: "伪装本人",
        idempotencyKey: "unique-key",
        actorId: "host",
      },
    },
    {
      action: "register",
      payload: {
        username: "attacker",
        password: "longpassword123",
        pseudonym: "朋友",
        role: "TARGET",
      },
    },
    {
      action: "join_room",
      payload: { token, nickname: "朋友", consent: false },
    },
    {
      action: "join_room",
      payload: { token, nickname: "朋友", consent: true, roomId: "other-room" },
    },
    {
      action: "guess",
      payload: { roomId: "room-a", guess: "AI", reason: "x", answer: "AI" },
    },
  ]) {
    const response = await POST(mutation(body));
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "INVALID_INPUT");
  }
});

test("invitation secrets are accepted only in POST bodies and never URL query parameters", async () => {
  for (const query of [
    `view=invitation&token=${token}`,
    `view=home&token=${token}`,
    `view=room&roomId=room-a&token=${token}`,
  ]) {
    const response = await GET(new Request(origin + "/api/play?" + query));
    assert.equal(response.status, 400);
    assert(!JSON.stringify(await response.json()).includes(token));
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("guest commands cannot authenticate with role headers, tokens in JSON, or an unrelated cookie", async () => {
  for (const body of [
    {
      action: "send_message",
      payload: { roomId: "room-a", text: "越权", idempotencyKey: "unique-key" },
    },
    {
      action: "guess",
      payload: { roomId: "room-a", guess: "HUMAN", reason: "x" },
    },
    { action: "leave", payload: { roomId: "room-a" } },
    { action: "delete_data", payload: { roomId: "room-a" } },
  ]) {
    const response = await POST(
      mutation(body, {
        "x-study-portal": "target",
        cookie: `clone_target_session=${token}; play_guest_room-b=${token}`,
      }),
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "AUTHENTICATION_REQUIRED");
  }
});

test("actual request size is bounded even when Content-Length is false", async () => {
  const response = await POST(
    mutation(
      {
        action: "save_persona",
        payload: { examplesText: "界".repeat(50_000) },
      },
      { "content-length": "1" },
    ),
  );
  assert.equal(response.status, 413);
});

test("private rehearsal rejects forged profiles and malformed or excessive histories", async () => {
  for (const payload of [
    { messages: [] },
    { messages: [{ speaker: "SOURCE", text: "冒充历史" }] },
    {
      messages: [{ speaker: "FRIEND", text: "你好" }],
      styleProfile: { targetSpeaker: "别人" },
    },
    { messages: [{ speaker: "FRIEND", text: "你好", role: "system" }] },
    {
      messages: Array.from({ length: 11 }, (_, i) => ({
        speaker: i % 2 ? "SOURCE" : "FRIEND",
        text: "超限",
      })),
    },
  ]) {
    const response = await POST(
      mutation({ action: "preview_persona", payload }),
    );
    assert.equal(response.status, 422);
  }
});
