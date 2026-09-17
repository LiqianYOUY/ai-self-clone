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
  | "low_mood"
  | "recollection"
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
  "low_mood",
  "recollection",
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

function hasOverloadSignal(text: string): boolean {
  // Treat overload as a conversational state, not a keyword in a definition,
  // a negated state, or a positive use such as being overwhelmed with joy.
  if (
    /是什么|什么意思|啥意思|怎么翻译|如何翻译|怎么说|为什么|定义|原理|概念|症状|\b(?:what (?:is|are|does)|definition|meaning|translate|symptoms?|causes?)\b/iu.test(
      text,
    ) ||
    /(?:不再|并不|不会|没有|没(?:有)?觉得|不觉得|并没有).{0,16}(?:压力|压得|压到|压垮|喘不过气|转不动|忙不过来|扛不住|撑不住)|\b(?:not|never|no longer|don't|do not|isn't|is not|aren't|are not)\b.{0,25}\b(?:overwhelmed|burn(?:ed|t)? out|under pressure|stressed)\b/iu.test(
      text,
    ) ||
    /\boverwhelmed\s+(?:with|by)\s+(?:(?:so much|the|pure)\s+)?(?:joy|happiness|excitement|love|gratitude)\b/iu.test(
      text,
    )
  )
    return false;
  return (
    /(?:工作|任务|事情|压力|生活|学业|考试).{0,12}(?:压得|压到|压垮|喘不过气|忙不过来|应付不过来|招架不住|扛不住|撑不住)|(?:脑子|脑袋|大脑|头脑).{0,5}(?:转不动|不转了|一片空白|宕机|罢工)|(?:我|今天|最近).{0,8}(?:忙不过来|扛不住|撑不住|被压垮)|(?:工作|任务|事情|作业)(?:实在)?太多.{0,8}(?:做不完|忙不过来|应付不来)/u.test(
      text,
    ) ||
    /\b(?:i(?:'m| am)?|feeling|feel)\s+(?:(?:so|really|very|completely|totally|a bit)\s+)?(?:overwhelmed|burn(?:ed|t) out|under pressure|swamped)\b|\b(?:work|tasks?|deadlines?)\s+(?:is |are )?(?:overwhelming|crushing)\s+me\b|^(?:overwhelmed|burn(?:ed|t) out|under pressure|swamped)(?:\s+(?:today|lately|again))?[.!\s]*$/iu.test(
      text,
    )
  );
}

function isConversationalCorrection(text: string): boolean {
  // Contrast the speakers' utterances, rather than classifying by the topic
  // inside them (a date, meal, place, quantity, and so on).
  if (
    /^我(?:想|能|可以)?问(?:你)?(?:一下|下|个问题)?[，,\s]*(?:你)?(?:怎么|怎样|如何|为什么|为啥|哪|什么)/u.test(
      text,
    )
  )
    return false;
  return (
    /(?:我|咱们)(?:刚才|刚刚|方才|之前|先前|刚|原本)?(?:问|说|提|讲)[^。！？\n]{0,70}(?:你|您)(?:却|反而|怎么|咋|又|还|说|答|回)|你(?:刚才|刚刚|之前|前面|先前)?(?:说|讲|答|回)[^。！？\n]{1,60}(?:现在|这次|后来)[^。！？\n]{0,12}(?:又|却|怎么|咋|变|成)|你[^。！？\n]{0,8}把[^。！？\n]{1,40}(?:说成|看成|听成|记成|弄成|当成)|(?:我问|我说|我指)(?:的)?是[^。！？\n]{1,50}(?:不是|而不是)|不是[^。！？\n]{1,50}(?:我问|我说|我指)(?:的)?是/u.test(
      text,
    ) ||
    /\bi (?:asked|said|meant|was asking|was talking about)\b[^.!?\n]{0,100}\b(?:but you|you (?:said|answered|replied)|why (?:did|are|do) you|not|rather than)\b|\byou (?:said|told me|answered)\b[^.!?\n]{1,80}\b(?:but now|now you|why (?:are|did) you)\b/iu.test(
      text,
    )
  );
}

function isRecollection(text: string): boolean {
  // Remembering an earlier event and being told to remember a future action
  // are different speech acts, even when both mention doing something together.
  if (
    /翻译|定义|怎么说|什么意思|啥意思|(?:怎么|如何|怎样)(?:才能|能|才会).{0,10}记得|(?:人|大脑|人们)为什么.{0,10}记得|\b(?:definition|translate|meaning|what does|(?:how|why) (?:do|does|can) (?:we|people|humans|the brain))\b/iu.test(
      text,
    )
  )
    return false;
  const question =
    /[?？]|[吗么不][。！!\s]*$|\b(?:do|did|can|could|would) you\b/iu.test(text);
  if (
    !question &&
    /记得(?:要|得|先|再|别|不要|明天|后天|下周|下个|待会|等会|到时候)|别忘(?:了)?(?:要|明天|后天|下周|待会|等会)|(?:明天|后天|下周|待会|等会|到时候)[^。！？\n]{0,16}(?:记得|别忘)|\bremember\s+to\b/iu.test(
      text,
    )
  )
    return false;
  return /(?:还)?记不记得|(?:还)?记得|想(?:不想)?得起|有没有印象|还有印象|有印象|\b(?:remember|recall)\b/iu.test(
    text,
  );
}

function isCasualCheckIn(text: string): boolean {
  // Whole-message check-ins can use the greeting examples. A question about a
  // particular task or object must retain its specific conversational purpose.
  return /^(?:(?:喂|哟|嗨|嘿)[，,!！\s]*)?(?:你)?(?:现在)?(?:(?:在|正在)(?:忙啥|忙什么|干啥|干嘛|做什么)|忙啥|忙什么|干嘛呢|干啥呢|做什么呢)[呢呀啊？?。！!\s]*$|^(?:(?:hey|hi|yo)[,!\s]+)?(?:what(?:'s| is) up|what are you (?:up to|doing)(?: right now)?)[?!.\s]*$/iu.test(
    text,
  );
}

/** Shared conversational intent for retrieval and the reply's immediate goal. */
export function classifyPlayStyleScene(text: string): PlayStyleScene {
  const value = text.trim();
  if (isConversationalCorrection(value)) return "clarification";
  if (
    /一眼\s*ai\b|(?:你|这(?:句|话|回复|语气))[^。！？\n]{0,18}(?:机器人|像\s*ai\b|是\s*ai\b|人工智能|客套|官方|敷衍|板正|客服|端着)|^(?:露馅|装的)|\b(?:are you (?:an? )?(?:ai|bot)|you sound (?:like|robotic|so formal)|that sounds (?:robotic|so formal)|(?:this|that) (?:reply|message) sounds like)\b/iu.test(
      value,
    )
  )
    return "skepticism";
  if (
    /^(?:啥|什么|啊)[？?！!。\s]*$|[？?]\s*(?:啥|什么)[？?\s]*$|什么意思|啥意思|(?:没|不)(?:听|看)?(?:懂|明白)|说清楚|你说啥|哪句|(?:再|重新)(?:说|解释)|解释(?:一下)?(?:你|刚|上|这|那)|^(?:请)?解释(?:一下)?[？?\s]*$|(?:为什么|为啥).{0,12}(?:这么说|那样说|这样说)|\b(?:what do you mean|(?:do not|don't|did not|didn't) (?:get|understand)|say that again|which part|why did you say|explain (?:that|what you))\b/iu.test(
      value,
    )
  )
    return "clarification";
  if (isRecollection(value)) return "recollection";
  if (isCasualCheckIn(value)) return "greeting";
  if (
    /^(?:哈[喽啰罗]|你好|您好|嗨|嘿|早安|早上好|晚上好|早[呀啊]?\s*$|(?:哟|喂)?[，,！!\s]*(?:在吗|在不|在不在)|好久(?:不见|没(?:聊|唠)(?:天)?了)|hello\b|hi\b|hey\b|good morning\b|long time no see\b|(?:yo[,!\s]*)?(?:are you )?(?:there|around)\b)/iu.test(
      value,
    )
  )
    return "greeting";
  if (
    !/不(?:太|怎么|是|觉得|会)?累|不(?:太|怎么|是|觉得)?烦|不难过|没有不开心|\b(?:not|never) (?:tired|sad|upset|down|exhausted)\b/iu.test(
      value,
    ) &&
    (/(?:有点|有些|挺|很|太|好|特别|真(?:的)?)(?:累|烦|难过|沮丧|委屈|郁闷|失落)|(?:我|今天|最近).{0,8}(?:累了|烦死|难过|不开心|心情不好|压力大|提不起劲)|^(?:累了|烦死了|难过|不开心|心情不好|提不起劲|想静静)[。！!\s]*$|\b(?:(?:i(?:'m| am)?|feeling|feel|so|really|very|a bit) (?:tired|sad|upset|down|exhausted|stressed)|having a (?:rough|bad) day)\b/iu.test(
      value,
    ) ||
      hasOverloadSignal(value))
  )
    return "low_mood";
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
  if (
    /[?？]|[吗呢么]$|为什么|为啥|怎么|怎样|哪[里个些]|几[点个岁]|多少|\b(?:how|when|where|what|who|why)\b/iu.test(
      text,
    )
  )
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
          scene: classifyPlayStyleScene(pendingFriend ?? text),
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
          "where",
          "when",
          "why",
          "who",
          "which",
          "is",
          "it",
          "my",
          "am",
          "be",
          "do",
          "as",
          "on",
          "in",
          "of",
          "to",
          "at",
          "we",
          "me",
          "so",
          "no",
          "an",
          "today",
          "really",
          "very",
          "feeling",
          "feel",
          "just",
          "was",
          "did",
          "not",
          "can",
          "could",
        ]).has(word)
      )
        result.add(word);
    } else {
      for (let i = 0; i < word.length - 1; i++) {
        const pair = word.slice(i, i + 2);
        if (
          !/^(?:我的|你的|我们|你们|这个|那个|就是|什么|为什|怎么|时候|么时|哪里|在哪|多少|何时|是否|怎样|咋样|一个|可以|不是|我在|你在|我很|你很|我也|你也|有点|有些|今天|明天|昨天|最近|好久|一下|了吧)$/u.test(
            pair,
          )
        )
          result.add(pair);
      }
    }
  }
  return result;
}

function textLanguage(text: string): "zh" | "en" | undefined {
  // Common acknowledgements may be borrowed in either language. For real
  // sentences, require the query and both sides of a pair to use compatible text.
  if (
    /^(?:ok(?:ay)?|kk|lol|lmao|(?:ha){2,}|哈+|嗯+)[\s.!！?？~～]*$/iu.test(
      text.trim(),
    )
  )
    return undefined;
  if (/\p{Script=Han}/u.test(text)) return "zh";
  if (/[a-z]/iu.test(text)) return "en";
  return undefined;
}

const FOCUSED_SCENES = new Set<PlayStyleScene>([
  "greeting",
  "clarification",
  "skepticism",
  "low_mood",
  "recollection",
]);

function retrievalTokens(text: string, scene: PlayStyleScene): Set<string> {
  if (scene !== "recollection") return tokens(text);
  // Recall cues alone do not make two different personal events relevant.
  // Require an actual topic overlap before exposing an old memory reply.
  return tokens(
    text
      .replace(
        /还记不记得|记不记得|还记得|记得|想不想得起来?|想得起来?|有没有印象|还有印象|有印象|一起|当时|以前|之前|从前|曾经|那时候|那会儿|(?:那|这|上)(?:一次|次|一回|回|件事|件)/gu,
        " ",
      )
      .replace(
        /\b(?:remember|recall|memories|memory|still|together|ago|last|time|used|then|back|ever|our)\b/giu,
        " ",
      ),
  );
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
  const currentScene = classifyPlayStyleScene(currentText);
  const queryLanguage = textLanguage(currentText);
  const queryTokens = retrievalTokens(currentText, currentScene);
  const scored = profile.samples
    .map((sample, index) => {
      // Stored v1 profiles retain valid original evidence. Reclassify that
      // evidence at retrieval time so existing profiles gain the improved matching.
      const candidateScene = classifyPlayStyleScene(
        sample.prompt ?? sample.text,
      );
      const compatibleLanguage = [sample.prompt, sample.text].every((text) => {
        const language = text === undefined ? undefined : textLanguage(text);
        return !queryLanguage || !language || queryLanguage === language;
      });
      const candidateTokens = retrievalTokens(
        sample.prompt ?? sample.text,
        candidateScene,
      );
      const shared = [...queryTokens].filter((token) =>
        candidateTokens.has(token),
      ).length;
      const sameScene =
        currentScene !== "other" &&
        currentScene !== "question" &&
        candidateScene === currentScene;
      const compatibleIntent =
        (!FOCUSED_SCENES.has(currentScene) &&
          !FOCUSED_SCENES.has(candidateScene)) ||
        sameScene;
      return {
        sample,
        index,
        score:
          compatibleLanguage &&
          compatibleIntent &&
          (currentScene !== "recollection" || shared > 0)
            ? (sameScene ? 10 : 0) +
              Math.min(8, shared * 2) +
              (sameScene || shared ? (sample.prompt ? 2 : 0) : 0)
            : 0,
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
