import assert from "node:assert/strict";
import test from "node:test";
import {
  enforceRateLimit,
  GatewayError,
  requestRateKey,
} from "../src/server/http";

const isRateLimited = (error: unknown) =>
  error instanceof GatewayError &&
  error.status === 429 &&
  error.code === "TRY_AGAIN_LATER";

test("a full rate table admits new keys without evicting active limits", (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, "now", () => now);
  const known = "capacity:existing-user";
  enforceRateLimit(known, 2);
  enforceRateLimit(known, 2);
  for (let index = 0; index < 9_999; index++) {
    enforceRateLimit(`capacity:filler:${index}`);
  }

  const newcomer = "capacity:new-user";
  assert.doesNotThrow(() => enforceRateLimit(newcomer, 2));
  assert.doesNotThrow(() => enforceRateLimit(newcomer, 2));
  assert.throws(() => enforceRateLimit(newcomer, 2), isRateLimited);

  // Cookie churn must not evict and reset the existing user's exact counter.
  for (let index = 0; index < 5_000; index++) {
    try {
      enforceRateLimit(`capacity:rotated-cookie:${index}`, 2);
    } catch (error) {
      assert.ok(isRateLimited(error));
    }
  }
  assert.throws(() => enforceRateLimit(known, 2), isRateLimited);
  assert.throws(() => enforceRateLimit(newcomer, 2), isRateLimited);

  now += 60_000;
  assert.doesNotThrow(() => enforceRateLimit(known, 2));
  assert.doesNotThrow(() => enforceRateLimit(newcomer, 2));
});

test("an overflow key keeps its spent budget when exact capacity returns", (t) => {
  let now = 2_000_001_000_000;
  t.mock.method(Date, "now", () => now);
  for (let index = 0; index < 10_000; index++) {
    enforceRateLimit(`promotion:filler:${index}`, 90, 1_000);
  }
  const key = "promotion:new-user";
  enforceRateLimit(key, 2, 60_000);
  now += 1_001;
  assert.doesNotThrow(() => enforceRateLimit(key, 2, 60_000));
  assert.throws(() => enforceRateLimit(key, 2, 60_000), isRateLimited);
  now += 60_000;
  assert.doesNotThrow(() => enforceRateLimit(key, 2, 60_000));
});

test("rate keys ignore untrusted forwarded IP headers", () => {
  const request = (forwardedFor: string) =>
    new Request("http://127.0.0.1:3000/api/play", {
      headers: {
        cookie: "clone_play_session=example-token",
        "x-forwarded-for": forwardedFor,
      },
    });
  assert.equal(
    requestRateKey(request("192.0.2.1")),
    requestRateKey(request("198.51.100.2")),
  );
});
