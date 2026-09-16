import { createHash } from "node:crypto";
import {
  DomainError,
  TOPIC_IDS,
  type SourceCondition,
  type TopicId,
} from "./types";

export const RANDOMIZATION_VERSION = "nbibd36-coordinate-descent-v1";
export interface AllocationSession {
  index: number;
  source: SourceCondition;
  topic: TopicId;
}
export interface AllocationDyad {
  dyadIndex: number;
  targetIndex: number;
  friendIndex: number;
  sessions: AllocationSession[];
}
export interface BalanceReport {
  dyadCount: number;
  sessionCount: number;
  topicCounts: Record<TopicId, number>;
  pairCounts: Record<string, number>;
  firstSource: Record<SourceCondition, number>;
  sourceByPosition: Record<SourceCondition, number[]>;
  topicSourceByPosition: Record<TopicId, Record<SourceCondition, number[]>>;
  objective: number;
  minCell: number;
  maxCell: number;
  iterations: number;
}
export interface AllocationPlan {
  seed: string;
  algorithmVersion: string;
  dyads: AllocationDyad[];
  hash: string;
  balance: BalanceReport;
  candidateSetHash: string;
  extraCombinations: TopicId[][];
}

function rng(seed: string) {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    state += 0x6d2b79f5;
    let v = state;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(list: T[], random: () => number): T[] {
  const result = [...list];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
const combinations: number[][] = [];
for (let a = 0; a < 5; a++)
  for (let b = a + 1; b < 5; b++)
    for (let c = b + 1; c < 5; c++) combinations.push([a, b, c]);
const permutations = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];
const sequences: number[][] = [];
for (let bits = 0; bits < 64; bits++) {
  const sequence = Array.from({ length: 6 }, (_, i) => (bits >> i) & 1);
  if (
    sequence.reduce((a, b) => a + b, 0) === 3 &&
    !sequence.some(
      (v, i) => i > 1 && v === sequence[i - 1] && v === sequence[i - 2],
    )
  )
    sequences.push(sequence);
}
function extraCombinationIndexes(): number[] {
  // Frozen candidate enumeration: exactly six of ten triples, each pair gains 1–3 uses.
  for (let mask = 0; mask < 1024; mask++) {
    const chosen = combinations.map((_, i) => i).filter((i) => mask & (1 << i));
    if (chosen.length !== 6) continue;
    const counts = [0, 0, 0, 0, 0],
      pairs = Array.from({ length: 5 }, () => Array(5).fill(0));
    for (const i of chosen) {
      for (const t of combinations[i]) counts[t]++;
      for (const a of combinations[i])
        for (const b of combinations[i]) if (a < b) pairs[a][b]++;
    }
    if (counts.join() !== "4,4,4,3,3") continue;
    if (
      pairs.every((row, a) =>
        row.every((count, b) => a >= b || (count >= 1 && count <= 3)),
      )
    )
      return chosen;
  }
  throw new DomainError("RANDOMIZATION_QUOTA_INFEASIBLE");
}
const extras = extraCombinationIndexes();
const candidateSetHash = createHash("sha256")
  .update(JSON.stringify({ combinations, extras, permutations, sequences }))
  .digest("hex");
const cellIndex = (topic: number, source: number, position: number) =>
  topic * 12 + source * 6 + position;

export function generatePlan(seed: string): AllocationPlan {
  if (typeof seed !== "string" || !seed.trim() || seed.length > 512)
    throw new DomainError("INVALID_SEED");
  const random = rng(seed);
  const labels = shuffle(TOPIC_IDS, random);
  const blocks = shuffle(
    [
      ...combinations.flatMap((triple) => [
        [...triple],
        [...triple],
        [...triple],
      ]),
      ...extras.map((i) => [...combinations[i]]),
    ],
    random,
  );
  // Complement pairs give exact 18/18 at every position, including the first position.
  const sourceSequences: number[][] = [];
  for (let i = 0; i < 18; i++) {
    const s = sequences[Math.floor(random() * sequences.length)];
    sourceSequences.push(
      [...s],
      s.map((v) => 1 - v),
    );
  }
  const sources = shuffle(sourceSequences, random);
  const candidates = blocks.map((triple, d) => {
    const options: number[][] = [];
    for (const hp of permutations)
      for (const ap of permutations) {
        let h = 0,
          a = 0;
        options.push(
          sources[d].map((source) =>
            source === 0 ? triple[hp[h++]] : triple[ap[a++]],
          ),
        );
      }
    return options;
  });
  let bestScore = Infinity,
    bestChoices: number[] = [],
    bestCounts: number[] = [],
    totalIterations = 0;
  // Exact integer objective (sum of squared counts); fixed margins make its minimum meaningful.
  for (let restart = 0; restart < 12; restart++) {
    const choices = candidates.map(() => Math.floor(random() * 36));
    const counts = Array(60).fill(0) as number[];
    for (let d = 0; d < 36; d++)
      candidates[d][choices[d]].forEach(
        (t, p) => counts[cellIndex(t, sources[d][p], p)]++,
      );
    for (let sweep = 0; sweep < 30; sweep++) {
      let changed = false;
      totalIterations++;
      for (const d of shuffle(
        Array.from({ length: 36 }, (_, i) => i),
        random,
      )) {
        candidates[d][choices[d]].forEach(
          (t, p) => counts[cellIndex(t, sources[d][p], p)]--,
        );
        let optionScore = Infinity,
          winners: number[] = [];
        for (let c = 0; c < 36; c++) {
          const delta = candidates[d][c].reduce(
            (sum, t, p) => sum + 2 * counts[cellIndex(t, sources[d][p], p)] + 1,
            0,
          );
          if (delta < optionScore) {
            optionScore = delta;
            winners = [c];
          } else if (delta === optionScore) winners.push(c);
        }
        const next = winners[Math.floor(random() * winners.length)];
        if (next !== choices[d]) changed = true;
        choices[d] = next;
        candidates[d][next].forEach(
          (t, p) => counts[cellIndex(t, sources[d][p], p)]++,
        );
      }
      const score = counts.reduce((a, b) => a + b * b, 0);
      if (score < bestScore) {
        bestScore = score;
        bestChoices = [...choices];
        bestCounts = [...counts];
      }
      if (Math.max(...counts) - Math.min(...counts) <= 1 || !changed) break;
    }
    if (Math.max(...bestCounts) - Math.min(...bestCounts) <= 1) break;
  }
  const dyads: AllocationDyad[] = blocks.map((_, d) => ({
    dyadIndex: d + 1,
    targetIndex: Math.floor(d / 3) + 1,
    friendIndex: (d % 3) + 1,
    sessions: candidates[d][bestChoices[d]].map((t, p) => ({
      index: p + 1,
      source: sources[d][p] === 0 ? "HUMAN" : "AI",
      topic: labels[t],
    })),
  }));
  const balance = describeBalance(dyads, bestScore, totalIterations);
  assertPlanConstraints(dyads, balance);
  // Do not silently return an approximate allocation if this solver misses its explicit cell constraint.
  if (balance.minCell < 3 || balance.maxCell > 4)
    throw new DomainError(
      "RANDOMIZATION_POSITION_INFEASIBLE",
      "随机化求解未满足位置平衡约束；请由研究者检查 seed 与算法报告。",
    );
  const body = {
    seed,
    algorithmVersion: RANDOMIZATION_VERSION,
    dyads,
    candidateSetHash,
    extraCombinations: extras.map((i) => combinations[i].map((t) => labels[t])),
  };
  return {
    ...body,
    balance,
    hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
}

function describeBalance(
  dyads: AllocationDyad[],
  objective: number,
  iterations: number,
): BalanceReport {
  const topicCounts = Object.fromEntries(
    TOPIC_IDS.map((t) => [t, 0]),
  ) as Record<TopicId, number>;
  const pairCounts: Record<string, number> = {};
  const firstSource = { HUMAN: 0, AI: 0 },
    sourceByPosition = { HUMAN: Array(6).fill(0), AI: Array(6).fill(0) };
  const topicSourceByPosition = Object.fromEntries(
    TOPIC_IDS.map((t) => [
      t,
      { HUMAN: Array(6).fill(0), AI: Array(6).fill(0) },
    ]),
  ) as Record<TopicId, Record<SourceCondition, number[]>>;
  for (const dyad of dyads) {
    const topics = [...new Set(dyad.sessions.map((s) => s.topic))].sort();
    for (const t of topics) topicCounts[t]++;
    for (let a = 0; a < 3; a++)
      for (let b = a + 1; b < 3; b++) {
        const key = topics[a] + "|" + topics[b];
        pairCounts[key] = (pairCounts[key] ?? 0) + 1;
      }
    firstSource[dyad.sessions[0].source]++;
    for (const session of dyad.sessions) {
      sourceByPosition[session.source][session.index - 1]++;
      topicSourceByPosition[session.topic][session.source][session.index - 1]++;
    }
  }
  const cells = Object.values(topicSourceByPosition).flatMap((v) => [
    ...v.HUMAN,
    ...v.AI,
  ]);
  return {
    dyadCount: dyads.length,
    sessionCount: dyads.reduce((n, d) => n + d.sessions.length, 0),
    topicCounts,
    pairCounts,
    firstSource,
    sourceByPosition,
    topicSourceByPosition,
    objective,
    minCell: Math.min(...cells),
    maxCell: Math.max(...cells),
    iterations,
  };
}
export function assertPlanConstraints(
  dyads: AllocationDyad[],
  report?: BalanceReport,
): void {
  if (dyads.length !== 36)
    throw new DomainError("RANDOMIZATION_INVALID_DYAD_COUNT");
  if (
    new Set(dyads.map((d) => d.dyadIndex)).size !== 36 ||
    dyads.some(
      (d) =>
        !Number.isInteger(d.dyadIndex) ||
        d.dyadIndex < 1 ||
        d.dyadIndex > 36 ||
        d.targetIndex !== Math.floor((d.dyadIndex - 1) / 3) + 1 ||
        d.friendIndex !== ((d.dyadIndex - 1) % 3) + 1,
    )
  )
    throw new DomainError("RANDOMIZATION_INVALID_DYAD_INDEX");
  for (const d of dyads) {
    if (
      d.sessions.length !== 6 ||
      d.sessions.filter((s) => s.source === "HUMAN").length !== 3
    )
      throw new DomainError("RANDOMIZATION_INVALID_SOURCE_QUOTA");
    if (
      d.sessions.some(
        (s, index) => s.index !== index + 1 || !TOPIC_IDS.includes(s.topic),
      )
    )
      throw new DomainError("RANDOMIZATION_INVALID_POSITION");
    if (
      d.sessions.some(
        (s, i) =>
          i > 1 &&
          s.source === d.sessions[i - 1].source &&
          s.source === d.sessions[i - 2].source,
      )
    )
      throw new DomainError("RANDOMIZATION_TRIPLE_SOURCE");
    const topics = [...new Set(d.sessions.map((s) => s.topic))];
    if (
      topics.length !== 3 ||
      topics.some((t) =>
        ["HUMAN", "AI"].some(
          (source) =>
            d.sessions.filter((s) => s.topic === t && s.source === source)
              .length !== 1,
        ),
      )
    )
      throw new DomainError("RANDOMIZATION_UNPAIRED_TOPIC");
  }
  // Recompute from assignments; an attached report must never override the checked facts.
  const balance = describeBalance(
    dyads,
    report?.objective ?? 0,
    report?.iterations ?? 0,
  );
  if (
    Object.values(balance.topicCounts).sort().join() !== "21,21,22,22,22" ||
    Object.values(balance.pairCounts).length !== 10 ||
    Object.values(balance.pairCounts).some((n) => n < 10 || n > 12)
  )
    throw new DomainError("RANDOMIZATION_TOPIC_IMBALANCE");
  if (
    Object.values(balance.sourceByPosition)
      .flat()
      .some((n) => n !== 18)
  )
    throw new DomainError("RANDOMIZATION_SOURCE_POSITION_IMBALANCE");
}
