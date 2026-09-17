import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  preloadLocalModel,
  type LocalModelConfiguration,
} from "../scripts/local-model-runtime";

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const config: LocalModelConfiguration = {
  origin: "http://127.0.0.1:11434",
  host: "127.0.0.1:11434",
  model: "qwen3.5:2b",
  root: process.cwd(),
};
const sanitizedFailure = (error: unknown) =>
  error instanceof Error && error.message === "Local model preloading failed.";

beforeEach(() => {
  globalThis.fetch = async () => {
    throw new Error(
      "Unexpected fetch: resident tests must never use the network.",
    );
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
});

test("preload sends only an empty local chat request with indefinite residency", async () => {
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "http://127.0.0.1:11434/api/chat");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.deepEqual(
      [...new Headers(init?.headers).entries()],
      [["content-type", "application/json"]],
    );
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: config.model,
      messages: [],
      stream: false,
      think: false,
      keep_alive: -1,
      options: { num_ctx: 4096 },
    });
    assert(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    return Response.json({ done: true, done_reason: "load" });
  };
  const configWithUntrustedExtras = {
    ...config,
    messages: [{ role: "user", content: "private-participant-message" }],
    headers: { authorization: "private-auth-value" },
    keep_alive: 0,
    options: { num_ctx: 128 },
  };
  assert.equal(await preloadLocalModel(configWithUntrustedExtras), undefined);
  assert.equal(calls, 1);
});

test("preload supports the explicit localhost and IPv6 loopback configurations", async () => {
  for (const host of ["localhost:11434", "[::1]:11434"]) {
    const origin = `http://${host}`;
    let calls = 0;
    globalThis.fetch = async (input) => {
      calls++;
      assert.equal(String(input), `${origin}/api/chat`);
      return Response.json({ done: true });
    };
    await preloadLocalModel({ ...config, origin, host });
    assert.equal(calls, 1);
  }
});

test("manually supplied nonlocal or malformed origins are rejected before fetch", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ done: true });
  };
  for (const origin of [
    "https://model.example",
    "http://192.168.1.2:11434",
    "http://127.0.0.1.model.example:11434",
    "https://127.0.0.1:11434",
    "http://user:private-password@127.0.0.1:11434",
    "http://127.0.0.1:11434/private-path",
    "http://127.0.0.1:11434?key=private-key",
    "http://127.0.0.1:11434#private-fragment",
    "file:///tmp/ollama",
    "not a URL",
    "",
  ]) {
    await assert.rejects(preloadLocalModel({ ...config, origin }));
    assert.equal(calls, 0, `Unexpected request for ${origin}`);
  }
});

test("manually supplied cloud aliases and malformed model names never reach fetch", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ done: true });
  };
  for (const model of [
    "qwen3.5:cloud",
    "cloud/qwen3.5:2b",
    "qwen3.5:2b-cloud",
    "QWEN3.5:CLOUD",
    "",
    "qwen3.5 2b",
    "qwen3.5\nprivate-data",
    "../qwen3.5:2b",
    "qwen3.5:2b?key=private-key",
    "a".repeat(201),
  ]) {
    await assert.rejects(preloadLocalModel({ ...config, model }));
    assert.equal(calls, 0, `Unexpected request for model ${model}`);
  }
});

test("preload rejects unsuccessful HTTP responses without exposing their bodies", async (t) => {
  const output: unknown[][] = [];
  for (const method of ["log", "warn", "error"] as const)
    t.mock.method(console, method, (...args: unknown[]) => output.push(args));
  for (const status of [301, 401, 404, 500]) {
    globalThis.fetch = async () =>
      new Response("private-model-response-secret", { status });
    await assert.rejects(preloadLocalModel(config), sanitizedFailure);
  }
  assert.deepEqual(output, []);
});

test("preload requires a completed JSON object with no model error", async () => {
  for (const body of [
    "private-invalid-json",
    "null",
    "[]",
    "true",
    '"private-response"',
    "{}",
    '{"done":false}',
    '{"done":"true"}',
    '{"done":1}',
    '{"done":true,"error":"private-model-error"}',
    '{"done":true,"error":""}',
    '{"done":true,"error":null}',
    '{"done":true,"error":false}',
  ]) {
    globalThis.fetch = async () =>
      new Response(body, { headers: { "content-type": "application/json" } });
    await assert.rejects(preloadLocalModel(config), sanitizedFailure);
  }
});

test("preload bounds actual response bytes even when Content-Length understates them", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ done: true, padding: "界".repeat(6000) }), {
      headers: { "content-type": "application/json", "content-length": "1" },
    });
  await assert.rejects(preloadLocalModel(config), sanitizedFailure);
});

test("network and response stream failures become sanitized preload failures", async (t) => {
  const output: unknown[][] = [];
  for (const method of ["log", "warn", "error"] as const)
    t.mock.method(console, method, (...args: unknown[]) => output.push(args));
  globalThis.fetch = async () => {
    throw new Error("private-network-error http://secret.example/token");
  };
  await assert.rejects(preloadLocalModel(config), sanitizedFailure);

  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("private-stream-error"));
        },
      }),
    );
  await assert.rejects(preloadLocalModel(config), sanitizedFailure);
  assert.deepEqual(output, []);
});

test("an already cancelled preload preserves the caller reason and makes no request", async () => {
  const controller = new AbortController();
  const reason = new Error("caller stopped local startup");
  controller.abort(reason);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ done: true });
  };
  await assert.rejects(
    preloadLocalModel(config, controller.signal),
    (error: unknown) => error === reason,
  );
  assert.equal(calls, 0);
});

test("caller cancellation interrupts an in-flight preload and preserves its reason", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled local startup");
  globalThis.fetch = async (_input, init) => {
    assert(init?.signal instanceof AbortSignal);
    assert.notEqual(init.signal, controller.signal);
    assert.equal(init.signal.aborted, false);
    controller.abort(reason);
    assert.equal(init.signal.aborted, true);
    throw new Error("private-fetch-cancellation-error");
  };
  await assert.rejects(
    preloadLocalModel(config, controller.signal),
    (error: unknown) => error === reason,
  );
});

test("the independent 180-second preload deadline applies with and without a caller signal", async () => {
  for (const withCaller of [false, true]) {
    const deadline = new AbortController();
    const caller = new AbortController();
    const durations: number[] = [];
    AbortSignal.timeout = (milliseconds) => {
      durations.push(milliseconds);
      return deadline.signal;
    };
    globalThis.fetch = async (_input, init) => {
      assert(init?.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      deadline.abort(new DOMException("test deadline elapsed", "TimeoutError"));
      assert.equal(init.signal.aborted, true);
      assert.equal(caller.signal.aborted, false);
      throw new Error("private-timeout-error");
    };
    await assert.rejects(
      preloadLocalModel(config, withCaller ? caller.signal : undefined),
      (error: unknown) => error === deadline.signal.reason,
    );
    assert.deepEqual(durations, [180_000]);
  }
});

test("a successful response cannot bypass cancellation that happened while fetching", async () => {
  const controller = new AbortController();
  const reason = new Error("startup stopped before preload completed");
  globalThis.fetch = async () => {
    controller.abort(reason);
    return Response.json({ done: true });
  };
  await assert.rejects(
    preloadLocalModel(config, controller.signal),
    (error: unknown) => error === reason,
  );
});
