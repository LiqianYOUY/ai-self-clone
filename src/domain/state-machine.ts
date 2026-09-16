import {
  DomainError,
  type PublicMessageRole,
  type SessionStatus,
} from "./types";

const transitions: Record<SessionStatus, readonly SessionStatus[]> = {
  SCHEDULED: ["READY", "PAUSED_TECHNICAL", "ENDED", "WITHDRAWN"],
  READY: ["ACTIVE", "PAUSED_TECHNICAL", "PAUSED_SAFETY", "ENDED", "WITHDRAWN"],
  ACTIVE: [
    "PAUSED_TECHNICAL",
    "PAUSED_SAFETY",
    "STAFF_CONTACT",
    "ENDED",
    "WITHDRAWN",
  ],
  PAUSED_TECHNICAL: [
    "READY",
    "PAUSED_SAFETY",
    "STAFF_CONTACT",
    "ENDED",
    "WITHDRAWN",
  ],
  PAUSED_SAFETY: ["STAFF_CONTACT", "ENDED", "WITHDRAWN"],
  STAFF_CONTACT: ["ENDED", "WITHDRAWN"],
  ENDED: ["WITHDRAWN"],
  WITHDRAWN: [],
};
export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return transitions[from]?.includes(to) ?? false;
}
export function transition(
  current: { status: SessionStatus; epoch: number },
  to: SessionStatus,
) {
  if (!canTransition(current.status, to))
    throw new DomainError("INVALID_TRANSITION");
  if (!Number.isSafeInteger(current.epoch) || current.epoch < 0)
    throw new DomainError("INVALID_EPOCH");
  const invalidatesPending = [
    "PAUSED_TECHNICAL",
    "PAUSED_SAFETY",
    "STAFF_CONTACT",
    "ENDED",
    "WITHDRAWN",
  ].includes(to);
  return { status: to, epoch: current.epoch + (invalidatesPending ? 1 : 0) };
}
export function canDeliver(
  current: { status: SessionStatus; epoch: number; consentValid: boolean },
  message: { epoch: number; eligibleAt: number },
  now: number,
): boolean {
  return (
    current.status === "ACTIVE" &&
    current.consentValid &&
    current.epoch === message.epoch &&
    Number.isFinite(message.eligibleAt) &&
    now >= message.eligibleAt
  );
}
export function eligibleAt(input: {
  triggeredAt: number;
  generationFinishedAt: number;
  safetyCheckedAt: number;
  delayMs: number;
}) {
  if (
    Object.values(input).some((v) => !Number.isFinite(v)) ||
    input.delayMs < 0
  )
    throw new DomainError("INVALID_TIMING");
  const readyAt = Math.max(input.generationFinishedAt, input.safetyCheckedAt);
  const desiredAt = input.triggeredAt + input.delayMs;
  return {
    eligibleAt: Math.max(desiredAt, readyAt),
    overshootMs: Math.max(0, readyAt - desiredAt),
  };
}
const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
export function graphemeCount(text: string): number {
  return Array.from(segmenter.segment(text)).length;
}
export function assertGraphemeLimit(text: string, limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || graphemeCount(text) > limit)
    throw new DomainError("MESSAGE_TOO_LONG");
}

export interface PublicMessage {
  id: string;
  role: PublicMessageRole;
  text: string;
  sequence: number;
  deliveredAt: string | null;
}
export function toPublicMessage(input: {
  id: string;
  role: string;
  text: string;
  sequence?: number;
  serverSequence?: number;
  deliveredAt: Date | string | null;
}): PublicMessage {
  const role: PublicMessageRole =
    input.role === "FRIEND"
      ? "FRIEND"
      : input.role === "STUDY_NOTICE"
        ? "STUDY_NOTICE"
        : "SOURCE";
  const sequence = input.sequence ?? input.serverSequence;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1)
    throw new DomainError("INVALID_SEQUENCE");
  return {
    id: input.id,
    role,
    text: input.text,
    sequence: sequence as number,
    deliveredAt:
      input.deliveredAt instanceof Date
        ? input.deliveredAt.toISOString()
        : input.deliveredAt,
  };
}
