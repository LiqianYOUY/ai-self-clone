import { createHash } from "node:crypto";
import type { PlayPersonaInput, PlayStyleSummary } from "../domain/play";

/** A versioned, evidence-only distillation. This never changes model weights. */
export const PLAY_STYLE_VERSION = "speaker-evidence-v1";
const MAX_SOURCE = 16_000;
const MAX_SAMPLES = 200;
const MAX_MESSAGE = 800;
const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
const SELF_LABELS = new Set([
  "我",
  "本人",
  "自己",
  "发起者",
  "发起人",
  "me",
  "self",
]);
const FRIEND_LABELS = new Set(["朋友", "好友", "对方", "friend", "other"]);
const WARNING_CODES = new Set([
  "unlabeled_self",
  "unrecognized_speakers",
  "limited_examples",
  "ignored_lines",
]);

export type PlayStyleScene =
  | "greeting"
  | "clarification"
  | "skepticism"
  | "invitation"
  | "thanks"
  | "apology"
  | "agreement"
  | "refusal"
  | "laughter"
  | "question"
  | "other";
const SCENES = new Set<PlayStyleScene>([
  "greeting",
  "clarification",
  "skepticism",
  "invitation",
  "thanks",
  "apology",
  "agreement",
  "refusal",
  "laughter",
  "question",
  "other",
]);

export interface PlayStyleSample {
  id: string;
  text: string;
  /** An actual preceding message, never an invented training prompt. */
  prompt?: string;
  scene: PlayStyleScene;
}

export interface PlayStyleProfile {
  version: string;
  sourceHash: string;
  targetSpeaker: string;
  samples: PlayStyleSample[];
  metrics: Pick<
    PlayStyleSummary,
    | "medianLength"
    | "p90Length"
    | "emojiRate"
    | "questionRate"
    | "exclamationRate"
    | "finalPunctuationRate"
    | "actionRate"
  >;
  recurringPhrases: Array<{ text: string; evidenceIds: string[] }>;
  warnings: string[];
  summary: PlayStyleSummary;
}

export function graphemeLength(text: string): number {
  return [...segmenter.segment(text)].length;
}

export function styleSourceHash(persona: PlayPersonaInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        PLAY_STYLE_VERSION,
        persona.displayName,
        persona.exampleSpeaker ?? "",
        persona.examplesText,
        persona.style,
        persona.bio,
        persona.memories,
      ]),
    )
    .digest("hex");
}

function labelKey(label: string): string {
  return label
    .trim()
    .replace(/^[【\[]|[】\]]$/gu, "")
    .trim()
    .toLocaleLowerCase("en");
}

function scene(text: string): PlayStyleScene {
  if (
    /一眼\s*ai|机器人|像\s*ai|是\s*ai|人工智能|露馅|装的|\bbot\b/iu.test(text)
  )
    return "skepticism";
  if (
    /啥|什么意思|什么意|没听懂|没懂|没明白|说清楚|解释|听不懂|哪句|为啥|为什么|\b(?:what do you mean|explain|why)\b/iu.test(
      text,
    )
  )
    return "clarification";
  if (
    /^(?:哈[喽啰罗]|你[好]|您好|嗨|嘿|早[呀啊安]?|晚[上]好|在吗|hello\b|hi\b|hey\b|good morning\b)/iu.test(
      text,
    )
  )
    return "greeting";
  if (
    /一起|约[吗个一下呗]?|出来|去[不]?去|吃饭|吃[个]?饭|喝[杯点]?|看[个]?电影|打[把]?游戏|\b(?:join|hang out|dinner|lunch)\b/iu.test(
      text,
    )
  )
    return "invitation";
  if (/谢谢|谢[啦了]|多谢|\bthank/iu.test(text)) return "thanks";
  if (/对不起|抱歉|不好意思|\bsorry\b/iu.test(text)) return "apology";
  if (/^(?:不[去行要用啦了]|算了|没空|no\b|nope\b)/iu.test(text))
    return "refusal";
  if (
    /^(?:好[的啊呀吧嘞哦哇]?|行[啊呀吧呗]?|可以|没问题|嗯|ok\b|okay\b|sure\b|yes\b)/iu.test(
      text,
    )
  )
    return "agreement";
  if (/^(?:哈{2,}|笑死|乐|lol\b|lmao\b)/iu.test(text)) return "laughter";
  if (/[?？]|[吗呢么]$|\b(?:how|when|where|what|who)\b/iu.test(text))
    return "question";
  return "other";
}

function isTimestamp(text: string): boolean {
  return (
    /^(?:\[|【)?(?:(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}月\d{1,2}日|今天|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天])\s*)?(?:上午|下午|晚上|早上|中午|凌晨)?\s*\d{1,2}[:：]\d{2}(?::\d{2})?(?:\s*[AP]M)?(?:\]|】)?$/iu.test(
      text,
    ) || /^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?$/u.test(text)
  );
}

function isSystemLine(text: string): boolean {
  return (
    /^(?:\[|【)?(?:系统消息|系统提示|系统|system(?: message)?)(?:\]|】|[:：])/iu.test(
      text,
    ) ||
    /^(?:你|对方|.+?)撤回了一条消息[。.]?$/u.test(text) ||
    /^(?:已读|未读|已送达|已发送|read|delivered)$/iu.test(text) ||
    /^(?:以下为新消息|以上是打招呼的内容|你们已经是好友了|消息已发出，但被对方拒收了)/u.test(
      text,
    )
  );
}

function isBoundary(text: string): boolean {
  return (
    !text ||
    /^[-=_*]{3,}$/u.test(text) ||
    /^(?:示例|对话|聊天|example|conversation)\s*[一二三四五六七八九十\d]+\s*[:：]?$/iu.test(
      text,
    )
  );
}

function inlineLabel(
  text: string,
  exactLabels?: ReadonlySet<string>,
): { label: string; text: string } | undefined {
  for (const label of exactLabels ?? []) {
    for (const colon of ["：", ":"]) {
      if (text.toLocaleLowerCase("en").startsWith(label + colon)) {
        return { label, text: text.slice(label.length + 1).trim() };
      }
    }
  }
  const match = /^([^:：\n]{1,40})[:：]\s*(.*)$/u.exec(text);
  if (
    !match ||
    !match[1].trim() ||
    /^(?:https?|ftp|file|mailto|\d+)$/iu.test(match[1].trim())
  )
    return undefined;
  return { label: labelKey(match[1]), text: match[2] };
}

/** Infer only the header positions of a regular, two-line-per-message export. */
function ownLineLabels(lines: string[], known: Set<string>): Set<string> {
  const clean = lines.filter(
    (line) => !isBoundary(line) && !isTimestamp(line) && !isSystemLine(line),
  );
  const labels = new Set(known);
  if (clean.length < 4 || clean.some((line) => inlineLabel(line, known)))
    return labels;
  const candidates = clean.filter((_, i) => i % 2 === 0);
  if (
    !candidates.every(
      (line) =>
        known.has(labelKey(line)) ||
        /^[\p{L}\p{N}_ .·\-【】\[\]]{1,24}$/u.test(line),
    )
  )
    return labels;
  if (clean.some((line, i) => i % 2 === 1 && known.has(labelKey(line))))
    return labels;
  const unique = new Set(candidates.map(labelKey));
  // More than four speakers, or a single unknown repeated word, is not reliable.
  if (unique.size > 4 || (unique.size === 1 && !known.has([...unique][0])))
    return labels;
  const hasKnownHeader = candidates.some((line) => known.has(labelKey(line)));
  const hasRepeatedHeader = unique.size < candidates.length && unique.size >= 2;
  if (!hasKnownHeader && !hasRepeatedHeader) return labels;
  for (const label of unique) labels.add(label);
  return labels;
}

function parseSamples(persona: PlayPersonaInput): {
  samples: PlayStyleSample[];
  warnings: string[];
  targetSpeaker: string;
} {
  const warnings = new Set<string>();
  const raw = persona.examplesText.replace(/\r\n?/gu, "\n");
  if (raw.length > MAX_SOURCE) warnings.add("ignored_lines");
  // Drop a cut-off last line rather than turn a fragment into speech evidence.
  const cut = raw.lastIndexOf("\n", MAX_SOURCE);
  const source =
    raw.length > MAX_SOURCE ? (cut < 0 ? "" : raw.slice(0, cut)) : raw;
  const lines = source.split("\n").map((line) => line.trim());
  const explicit = labelKey(persona.exampleSpeaker ?? "");
  const display = labelKey(persona.displayName);
  const displayOccurs =
    !!display &&
    lines.some(
      (line) =>
        labelKey(line) === display ||
        inlineLabel(line, new Set([display]))?.label === display,
    );
  const self = explicit
    ? new Set([explicit])
    : displayOccurs && !SELF_LABELS.has(display)
      ? new Set([display])
      : new Set([...SELF_LABELS, display].filter(Boolean));
  const known = new Set([...self, ...FRIEND_LABELS]);
  const names = ownLineLabels(lines, known);
  for (const line of lines) {
    if (isTimestamp(line) || isSystemLine(line)) continue;
    const inline = names.has(labelKey(line))
      ? undefined
      : inlineLabel(line, self);
    if (inline) names.add(inline.label);
  }
  const hasLabels = lines.some(
    (line) =>
      !isTimestamp(line) &&
      !isSystemLine(line) &&
      (names.has(labelKey(line)) || !!inlineLabel(line, self)),
  );
  const samples: PlayStyleSample[] = [];
  let active: { label: string; text: string[]; oneLine?: boolean } | undefined;
  let pendingFriend: string | undefined;
  let foundSelf = false;
  let selectedSpeaker =
    persona.exampleSpeaker?.trim() ||
    (displayOccurs && !SELF_LABELS.has(display)
      ? persona.displayName.trim()
      : "");
  function finish() {
    if (!active) return;
    const text = active.text.join("\n").trim();
    if (!text) {
      warnings.add("ignored_lines");
      active = undefined;
      return;
    }
    if (graphemeLength(text) > MAX_MESSAGE) {
      warnings.add("ignored_lines");
      pendingFriend = undefined;
    } else if (self.has(active.label)) {
      foundSelf = true;
      selectedSpeaker ||= active.label;
      if (samples.length < MAX_SAMPLES) {
        samples.push({
          id: `s${samples.length + 1}`,
          text,
          ...(pendingFriend ? { prompt: pendingFriend } : {}),
          scene: scene(pendingFriend ?? text),
        });
      } else warnings.add("ignored_lines");
      // Consecutive host messages remain distinct; only the first is a direct reply.
      pendingFriend = undefined;
    } else {
      pendingFriend = text;
    }
    active = undefined;
  }
  for (const line of lines) {
    if (isBoundary(line)) {
      finish();
      pendingFriend = undefined;
      continue;
    }
    if (isTimestamp(line)) {
      warnings.add("ignored_lines");
      continue;
    }
    if (isSystemLine(line)) {
      finish();
      pendingFriend = undefined;
      warnings.add("ignored_lines");
      continue;
    }
    const inline = names.has(labelKey(line))
      ? undefined
      : inlineLabel(line, self);
    if (inline || names.has(labelKey(line))) {
      finish();
      active = {
        label: inline?.label ?? labelKey(line),
        text: inline?.text ? [inline.text] : [],
        oneLine: !inline,
      };
    } else if (hasLabels) {
      if (active) {
        active.text.push(line);
        // Header-only exports have no explicit end delimiter. Consume one body
        // line, avoiding accidental absorption of an unidentified next speaker.
        if (active.oneLine) finish();
      } else warnings.add("ignored_lines");
    } else {
      warnings.add("unlabeled_self");
      active = { label: [...self][0], text: [line] };
      finish();
    }
  }
  finish();
  if (hasLabels && !foundSelf) warnings.add("unrecognized_speakers");
  return {
    samples,
    warnings: [...warnings].sort(),
    targetSpeaker: selectedSpeaker || persona.displayName.trim() || "我",
  };
}

function fraction(samples: PlayStyleSample[], pattern: RegExp): number {
  return samples.length
    ? Number(
        (
          samples.filter(({ text }) => pattern.test(text)).length /
          samples.length
        ).toFixed(4),
      )
    : 0;
}

function recurringPhrases(
  samples: PlayStyleSample[],
): PlayStyleProfile["recurringPhrases"] {
  const evidence = new Map<string, Set<string>>();
  for (const sample of samples) {
    // Whole short clauses retain actual language, rather than invented n-gram fragments.
    const clauses = sample.text
      .split(/[，。！？、,!?;；\n]+/u)
      .map((value) => value.trim())
      .filter(
        (value) => graphemeLength(value) >= 2 && graphemeLength(value) <= 12,
      );
    const particles =
      sample.text.match(
        /哈{2,}|呵{2,}|嘿{2,}|嗯{2,}|好[呀啊嘞哇]|行[啊呀吧呗]|笑死(?:我了)?|[啊呀呗啦咯嘛呐哇]$/gu,
      ) ?? [];
    for (const phrase of new Set([...clauses, ...particles])) {
      const ids = evidence.get(phrase) ?? new Set<string>();
      ids.add(sample.id);
      evidence.set(phrase, ids);
    }
  }
  return [...evidence]
    .filter(([, ids]) => ids.size >= 2)
    .sort(
      (a, b) =>
        b[1].size - a[1].size ||
        graphemeLength(b[0]) - graphemeLength(a[0]) ||
        a[0].localeCompare(b[0], "zh"),
    )
    .slice(0, 8)
    .map(([text, ids]) => ({ text, evidenceIds: [...ids] }));
}

export function summarizePlayStyle(
  profile: PlayStyleProfile,
): PlayStyleSummary {
  const sampleCount = profile.samples.length;
  const pairedExampleCount = profile.samples.filter(
    (sample) => sample.prompt,
  ).length;
  const status =
    sampleCount === 0
      ? "needs_examples"
      : sampleCount >= 8 && pairedExampleCount >= 3
        ? "ready"
        : "limited";
  return {
    version: profile.version,
    sourceHash: profile.sourceHash,
    targetSpeaker: profile.targetSpeaker,
    sampleCount,
    pairedExampleCount,
    status,
    ...profile.metrics,
    commonPhrases: profile.recurringPhrases.map((phrase) => phrase.text),
    warnings: [
      ...new Set([
        ...profile.warnings.filter((warning) => warning !== "limited_examples"),
        ...(status === "limited" ? ["limited_examples"] : []),
      ]),
    ].sort(),
  };
}

export function distillPlayStyle(persona: PlayPersonaInput): PlayStyleProfile {
  const { samples, warnings, targetSpeaker } = parseSamples(persona);
  const lengths = samples
    .map(({ text }) => graphemeLength(text))
    .sort((a, b) => a - b);
  const middle = Math.floor(lengths.length / 2);
  const metrics: PlayStyleProfile["metrics"] = {
    medianLength: !lengths.length
      ? 0
      : lengths.length % 2
        ? lengths[middle]
        : (lengths[middle - 1] + lengths[middle]) / 2,
    p90Length: lengths[Math.max(0, Math.ceil(lengths.length * 0.9) - 1)] ?? 0,
    emojiRate: fraction(
      samples,
      /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u,
    ),
    questionRate: fraction(samples, /[?？]/u),
    exclamationRate: fraction(samples, /[!！]/u),
    finalPunctuationRate: fraction(samples, /[。！？.!?，,；;：:…]$/u),
    actionRate: fraction(
      samples,
      /[（(][^()（）\n]{0,20}(?:笑|歪头|摊手|眨眼|耸肩|点头|摇头|挥手|叹气|脸红|眼睛亮|smil|laugh|shrug)[^()（）\n]{0,20}[）)]|\*[^*\n]{1,40}\*/iu,
    ),
  };
  const profile: PlayStyleProfile = {
    version: PLAY_STYLE_VERSION,
    sourceHash: styleSourceHash(persona),
    targetSpeaker,
    samples,
    metrics,
    recurringPhrases: recurringPhrases(samples),
    warnings,
    summary: {} as PlayStyleSummary,
  };
  profile.summary = summarizePlayStyle(profile);
  profile.warnings = profile.summary.warnings;
  return profile;
}

/** Cached profiles are server-owned; validate before using data from old snapshots. */
export function resolvePlayStyle(
  persona: PlayPersonaInput,
  stored?: unknown,
): PlayStyleProfile {
  if (stored && typeof stored === "object") {
    const value = stored as PlayStyleProfile;
    const source = persona.examplesText.replace(/\r\n?/gu, "\n");
    const validSamples =
      Array.isArray(value.samples) &&
      value.samples.length <= MAX_SAMPLES &&
      value.samples.every(
        (sample, index) =>
          sample &&
          sample.id === `s${index + 1}` &&
          typeof sample.text === "string" &&
          sample.text.length > 0 &&
          graphemeLength(sample.text) <= MAX_MESSAGE &&
          source.includes(sample.text) &&
          SCENES.has(sample.scene) &&
          (sample.prompt === undefined ||
            (typeof sample.prompt === "string" &&
              sample.prompt.length > 0 &&
              graphemeLength(sample.prompt) <= MAX_MESSAGE &&
              source.includes(sample.prompt))),
      );
    const validMetrics =
      value.metrics &&
      [
        "medianLength",
        "p90Length",
        "emojiRate",
        "questionRate",
        "exclamationRate",
        "finalPunctuationRate",
        "actionRate",
      ].every((key) => {
        const number = value.metrics[key as keyof PlayStyleProfile["metrics"]];
        return (
          typeof number === "number" &&
          Number.isFinite(number) &&
          number >= 0 &&
          number <= (key.endsWith("Rate") ? 1 : MAX_MESSAGE)
        );
      });
    const validPhrases =
      validSamples &&
      Array.isArray(value.recurringPhrases) &&
      value.recurringPhrases.length <= 8 &&
      value.recurringPhrases.every(
        (phrase) =>
          phrase &&
          typeof phrase.text === "string" &&
          graphemeLength(phrase.text) <= 12 &&
          Array.isArray(phrase.evidenceIds) &&
          phrase.evidenceIds.length >= 2 &&
          phrase.evidenceIds.every((id) =>
            value.samples.some(
              (sample) => sample.id === id && sample.text.includes(phrase.text),
            ),
          ),
      );
    if (
      value.version === PLAY_STYLE_VERSION &&
      value.sourceHash === styleSourceHash(persona) &&
      value.targetSpeaker === parseSamples(persona).targetSpeaker &&
      validSamples &&
      validMetrics &&
      validPhrases &&
      Array.isArray(value.warnings) &&
      value.warnings.every((warning) => WARNING_CODES.has(warning))
    ) {
      return { ...value, summary: summarizePlayStyle(value) };
    }
  }
  return distillPlayStyle(persona);
}

function tokens(text: string): Set<string> {
  const result = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z]{2,}|\p{Script=Han}+/gu) ??
    []) {
    if (/^[a-z]+$/u.test(word)) {
      if (
        !new Set([
          "the",
          "you",
          "your",
          "are",
          "and",
          "for",
          "that",
          "this",
          "have",
          "with",
          "what",
          "how",
        ]).has(word)
      )
        result.add(word);
    } else {
      for (let i = 0; i < word.length - 1; i++) {
        const pair = word.slice(i, i + 2);
        if (
          !/^(?:我的|你的|我们|你们|这个|那个|就是|什么|怎么|时候|一个|可以|不是|我在|你在)$/u.test(
            pair,
          )
        )
          result.add(pair);
      }
    }
  }
  return result;
}

/** Relevant authentic examples, bounded independently of corpus size. */
export function selectStyleExamples(
  profile: PlayStyleProfile,
  currentText: string,
  limit = 4,
): PlayStyleSample[] {
  const count = Math.max(
    0,
    Math.min(6, Number.isFinite(limit) ? Math.floor(limit) : 4),
  );
  const currentScene = scene(currentText);
  const queryTokens = tokens(currentText);
  const scored = profile.samples
    .map((sample, index) => {
      const candidateTokens = tokens(sample.prompt ?? sample.text);
      const shared = [...queryTokens].filter((token) =>
        candidateTokens.has(token),
      ).length;
      const sameScene =
        currentScene !== "other" && sample.scene === currentScene;
      return {
        sample,
        index,
        score:
          (sameScene ? 10 : 0) +
          Math.min(8, shared * 2) +
          (sameScene || shared ? (sample.prompt ? 2 : 0) : 0),
      };
    })
    .filter(
      ({ sample, score }) =>
        score > 0 &&
        graphemeLength(sample.text) <= 400 &&
        graphemeLength(sample.prompt ?? "") <= 400,
    )
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: PlayStyleSample[] = [];
  const seen = new Set<string>();
  let budget = 2_000;
  for (const { sample } of scored) {
    const key = sample.text.replace(/\s+/gu, "").toLowerCase();
    const size =
      graphemeLength(sample.text) + graphemeLength(sample.prompt ?? "");
    if (selected.length >= count) break;
    if (seen.has(key) || size > budget) continue;
    selected.push({ ...sample });
    seen.add(key);
    budget -= size;
  }
  return selected;
}
