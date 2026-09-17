import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  checkPlayProvider,
  generatePlayReply,
  isPlayProviderConfigured,
  PlayProviderError,
  playGenerationPolicy,
} from "../src/server/play-provider";
import { distillPlayStyle } from "../src/server/play-style";

const originalFetch = globalThis.fetch;
const oldEnv = {
  base: process.env.PLAY_MODEL_BASE_URL,
  key: process.env.PLAY_MODEL_API_KEY,
  model: process.env.PLAY_MODEL_NAME,
  provider: process.env.PLAY_MODEL_PROVIDER,
  resident: process.env.PLAY_MODEL_RESIDENT,
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
  delete process.env.PLAY_MODEL_RESIDENT;
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
    PLAY_MODEL_RESIDENT: oldEnv.resident,
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
    assert.equal(body.temperature, 0);
    assert(body.messages[0].content.includes("本轮最多 24 个字符"));
    assert.deepEqual(body.messages.slice(1), [
      { role: "user", content: "去吃饭吗" },
      { role: "assistant", content: "去哪" },
      { role: "user", content: "老地方" },
    ]);
    assert(body.messages[0].content.includes(context.persona.style));
    assert(body.messages[0].content.includes("改天约呗"));
    assert(!body.messages[0].content.includes('"examplesText"'));
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
    assert.equal(body.keep_alive, "10m");
    assert.equal(body.options.num_ctx, 4096);
    assert.equal(body.options.num_predict, 512);
    assert.equal(body.options.temperature, 0);
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

test("resident mode is explicit and only changes the native local keep-alive", async () => {
  process.env.PLAY_MODEL_PROVIDER = "ollama";
  process.env.PLAY_MODEL_BASE_URL = "http://127.0.0.1:11434";
  for (const [setting, expected] of [
    ["0", "10m"],
    ["true", "10m"],
    ["1", -1],
  ] as const) {
    process.env.PLAY_MODEL_RESIDENT = setting;
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.keep_alive, expected);
      assert.equal(body.think, false);
      assert.deepEqual(body.messages.slice(1), [
        { role: "user", content: "去吃饭吗" },
        { role: "assistant", content: "去哪" },
        { role: "user", content: "老地方" },
      ]);
      return Response.json({
        message: { content: "好，就老地方" },
        done: true,
        done_reason: "stop",
      });
    };
    assert.equal(await generatePlayReply(context), "好，就老地方");
  }
  process.env.PLAY_MODEL_PROVIDER = "compatible";
  process.env.PLAY_MODEL_BASE_URL = "https://provider.example/v1";
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal("keep_alive" in body, false);
    assert.equal("options" in body, false);
    return completion({ content: "好，就老地方" });
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
  for (const provider of ["compatible", "ollama", "private-ollama"] as const) {
    process.env.PLAY_MODEL_PROVIDER = provider;
    process.env.PLAY_MODEL_API_KEY = "test-private-gateway-token-32-characters";
    process.env.PLAY_MODEL_BASE_URL =
      provider !== "compatible"
        ? "http://127.0.0.1:11434"
        : "https://provider.example/v1";
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(
        provider !== "compatible" ? body.options.num_predict : body.max_tokens,
        calls === 1 ? 512 : 768,
      );
      assert.equal(body.messages.length, context.messages.length + 1);
      assert(!JSON.stringify(body.messages).includes("不完整的消息"));
      if (calls === 2)
        assert(body.messages[0].content.includes("24 个字符以内"));
      const content = calls === 1 ? "不完整的消息" : "好，老时间见";
      const finish_reason = calls === 1 ? "length" : "stop";
      return provider !== "compatible"
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

test("style violations are rewritten once without adding the rejected text to conversation history", async () => {
  for (const rejected of [
    "很长的寒暄".repeat(10),
    "来了🤩",
    "（歪头笑）你好",
    "作为一个AI，我可以陪你聊天",
  ]) {
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(
        body.messages.slice(1),
        context.messages.map((message) => ({
          role: message.speaker === "FRIEND" ? "user" : "assistant",
          content: message.text,
        })),
      );
      if (calls === 2) {
        assert.match(body.messages[0].content, /重新生成要求/);
        assert(!body.messages[0].content.includes(rejected));
      }
      return completion({ content: calls === 1 ? rejected : "走呗" });
    };
    assert.equal(await generatePlayReply(context), "走呗");
    assert.equal(calls, 2);
  }
});

test("speaker ownership and a later correction survive retries without becoming persona facts", async () => {
  for (const [friendDay, selfDay] of [
    ["周三", "周二"],
    ["周二", "周三"],
  ]) {
    const messages = [
      { speaker: "FRIEND" as const, text: `我${friendDay}休息` },
      { speaker: "SOURCE" as const, text: `我也是${friendDay}` },
      { speaker: "FRIEND" as const, text: "你再确认一下自己的安排" },
      { speaker: "SOURCE" as const, text: `刚才记错了 我${selfDay}休息` },
      {
        speaker: "FRIEND" as const,
        text: `所以你是${selfDay}，我是${friendDay}，对吧`,
      },
    ];
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(
        body.messages.slice(1),
        messages.map((message) => ({
          role: message.speaker === "FRIEND" ? "user" : "assistant",
          content: message.text,
        })),
      );
      const system = body.messages[0].content;
      assert.match(system, /本人.*assistant.*朋友.*user/u);
      assert.match(system, /本人之前的话.*(?:说错|更正)/u);
      for (const message of messages) assert(!system.includes(message.text));
      // This mock exercises request boundaries, not the model's understanding.
      return completion({
        content: calls === 1 ? "解释".repeat(30) : "对 各自那天",
      });
    };
    await generatePlayReply({ persona: context.persona, messages });
    assert.equal(calls, 2);
  }
});

test("confirmation purpose preserves context and retrieval while allowing agreement, correction and uncertainty", async () => {
  const persona = {
    ...context.persona,
    examplesText:
      "朋友：改到周日对吗\n我：是，周日见\n朋友：什么意思\n我：我刚才没表达清楚，是说昨晚没睡好",
  };
  for (const [latest, reply] of [
    ["所以你是说周日，不是周六，对吧", "对，周日"],
    ["所以你是说周六，对吗？", "不是，是周日"],
    ["你说周六也有空，是这个意思吗", "周六还没说定"],
  ]) {
    const messages = [
      { speaker: "FRIEND" as const, text: "周六下午见面行吗" },
      { speaker: "SOURCE" as const, text: "周日下午我有空" },
      { speaker: "FRIEND" as const, text: latest },
    ];
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.messages.slice(1), [
        { role: "user", content: "周六下午见面行吗" },
        { role: "assistant", content: "周日下午我有空" },
        { role: "user", content: latest },
      ]);
      const system = body.messages[0].content;
      assert.match(system, /核对本局.*不符.*纠正/u);
      assert.match(system, /没说明.*未知/u);
      assert(!system.includes("我刚才没表达清楚"));
      assert(!system.includes("昨晚没睡好"));
      if (latest.includes("周日")) assert(system.includes("是，周日见"));
      // Mock replies test that validation permits all three outcomes.
      return completion({ content: reply });
    };
    assert.equal(await generatePlayReply({ persona, messages }), reply);
    assert.equal(calls, 1);
  }
});

test("skepticism purpose addresses conversational tone without suggesting an identity claim", async () => {
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const purpose = body.messages[0].content.split("【参考结束】")[1];
    assert.match(purpose, /说话生硬.*语气/u);
    assert.doesNotMatch(purpose, /AI|身份|真人/iu);
    assert.deepEqual(body.messages.slice(1), [
      { role: "user", content: "一眼ai" },
    ]);
    return completion({ content: "行 我自然点" });
  };
  await generatePlayReply({
    persona: context.persona,
    messages: [{ speaker: "FRIEND", text: "一眼ai" }],
  });
});

test("repeated style failures never leak an invalid reply or get unlimited retries", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return completion({ content: "来了🤩" });
  };
  await assert.rejects(
    generatePlayReply(context),
    (error: unknown) =>
      error instanceof PlayProviderError && error.code === "INVALID_REPLY",
  );
  assert.equal(calls, 2);
});

test("longer or expressive speaker evidence is respected instead of enforcing one universal short style", async () => {
  const expressive = {
    ...context,
    persona: {
      ...context.persona,
      examplesText:
        "朋友：周末怎么安排？\n我：我想先去河边走走，晚点找家小店吃饭，再回家看电影，感觉这样就很舒服哈哈😊\n朋友：你今天心情怎么样？\n我：今天挺好的呀，忙完以后终于有时间做点自己喜欢的事，准备好好放松一下😊",
    },
  };
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const system = JSON.parse(String(init?.body)).messages[0].content;
    assert(!system.includes("无表情图标"));
    assert.match(system, /只学示例.*接话.*措辞/u);
    return completion({
      content: "好呀，我觉得可以慢慢走过去，时间还早，到了再决定吃什么就好😊",
    });
  };
  assert((await generatePlayReply(expressive)).endsWith("😊"));
  assert.equal(calls, 1);
});

const groundedPersona = {
  ...context.persona,
  examplesText:
    "朋友：嗨\n我：在啊 咋啦\n朋友：今天有点累\n我：那就先歇会儿呗\n朋友：这话像机器人\n我：笑死 有那么夸张吗\n朋友：没懂你这句话\n我：我没说清楚 重新说",
};

test("obvious echoes and empty acknowledgements get one content-focused retry", async () => {
  for (const [input, rejected, accepted] of [
    ["有点累 不想出门", "好。", "那就先歇会儿呗"],
    ["一眼ai", "哈哈，一眼 Ai", "笑死 有那么夸张吗"],
    ["没看懂你这句话", "没看懂你这句话", "我没说清楚 重新说"],
  ]) {
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.messages.at(-1).content, input);
      if (calls === 2) assert.match(body.messages[0].content, /重新生成要求/);
      return completion({ content: calls === 1 ? rejected : accepted });
    };
    assert.equal(
      await generatePlayReply({
        persona: groundedPersona,
        messages: [{ speaker: "FRIEND", text: input }],
      }),
      accepted,
    );
    assert.equal(calls, 2);
  }
});

test("confirmations and source-supported short responses are not padded into longer replies", async () => {
  for (const [input, reply] of [
    ["下次九点见", "下次九点见"],
    ["没看懂，是这个意思吗", "对"],
    ["你有点累吗", "嗯"],
    ["哈喽哈喽", "哈喽哈喽"],
    ["一眼ai", "笑死"],
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return completion({ content: reply });
    };
    assert.equal(
      await generatePlayReply({
        persona: groundedPersona,
        messages: [{ speaker: "FRIEND", text: input }],
      }),
      reply,
    );
    assert.equal(calls, 1);
  }
  globalThis.fetch = async () => completion({ content: "嗯" });
  assert.equal(
    await generatePlayReply({
      persona: {
        ...groundedPersona,
        examplesText:
          groundedPersona.examplesText + "\n朋友：今天有点烦\n我：嗯",
      },
      messages: [{ speaker: "FRIEND", text: "今天有点累" }],
    }),
    "嗯",
  );
});

test("a new topic does not retrieve old conversation facts and representative voice follows the current language", async () => {
  const persona = {
    ...groundedPersona,
    examplesText:
      "朋友：一起吃饭吗\n我：好呀 海边那家面馆\nfriend: hey\n我：hey what's up",
  };
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.match(body.messages[0].content, /相关历史接话：\[\]/);
    assert(!body.messages[0].content.includes("海边那家面馆"));
    return completion({ content: "not sure yet" });
  };
  await generatePlayReply({
    persona,
    messages: [
      { speaker: "FRIEND", text: "一起吃饭吗" },
      { speaker: "SOURCE", text: "再看看" },
      { speaker: "FRIEND", text: "what book are you reading?" },
    ],
  });
});

test("local context grows for a long conversation while small chats avoid the maximum allocation", async () => {
  process.env.PLAY_MODEL_PROVIDER = "ollama";
  process.env.PLAY_MODEL_BASE_URL = "http://127.0.0.1:11434";
  const sizes: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    sizes.push(body.options.num_ctx);
    assert.equal(body.think, false);
    assert(body.messages.at(-1).content.endsWith("吃饭吗"));
    return Response.json({
      message: { content: "行啊" },
      done: true,
      done_reason: "stop",
    });
  };
  for (const length of [0, 2000, 3900]) {
    await generatePlayReply({
      persona: { ...context.persona, bio: "资".repeat(length) },
      messages: [{ speaker: "FRIEND", text: "吃饭吗" }],
    });
  }
  assert.equal(sizes[0], 4096);
  assert(sizes[1] > sizes[0]);
  assert(sizes[2] >= sizes[1]);
  assert(sizes.every((size) => size <= 32768));
});

test("clarification learns literal repair wording without importing an unrelated reason from history", async () => {
  const persona = {
    ...context.persona,
    examplesText:
      "朋友：没听懂你那句话\n我：我刚才没表达清楚，是说昨晚没睡好\n朋友：什么意思\n我：是我说得太绕了，我想说的就是有点困\n朋友：解释一下\n我：今天太忙了，所以没说清楚",
  };
  const messages = [
    { speaker: "FRIEND" as const, text: "嗨" },
    { speaker: "SOURCE" as const, text: "我刚从月球回来" },
    { speaker: "FRIEND" as const, text: "你刚才那句什么意思" },
  ];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const system = body.messages[0].content;
    assert.deepEqual(body.messages.slice(1), [
      { role: "user", content: "嗨" },
      { role: "assistant", content: "我刚从月球回来" },
      { role: "user", content: "你刚才那句什么意思" },
    ]);
    assert(!system.includes("我刚从月球回来"));
    assert(system.includes("我刚才没表达清楚"));
    assert(system.includes("是我说得太绕了"));
    for (const unrelated of ["昨晚没睡好", "有点困", "今天太忙了"])
      assert(!system.includes(unrelated));
    return completion({ content: "刚才是我说岔了" });
  };
  assert.equal(
    await generatePlayReply({
      persona,
      messages,
    }),
    "刚才是我说岔了",
  );
});

test("ambiguous target examples fail before inference rather than imitating the other speaker", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return completion({ content: "错误" });
  };
  await assert.rejects(
    generatePlayReply({
      ...context,
      persona: {
        ...context.persona,
        exampleSpeaker: "老王",
        examplesText: "甲：你好\n乙：你也好",
      },
    }),
    PlayProviderError,
  );
  assert.equal(calls, 0);
});

test("frozen games reject model or distillation version drift before inference", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return completion({ content: "行" });
  };
  const profile = distillPlayStyle(context.persona);
  for (const frozen of [
    { styleProfile: { ...profile, version: "old-unsupported-style" } },
    { styleProfile: { ...profile, sourceHash: "wrong-persona" } },
    { generationPolicy: { ...playGenerationPolicy(), model: "another-model" } },
    {
      generationPolicy: {
        ...playGenerationPolicy(),
        promptVersion: "speaker-reply-v2",
      },
    },
  ])
    await assert.rejects(
      generatePlayReply({ ...context, ...frozen }),
      PlayProviderError,
    );
  assert.equal(calls, 0);
  assert.equal(
    await generatePlayReply({
      ...context,
      styleProfile: profile,
      generationPolicy: playGenerationPolicy(),
    }),
    "行",
  );
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
    for (const provider of [
      "compatible",
      "ollama",
      "private-ollama",
    ] as const) {
      process.env.PLAY_MODEL_PROVIDER = provider;
      process.env.PLAY_MODEL_API_KEY =
        "test-private-gateway-token-32-characters";
      process.env.PLAY_MODEL_BASE_URL =
        provider !== "compatible"
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
        return provider !== "compatible"
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
        provider !== "compatible"
          ? [75_000, 60_000, 60_000]
          : [45_000, 30_000, 30_000],
      );
    }
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});
