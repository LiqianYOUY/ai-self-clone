import assert from "node:assert/strict";

const origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
const navigation: Record<string, string[]> = {
  RESEARCHER: [
    "dashboard",
    "sessions",
    "onboarding",
    "offline",
    "consent",
    "safety",
    "audit",
    "study",
    "evaluations",
  ],
  TARGET: [
    "sessions",
    "onboarding",
    "consent",
    "relationship",
    "evaluations",
    "development",
  ],
  FRIEND: ["sessions", "consent", "offline", "relationship", "evaluations"],
  ANALYST: ["audit", "study", "evaluations"],
};
const forbidden: Record<string, string[]> = {
  TARGET: ["audit", "safety", "study", "offline"],
  FRIEND: ["audit", "safety", "study", "onboarding", "development"],
  ANALYST: ["safety", "development"],
};
async function main() {
  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  let passed = 0;
  const failures: string[] = [];
  for (const [role, views] of Object.entries(navigation)) {
    const login = await fetch(`${origin}/api/auth`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(process.env.DEMO_ACCESS_TOKEN
          ? { "x-demo-access-token": process.env.DEMO_ACCESS_TOKEN }
          : {}),
      },
      body: JSON.stringify({ role }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    for (const view of views) {
      const response = await fetch(`${origin}/api/study?view=${view}`, {
        headers: { cookie },
      });
      if (response.status !== 200)
        failures.push(
          `${role} ${view}: expected 200, received ${response.status}`,
        );
      else passed++;
    }
    for (const view of forbidden[role] ?? []) {
      const response = await fetch(`${origin}/api/study?view=${view}`, {
        headers: { cookie },
      });
      if (response.status !== 403)
        failures.push(
          `${role} ${view}: expected 403, received ${response.status}`,
        );
      else passed++;
    }
    await fetch(`${origin}/api/auth`, {
      method: "DELETE",
      headers: { origin, cookie },
    });
  }
  console.log(
    `Role navigation and denial checks: ${passed} passed; ${failures.length} failed. Health passed.`,
  );
  for (const failure of failures) console.error(failure);
  assert.equal(failures.length, 0);
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Navigation smoke failed",
  );
  process.exitCode = 1;
});
