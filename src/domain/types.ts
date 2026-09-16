/** Server-side research domain. Do not serialize these objects into participant UI. */
export type ActorRole = "RESEARCHER" | "FRIEND" | "TARGET" | "ANALYST";
export interface Actor {
  id: string;
  role: ActorRole;
  pseudonym: string;
}
export type SourceCondition = "HUMAN" | "AI";
export const SESSION_STATUSES = [
  "SCHEDULED",
  "READY",
  "ACTIVE",
  "PAUSED_TECHNICAL",
  "PAUSED_SAFETY",
  "STAFF_CONTACT",
  "ENDED",
  "WITHDRAWN",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type Partition = "BUILD" | "DEV" | "HOLDOUT" | "LIVE";
export type PublicMessageRole = "FRIEND" | "SOURCE" | "STUDY_NOTICE";
export type TopicId =
  | "CATCH_UP"
  | "SHARED_MEMORY"
  | "OPINIONS"
  | "BOUNDED_SUPPORT"
  | "HYPOTHETICAL_PLAN";
export const TOPIC_IDS: TopicId[] = [
  "CATCH_UP",
  "SHARED_MEMORY",
  "OPINIONS",
  "BOUNDED_SUPPORT",
  "HYPOTHETICAL_PLAN",
];
export const TOPIC_LABELS: Record<TopicId, string> = {
  CATCH_UP: "近况闲聊",
  SHARED_MEMORY: "低敏感共同往事",
  OPINIONS: "一般观点",
  BOUNDED_SUPPORT: "有限边界的情绪支持",
  HYPOTHETICAL_PLAN: "假设共同计划",
};

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly publicMessage = "研究操作暂时无法完成。",
  ) {
    super(code);
    this.name = "DomainError";
  }
}
