import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMutationRequest,
  enforceRateLimit,
  gatewayErrorResponse,
  GatewayError,
  isAllowedOrigin,
  readJson,
} from "../src/server/http";

process.env.APP_ORIGIN = "http://127.0.0.1:3000";

test("mutation gateway rejects cross-origin requests even with a valid-looking cookie", () => {
  const request = new Request("http://127.0.0.1:3000/api/study", {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      "content-type": "application/json",
      cookie: "clone_study_session=" + "a".repeat(64),
    },
    body: "{}",
  });
  assert.throws(
    () => assertMutationRequest(request),
    (error: unknown) => error instanceof GatewayError && error.status === 403,
  );
});

test("exact same-origin JSON is accepted but forged host suffix and missing origin are rejected", () => {
  assert.equal(
    isAllowedOrigin("http://127.0.0.1:3000.attacker.example"),
    false,
  );
  assert.equal(isAllowedOrigin(undefined), false);
  assert.doesNotThrow(() =>
    assertMutationRequest(
      new Request("http://127.0.0.1:3000/api/study", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3000",
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: "{}",
      }),
    ),
  );
});

test("body limit uses received bytes when Content-Length lies", async () => {
  const request = new Request("http://127.0.0.1:3000/api/study", {
    method: "POST",
    headers: { "content-length": "1" },
    body: JSON.stringify({ content: "界".repeat(100) }),
  });
  await assert.rejects(
    readJson(request, 100),
    (error: unknown) => error instanceof GatewayError && error.status === 413,
  );
});

test("malformed JSON and exhaustion are neutral controlled failures", async () => {
  await assert.rejects(
    readJson(
      new Request("http://127.0.0.1:3000/api/study", {
        method: "POST",
        body: "provider-private-stack",
      }),
    ),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "REQUEST_REJECTED",
  );
  const key = `test:${Date.now()}`;
  enforceRateLimit(key, 2);
  enforceRateLimit(key, 2);
  assert.throws(
    () => enforceRateLimit(key, 2),
    (error: unknown) => error instanceof GatewayError && error.status === 429,
  );
});

test("unknown internal exceptions never serialize their message or stack", async () => {
  const response = gatewayErrorResponse(new Error("AI_PROVIDER_SECRET_BODY"));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "REQUEST_FAILED" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});
