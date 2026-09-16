import { createHash } from "node:crypto";
import { DomainError, type Partition } from "./types";

export interface PIIFinding {
  kind: string;
  start: number;
  end: number;
  severity: "REVIEW" | "REDACT";
}
const patterns: [string, RegExp, "REVIEW" | "REDACT"][] = [
  ["EMAIL", /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "REDACT"],
  ["PHONE", /(?:\+?\d[\d ()-]{7,}\d)/g, "REDACT"],
  ["GOVERNMENT_ID", /\b\d{17}[\dXx]\b|\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, "REDACT"],
  [
    "ADDRESS",
    /(?:\d{1,5}\s+[A-Za-z ]{2,35}\s+(?:street|st|road|rd|avenue|ave|lane|ln)\b)|(?:[\u4e00-\u9fff]{2,12}(?:路|街|巷)\d{1,5}号)/gi,
    "REDACT",
  ],
  [
    "FINANCIAL",
    /(?:银行卡|银行账户|信用卡|卡号|bank account|credit card|account number|BSB)\s*[:：]?\s*[\d -]+/gi,
    "REDACT",
  ],
  [
    "CREDENTIAL",
    /(?:密码|验证码|password|passcode|api[_ -]?key|secret)\s*(?:是|为|is|=|:|：)\s*\S+/gi,
    "REDACT",
  ],
  [
    "SENSITIVE_NARRATIVE",
    /(?:他|她|同事|朋友|室友|老板|my friend|my colleague|my roommate).{0,24}(?:诊断|抑郁|病历|怀孕|出轨|欠债|家庭暴力|diagnos|pregnan|medical|debt|affair)/gi,
    "REVIEW",
  ],
  [
    "PERSON_OR_ORGANISATION",
    /(?:我叫|姓名[：:]|名字是|my name is|就职于|工作单位[：:])\s*[^，。\n,]{1,30}/gi,
    "REVIEW",
  ],
];
/** Local, deterministic screen; passing it is NOT automatic privacy approval. */
export function scanPII(text: string): PIIFinding[] {
  const results: PIIFinding[] = [];
  for (const [kind, pattern, severity] of patterns) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern))
      results.push({
        kind,
        start: m.index!,
        end: m.index! + m[0].length,
        severity,
      });
  }
  return results.sort((a, b) => a.start - b.start || a.end - b.end);
}
export function contentHash(text: string): string {
  return createHash("sha256").update(text.normalize("NFC")).digest("hex");
}
const canonical = (text: string) =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[\p{P}\p{Z}\s]/gu, "");
function shingles(text: string): Set<string> {
  const v = Array.from(canonical(text));
  return new Set(
    v.length < 3
      ? [v.join("")]
      : v.slice(0, -2).map((_, i) => v.slice(i, i + 3).join("")),
  );
}
export function nearDuplicate(a: string, b: string): boolean {
  if (canonical(a) === canonical(b)) return true;
  const left = shingles(a),
    right = shingles(b);
  if (Math.min(canonical(a).length, canonical(b).length) < 12) return false;
  const overlap = [...left].filter((v) => right.has(v)).length;
  return overlap / new Set([...left, ...right]).size >= 0.85;
}
export interface CorpusDraft {
  text: string;
  contentHash: string;
  partition: Partition;
  duplicateOf: string | null;
  privacyStatus: "PENDING";
  findings: PIIFinding[];
}
export function importCorpus(
  messages: string[] | string,
  seed: string,
): CorpusDraft[] {
  const lines =
    typeof messages === "string" ? messages.split(/\r?\n/) : messages;
  if (
    !seed.trim() ||
    lines.length > 1000 ||
    lines.some((v) => typeof v !== "string" || v.length > 20000)
  )
    throw new DomainError("INVALID_CORPUS");
  const texts = lines.filter((text) => text.trim().length > 0);
  // Union connected duplicate groups before partitioning, so transitive near-duplicates cannot leak.
  const parent = texts.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < texts.length; i++)
    for (let j = 0; j < i; j++)
      if (nearDuplicate(texts[i], texts[j])) parent[find(i)] = find(j);
  return texts.map((text, i) => {
    const representative = find(i);
    const bucket =
      parseInt(
        contentHash(seed + "\0" + canonical(texts[representative])).slice(0, 8),
        16,
      ) % 100;
    return {
      text,
      contentHash: contentHash(text),
      partition: bucket < 70 ? "BUILD" : bucket < 85 ? "DEV" : "HOLDOUT",
      duplicateOf:
        representative === i ? null : contentHash(texts[representative]),
      privacyStatus: "PENDING",
      findings: scanPII(text),
    };
  });
}
export function assertBuildEligible(item: {
  partition: string;
  privacyStatus: string;
  deletedAt?: unknown;
  approved?: boolean;
}): void {
  if (
    item.partition !== "BUILD" ||
    item.privacyStatus !== "APPROVED" ||
    item.deletedAt ||
    item.approved === false
  )
    throw new DomainError("CORPUS_NOT_ELIGIBLE");
}
export function redactFindings(text: string, findings = scanPII(text)): string {
  const intervals: [number, number][] = [];
  for (const item of [...findings].sort((a, b) => a.start - b.start)) {
    const previous = intervals.at(-1);
    if (previous && item.start <= previous[1])
      previous[1] = Math.max(previous[1], item.end);
    else intervals.push([item.start, item.end]);
  }
  return intervals
    .reverse()
    .reduce(
      (result, [start, end]) =>
        result.slice(0, start) + "[已移除]" + result.slice(end),
      text,
    );
}
