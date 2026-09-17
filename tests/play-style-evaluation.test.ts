import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnosticPayload,
  distributionReview,
  evaluationJobs,
  parseEvaluationArgs,
  reviewReply,
  withDiagnostics,
  type ModelAttemptDiagnostic,
} from "../scripts/testing/evaluate-play-style";

test("evaluation arguments bound repetitions and retain quick/full workload", () => {
  assert.equal(evaluationJobs(parseEvaluationArgs([])).length, 8);
  assert.equal(evaluationJobs(parseEvaluationArgs(["--extended"])).length, 12);
  const quick = evaluationJobs(
    parseEvaluationArgs(["--quick", "--repeat=2", "--diagnostics"]),
  );
  assert.equal(quick.length, 6);
  assert.deepEqual(
    quick.map((job) => job.repeat),
    [1, 1, 1, 2, 2, 2],
  );
  assert.equal(
    evaluationJobs(parseEvaluationArgs(["--extended", "--repeat=3"])).length,
    36,
  );
  for (const args of [
    ["--repeat=0"],
    ["--repeat=4"],
    ["--repeat=2.5"],
    ["--repeat=2", "--repeat=3"],
    ["--quick", "--extended"],
    ["--url=private"],
    ["--diagnostics=private"],
  ]) {
    assert.throws(() => parseEvaluationArgs(args), /INVALID_ARGUMENTS/);
  }
});

test("all evaluation inputs remain built-in held-out synthetic conversations", () => {
  const jobs = evaluationJobs(parseEvaluationArgs(["--extended"]));
  for (const job of jobs) {
    const latest = job.scenario.messages.at(-1)!;
    assert.equal(latest.speaker, "FRIEND");
    assert(!job.fixture.examples.some((pair) => pair.friend === latest.text));
    assert.equal(job.fixture.persona.memories, "");
  }
});

test("pure echo is rejected without rejecting legitimate repeated greetings", () => {
  assert(
    reviewReply("哈哈，一眼 Ai", "一眼ai", "teasing", 26).hardFailures.includes(
      "REPLY_ONLY_ECHOES_INPUT",
    ),
  );
  assert(
    reviewReply("今天好累！", "今天好累", "low-mood", 7).hardFailures.includes(
      "REPLY_ONLY_ECHOES_INPUT",
    ),
  );
  assert.deepEqual(
    reviewReply("哈喽哈喽", "哈喽哈喽", "greeting", 7).hardFailures,
    [],
  );
  assert.deepEqual(
    reviewReply("累就先歇会呗", "今天好累", "low-mood", 7).hardFailures,
    [],
  );
});

test("minimal filler fails explicit-state or explanation cases, not confirmations", () => {
  for (const scenario of ["clarification", "low-mood", "work-pressure"]) {
    assert(
      reviewReply("好。", "今天有点累", scenario, 7).hardFailures.includes(
        "NONRESPONSIVE_MINIMAL_REPLY",
      ),
    );
  }
  assert.deepEqual(
    reviewReply("对", "周日对吧", "reschedule-clarification", 7).hardFailures,
    [],
  );
  assert.deepEqual(reviewReply("嗨", "嗨", "greeting", 26).hardFailures, []);
  assert(
    reviewReply("哈哈", "哈喽哈喽", "greeting", 26).reviewSignals.includes(
      "FAR_SHORTER_THAN_SOURCE_MEDIAN",
    ),
  );
  assert(
    reviewReply("哈哈 哈哈", "哈喽哈喽", "greeting", 7).reviewSignals.includes(
      "REPEATED_FILLER_WITHOUT_CONTENT",
    ),
  );
});

test("distribution detects collapse and repetitive openings across contexts", () => {
  const reference = [
    "在呀，你来了我就冒泡了。",
    "好呀，你定个方便的时间。",
    "哈哈，你一说确实板正了。",
    "听起来今天不太顺呀。",
  ];
  const review = distributionReview(reference, [
    { scenario: "greeting", text: "哈哈" },
    { scenario: "clarification", text: "哈哈，好" },
    { scenario: "teasing", text: "哈哈，行" },
    { scenario: "low-mood", text: "哈哈，嗯" },
  ]);
  assert(review.reviewSignals.includes("GENERATED_LENGTH_COLLAPSE"));
  assert(review.reviewSignals.includes("REPEATED_OPENING_OVER_SOURCE"));
  assert.equal(review.openingDistribution[0].count, 4);
  assert.equal(review.openingDistribution[0].sourceRate, 0.25);
  assert.equal(review.lengthDistribution?.twoCharactersOrFewer, 1);
});

test("reproducibility for identical inputs is distinct from repeating across contexts", () => {
  const repeated = distributionReview(
    ["在呢", "咋啦"],
    Array.from({ length: 4 }, () => ({ scenario: "greeting", text: "在呢" })),
  );
  assert(
    !repeated.reviewSignals.includes("SAME_REPLY_ACROSS_DIFFERENT_SCENARIOS"),
  );
  const crossed = distributionReview(
    ["在呢", "咋啦"],
    Array.from({ length: 4 }, (_, index) => ({
      scenario: `scenario-${index}`,
      text: "在呢",
    })),
  );
  assert(
    crossed.reviewSignals.includes("SAME_REPLY_ACROSS_DIFFERENT_SCENARIOS"),
  );
  assert.deepEqual(distributionReview([], []).reviewSignals, []);
  assert.equal(distributionReview([], []).lengthDistribution, null);
});

test("diagnostics retain only allowlisted completion fields and redact sensitive text", () => {
  const diagnostic = diagnosticPayload(
    {
      id: "private-provider-id",
      model: "private-model",
      key: "secret-password",
      url: "https://private-provider.example/v1",
      error: "private-error",
      choices: [
        {
          finish_reason: "length",
          message: {
            content:
              "嗯 secret-password https://secret.example/path Bearer private-token",
            reasoning_content: "private-reasoning",
            tool_calls: [{ arguments: "private-arguments" }],
          },
        },
      ],
      usage: { completion_tokens: 512, extra: "private-usage" },
    },
    2,
    ["secret-password"],
  );
  assert.equal(diagnostic.attempt, 2);
  assert.equal(diagnostic.finishReason, "length");
  assert.equal(diagnostic.outputTokens, 512);
  assert.equal(diagnostic.reasoningPresent, true);
  assert.equal(diagnostic.outputRedacted, true);
  assert(diagnostic.observedChecks.includes("TRUNCATED_COMPLETION"));
  const serialized = JSON.stringify(diagnostic);
  for (const secret of [
    "secret-password",
    "secret.example",
    "private-provider",
    "private-model",
    "private-token",
    "private-reasoning",
    "private-arguments",
    "private-usage",
    "private-error",
  ])
    assert(!serialized.includes(secret));
});

test("Ollama diagnostics preserve finish and body evidence without printing thinking", () => {
  const diagnostic = diagnosticPayload(
    {
      message: { content: "😂（歪头笑）", thinking: "private chain" },
      done: true,
      done_reason: "stop",
      eval_count: 14,
    },
    1,
  );
  assert.equal(diagnostic.responseFormat, "ollama");
  assert.equal(diagnostic.rawOutput, "😂（歪头笑）");
  assert.equal(diagnostic.done, true);
  assert.equal(diagnostic.finishReason, "stop");
  assert(diagnostic.observedChecks.includes("STAGE_ACTION"));
  assert(diagnostic.observedChecks.includes("CONTAINS_EMOJI"));
  assert.equal(diagnostic.reasoningPresent, true);
  assert(!JSON.stringify(diagnostic).includes("private chain"));
  const invalid = diagnosticPayload(
    { message: { content: null }, done_reason: "private-error-secret" },
    1,
  );
  assert.equal(invalid.finishReason, "other");
  assert(invalid.observedChecks.includes("NON_STRING_CONTENT"));
  const long = diagnosticPayload(
    { message: { content: "👨‍👩‍👧‍👦".repeat(4_001) }, done_reason: "stop" },
    1,
  );
  assert.equal(long.rawOutputLength, 4_001);
  assert.equal(long.outputTruncated, true);
  assert.equal(
    [
      ...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(
        long.rawOutput!,
      ),
    ].length,
    4_000,
  );
});

test("diagnostic transport records both attempts and restores fetch after failure", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const fake: typeof fetch = async () => {
    calls++;
    if (calls === 2) throw new Error("private URL and credentials");
    return Response.json({
      message: { content: "好", thinking: "private-reasoning" },
      done: true,
      done_reason: "stop",
    });
  };
  globalThis.fetch = fake;
  const records: ModelAttemptDiagnostic[] = [];
  try {
    await assert.rejects(
      withDiagnostics(async () => {
        const first = await fetch("http://synthetic.invalid");
        assert.equal((await first.json()).message.content, "好");
        await fetch("http://synthetic.invalid");
      }, records),
    );
    assert.equal(globalThis.fetch, fake);
    assert.equal(records.length, 2);
    assert.equal(records[0].rawOutput, "好");
    assert.equal(records[1].diagnosticError, "TRANSPORT_FAILURE");
    assert(!JSON.stringify(records).includes("private"));
    assert(!JSON.stringify(records).includes("synthetic.invalid"));
  } finally {
    globalThis.fetch = original;
  }
});

test("non-success response bodies never enter diagnostics", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { message: { content: "private-provider-error" }, key: "secret" },
      { status: 500 },
    );
  const records: ModelAttemptDiagnostic[] = [];
  try {
    await withDiagnostics(async () => {
      const response = await fetch("http://synthetic.invalid");
      await response.body?.cancel();
    }, records);
    assert.equal(records[0].httpStatus, 500);
    assert.equal(records[0].rawOutput, null);
    assert.equal(records[0].diagnosticError, "NON_SUCCESS_HTTP");
    assert(!JSON.stringify(records).includes("private-provider-error"));
  } finally {
    globalThis.fetch = original;
  }
});
