/**
 * Real-model style evaluation using only the synthetic fixtures below.
 * Uses PLAY_MODEL_* configuration (and .env); never reads a database or starts services.
 * Run: node --import tsx scripts/testing/evaluate-play-style.ts [--quick] [--repeat=1..3] [--extended] [--diagnostics]
 * Automatic checks cover observable habits, not personality likeness or semantic quality.
 */
import { config } from "dotenv";
import { pathToFileURL } from "node:url";
import type { PlayPersonaInput, PlaySpeaker } from "../../src/domain/play";
import {
  generatePlayReply,
  PlayProviderError,
} from "../../src/server/play-provider";

type Example = { friend: string; self: string };
type Fixture = {
  id: string;
  persona: PlayPersonaInput;
  examples: Example[];
  maxReplyLength: number;
  allowEmoji: boolean;
};
type Message = { speaker: PlaySpeaker; text: string };
type Scenario = {
  id: string;
  messages: Message[];
  reviewFocus: string;
};
type CaseResult = {
  id: string;
  personaId: string;
  scenario: string;
  repeat: number;
  syntheticHistory: Message[];
  syntheticOutput: string | null;
  reviewFocus: string;
  latencyMs: number;
  length: number | null;
  sourceMedianLength: number;
  lengthToSourceMedian: number | null;
  emojiPresent: boolean | null;
  questionPresent: boolean | null;
  hardFailures: string[];
  reviewSignals: string[];
  providerError: string | null;
  diagnostics?: ModelAttemptDiagnostic[];
};

export type EvaluationOptions = {
  quick: boolean;
  repeat: number;
  extended: boolean;
  diagnostics: boolean;
};

export function parseEvaluationArgs(args: string[]): EvaluationOptions {
  const options: EvaluationOptions = {
    quick: false,
    repeat: 1,
    extended: false,
    diagnostics: false,
  };
  const seen = new Set<string>();
  for (const argument of args) {
    const flag = argument.split("=")[0];
    if (seen.has(flag)) throw new Error("INVALID_ARGUMENTS");
    seen.add(flag);
    if (argument === "--quick") options.quick = true;
    else if (argument === "--extended") options.extended = true;
    else if (argument === "--diagnostics") options.diagnostics = true;
    else if (/^--repeat=[1-3]$/u.test(argument))
      options.repeat = Number(argument.at(-1));
    else throw new Error("INVALID_ARGUMENTS");
  }
  if (options.quick && options.extended) throw new Error("INVALID_ARGUMENTS");
  return options;
}

const shortExamples: Example[] = [
  { friend: "哟在不", self: "在 咋啦" },
  { friend: "好久没唠了", self: "是啊 最近咋样" },
  { friend: "你说跑偏是啥意思", self: "就我刚才说岔了" },
  { friend: "这句像机器人发的", self: "笑死 有那么夸张吗" },
  { friend: "今天有点烦", self: "咋啦 说来听听" },
  { friend: "明天一起买菜不", self: "行啊 几点" },
  { friend: "没看懂你上一句", self: "我没说清 就是太困了" },
  { friend: "你这话太客套了吧", self: "行行行 我正常点" },
];
const warmExamples: Example[] = [
  {
    friend: "哟在不",
    self: "在呀，你一来我就冒泡了。今天过得怎么样？🙂",
  },
  {
    friend: "好久没唠了",
    self: "是呀，有阵子没聊了。你今天有空，我就陪你慢慢唠🙂",
  },
  {
    friend: "你说跑偏是啥意思",
    self: "我刚才没表达清楚，是说我把话题扯远了，跟你没关系呀🙂",
  },
  {
    friend: "这句像机器人发的",
    self: "哈哈，被你这么一说确实有点板正。我放松点，你接着说🙂",
  },
  {
    friend: "今天有点烦",
    self: "听起来今天不太顺呀。你愿意说的话，我就在这儿听🙂",
  },
  {
    friend: "明天一起买菜不",
    self: "好呀，我挺想一起逛逛的。你定个方便的时间，我们再碰头🙂",
  },
  {
    friend: "没看懂你上一句",
    self: "是我说得太绕了，我想说的就是有点困，没有别的意思呀🙂",
  },
  {
    friend: "你这话太客套了吧",
    self: "哈哈，我一认真就容易说得客气。你提醒得对，咱们随意聊🙂",
  },
];

function fixture(
  id: string,
  label: string,
  style: string,
  examples: Example[],
  maxReplyLength: number,
  allowEmoji: boolean,
): Fixture {
  return {
    id,
    examples,
    maxReplyLength,
    allowEmoji,
    persona: {
      displayName: label,
      exampleSpeaker: label,
      bio: "这是评测专用的虚构人物，没有真实个人资料或已知共同经历。",
      style,
      memories: "",
      examplesText: examples
        .map(({ friend, self }) => `合成朋友：${friend}\n${label}：${self}`)
        .join("\n\n"),
    },
  };
}

const fixtures = [
  fixture(
    "synthetic-terse",
    "合成短句甲",
    "说话短，常用空格，不用表情图标或动作描写；有啥说啥，被追问就解释前一句。",
    shortExamples,
    40,
    false,
  ),
  fixture(
    "synthetic-warm",
    "合成温和乙",
    "语气温和，完整表达，通常一两句；习惯呀和🙂，先接住朋友的话，不随便换话题。",
    warmExamples,
    120,
    true,
  ),
];

// All prompts are held out from the examples. The awkward prior reply is synthetic
// and deliberately tests recovery from an earlier assistant mistake.
const scenarios: Scenario[] = [
  {
    id: "greeting",
    messages: [{ speaker: "FRIEND", text: "哈喽哈喽" }],
    reviewFocus: "直接打招呼；比较两个虚构人物的句长、标点与表情习惯。",
  },
  {
    id: "clarification",
    messages: [
      { speaker: "FRIEND", text: "哈喽哈喽" },
      {
        speaker: "SOURCE",
        text: "哇塞哈喽！我是不是又听多了？😂（歪头笑）",
      },
      { speaker: "FRIEND", text: "听多了？啥" },
    ],
    reviewFocus:
      "回应前一句的歧义或承认说岔了；不责怪朋友认真，不转去咖啡店、看展等新话题。",
  },
  {
    id: "teasing",
    messages: [{ speaker: "FRIEND", text: "一眼ai" }],
    reviewFocus: "简短接住吐槽；不介绍AI能力，不编造刚写代码等即时经历。",
  },
  {
    id: "low-mood",
    messages: [{ speaker: "FRIEND", text: "有点累 不想出门" }],
    reviewFocus: "围绕朋友的状态回应；不自动变成客服建议清单。",
  },
];

const extendedScenarios: Scenario[] = [
  {
    id: "work-pressure",
    messages: [
      { speaker: "FRIEND", text: "今天被工作压得喘不过气，脑子都转不动了" },
    ],
    reviewFocus:
      "接住工作压力，给出符合本人习惯的回应；不泛泛复读，不编造自己的工作经历。",
  },
  {
    id: "reschedule-clarification",
    messages: [
      { speaker: "FRIEND", text: "周六下午见面行吗" },
      { speaker: "SOURCE", text: "周日下午我有空" },
      { speaker: "FRIEND", text: "所以你是想改到周日，不是周六，对吧" },
    ],
    reviewFocus:
      "明确周日而非周六，依据本局历史澄清；不带入参考里的买菜或其他约定。",
  },
];

export function evaluationJobs(options: EvaluationOptions) {
  const base = options.quick
    ? [
        { fixture: fixtures[0], scenario: scenarios[0] },
        { fixture: fixtures[1], scenario: scenarios[0] },
        { fixture: fixtures[0], scenario: scenarios[1] },
      ]
    : fixtures.flatMap((item) =>
        [...scenarios, ...(options.extended ? extendedScenarios : [])].map(
          (scenario) => ({ fixture: item, scenario }),
        ),
      );
  return Array.from({ length: options.repeat }, (_, index) =>
    base.map((job) => ({ ...job, repeat: index + 1 })),
  ).flat();
}

const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
const lengthOf = (text: string) => [...segmenter.segment(text)].length;
const hasEmoji = (text: string) =>
  /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text);
const hasAction = (text: string) =>
  /[（(][^）)\n]{0,50}(?:笑|歪头|眨眼|眼睛|耸肩|点头|摊手)[^）)\n]{0,50}[）)]|\*[^*\n]{1,50}\*/u.test(
    text,
  );
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const rounded = (value: number) => Math.round(value * 100) / 100;

const normalized = (text: string) =>
  text.toLocaleLowerCase("en").replace(/[\p{P}\p{S}\s]/gu, "");
const withoutPreface = (text: string) =>
  text.replace(/^(?:哈{2,}|呵{2,}|嘿{2,}|嗯+|呃+|哈哈|lol|haha)+/iu, "");

/** Conservative, observable screens. These are not semantic or likeness scores. */
export function reviewReply(
  reply: string,
  current: string,
  scenarioId: string,
  sourceMedian: number,
) {
  const hardFailures: string[] = [];
  const reviewSignals: string[] = [];
  const replyCore = normalized(reply);
  const currentCore = normalized(current);
  const replyWithoutPreface = withoutPreface(replyCore);
  if (
    scenarioId !== "greeting" &&
    currentCore.length >= 3 &&
    (replyCore === currentCore || replyWithoutPreface === currentCore)
  ) {
    hardFailures.push("REPLY_ONLY_ECHOES_INPUT");
  }
  const onlyAcknowledgement =
    /^(?:好|好的|嗯|哦|对|是|好吧|行|行啊|ok|okay|yes|哈{2,})$/iu.test(
      replyCore,
    );
  if (
    onlyAcknowledgement &&
    ["clarification", "low-mood", "work-pressure"].includes(scenarioId)
  ) {
    hardFailures.push("NONRESPONSIVE_MINIMAL_REPLY");
  } else if (onlyAcknowledgement && scenarioId !== "greeting") {
    reviewSignals.push("MINIMAL_ACKNOWLEDGEMENT_NEEDS_REVIEW");
  }
  if (sourceMedian > 0 && lengthOf(reply) / sourceMedian < 0.35)
    reviewSignals.push("FAR_SHORTER_THAN_SOURCE_MEDIAN");
  if (sourceMedian > 0 && lengthOf(reply) / sourceMedian > 2)
    reviewSignals.push("MORE_THAN_TWICE_SOURCE_MEDIAN");
  if (/^(?:哈哈\s*){2,}$/u.test(reply.trim()))
    reviewSignals.push("REPEATED_FILLER_WITHOUT_CONTENT");
  if (/聊点轻松|换个话题|快说说看|看看\s*AI\s*的?本领/iu.test(reply))
    reviewSignals.push("POSSIBLE_TEMPLATE_OR_TOPIC_DEFLECTION");
  if (/刚(?:刚|才)?[^。！？\n]{0,20}(?:代码|咖啡|展览|写完)/u.test(reply))
    reviewSignals.push("CHECK_UNSUPPORTED_RECENT_EVENT");
  return { hardFailures, reviewSignals };
}

function opening(text: string) {
  const clean = text
    .trim()
    .toLocaleLowerCase("en")
    .replace(/^[\p{P}\p{S}\s]+/u, "");
  const word = /^[a-z]+/u.exec(clean)?.[0];
  return (
    word ??
    [...segmenter.segment(clean)]
      .slice(0, 2)
      .map((part) => part.segment)
      .join("")
  );
}

export function distributionReview(
  reference: string[],
  outputs: Array<{ text: string; scenario: string }>,
) {
  const counts = new Map<string, { count: number; scenarios: Set<string> }>();
  const starts = new Map<string, number>();
  const lengths = outputs
    .map(({ text }) => lengthOf(text))
    .sort((a, b) => a - b);
  for (const output of outputs) {
    const key = normalized(output.text);
    const item = counts.get(key) ?? { count: 0, scenarios: new Set<string>() };
    item.count++;
    item.scenarios.add(output.scenario);
    counts.set(key, item);
    const start = opening(output.text);
    starts.set(start, (starts.get(start) ?? 0) + 1);
  }
  const openingDistribution = [...starts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([text, count]) => ({
      text,
      count,
      rate: rounded(count / outputs.length),
      sourceRate: rounded(
        reference.filter((sample) => opening(sample) === text).length /
          Math.max(1, reference.length),
      ),
    }));
  const sourceMedian = median(reference.map(lengthOf));
  const ratio =
    lengths.length && sourceMedian
      ? rounded(median(lengths) / sourceMedian)
      : null;
  const reviewSignals: string[] = [];
  if (outputs.length >= 3 && ratio !== null && ratio < 0.5)
    reviewSignals.push("GENERATED_LENGTH_COLLAPSE");
  const first = openingDistribution[0];
  if (
    outputs.length >= 3 &&
    first &&
    first.count >= 3 &&
    first.rate >= 0.75 &&
    first.rate - first.sourceRate >= 0.25
  )
    reviewSignals.push("REPEATED_OPENING_OVER_SOURCE");
  const crossScenarioDuplicates = [...counts]
    .filter(([, item]) => item.scenarios.size >= 2 && item.count >= 2)
    .map(([text, item]) => ({
      normalizedText: text,
      count: item.count,
      scenarios: [...item.scenarios].sort(),
    }));
  if (
    outputs.length >= 4 &&
    crossScenarioDuplicates.some((item) => item.count / outputs.length >= 0.5)
  )
    reviewSignals.push("SAME_REPLY_ACROSS_DIFFERENT_SCENARIOS");
  return {
    sourceMedianLength: sourceMedian,
    medianToSourceRatio: ratio,
    lengthDistribution: lengths.length
      ? {
          min: lengths[0],
          median: median(lengths),
          p90: lengths[Math.ceil(lengths.length * 0.9) - 1],
          max: lengths.at(-1),
          twoCharactersOrFewer: lengths.filter((length) => length <= 2).length,
        }
      : null,
    openingDistribution,
    crossScenarioDuplicates,
    reviewSignals,
  };
}

export type ModelAttemptDiagnostic = {
  attempt: number;
  httpStatus: number | null;
  responseFormat: "ollama" | "compatible" | "unknown";
  rawOutput: string | null;
  outputTruncated: boolean;
  outputRedacted: boolean;
  rawOutputLength: number | null;
  finishReason: string | null;
  done: boolean | null;
  reasoningPresent: boolean;
  toolCallsPresent: boolean;
  outputTokens: number | null;
  observedChecks: string[];
  diagnosticError:
    | "TRANSPORT_FAILURE"
    | "NON_SUCCESS_HTTP"
    | "BODY_TOO_LARGE"
    | "UNREADABLE_RESPONSE"
    | null;
};

function emptyDiagnostic(attempt: number): ModelAttemptDiagnostic {
  return {
    attempt,
    httpStatus: null,
    responseFormat: "unknown",
    rawOutput: null,
    outputTruncated: false,
    outputRedacted: false,
    rawOutputLength: null,
    finishReason: null,
    done: null,
    reasoningPresent: false,
    toolCallsPresent: false,
    outputTokens: null,
    observedChecks: [],
    diagnosticError: null,
  };
}

/** Only allowlisted response fields are kept. No request, headers or exception text. */
export function diagnosticPayload(
  payload: unknown,
  attempt: number,
  secrets: string[] = [],
): ModelAttemptDiagnostic {
  const result = emptyDiagnostic(attempt);
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const choices = Array.isArray(record.choices) ? record.choices : undefined;
  const compatible = !!choices;
  const choice = choices?.[0] as Record<string, unknown> | undefined;
  const message = (compatible ? choice?.message : record.message) as
    Record<string, unknown> | undefined;
  result.responseFormat = compatible
    ? "compatible"
    : message
      ? "ollama"
      : "unknown";
  const raw = message?.content;
  const reason = compatible ? choice?.finish_reason : record.done_reason;
  result.finishReason =
    typeof reason === "string"
      ? ["stop", "length", "tool_calls", "content_filter", "error"].includes(
          reason,
        )
        ? reason
        : "other"
      : null;
  result.done = typeof record.done === "boolean" ? record.done : null;
  result.reasoningPresent = !!(
    message?.thinking ||
    message?.reasoning_content ||
    message?.reasoning
  );
  result.toolCallsPresent =
    Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  const tokens = compatible
    ? (record.usage as Record<string, unknown> | undefined)?.completion_tokens
    : record.eval_count;
  result.outputTokens =
    typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0
      ? tokens
      : null;
  if (typeof raw === "string") {
    result.rawOutputLength = lengthOf(raw);
    let redacted = raw;
    for (const secret of secrets.filter(Boolean))
      redacted = redacted.split(secret).join("[REDACTED_SECRET]");
    redacted = redacted
      .replace(/https?:\/\/[^\s<>"'）)]+/giu, "[REDACTED_URL]")
      .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED_SECRET]")
      .replace(/\bsk-[\w-]{8,}/gu, "[REDACTED_SECRET]");
    result.outputRedacted = redacted !== raw;
    result.outputTruncated = lengthOf(redacted) > 4_000;
    result.rawOutput = [...segmenter.segment(redacted)]
      .slice(0, 4_000)
      .map((part) => part.segment)
      .join("");
    if (!raw.trim()) result.observedChecks.push("EMPTY_CONTENT");
    if (/<\/?(?:think|analysis|reasoning)>/iu.test(raw))
      result.observedChecks.push("REASONING_TAGS");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(raw))
      result.observedChecks.push("CONTROL_CHARACTERS");
    if (hasAction(raw)) result.observedChecks.push("STAGE_ACTION");
    if (hasEmoji(raw)) result.observedChecks.push("CONTAINS_EMOJI");
  } else result.observedChecks.push("NON_STRING_CONTENT");
  if (result.finishReason === "length")
    result.observedChecks.push("TRUNCATED_COMPLETION");
  if (result.finishReason !== "stop")
    result.observedChecks.push("NON_STOP_FINISH");
  if (result.toolCallsPresent) result.observedChecks.push("TOOL_CALLS");
  return result;
}

async function inspectResponse(
  response: Response,
  attempt: number,
): Promise<ModelAttemptDiagnostic> {
  const result = emptyDiagnostic(attempt);
  result.httpStatus = response.status;
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    result.diagnosticError = "NON_SUCCESS_HTTP";
    return result;
  }
  try {
    if (!response.body) throw new Error("MISSING_BODY");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 131_072) {
          void reader.cancel().catch(() => {});
          result.diagnosticError = "BODY_TOO_LARGE";
          return result;
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    return {
      ...diagnosticPayload(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
        attempt,
        [process.env.PLAY_MODEL_API_KEY ?? ""],
      ),
      httpStatus: response.status,
    };
  } catch {
    result.diagnosticError = "UNREADABLE_RESPONSE";
    return result;
  }
}

/** Installed only around the built-in synthetic case; the original fetch is restored. */
export async function withDiagnostics<T>(
  run: () => Promise<T>,
  records: ModelAttemptDiagnostic[],
): Promise<T> {
  const original = globalThis.fetch;
  const pending: Promise<ModelAttemptDiagnostic>[] = [];
  globalThis.fetch = async (...args) => {
    const attempt = pending.length + 1;
    let response: Response;
    try {
      response = await original(...args);
    } catch (error) {
      pending.push(
        Promise.resolve({
          ...emptyDiagnostic(attempt),
          diagnosticError: "TRANSPORT_FAILURE",
        }),
      );
      throw error;
    }
    try {
      pending.push(inspectResponse(response.clone(), attempt));
    } catch {
      pending.push(
        Promise.resolve({
          ...emptyDiagnostic(attempt),
          diagnosticError: "UNREADABLE_RESPONSE",
        }),
      );
    }
    return response;
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    const results = await Promise.allSettled(pending);
    for (const result of results)
      if (result.status === "fulfilled") records.push(result.value);
  }
}

async function main() {
  let options: EvaluationOptions;
  try {
    options = parseEvaluationArgs(process.argv.slice(2));
  } catch {
    console.error(
      "Usage: node --import tsx scripts/testing/evaluate-play-style.ts [--quick | --extended] [--repeat=1..3] [--diagnostics]",
    );
    process.exitCode = 2;
    return;
  }
  config({ quiet: true });
  const jobs = evaluationJobs(options);
  const started = performance.now();
  const suiteSignal = AbortSignal.timeout(
    (options.quick ? 230_000 : options.extended ? 900_000 : 600_000) *
      options.repeat,
  );
  const cases: CaseResult[] = [];
  for (const job of jobs) {
    const caseStarted = performance.now();
    const baseline = median(
      job.fixture.examples.map((item) => lengthOf(item.self)),
    );
    const result: CaseResult = {
      id: `${job.fixture.id}/${job.scenario.id}${options.repeat > 1 ? `/run-${job.repeat}` : ""}`,
      personaId: job.fixture.id,
      scenario: job.scenario.id,
      repeat: job.repeat,
      syntheticHistory: job.scenario.messages,
      syntheticOutput: null,
      reviewFocus: job.scenario.reviewFocus,
      latencyMs: 0,
      length: null,
      sourceMedianLength: baseline,
      lengthToSourceMedian: null,
      emojiPresent: null,
      questionPresent: null,
      hardFailures: [],
      reviewSignals: [],
      providerError: null,
      ...(options.diagnostics ? { diagnostics: [] } : {}),
    };
    try {
      const generate = () =>
        generatePlayReply(
          { persona: job.fixture.persona, messages: job.scenario.messages },
          {
            signal: AbortSignal.any([suiteSignal, AbortSignal.timeout(80_000)]),
          },
        );
      const reply = options.diagnostics
        ? await withDiagnostics(generate, result.diagnostics!)
        : await generate();
      result.syntheticOutput = reply;
      result.length = lengthOf(reply);
      result.lengthToSourceMedian = rounded(result.length / baseline);
      result.emojiPresent = hasEmoji(reply);
      result.questionPresent = /[?？]/u.test(reply);
      if (!reply.trim()) result.hardFailures.push("EMPTY_REPLY");
      if (result.length > job.fixture.maxReplyLength)
        result.hardFailures.push("EXCESSIVE_LENGTH_FOR_FIXTURE");
      if (!job.fixture.allowEmoji && result.emojiPresent)
        result.hardFailures.push("EMOJI_ABSENT_FROM_SOURCE_STYLE");
      if (hasAction(reply))
        result.hardFailures.push("STAGE_ACTION_ABSENT_FROM_SOURCE_STYLE");
      if (/<\/?(?:think|analysis|reasoning)>/iu.test(reply))
        result.hardFailures.push("REASONING_TAGS");
      if (reply.startsWith(`${job.fixture.persona.displayName}：`))
        result.hardFailures.push("SPEAKER_PREFIX");
      const review = reviewReply(
        reply,
        job.scenario.messages.at(-1)!.text,
        job.scenario.id,
        baseline,
      );
      result.hardFailures.push(...review.hardFailures);
      result.reviewSignals.push(...review.reviewSignals);
    } catch (error) {
      // Never print raw exception messages, provider bodies, URLs or credentials.
      result.providerError =
        error instanceof PlayProviderError ? error.code : "UNEXPECTED_ERROR";
      result.hardFailures.push("GENERATION_FAILED");
    }
    for (const attempt of result.diagnostics ?? []) {
      if (
        attempt.rawOutputLength !== null &&
        attempt.rawOutputLength > job.fixture.maxReplyLength
      )
        attempt.observedChecks.push("ABOVE_FIXTURE_LENGTH_LIMIT");
      if (
        !job.fixture.allowEmoji &&
        attempt.observedChecks.includes("CONTAINS_EMOJI")
      )
        attempt.observedChecks.push("EMOJI_ABSENT_FROM_SOURCE_STYLE");
      if (attempt.rawOutput !== null) {
        const review = reviewReply(
          attempt.rawOutput,
          job.scenario.messages.at(-1)!.text,
          job.scenario.id,
          baseline,
        );
        attempt.observedChecks.push(
          ...review.hardFailures,
          ...review.reviewSignals,
        );
      }
    }
    result.latencyMs = Math.round(performance.now() - caseStarted);
    cases.push(result);
    console.error(
      `[synthetic eval] ${result.id}: ${result.latencyMs}ms, ${result.hardFailures.length} hard failure(s), ${result.reviewSignals.length} review signal(s)`,
    );
    if (
      suiteSignal.aborted ||
      result.providerError === "NOT_CONFIGURED" ||
      result.providerError === "UNAVAILABLE"
    )
      break;
  }
  const completed = cases.filter((item) => item.syntheticOutput !== null);
  const failed = cases.filter((item) => item.hardFailures.length > 0);
  const skipped = jobs.length - cases.length;
  const byPersona = fixtures.map((item) => {
    const outputs = completed.filter((result) => result.personaId === item.id);
    return {
      personaId: item.id,
      targetSpeaker: item.persona.exampleSpeaker,
      syntheticReferencePairs: item.examples,
      sourceEmojiRate: rounded(
        item.examples.filter((pair) => hasEmoji(pair.self)).length /
          item.examples.length,
      ),
      generatedCount: outputs.length,
      generatedMedianLength: outputs.length
        ? median(outputs.map((result) => result.length!))
        : null,
      generatedEmojiRate: outputs.length
        ? rounded(
            outputs.filter((result) => result.emojiPresent).length /
              outputs.length,
          )
        : null,
      ...distributionReview(
        item.examples.map((pair) => pair.self),
        outputs.map((result) => ({
          text: result.syntheticOutput!,
          scenario: result.scenario,
        })),
      ),
    };
  });
  const reviewCases = cases.filter((item) => item.reviewSignals.length > 0);
  const distributionSignals = byPersona.flatMap((item) =>
    item.reviewSignals.map((signal) => `${item.personaId}/${signal}`),
  );
  const summary = {
    evaluation: "synthetic-play-style-v2",
    scope:
      "Synthetic fixtures only. Real model calls; automatic habit checks plus human-review pairs. No measured personality-likeness claim.",
    mode: options.quick ? "quick" : options.extended ? "extended" : "full",
    repeat: options.repeat,
    diagnosticsEnabled: options.diagnostics,
    diagnosticScope: options.diagnostics
      ? "Bounded synthetic model responses only; sensitive strings redacted. Observed checks are not the provider's internal rejection reason."
      : null,
    plannedCases: jobs.length,
    attemptedCases: cases.length,
    successfulGenerations: completed.length,
    casesWithHardFailures: failed.length,
    casesWithReviewSignals: reviewCases.length,
    distributionSignals,
    skippedCases: skipped,
    totalLatencyMs: Math.round(performance.now() - started),
    passedAutomaticChecks: failed.length === 0 && skipped === 0,
    passedHeuristicScreen:
      failed.length === 0 &&
      skipped === 0 &&
      reviewCases.length === 0 &&
      distributionSignals.length === 0,
    humanReviewRequired: true,
    byPersona,
    byScenario: [
      ...new Set(cases.map((item) => `${item.personaId}/${item.scenario}`)),
    ].map((id) => {
      const matching = cases.filter(
        (item) => `${item.personaId}/${item.scenario}` === id,
      );
      const successful = matching.filter(
        (item) => item.syntheticOutput !== null,
      );
      return {
        id,
        attemptedRuns: matching.length,
        successfulRuns: successful.length,
        runsWithHardFailures: matching.filter(
          (item) => item.hardFailures.length,
        ).length,
        outputs: successful.map((item) => ({
          repeat: item.repeat,
          text: item.syntheticOutput,
          length: item.length,
        })),
      };
    }),
    cases,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passedAutomaticChecks) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    console.error(
      "Synthetic evaluation could not finish (details suppressed).",
    );
    process.exitCode = 1;
  });
}
