import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  createPortalSession,
  getActor,
  getPortalActor,
  logoutPortal,
  PORTAL_COOKIES,
  requestPortal,
} from "../src/server/auth";
import { prisma } from "../src/server/db";
import { GatewayError } from "../src/server/http";

process.env.APP_ORIGIN = "http://127.0.0.1:3000";
const token = "a".repeat(64);
const otherToken = "b".repeat(64);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const actor = { id: "target-real", role: "TARGET" as const, pseudonym: "Target A" };
const session = (portal: string | null = "target", overrides = {}) => ({
  id: "login-a", tokenHash: digest(token), portal, participantId: actor.id,
  expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
  participant: { ...actor, active: true, timezone: "Australia/Sydney", createdAt: new Date() },
  ...overrides,
});
function replaceMethod(t: TestContext, delegate: any, name: string, implementation: (...args: any[]) => any) {
  const previous = delegate[name];
  const mock = t.mock.fn(implementation);
  delegate[name] = mock;
  t.after(() => { delegate[name] = previous; });
  return mock;
}
const request = (cookie: string, portal?: string, post = false) => new Request("http://127.0.0.1:3000/api/portal", {
  method: post ? "POST" : "GET",
  headers: {
    cookie, ...(portal === undefined ? {} : { "x-study-portal": portal }),
    ...(post ? { origin: "http://127.0.0.1:3000", "content-type": "application/json" } : {}),
  },
  ...(post ? { body: "{}" } : {}),
});

test("portal authentication selects its own cookie when all three portals are signed in", async (t) => {
  const calls: unknown[] = [];
  replaceMethod(t, prisma.authSession, "findUnique", async (args: unknown) => { calls.push(args); return session(); });
  const result = await getActor(request([
    `clone_research_session=${otherToken}`, `clone_target_session=${token}`,
    `clone_friend_session=${otherToken}`, `clone_study_session=${otherToken}`,
  ].join("; "), "target"));
  assert.deepEqual(result, actor);
  assert.deepEqual(calls, [{ where: { tokenHash: digest(token) }, include: { participant: true } }]);
});

test("a missing portal cookie never falls back to a demo or another portal session", async (t) => {
  const find = replaceMethod(t, prisma.authSession, "findUnique", async () => session());
  assert.equal(await getPortalActor(request(`clone_study_session=${token}; clone_friend_session=${token}`, "target")), null);
  assert.equal(find.mock.callCount(), 0);
});

test("copying an opaque token into another portal cookie does not switch its portal or role", async (t) => {
  const find = replaceMethod(t, prisma.authSession, "findUnique", async () => session("friend"));
  assert.equal(await getActor(request(`clone_target_session=${token}`, "target")), null);
  find.mock.mockImplementation(async () => session("target", { participant: { ...actor, role: "RESEARCHER", active: true } }));
  assert.equal(await getActor(request(`clone_target_session=${token}`, "target")), null);
  find.mock.mockImplementation(async () => session("target"));
  assert.equal(await getActor(request(`clone_study_session=${token}`)), null);
});

test("legacy demo sessions remain available only with the legacy cookie and no portal selection", async (t) => {
  replaceMethod(t, prisma.authSession, "findUnique", async () => session(null));
  assert.deepEqual(await getActor(request(`clone_study_session=${token}`)), actor);
  assert.equal(await getActor(request(`clone_target_session=${token}`, "target")), null);
});

test("expired, inactive and malformed portal requests cannot authenticate", async (t) => {
  const find = replaceMethod(t, prisma.authSession, "findUnique", async () => session("target", { expiresAt: new Date(0) }));
  assert.equal(await getActor(request(`clone_target_session=${token}`, "target")), null);
  find.mock.mockImplementation(async () => session("target", { participant: { ...actor, active: false } }));
  assert.equal(await getActor(request(`clone_target_session=${token}`, "target")), null);
  assert.throws(() => requestPortal(request("", "analyst")), GatewayError);
  assert.throws(() => requestPortal(request("")), GatewayError);
  await assert.rejects(getActor(request(`clone_study_session=${token}`, "TARGET")), GatewayError);
});

test("creating a portal login stores a hash and returns only the actor with an HttpOnly cookie", async (t) => {
  const creates: Array<Record<string, any>> = [];
  const deletes: unknown[] = [];
  replaceMethod(t, prisma.account, "findUnique", async () => ({ participantId: actor.id, participant: { ...actor, active: true } }));
  replaceMethod(t, prisma.authSession, "create", async (args: Record<string, any>) => { creates.push(args); return args.data; });
  replaceMethod(t, prisma.authSession, "deleteMany", async (args: unknown) => { deletes.push(args); return { count: 1 }; });
  const response = await createPortalSession(request(`clone_target_session=${token}; clone_friend_session=${otherToken}`, "target", true), "target", actor);
  assert.deepEqual(await response.json(), { actor, portal: "target" });
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /^clone_target_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800$/);
  assert.equal(creates[0].data.portal, "target");
  assert.equal(creates[0].data.tokenHash, digest(cookie.split(";")[0].split("=")[1]));
  assert.deepEqual(deletes[0], { where: { tokenHash: digest(token), portal: "target" } });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("portal session creation rejects demo and mismatched role actors before writing", async () => {
  await assert.rejects(createPortalSession(request("", "target", true), "target", { ...actor, id: "demo-target" }), GatewayError);
  await assert.rejects(createPortalSession(request("", "friend", true), "friend", actor), GatewayError);
});

test("logout revokes and clears only the selected portal's session", async (t) => {
  const deletes: unknown[] = [];
  replaceMethod(t, prisma.authSession, "deleteMany", async (args: unknown) => { deletes.push(args); return { count: 1 }; });
  const response = await logoutPortal(request(`${PORTAL_COOKIES.target}=${token}; ${PORTAL_COOKIES.friend}=${otherToken}`, "target", true));
  assert.deepEqual(deletes, [{ where: { tokenHash: digest(token), portal: "target" } }]);
  assert.match(response.headers.get("set-cookie")!, /^clone_target_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0$/);
  assert.deepEqual(await response.json(), { actor: null, portal: "target" });
});
