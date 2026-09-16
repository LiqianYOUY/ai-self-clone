import { z } from "zod";
import { DomainError } from "./types";

const rating = z.number().int().min(1).max(5).nullable();
export const SURVEY_VERSION = "live-survey-zh-v1-draft";
export const LIVE_SURVEY_ORDER = [
  "guess",
  "confidence",
  "likeness",
  "authenticity",
  "naturalness",
  "trust",
  "comfort",
  "reasons",
] as const;
export const surveySchema = z
  .object({
    guess: z.enum(["HUMAN", "AI"]).nullable(),
    confidence: z.number().int().min(50).max(100).nullable(),
    likeness: rating,
    authenticity: rating,
    naturalness: rating,
    trust: rating,
    comfort: rating,
    reasons: z.string().max(4000).nullable(),
    skippedItems: z.array(z.string().max(80)).max(30).optional(),
    contaminationFlags: z.array(z.string().max(80)).max(20).optional(),
    instrumentVersion: z.string().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.guess === null && value.confidence !== null)
      ctx.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "Confidence is only defined for a selected source guess",
      });
  });
export const offlineRatingSchema = z
  .object({
    guess: z.enum(["HUMAN", "AI"]).nullable(),
    confidence: z.number().int().min(50).max(100).nullable(),
    naturalness: rating,
    personLikeness: rating,
    ratioInference: z.boolean().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.guess === null && value.confidence !== null)
      ctx.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "Select a guess before confidence",
      });
  });
export function validateOfflineRating(
  value: unknown,
  familiarity: "FAMILIAR" | "UNFAMILIAR",
) {
  const result = offlineRatingSchema.parse(value);
  if (familiarity === "UNFAMILIAR" && result.personLikeness !== null)
    throw new DomainError("UNFAMILIAR_PERSON_LIKENESS");
  return result;
}
export function probabilityAI(
  guess: "HUMAN" | "AI" | null,
  confidence: number | null,
): number | null {
  if (guess === null || confidence === null) return null;
  if (
    !["HUMAN", "AI"].includes(guess) ||
    !Number.isFinite(confidence) ||
    confidence < 50 ||
    confidence > 100
  )
    throw new DomainError("INVALID_CONFIDENCE");
  return guess === "AI" ? confidence / 100 : (100 - confidence) / 100;
}
/** UTF-8 CSV: \N denotes null; every non-null value is quoted. Prefix spreadsheet formulas. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "\\N";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text))
    text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export function csvDocument(headers: string[], rows: unknown[][]): string {
  if (rows.some((row) => row.length !== headers.length))
    throw new DomainError("INVALID_EXPORT_WIDTH");
  return (
    "\uFEFF" +
    [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
export const relationshipSchema = z
  .object({
    timepoint: z.enum(["BASELINE", "PRE_DEBRIEF", "POST_DEBRIEF"]),
    ios: z.number().int().min(1).max(7).nullable(),
    distress: z.boolean().nullable(),
    instrumentVersion: z.string().min(1),
  })
  .strict();
