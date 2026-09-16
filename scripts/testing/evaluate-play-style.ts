/**
 * Real-model style evaluation using only the synthetic fixtures below.
 * Uses PLAY_MODEL_* configuration (and .env); never reads a database or starts services.
 * Run: node --import tsx scripts/testing/evaluate-play-style.ts [--quick]
 * Automatic checks cover observable habits, not personality likeness or semantic quality.
 */
import { config } from "dotenv";
import type { PlayPersonaInput, PlaySpeaker } from "../../src/domain/play";
import {
  generatePlayReply,
  PlayProviderError,
} from "../../src/server/play-provider";

config({ quiet: true });

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
};

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

const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
const lengthOf = (text: string) => [...segmenter.segment(text)].length;
const hasEmoji = (text: string) =>
  /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text);
const hasAction = (text: string) =>
  /[（(][^）)\n]{0,50}(?:笑|歪头|眨眼|眼睛|耸肩|点头|摊手)[^）)\n]{0,50}[）)]|\*[^*\n]{1,50}\*/u.test(
    text,
  );
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const rounded = (value: number) => Math.round(value * 100) / 100;

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--quick")) {
    console.error(
      "Usage: node --import tsx scripts/testing/evaluate-play-style.ts [--quick]",
    );
    process.exitCode = 2;
    return;
  }
  const quick = args.includes("--quick");
  const jobs = quick
    ? [
        { fixture: fixtures[0], scenario: scenarios[0] },
        { fixture: fixtures[1], scenario: scenarios[0] },
        { fixture: fixtures[0], scenario: scenarios[1] },
      ]
    : fixtures.flatMap((item) =>
        scenarios.map((scenario) => ({ fixture: item, scenario })),
      );
  const started = performance.now();
  const suiteSignal = AbortSignal.timeout(quick ? 230_000 : 600_000);
  const cases: CaseResult[] = [];
  for (const job of jobs) {
    const caseStarted = performance.now();
    const baseline = median(
      job.fixture.examples.map((item) => lengthOf(item.self)),
    );
    const result: CaseResult = {
      id: `${job.fixture.id}/${job.scenario.id}`,
      personaId: job.fixture.id,
      scenario: job.scenario.id,
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
    };
    try {
      const reply = await generatePlayReply(
        { persona: job.fixture.persona, messages: job.scenario.messages },
        {
          signal: AbortSignal.any([suiteSignal, AbortSignal.timeout(80_000)]),
        },
      );
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
      if (result.lengthToSourceMedian > 2)
        result.reviewSignals.push("MORE_THAN_TWICE_SOURCE_MEDIAN");
      if (/聊点轻松|换个话题|快说说看|看看\s*AI\s*的?本领/iu.test(reply))
        result.reviewSignals.push("POSSIBLE_TEMPLATE_OR_TOPIC_DEFLECTION");
      if (/刚(?:刚|才)?[^。！？\n]{0,20}(?:代码|咖啡|展览|写完)/u.test(reply))
        result.reviewSignals.push("CHECK_UNSUPPORTED_RECENT_EVENT");
    } catch (error) {
      // Never print raw exception messages, provider bodies, URLs or credentials.
      result.providerError =
        error instanceof PlayProviderError ? error.code : "UNEXPECTED_ERROR";
      result.hardFailures.push("GENERATION_FAILED");
    }
    result.latencyMs = Math.round(performance.now() - caseStarted);
    cases.push(result);
    console.error(
      `[synthetic eval] ${result.id}: ${result.latencyMs}ms, ${result.hardFailures.length} hard failure(s)`,
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
  const summary = {
    evaluation: "synthetic-play-style-v1",
    scope:
      "Synthetic fixtures only. Real model calls; automatic habit checks plus human-review pairs. No measured personality-likeness claim.",
    mode: quick ? "quick" : "full",
    plannedCases: jobs.length,
    attemptedCases: cases.length,
    successfulGenerations: completed.length,
    casesWithHardFailures: failed.length,
    skippedCases: skipped,
    totalLatencyMs: Math.round(performance.now() - started),
    passedAutomaticChecks: failed.length === 0 && skipped === 0,
    byPersona: fixtures.map((item) => {
      const outputs = completed.filter(
        (result) => result.personaId === item.id,
      );
      return {
        personaId: item.id,
        targetSpeaker: item.persona.exampleSpeaker,
        syntheticReferencePairs: item.examples,
        sourceMedianLength: median(
          item.examples.map((pair) => lengthOf(pair.self)),
        ),
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
      };
    }),
    cases,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passedAutomaticChecks) process.exitCode = 1;
}

main().catch(() => {
  console.error("Synthetic evaluation could not finish (details suppressed).");
  process.exitCode = 1;
});
