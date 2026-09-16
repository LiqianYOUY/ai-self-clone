/** Public contracts for the five-round game. Never import server configuration here. */
export const PLAY_TURNS = 5;
export type PlayIdentity = "HUMAN" | "AI";
export type PlayStatus =
  "WAITING" | "ACTIVE" | "GUESSING" | "REVEALED" | "CANCELLED";
export type PlaySpeaker = "FRIEND" | "SOURCE";

export interface PlayPersonaInput {
  displayName: string;
  bio: string;
  style: string;
  memories: string;
  examplesText: string;
  /** Label used for the host in pasted examples; omitted for legacy profiles. */
  exampleSpeaker?: string;
}

/** Host-only evidence summary. Never include this in a friend's room DTO. */
export interface PlayStyleSummary {
  version: string;
  sourceHash: string;
  targetSpeaker: string;
  sampleCount: number;
  pairedExampleCount: number;
  status: "needs_examples" | "limited" | "ready";
  medianLength: number;
  p90Length: number;
  emojiRate: number;
  questionRate: number;
  exclamationRate: number;
  finalPunctuationRate: number;
  actionRate: number;
  commonPhrases: string[];
  warnings: string[];
}

export interface PlayMessageDto {
  id: string;
  speaker: PlaySpeaker;
  text: string;
  sequence: number;
}

export interface PlayResult {
  answer: PlayIdentity;
  guess: PlayIdentity;
  correct: boolean;
  reason: string;
}

/** This allowlist is the entire friend-facing room, including before reveal. */
export interface PlayRoomDto {
  id: string;
  hostName: string;
  friendName: string | null;
  status: PlayStatus;
  turnsCompleted: number;
  maxTurns: number;
  waitingFor: PlaySpeaker | null;
  messages: PlayMessageDto[];
  result: PlayResult | null;
}

export interface PlayHostRoomDto extends PlayRoomDto {
  mode: PlayIdentity;
}

export interface PlayStats {
  completed: number;
  cancelled: number;
  aiRounds: number;
  humanRounds: number;
  aiFooledRate: number | null;
  humanRecognizedRate: number | null;
}

export interface PlayHomeDto {
  actor: { id: string; pseudonym: string } | null;
  persona: PlayPersonaInput | null;
  styleSummary?: PlayStyleSummary | null;
  providerReady: boolean;
  providerStatus?: PlayProviderStatus;
  online: boolean;
  activeRoom: PlayHostRoomDto | null;
  recentRooms: PlayHostRoomDto[];
  stats: PlayStats;
}

export interface PlayProviderStatus {
  kind: "ollama" | "compatible";
  ready: boolean;
  model: string | null;
  message: string;
}

export interface PlayInvitationDto {
  hostName: string;
  expiresAt: string;
}
