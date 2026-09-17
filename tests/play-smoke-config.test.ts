import assert from "node:assert/strict";
import test from "node:test";
import {
  smokeModelSettings,
  verifySmokeModel,
} from "../scripts/testing/smoke-play";

const privateEnv = {
  PLAY_SMOKE_PROVIDER: "private-ollama",
  PLAY_MODEL_BASE_URL: "http://127.0.0.1:11441",
  PLAY_MODEL_NAME: "synthetic-model:9b",
  PLAY_MODEL_API_KEY: "synthetic-key-for-unit-tests-only-1234",
};
const settings = smokeModelSettings(privateEnv);
const model = { name: settings.model, expires_at: "2099-01-01T00:00:00Z" };

test("HTTP smoke defaults to local Ollama and ignores production provider credentials", () => {
  assert.deepEqual(
    smokeModelSettings({
      PLAY_MODEL_PROVIDER: "private-ollama",
      PLAY_MODEL_BASE_URL: "http://127.0.0.1:11441",
      PLAY_MODEL_NAME: "another-model:27b",
      PLAY_MODEL_API_KEY: privateEnv.PLAY_MODEL_API_KEY,
    }),
    {
      kind: "ollama",
      origin: "http://127.0.0.1:11434",
      model: "qwen3.5:4b",
      apiKey: "",
    },
  );
  assert.deepEqual(
    smokeModelSettings({
      PLAY_SMOKE_MODEL: "synthetic-model:4b",
      PLAY_SMOKE_OLLAMA_URL: "http://127.0.0.1:11442",
    }),
    {
      kind: "ollama",
      origin: "http://127.0.0.1:11442",
      model: "synthetic-model:4b",
      apiKey: "",
    },
  );
});

test("private smoke requires explicit credentials and a plain loopback origin", () => {
  assert.equal(
    smokeModelSettings({
      ...privateEnv,
      PLAY_SMOKE_MODEL: "synthetic-model:27b",
    }).model,
    "synthetic-model:27b",
  );
  for (const override of [
    { PLAY_SMOKE_PROVIDER: "compatible" },
    { PLAY_MODEL_BASE_URL: "https://model.example.test" },
    { PLAY_MODEL_BASE_URL: "http://127.0.0.1:11441/api" },
    { PLAY_MODEL_BASE_URL: "http://user:password@127.0.0.1:11441" },
    { PLAY_MODEL_BASE_URL: "http://127.0.0.1:11441?token=secret" },
    { PLAY_MODEL_API_KEY: "" },
    { PLAY_MODEL_API_KEY: "short" },
    { PLAY_MODEL_API_KEY: `${privateEnv.PLAY_MODEL_API_KEY}\n` },
    { PLAY_MODEL_NAME: "synthetic-model:cloud" },
    { PLAY_MODEL_NAME: "" },
  ])
    assert.throws(() => smokeModelSettings({ ...privateEnv, ...override }));
});

test("private smoke authenticates both live tags and resident checks without redirects", async () => {
  const calls: string[] = [];
  await verifySmokeModel(settings, {
    fetchImpl: (async (input, init) => {
      calls.push(String(input));
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${privateEnv.PLAY_MODEL_API_KEY}`,
      );
      assert.equal(init?.redirect, "error");
      assert(init?.signal);
      return Response.json({ models: [model] });
    }) as typeof fetch,
  });
  assert.deepEqual(calls, [
    "http://127.0.0.1:11441/api/tags",
    "http://127.0.0.1:11441/api/ps",
  ]);
});

test("local smoke retains the unauthenticated installed-model check", async () => {
  const calls: string[] = [];
  await verifySmokeModel(smokeModelSettings({}), {
    fetchImpl: (async (input, init) => {
      calls.push(String(input));
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      return Response.json({ models: [{ name: "qwen3.5:4b" }] });
    }) as typeof fetch,
  });
  assert.deepEqual(calls, ["http://127.0.0.1:11434/api/tags"]);
});

test("private smoke fails closed for unauthorized, missing, remote or expired models", async () => {
  for (const fixture of [
    { models: [] },
    { models: [{ ...model, name: "other-model:9b" }] },
    { models: [{ ...model, remote_host: "cloud.example.test" }] },
    { models: [{ ...model, remote_model: "cloud-model" }] },
    { models: [{ ...model, expires_at: "2000-01-01T00:00:00Z" }] },
    { models: [{ name: settings.model }] },
  ]) {
    let count = 0;
    await assert.rejects(
      verifySmokeModel(settings, {
        fetchImpl: (async () => {
          count++;
          return Response.json(count === 1 ? { models: [model] } : fixture);
        }) as typeof fetch,
      }),
    );
    assert.equal(count, 2, "Failure must not retry a local endpoint");
  }
  let count = 0;
  await assert.rejects(
    verifySmokeModel(settings, {
      fetchImpl: (async () => {
        count++;
        return new Response("private response body", { status: 401 });
      }) as typeof fetch,
    }),
    /Requested model health check failed/,
  );
  assert.equal(count, 1);
});

test("private smoke forwards cancellation without exposing response bodies", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    verifySmokeModel(settings, {
      signal: controller.signal,
      fetchImpl: (async (_input, init) => {
        assert(init?.signal?.aborted);
        throw new Error("cancelled synthetic request");
      }) as typeof fetch,
    }),
    /cancelled synthetic request/,
  );
});
