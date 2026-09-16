import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { GET, POST } from "../src/app/api/portal/route";
import { GET as studyGet, POST as studyPost } from "../src/app/api/study/route";
import { prisma } from "../src/server/db";

process.env.APP_ORIGIN = "http://127.0.0.1:3000";
const origin = "http://127.0.0.1:3000";
const token = "c".repeat(64);
function replaceMethod(
  t: TestContext,
  delegate: any,
  name: string,
  implementation: (...args: any[]) => any,
) {
  const previous = delegate[name];
  const mock = t.mock.fn(implementation);
  delegate[name] = mock;
  t.after(() => {
    delegate[name] = previous;
  });
  return mock;
}
const mutation = (
  body: unknown,
  portal = "target",
  headers: Record<string, string> = {},
) =>
  new Request(origin + "/api/portal", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-study-portal": portal,
      ...headers,
    },
    body: JSON.stringify(body),
  });

test("portal gateway rejects missing or unrecognized portal without falling back", async () => {
  for (const portal of [undefined, "ANALYST", "demo", "target,friend"]) {
    const response = await GET(
      new Request(origin + "/api/portal?view=home", {
        headers: {
          cookie: `clone_study_session=${token}`,
          ...(portal ? { "x-study-portal": portal } : {}),
        },
      }),
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "REQUEST_REJECTED");
  }
});

test("account and invitation mutations reject foreign origins before any credential work", async () => {
  const response = await POST(
    mutation({ action: "register", payload: {} }, "target", {
      origin: "https://attacker.example",
    }),
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "REQUEST_REJECTED");
  const preview = await POST(
    mutation(
      { action: "inspectInvitation", payload: { token: "private-invitation" } },
      "target",
      { origin: "https://attacker.example" },
    ),
  );
  assert.equal(preview.status, 403);
});

test("invitation preview refuses URL tokens and only accepts the exact POST body", async () => {
  const get = await GET(
    new Request(
      origin + "/api/portal?view=invitation&token=private-invitation",
      { headers: { "x-study-portal": "target" } },
    ),
  );
  assert.equal(get.status, 400);
  const injected = await POST(
    mutation({
      action: "inspectInvitation",
      payload: { token: "private-invitation", role: "TARGET" },
    }),
  );
  assert.equal(injected.status, 400);
  assert.ok(
    !JSON.stringify(await injected.json()).includes("private-invitation"),
  );
});

test("portal gateway rejects actor injection and unexpected action fields", async () => {
  for (const body of [
    {
      action: "login",
      payload: {
        username: "alice",
        password: "validpassword12",
        actorId: "demo-researcher",
      },
    },
    { action: "logout", payload: { role: "RESEARCHER" } },
    { action: "logout", payload: {}, actor: { role: "RESEARCHER" } },
  ]) {
    const response = await POST(mutation(body));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "REQUEST_REJECTED");
  }
});

test("portal registration needs exact participation consent and rejects oversized received bodies", async () => {
  const response = await POST(
    mutation({
      action: "register",
      payload: {
        token: "token",
        username: "alice",
        password: "validpassword12",
        pseudonym: "Alice",
        consent: { participation: false, version: "enrollment-v1" },
      },
    }),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "CONSENT_REQUIRED");
  const oversized = await POST(
    mutation(
      { action: "send", payload: { text: "界".repeat(7000) } },
      "target",
      { "content-length": "1" },
    ),
  );
  assert.equal(oversized.status, 413);
});

test("real target and friend credentials cannot read or mutate the legacy study", async (t) => {
  const write = replaceMethod(t, prisma.consent, "create", async () => {
    throw new Error("Legacy consent must not be reached");
  });
  const find = replaceMethod(
    t,
    prisma.authSession,
    "findUnique",
    async () => null,
  );
  for (const portal of ["target", "friend"] as const) {
    find.mock.mockImplementation(async () => ({
      portal,
      expiresAt: new Date(Date.now() + 60_000),
      participant: {
        id: `real-${portal}-uuid`,
        role: portal.toUpperCase(),
        pseudonym: "Participant",
        active: true,
      },
    }));
    const headers = {
      "x-study-portal": portal,
      cookie: `clone_${portal}_session=${token}`,
    };
    for (const view of ["dashboard", "export", "development"]) {
      const response = await studyGet(
        new Request(origin + "/api/study?view=" + view, { headers }),
      );
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "FORBIDDEN");
    }
    const response = await studyPost(
      new Request(origin + "/api/study", {
        method: "POST",
        headers: { ...headers, origin, "content-type": "application/json" },
        body: JSON.stringify({
          action: "saveConsent",
          payload: { participation: true, corpusUse: true },
        }),
      }),
    );
    assert.equal(response.status, 403);
  }
  assert.equal(write.mock.callCount(), 0);
});

test("removing portal header or moving portal token into legacy cookie cannot downgrade to demonstration auth", async (t) => {
  replaceMethod(t, prisma.authSession, "findUnique", async () => ({
    portal: "target",
    expiresAt: new Date(Date.now() + 60_000),
    participant: {
      id: "real-target-uuid",
      role: "TARGET",
      pseudonym: "Participant",
      active: true,
    },
  }));
  for (const cookie of [
    `clone_target_session=${token}`,
    `clone_study_session=${token}`,
  ]) {
    const response = await studyGet(
      new Request(origin + "/api/study?view=export", { headers: { cookie } }),
    );
    assert.equal(response.status, 401);
  }
});

test("authenticated game accounts cannot enter research portals or create enrollment records", async (t) => {
  replaceMethod(t, prisma.authSession, "findUnique", async () => ({
    portal: "target",
    expiresAt: new Date(Date.now() + 60_000),
    participant: {
      id: "play-target-game-only",
      role: "TARGET",
      pseudonym: "Alias",
      active: true,
    },
  }));
  const transactions = replaceMethod(t, prisma, "$transaction", async () => {
    throw new Error("Research mutation must not be reached");
  });
  const headers = {
    "x-study-portal": "target",
    cookie: `clone_target_session=${token}`,
  };
  for (const view of ["me", "home", "rooms", "room"]) {
    const response = await GET(
      new Request(origin + "/api/portal?view=" + view, { headers }),
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "FORBIDDEN");
  }
  for (const action of [
    "consent",
    "invite",
    "profile",
    "withdraw",
    "logout",
    "register",
  ]) {
    const response = await POST(
      mutation({ action, payload: {} }, "target", headers),
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "FORBIDDEN");
  }
  assert.equal(transactions.mock.callCount(), 0);
});
