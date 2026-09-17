import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  checkPlayProvider,
  generatePlayReply,
  isPlayProviderConfigured,
  playGenerationPolicy,
  PlayProviderError,
} from "../src/server/play-provider";
import { localModelConfiguration } from "../scripts/local-model-runtime";

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const environment = [
  "PLAY_MODEL_PROVIDER",
  "PLAY_MODEL_BASE_URL",
  "PLAY_MODEL_API_KEY",
  "PLAY_MODEL_NAME",
  "PLAY_MODEL_RESIDENT",
] as const;
const previous = Object.fromEntries(
  environment.map((key) => [key, process.env[key]]),
);
const token = "test-private-gateway-token-32-characters";
const model = "qwen3.5:9b";
const digest = "a".repeat(64);
const metadata = { models: [{ name: model, model, digest }] };
const context = {
  persona: {
    displayName: "小林",
    bio: "爱吃面",
    style: "短句口语",
    memories: "一起去过海边",
    examplesText: "我：改天约呗",
  },
  messages: [
    { speaker: "FRIEND" as const, text: "去吃饭吗" },
    { speaker: "SOURCE" as const, text: "去哪" },
    { speaker: "FRIEND" as const, text: "老地方" },
  ],
};

beforeEach(() => {
  process.env.PLAY_MODEL_PROVIDER = "private-ollama";
  process.env.PLAY_MODEL_BASE_URL = "http://127.0.0.1:11441";
  process.env.PLAY_MODEL_API_KEY = token;
  process.env.PLAY_MODEL_NAME = model;
  process.env.PLAY_MODEL_RESIDENT = "1";
  globalThis.fetch = async () => {
    throw new Error("Unexpected network request in private gateway test");
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  for (const key of environment) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

test("private gateway requires explicit authenticated configuration and refuses unsafe endpoints", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("must not forward a conversation");
  };
  for (const [key, value] of [
    ["PLAY_MODEL_PROVIDER", "private"],
    ["PLAY_MODEL_BASE_URL", ""],
    ["PLAY_MODEL_BASE_URL", "http://192.168.1.2:11441"],
    ["PLAY_MODEL_BASE_URL", "http://127.0.0.1.example:11441"],
    ["PLAY_MODEL_BASE_URL", "https://gateway.example/api"],
    ["PLAY_MODEL_BASE_URL", "https://gateway.example"],
    ["PLAY_MODEL_BASE_URL", "https://127.0.0.1:11441"],
    ["PLAY_MODEL_BASE_URL", "https://user:password@gateway.example"],
    ["PLAY_MODEL_BASE_URL", "http://127.0.0.1:11441?token=private"],
    ["PLAY_MODEL_BASE_URL", "http://127.0.0.1:11441#fragment"],
    ["PLAY_MODEL_BASE_URL", "file:///tmp/gateway"],
    ["PLAY_MODEL_API_KEY", ""],
    ["PLAY_MODEL_API_KEY", "a".repeat(31)],
    ["PLAY_MODEL_API_KEY", "a".repeat(513)],
    ["PLAY_MODEL_API_KEY", `${token}中文`],
    ["PLAY_MODEL_API_KEY", `${token}\nprivate`],
    ["PLAY_MODEL_API_KEY", `${token} private`],
    ["PLAY_MODEL_API_KEY", ` ${token}`],
    ["PLAY_MODEL_API_KEY", `${token} `],
    ["PLAY_MODEL_NAME", ""],
    ["PLAY_MODEL_NAME", "qwen3.5:cloud"],
    ["PLAY_MODEL_NAME", "cloud/qwen3.5:9b"],
    ["PLAY_MODEL_NAME", "qwen3.5:9b-cloud"],
    ["PLAY_MODEL_NAME", "model_cloud:9b"],
    ["PLAY_MODEL_NAME", "../model:9b"],
    ["PLAY_MODEL_NAME", "invalid model name"],
  ]) {
    const old = process.env[key];
    process.env[key] = value;
    assert.equal(isPlayProviderConfigured(), false, key);
    assert.equal((await checkPlayProvider()).ready, false);
    await assert.rejects(
      generatePlayReply(context),
      (error: unknown) =>
        error instanceof PlayProviderError && error.code === "NOT_CONFIGURED",
    );
    process.env[key] = old;
  }
  assert.equal(calls, 0);
  for (const base of [
    "http://127.0.0.1:11441",
    "http://localhost:11441/",
    "http://[::1]:11441",
  ]) {
    process.env.PLAY_MODEL_BASE_URL = base;
    assert.equal(isPlayProviderConfigured(), true);
  }
});

test("private mode never starts a local fallback and preserves the local default", () => {
  assert.equal(localModelConfiguration(), null);
  process.env.PLAY_MODEL_BASE_URL = "malformed";
  assert.equal(localModelConfiguration(), null);
  for (const key of environment) delete process.env[key];
  assert.equal(localModelConfiguration()?.origin, "http://127.0.0.1:11434");
  assert.equal(localModelConfiguration()?.model, "qwen3.5:4b");
  process.env.PLAY_MODEL_PROVIDER = "ollama";
  process.env.PLAY_MODEL_BASE_URL = "https://gateway.example";
  assert.throws(() => localModelConfiguration());
  assert.equal(isPlayProviderConfigured(), false);
});

test("private replies use authenticated native Ollama controls and ordered roles", async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "http://127.0.0.1:11441/api/chat");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method, "POST");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${token}`,
    );
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, model);
    assert.equal(body.stream, false);
    assert.equal(body.think, false);
    assert.equal(body.keep_alive, -1);
    assert.deepEqual(body.options, {
      num_predict: 512,
      num_ctx: 4096,
      temperature: 0,
    });
    assert.deepEqual(body.messages.slice(1), [
      { role: "user", content: "去吃饭吗" },
      { role: "assistant", content: "去哪" },
      { role: "user", content: "老地方" },
    ]);
    return Response.json({
      message: {
        content: " 好，就老地方 ",
        thinking: "private-model-reasoning",
      },
      done: true,
      done_reason: "stop",
      model,
    });
  };
  assert.equal(await generatePlayReply(context), "好，就老地方");
  assert.deepEqual(playGenerationPolicy(), {
    promptVersion: "speaker-reply-v4",
    provider: "private-ollama",
    model,
  });
});

test("private readiness verifies authenticated installed and loaded model digests", async () => {
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${token}`,
    );
    assert.equal(init?.body, undefined);
    return Response.json(metadata);
  };
  const status = await checkPlayProvider();
  assert.equal(status.kind, "private-ollama");
  assert.equal(status.ready, true);
  assert.equal(status.model, model);
  assert.deepEqual(requests.sort(), [
    "http://127.0.0.1:11441/api/ps",
    "http://127.0.0.1:11441/api/tags",
  ]);
  assert(!JSON.stringify(status).includes(token));
  assert(!JSON.stringify(status).includes(digest));
});

test("private readiness rejects absent, remote, mismatched or non-allowlisted running models", async () => {
  for (const payload of [
    null,
    { error: "private-gateway-error" },
    { models: [] },
    { models: [null] },
    { models: [{ name: "other-model:9b", digest }] },
    { models: [{ name: model, digest: "b".repeat(64) }] },
    { models: [{ name: model, digest: "invalid-digest" }] },
    {
      models: [{ name: model, digest, remote_host: "https://remote.example" }],
    },
    { models: [{ name: model, digest, remote_model: "cloud-model" }] },
    { models: [...metadata.models, { name: "another-model", digest }] },
  ]) {
    for (const invalidEndpoint of ["/api/ps", "/api/tags"]) {
      globalThis.fetch = async (input) =>
        Response.json(
          String(input).endsWith(invalidEndpoint) ? payload : metadata,
        );
      assert.equal((await checkPlayProvider()).ready, false);
    }
  }
});

test("private readiness does not cache a successful connection across outages or token changes", async () => {
  globalThis.fetch = async () => Response.json(metadata);
  assert.equal((await checkPlayProvider()).ready, true);
  process.env.PLAY_MODEL_API_KEY = "new-test-gateway-token-32-characters";
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer new-test-gateway-token-32-characters",
    );
    return new Response("private-auth-error", { status: 401 });
  };
  const status = await checkPlayProvider();
  assert.equal(status.ready, false);
  assert.equal(calls, 2);
  assert(!JSON.stringify(status).includes("private-auth-error"));
  globalThis.fetch = async () => {
    throw new Error("private-network-error");
  };
  assert.equal((await checkPlayProvider()).ready, false);
});

test("private readiness bounds metadata streams and never exposes malformed provider data", async () => {
  for (const response of [
    () => new Response("private-provider-body", { status: 500 }),
    () => new Response("not-json-private-body"),
    () =>
      new Response("x".repeat(16_385), { headers: { "content-length": "1" } }),
  ]) {
    globalThis.fetch = async () => response();
    const status = await checkPlayProvider();
    assert.equal(status.ready, false);
    assert(!JSON.stringify(status).includes("private-provider-body"));
    assert(!JSON.stringify(status).includes(token));
  }
});

test("private readiness applies a shared short deadline to both metadata requests", async () => {
  const deadline = new AbortController();
  const timeouts: number[] = [];
  AbortSignal.timeout = (milliseconds) => {
    timeouts.push(milliseconds);
    return deadline.signal;
  };
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.signal, deadline.signal);
    deadline.abort();
    return Response.json(metadata);
  };
  assert.equal((await checkPlayProvider()).ready, false);
  assert.deepEqual(timeouts, [2000]);
});

test("private reply validation discards thinking, tools and partial replies without leaking them", async () => {
  for (const response of [
    {
      message: { content: "", thinking: "private reasoning" },
      done: true,
      done_reason: "stop",
    },
    {
      message: { content: "<think>private reasoning</think>answer" },
      done: true,
      done_reason: "stop",
    },
    {
      message: { content: "answer", tool_calls: [{ id: "private-tool" }] },
      done: true,
      done_reason: "stop",
    },
    { message: { content: "partial" }, done: false },
    {
      message: { content: "still partial" },
      done: true,
      done_reason: "length",
    },
  ]) {
    globalThis.fetch = async () => Response.json(response);
    await assert.rejects(
      generatePlayReply(context),
      (error: unknown) =>
        error instanceof PlayProviderError && error.code === "INVALID_REPLY",
    );
  }
});

test("private games refuse a changed provider or model before sending any conversation", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("must not send conversation");
  };
  for (const policy of [
    { ...playGenerationPolicy(), provider: "ollama" },
    { ...playGenerationPolicy(), provider: "compatible" },
    { ...playGenerationPolicy(), model: "qwen3.5:27b" },
  ]) {
    await assert.rejects(
      generatePlayReply({ ...context, generationPolicy: policy }),
      (error: unknown) =>
        error instanceof PlayProviderError && error.code === "UNAVAILABLE",
    );
  }
  assert.equal(calls, 0);
});
