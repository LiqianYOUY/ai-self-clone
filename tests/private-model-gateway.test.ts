import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  checkPrivateModelReady,
  createPrivateModelGateway,
  loadPrivateModelConfig,
  parsePrivateModelConfig,
  type PrivateModelGatewayOptions,
} from "../scripts/private-model-gateway";

// All credentials, model metadata and conversations here are synthetic.
const config = {
  upstream: "http://127.0.0.1:11440",
  model: "qwen3.5:4b",
  token: "synthetic-gateway-token-for-tests-only",
  port: 11441,
  modelDigest: "a".repeat(64),
};
const model = (extra: Record<string, unknown> = {}) => ({
  name: config.model,
  model: config.model,
  digest: config.modelDigest,
  expires_at: "2099-01-01T00:00:00Z",
  size: 123,
  ...extra,
});
const reply = (extra: Record<string, unknown> = {}) => ({
  model: config.model,
  message: { role: "assistant", content: "行 周日见" },
  done: true,
  done_reason: "stop",
  ...extra,
});
const body = {
  model: config.model,
  messages: [
    { role: "system", content: "这是合成风格说明" },
    { role: "user", content: "周日见吗" },
  ],
  stream: false,
  think: false,
};
const ready: typeof fetch = async () => Response.json({ models: [model()] });
const syntheticFetch =
  (chat: typeof fetch): typeof fetch =>
  async (input, init) =>
    String(input).endsWith("/api/chat")
      ? chat(input, init)
      : ready(input, init);

async function gateway(
  t: TestContext,
  fetcher: typeof fetch,
  options: PrivateModelGatewayOptions = {},
  settings = config,
) {
  const controller = new AbortController();
  const server = createPrivateModelGateway(settings, {
    ...options,
    fetch: fetcher,
    signal: options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  t.after(async () => {
    controller.abort();
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    server,
    get: (path: string) =>
      fetch(`${origin}${path}`, {
        headers: { authorization: `Bearer ${config.token}` },
      }),
    post: (value: unknown = body, signal?: AbortSignal) =>
      fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(value),
        signal,
      }),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("private configuration rejects nonlocal origins, weak tokens, cloud aliases and unexpected settings", () => {
  assert.equal(
    parsePrivateModelConfig({ ...config, upstream: "http://localhost:11440/" })
      .upstream,
    config.upstream,
  );
  assert.equal(
    parsePrivateModelConfig({
      ...config,
      modelDigest: `sha256:${"A".repeat(64)}`,
    }).modelDigest,
    config.modelDigest,
  );
  for (const change of [
    { upstream: "https://127.0.0.1:11440" },
    { upstream: "http://remote.example:11440" },
    { upstream: "http://127.0.0.1.remote.example:11440" },
    { upstream: "http://secret:token@127.0.0.1:11440" },
    { upstream: "http://127.0.0.1:11440/api" },
    { upstream: "http://127.0.0.1:11440?key=secret" },
    { upstream: "http://127.0.0.1:11440#secret" },
    { upstream: "http://127.0.0.1:11441" },
    { token: "x".repeat(31) },
    { token: "x".repeat(513) },
    { token: `${"x".repeat(32)} secret` },
    { model: "qwen3.5:cloud" },
    { model: "qwen3.5:4b-cloud" },
    { model: "cloud/model:4b" },
    { model: "../model:4b" },
    { model: "model\nsecret" },
    { modelDigest: "a".repeat(63) },
    { port: 0 },
    { port: 65536 },
    { port: "11441" },
    { pull: true },
  ])
    assert.throws(
      () => parsePrivateModelConfig({ ...config, ...change }),
      /^Error: Invalid private model configuration\.$/,
    );
});

test("config loader reads only explicitly named private regular files and suppresses parse details", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "private-gateway-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(await loadPrivateModelConfig(path), config);
  await chmod(path, 0o644);
  await assert.rejects(
    loadPrivateModelConfig(path),
    /Invalid private model configuration/,
  );
  await chmod(path, 0o600);
  const link = join(directory, "alias.json");
  await symlink(path, link);
  await assert.rejects(
    loadPrivateModelConfig(link),
    /Invalid private model configuration/,
  );
  await writeFile(path, `${config.token}: broken JSON`);
  await assert.rejects(
    loadPrivateModelConfig(path),
    (error: unknown) =>
      error instanceof Error && !error.message.includes(config.token),
  );
  await writeFile(path, "x".repeat(16385));
  await assert.rejects(
    loadPrivateModelConfig(path),
    /Invalid private model configuration/,
  );
  await assert.rejects(
    loadPrivateModelConfig("relative-config.json"),
    /Invalid private model configuration/,
  );
});

test("readiness requires installed and resident local identities with matching digests", async () => {
  await checkPrivateModelReady(config, { fetch: ready });
  for (const [path, result] of [
    ["/api/tags", { models: [] }],
    ["/api/ps", { models: [] }],
    ["/api/ps", { models: [model({ expires_at: "2000-01-01T00:00:00Z" })] }],
    ["/api/ps", { models: [model({ expires_at: "not a time" })] }],
    ["/api/tags", { models: [model({ digest: "b".repeat(64) })] }],
    ["/api/ps", { models: [model({ digest: "b".repeat(64) })] }],
    [
      "/api/tags",
      { models: [model({ remote_host: "https://cloud.example" })] },
    ],
    ["/api/ps", { models: [model({ remote_model: "remote" })] }],
    ["/api/tags", { models: [model({ model: "other:4b" })] }],
    ["/api/tags", { models: [model(), model()] }],
  ] as const) {
    await assert.rejects(
      checkPrivateModelReady(config, {
        fetch: async (input) =>
          Response.json(
            String(input).endsWith(path) ? result : { models: [model()] },
          ),
      }),
      /MODEL_NOT_READY/,
    );
  }
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    checkPrivateModelReady(config, {
      signal: controller.signal,
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    }),
  );
  assert.equal(calls, 0);
});

test("every route authenticates before reading a body or contacting upstream; admin paths remain inaccessible", async (t) => {
  let calls = 0;
  const app = await gateway(t, async () => {
    calls++;
    return Response.json({ models: [model()] });
  });
  for (const authorization of [
    undefined,
    "Basic invalid",
    `bearer ${config.token}`,
    `Bearer ${"x".repeat(config.token.length)}`,
    `Bearer ${config.token}x`,
  ]) {
    const response = await fetch(`${app.origin}/api/tags`, {
      headers: authorization ? { authorization } : {},
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "UNAUTHORIZED" });
  }
  for (const [method, path] of [
    ["GET", "/api/version"],
    ["POST", "/api/pull"],
    ["DELETE", "/api/delete"],
    ["POST", "/api/create"],
    ["POST", "/api/generate"],
    ["GET", "/api/tags?all=true"],
    ["HEAD", "/api/tags"],
  ]) {
    const response = await fetch(`${app.origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.token}` },
    });
    assert.equal(response.status, 404);
  }
  // No POST body is sent: authentication must respond without waiting for it.
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      `${app.origin}/api/chat`,
      {
        method: "POST",
        headers: {
          "content-length": 200000,
          "content-type": "application/json",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    request.on("error", reject);
    request.flushHeaders();
  });
  assert.equal(status, 401);
  assert.equal(calls, 0);
});

test("tags and ps expose only the allowlisted resident model and sanitized metadata", async (t) => {
  const app = await gateway(t, async (_input, init) => {
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return Response.json({
      models: [
        model({ private_field: "do-not-export" }),
        model({ name: "other:4b", model: "other:4b" }),
      ],
      error_trace: "private trace",
    });
  });
  for (const path of ["/api/tags", "/api/ps"]) {
    const response = await app.get(path);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].name, config.model);
    assert.equal(result.models[0].digest, config.modelDigest);
    assert(!JSON.stringify(result).includes("private"));
    assert(!JSON.stringify(result).includes("other"));
  }
});

test("an untagged allowlist name exposes Ollama's canonical latest tag while requests stay exact", async (t) => {
  const settings = { ...config, model: "synthetic-model" };
  const canonical = "synthetic-model:latest";
  const app = await gateway(
    t,
    async (input, init) => {
      if (String(input).endsWith("/api/chat")) {
        assert.equal(JSON.parse(String(init?.body)).model, settings.model);
        return Response.json(reply({ model: canonical }));
      }
      return Response.json({
        models: [model({ name: canonical, model: canonical })],
      });
    },
    {},
    settings,
  );
  for (const path of ["/api/tags", "/api/ps"]) {
    const response = await app.get(path);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).models[0].name, canonical);
  }
  const response = await app.post({ ...body, model: settings.model });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, canonical);
  assert.equal((await app.post({ ...body, model: canonical })).status, 400);
});

test("chat forwards original roles and content while fixing model, generation limits and residency", async (t) => {
  let calls = 0;
  const app = await gateway(
    t,
    syntheticFetch(async (input, init) => {
      calls++;
      assert.equal(String(input), `${config.upstream}/api/chat`);
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        ...body,
        keep_alive: -1,
        options: { num_ctx: 8192, num_predict: 768, temperature: 0 },
      });
      return Response.json(
        reply({
          message: {
            role: "assistant",
            content: "行 周日见",
            thinking: "private chain",
            tool_calls: [],
          },
          internal: "private response field",
          eval_count: 5,
        }),
      );
    }),
  );
  const response = await app.post({
    ...body,
    keep_alive: 0,
    options: { num_ctx: 8192, num_predict: 768, temperature: 1.5 },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...reply(), eval_count: 5 });
  assert.equal(calls, 1);
});

test("invalid payloads and excessive actual bytes are rejected before readiness or inference", async (t) => {
  let calls = 0;
  const app = await gateway(t, async () => {
    calls++;
    throw new Error("must not fetch");
  });
  for (const value of [
    { ...body, model: "other:4b" },
    { ...body, stream: true },
    { ...body, think: true },
    { ...body, tools: [] },
    { ...body, format: "json" },
    { ...body, options: { num_ctx: 32769 } },
    { ...body, options: { num_ctx: 511 } },
    { ...body, options: { num_predict: 769 } },
    { ...body, options: { num_predict: -1 } },
    { ...body, options: { temperature: 3 } },
    { ...body, options: { mirostat: 1 } },
    { ...body, messages: [] },
    { ...body, messages: [{ role: "system", content: "x" }] },
    { ...body, messages: [{ role: "assistant", content: "x" }] },
    { ...body, messages: [{ role: "user", content: "x", images: ["image"] }] },
    { ...body, messages: [{ role: "tool", content: "x" }] },
    { ...body, messages: [{ role: "user", content: " " }] },
    { ...body, messages: [{ role: "user", content: "x".repeat(20001) }] },
    {
      ...body,
      messages: [
        { role: "user", content: "one" },
        { role: "user", content: "two" },
      ],
    },
    {
      ...body,
      messages: Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: "x",
      })),
    },
  ])
    assert.equal((await app.post(value)).status, 400);
  assert.equal(
    (await app.post({ ...body, padding: "界".repeat(50000) })).status,
    413,
  );
  const oversizedChunked = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      `${app.origin}/api/chat`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    request.on("error", reject);
    request.end("x".repeat(128 * 1024 + 1));
  });
  assert.equal(oversizedChunked, 413);
  assert.equal(calls, 0);
});

test("nonresident or redirected upstreams fail closed without leaking response bodies", async (t) => {
  const logs: unknown[] = [];
  for (const method of ["log", "warn", "error"] as const)
    t.mock.method(console, method, (...values: unknown[]) => logs.push(values));
  let chats = 0;
  const app = await gateway(t, async (input, init) => {
    assert.equal(init?.redirect, "error");
    if (String(input).endsWith("/api/chat")) chats++;
    return String(input).endsWith("/api/ps")
      ? Response.json({ models: [] })
      : Response.json({ models: [model()] });
  });
  for (const response of [
    await app.get("/api/tags"),
    await app.get("/api/ps"),
    await app.post(),
  ]) {
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "MODEL_NOT_READY" });
  }
  assert.equal(chats, 0);
  await assert.rejects(
    checkPrivateModelReady(config, {
      fetch: async () =>
        new Response("private-vendor-token", {
          status: 302,
          headers: { location: "https://remote.example" },
        }),
    }),
    /MODEL_NOT_READY/,
  );
  assert.deepEqual(logs, []);
});

test("upstream response size, completion identity, tool calls and errors cannot bypass the gateway", async (t) => {
  let result: () => Response = () => Response.json(reply());
  const app = await gateway(
    t,
    syntheticFetch(async () => result()),
  );
  for (const response of [
    () => new Response("private error", { status: 500 }),
    () => new Response("not json private token"),
    () => Response.json(reply({ model: "other:4b" })),
    () => Response.json(reply({ done: false })),
    () => Response.json(reply({ error: "private vendor error" })),
    () =>
      Response.json(
        reply({
          message: {
            role: "assistant",
            content: "x",
            tool_calls: [{ name: "execute" }],
          },
        }),
      ),
    () =>
      new Response(JSON.stringify({ padding: "x".repeat(1024 * 1024) }), {
        headers: { "content-length": "1" },
      }),
  ]) {
    result = response;
    const actual = await app.post();
    assert.equal(actual.status, 502);
    assert.deepEqual(await actual.json(), {
      error: "INVALID_UPSTREAM_RESPONSE",
    });
  }
});

test("one active chat admits two waiting requests, rejects a fourth and drains in order", async (t) => {
  const began = deferred<void>();
  const release = deferred<void>();
  const seen: string[] = [];
  const app = await gateway(
    t,
    syntheticFetch(async (_input, init) => {
      const content = JSON.parse(String(init?.body)).messages.at(-1).content;
      seen.push(content);
      if (seen.length === 1) {
        began.resolve();
        await release.promise;
      }
      return Response.json(reply());
    }),
    { queueTimeoutMs: 1000 },
  );
  const payload = (text: string) => ({
    ...body,
    messages: [{ role: "user", content: text }],
  });
  const first = app.post(payload("first"));
  await began.promise;
  const second = app.post(payload("second"));
  const third = app.post(payload("third"));
  // Wait until these requests reach the gateway, without waiting for inference.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const fourth = await app.post(payload("fourth"));
  assert.equal(fourth.status, 503);
  assert.equal(fourth.headers.get("retry-after"), "1");
  assert.deepEqual(await fourth.json(), { error: "BUSY" });
  release.resolve();
  assert.deepEqual(
    (await Promise.all([first, second, third])).map(
      (response) => response.status,
    ),
    [200, 200, 200],
  );
  assert.deepEqual(seen, ["first", "second", "third"]);
});

test("queued cancellation frees capacity, and client disconnection aborts the active upstream", async (t) => {
  const began = deferred<void>();
  const aborted = deferred<void>();
  let chats = 0;
  const app = await gateway(
    t,
    syntheticFetch(async (_input, init) => {
      chats++;
      if (chats === 1) {
        began.resolve();
        await new Promise<void>((resolve) =>
          init!.signal!.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              resolve();
            },
            { once: true },
          ),
        );
      }
      return Response.json(reply());
    }),
  );
  const activeController = new AbortController();
  const first = app.post(body, activeController.signal).catch(() => undefined);
  await began.promise;
  const queuedController = new AbortController();
  const queued = app.post(body, queuedController.signal).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  queuedController.abort();
  await queued;
  activeController.abort();
  await first;
  await aborted.promise;
  assert.equal(chats, 1);
  assert.equal((await app.post()).status, 200);
});

test("queue and upstream deadlines terminate work and permit subsequent requests", async (t) => {
  const began = deferred<void>();
  let chats = 0;
  let upstreamAborted = false;
  const app = await gateway(
    t,
    syntheticFetch(async (_input, init) => {
      chats++;
      if (chats === 1) {
        began.resolve();
        init!.signal!.addEventListener(
          "abort",
          () => {
            upstreamAborted = true;
          },
          { once: true },
        );
        await new Promise(() => undefined);
      }
      return Response.json(reply());
    }),
    { queueTimeoutMs: 25, upstreamTimeoutMs: 100, requestTimeoutMs: 200 },
  );
  const first = app.post();
  await began.promise;
  assert.equal((await app.post()).status, 503);
  const timedOut = await first;
  assert.equal(timedOut.status, 504);
  assert.equal(upstreamAborted, true);
  assert.equal((await app.post()).status, 200);
});

test("the total deadline also limits a stalled request body without upstream work", async (t) => {
  let calls = 0;
  const app = await gateway(
    t,
    async () => {
      calls++;
      return Response.json({});
    },
    { requestTimeoutMs: 40 },
  );
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      `${app.origin}/api/chat`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          "content-length": 100,
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    request.on("error", reject);
    request.flushHeaders();
  });
  assert.equal(status, 504);
  assert.equal(calls, 0);
  assert(app.server.headersTimeout <= 5000);
  assert(app.server.requestTimeout <= 10000);
});

test("cancellation during response reading consumes a simultaneous rejected read promise", async (t) => {
  const controller = new AbortController();
  const app = await gateway(
    t,
    syntheticFetch(async () => {
      const response = Response.json(reply());
      Object.defineProperty(response.body, "getReader", {
        value: () => ({
          read: () => {
            controller.abort();
            return Promise.reject(
              new Error("private-read-cancellation-detail"),
            );
          },
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      });
      return response;
    }),
    { signal: controller.signal },
  );
  const response = await app.post();
  assert.equal(response.status, 503);
  assert(!(await response.text()).includes("private-read"));
  // node:test also fails this test if the rejected read escapes unhandled.
  await new Promise((resolve) => setImmediate(resolve));
});
