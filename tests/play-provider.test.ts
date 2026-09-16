import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  checkPlayProvider,
  generatePlayReply,
  isPlayProviderConfigured,
  PlayProviderError,
} from "../src/server/play-provider";

const originalFetch = globalThis.fetch;
const oldEnv = {
  base: process.env.PLAY_MODEL_BASE_URL,
  key: process.env.PLAY_MODEL_API_KEY,
  model: process.env.PLAY_MODEL_NAME,
  provider: process.env.PLAY_MODEL_PROVIDER,
};
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
const completion = (message: Record<string, unknown>, finish_reason = "stop") =>
  Response.json({
    id: "private-provider-id",
    model: "private-model",
    usage: { total_tokens: 999 },
    choices: [{ message, finish_reason }],
  });
beforeEach(() => {
  process.env.PLAY_MODEL_PROVIDER = "compatible";
  process.env.PLAY_MODEL_BASE_URL = "https://provider.example/v1/";
  process.env.PLAY_MODEL_API_KEY = "private-provider-key";
  process.env.PLAY_MODEL_NAME = "private-model";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries({
    PLAY_MODEL_BASE_URL: oldEnv.base,
    PLAY_MODEL_API_KEY: oldEnv.key,
    PLAY_MODEL_NAME: oldEnv.model,
    PLAY_MODEL_PROVIDER: oldEnv.provider,
  }))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

test("provider requires complete server configuration and rejects unsafe endpoints", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("must not fetch");
  };
  for (const base of [
    "",
    "https://provider.example/v1?key=secret",
    "https://user:password@provider.example/v1",
    "http://remote.example/v1",
    "file:///tmp/model",
  ]) {
    process.env.PLAY_MODEL_BASE_URL = base;
    assert.equal(isPlayProviderConfigured(), false);
    await assert.rejects(
      generatePlayReply(context),
      (e: unknown) =>
        e instanceof PlayProviderError && e.code === "NOT_CONFIGURED",
    );
  }
  process.env.PLAY_MODEL_BASE_URL = "http://127.0.0.1:1234/v1";
  assert.equal(isPlayProviderConfigured(), true);
  delete process.env.PLAY_MODEL_API_KEY;
  assert.equal(isPlayProviderConfigured(), false);
  assert.equal(calls, 0);
});

test("provider sends ordered role messages and returns only trimmed reply text", async () => {
  let called = false;
  globalThis.fetch = async (input, init) => {
    called = true;
    assert.equal(String(input), "https://provider.example/v1/chat/completions");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method, "POST");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer private-provider-key",
    );
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, false);
    assert.equal(body.model, "private-model");
    assert.equal(body.max_tokens, 512);
    assert(body.messages[0].content.includes("最多 120 个字"));
    assert.deepEqual(body.messages.slice(1), [
      { role: "user", content: "去吃饭吗" },
      { role: "assistant", content: "去哪" },
      { role: "user", content: "老地方" },
    ]);
    assert(body.messages[0].content.includes(context.persona.style));
    assert(body.messages[0].content.includes(context.persona.examplesText));
    return completion({
      content: "  行啊，几点  ",
      reasoning_content: "private provider analysis",
    });
  };
  assert.equal(await generatePlayReply(context), "行啊，几点");
  assert(called);
});

test("bad turn histories are rejected before calling an external provider", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("must not fetch");
  };
  for (const messages of [
    [],
    [{ speaker: "SOURCE" as const, text: "抢答" }],
    [
      { speaker: "FRIEND" as const, text: "一" },
      { speaker: "FRIEND" as const, text: "二" },
    ],
    Array.from({ length: 11 }, (_, i) => ({
      speaker: i % 2 ? ("SOURCE" as const) : ("FRIEND" as const),
      text: "超出五轮",
    })),
  ])
    await assert.rejects(
      generatePlayReply({ ...context, messages }),
      PlayProviderError,
    );
  assert.equal(called, false);
});

test("provider refuses partial replies, tool calls, reasoning text and oversized streams", async () => {
  const responses = [
    () => completion({ content: "截断了" }, "length"),
    () => completion({ content: "" }),
    () => completion({ content: "answer", tool_calls: [{ id: "call" }] }),
    () => completion({ content: "<think>秘密推理</think>答案" }),
    () => completion({ content: "字".repeat(2001) }),
    () =>
      new Response("private-error".repeat(12_000), {
        headers: { "content-length": "2" },
      }),
  ];
  for (const response of responses) {
    globalThis.fetch = async () => response();
    await assert.rejects(
      generatePlayReply(context),
      (e: unknown) =>
        e instanceof PlayProviderError && e.code === "INVALID_REPLY",
    );
  }
});

test("transport failures expose neither error response bodies nor credentials", async () => {
  for (const response of [
    async () =>
      new Response("private-provider-key: internal model traceback", {
        status: 500,
      }),
    async () => {
      throw new Error(
        "private-provider-key: model at provider.example unavailable",
      );
    },
    async () => new Response("not JSON"),
  ]) {
    globalThis.fetch = response;
    await assert.rejects(generatePlayReply(context), (error: unknown) => {
      assert(error instanceof PlayProviderError);
      assert.equal(error.message, "UNAVAILABLE");
      assert(!JSON.stringify(error).includes("private-provider"));
      return true;
    });
  }
});

test("aborted generation cannot return a late valid completion", async () => {
  const controller = new AbortController();
  globalThis.fetch = async (_input, init) => {
    controller.abort();
    assert.equal(init?.signal?.aborted, true);
    return completion({ content: "迟到的回答" });
  };
  await assert.rejects(
    generatePlayReply(context, { signal: controller.signal }),
    (e: unknown) => e instanceof PlayProviderError && e.code === "UNAVAILABLE",
  );
});

test("without environment settings the provider defaults to native local Ollama without an API key", async () => {
  for (const key of [
    "PLAY_MODEL_PROVIDER",
    "PLAY_MODEL_BASE_URL",
    "PLAY_MODEL_API_KEY",
    "PLAY_MODEL_NAME",
  ])
    delete process.env[key];
  assert.equal(isPlayProviderConfigured(), true);
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "http://127.0.0.1:11434/api/chat");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "qwen3.5:4b");
    assert.equal(body.think, false);
    assert.equal(body.stream, false);
    assert.equal(body.options.num_ctx, 32768);
    assert.equal(body.options.num_predict, 512);
    return Response.json({
      model: "qwen3.5:4b",
      message: {
        role: "assistant",
        content: "好，就老地方",
        thinking: "private local reasoning",
      },
      done: true,
      done_reason: "stop",
    });
  };
  assert.equal(await generatePlayReply(context), "好，就老地方");
});

test("local readiness requires the requested installed model and never accepts a remote model alias", async () => {
  process.env.PLAY_MODEL_PROVIDER = "ollama";
  process.env.PLAY_MODEL_BASE_URL = "http://127.0.0.1:11434";
  delete process.env.PLAY_MODEL_API_KEY;
  for (const [name, response, expected] of [
    ["installed-test:4b", { models: [{ name: "installed-test:4b" }] }, true],
    ["missing-test:4b", { models: [{ name: "other:4b" }] }, false],
    [
      "remote-test:4b",
      {
        models: [{ name: "remote-test:4b", remote_host: "https://ollama.com" }],
      },
      false,
    ],
    [
      "alias-test:4b",
      {
        models: [
          { name: "alias-test:4b", remote_model: "external-cloud-model" },
        ],
      },
      false,
    ],
    ["latest-test", { models: [{ model: "latest-test:latest" }] }, true],
  ] as const) {
    process.env.PLAY_MODEL_NAME = name;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "http://127.0.0.1:11434/api/tags");
      assert.equal(init?.redirect, "error");
      return Response.json(response);
    };
    const result = await checkPlayProvider();
    assert.equal(result.kind, "ollama");
    assert.equal(result.ready, expected);
  }
  process.env.PLAY_MODEL_NAME = "offline-test:4b";
  globalThis.fetch = async () => {
    throw new Error("Connection refused");
  };
  assert.equal((await checkPlayProvider()).ready, false);
});

test("local provider rejects remote endpoints and cloud model names before sending any chat", async () => {
  process.env.PLAY_MODEL_PROVIDER = "ollama";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("must not send private chat");
  };
  for (const [base, model] of [
    ["https://ollama.com", "qwen3.5:4b"],
    ["https://remote.example", "qwen3.5:4b"],
    ["http://127.0.0.1:11434", "qwen3.5:cloud"],
    ["http://127.0.0.1:11434", "model-cloud:latest"],
  ]) {
    process.env.PLAY_MODEL_BASE_URL = base;
    process.env.PLAY_MODEL_NAME = model;
    assert.equal(isPlayProviderConfigured(), false);
    assert.equal((await checkPlayProvider()).ready, false);
    await assert.rejects(generatePlayReply(context), PlayProviderError);
  }
  assert.equal(calls, 0);
});

test("Ollama truncated or thinking-only responses never become chat replies", async () => {
  process.env.PLAY_MODEL_PROVIDER = "ollama";
  process.env.PLAY_MODEL_BASE_URL = "http://127.0.0.1:11434";
  process.env.PLAY_MODEL_NAME = "qwen3.5:4b";
  for (const response of [
    { message: { content: "没写完" }, done: true, done_reason: "length" },
    {
      message: { content: "", thinking: "private thought" },
      done: true,
      done_reason: "stop",
    },
    { message: { content: "partial" }, done: false },
  ]) {
    globalThis.fetch = async () => Response.json(response);
    await assert.rejects(
      generatePlayReply(context),
      (e: unknown) =>
        e instanceof PlayProviderError && e.code === "INVALID_REPLY",
    );
  }
});

test("a truncated response is discarded and retried once with a shorter prompt and enough tokens", async () => {
  for (const provider of ["compatible", "ollama"] as const) {
    process.env.PLAY_MODEL_PROVIDER = provider;
    process.env.PLAY_MODEL_BASE_URL =
      provider === "ollama"
        ? "http://127.0.0.1:11434"
        : "https://provider.example/v1";
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(
        provider === "ollama" ? body.options.num_predict : body.max_tokens,
        calls === 1 ? 512 : 768,
      );
      assert.equal(body.messages.length, context.messages.length + 1);
      assert(!JSON.stringify(body.messages).includes("不完整的消息"));
      if (calls === 2) assert(body.messages[0].content.includes("60 个字以内"));
      const content = calls === 1 ? "不完整的消息" : "好，老时间见";
      const finish_reason = calls === 1 ? "length" : "stop";
      return provider === "ollama"
        ? Response.json({
            message: { content },
            done: true,
            done_reason: finish_reason,
          })
        : completion({ content }, finish_reason);
    };
    assert.equal(await generatePlayReply(context), "好，老时间见");
    assert.equal(calls, 2);
  }
});

test("temporary HTTP and network failures get at most one retry with unchanged history", async () => {
  for (const failure of [
    () => new Response("private provider error", { status: 503 }),
    () => {
      throw new TypeError("private connection reset");
    },
  ]) {
    const requests: string[] = [];
    globalThis.fetch = async (_input, init) => {
      requests.push(String(init?.body));
      if (requests.length === 1) return failure();
      return completion({ content: "走起" });
    };
    assert.equal(await generatePlayReply(context), "走起");
    assert.equal(requests.length, 2);
    assert.equal(requests[0], requests[1]);
  }
  for (const failure of [
    () => new Response("private provider error", { status: 429 }),
    () => completion({ content: "总是截断" }, "length"),
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return failure();
    };
    await assert.rejects(generatePlayReply(context), PlayProviderError);
    assert.equal(calls, 2);
  }
});

test("permanent HTTP errors and unsafe completions do not retry", async () => {
  for (const failure of [
    () => new Response("private auth failure", { status: 401 }),
    () => new Response("private invalid input", { status: 400 }),
    () => completion({ content: "<think>secret</think>answer" }, "length"),
    () =>
      completion({ content: "answer", tool_calls: [{ id: "call" }] }, "length"),
    () => completion({ content: "" }),
    () => new Response("invalid JSON"),
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return failure();
    };
    await assert.rejects(generatePlayReply(context), PlayProviderError);
    assert.equal(calls, 1);
  }
});

test("external abort before a request or during retry delay prevents further provider calls", async () => {
  for (const abortBefore of [true, false]) {
    const controller = new AbortController();
    let calls = 0;
    if (abortBefore) controller.abort();
    globalThis.fetch = async () => {
      calls++;
      setTimeout(() => controller.abort(), 10);
      return new Response("temporary outage", { status: 503 });
    };
    await assert.rejects(
      generatePlayReply(context, { signal: controller.signal }),
      (error: unknown) =>
        error instanceof PlayProviderError && error.code === "UNAVAILABLE",
    );
    assert.equal(calls, abortBefore ? 0 : 1);
  }
});

test("attempt timeouts can retry but both attempts share a deadline shorter than the route lifetime", async () => {
  const originalTimeout = AbortSignal.timeout;
  try {
    for (const provider of ["compatible", "ollama"] as const) {
      process.env.PLAY_MODEL_PROVIDER = provider;
      process.env.PLAY_MODEL_BASE_URL =
        provider === "ollama"
          ? "http://127.0.0.1:11434"
          : "https://provider.example/v1";
      const timers: { milliseconds: number; controller: AbortController }[] =
        [];
      AbortSignal.timeout = (milliseconds) => {
        const controller = new AbortController();
        timers.push({ milliseconds, controller });
        return controller.signal;
      };
      let calls = 0;
      globalThis.fetch = async (_input, init) => {
        calls++;
        if (calls === 1) {
          timers[1].controller.abort();
          assert.equal(init?.signal?.aborted, true);
          throw new Error("attempt timed out");
        }
        assert.equal(init?.signal?.aborted, false);
        // Even a provider completing after the overall deadline cannot return text.
        timers[0].controller.abort();
        return provider === "ollama"
          ? Response.json({
              message: { content: "迟到的回答" },
              done: true,
              done_reason: "stop",
            })
          : completion({ content: "迟到的回答" });
      };
      await assert.rejects(
        generatePlayReply(context),
        (error: unknown) =>
          error instanceof PlayProviderError && error.code === "UNAVAILABLE",
      );
      assert.equal(calls, 2);
      assert.deepEqual(
        timers.map(({ milliseconds }) => milliseconds),
        provider === "ollama"
          ? [75_000, 60_000, 60_000]
          : [45_000, 30_000, 30_000],
      );
    }
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});
