import { z } from "zod";
import { DomainError } from "./types";

const approvedText = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (v) =>
      !/(?:\b(?:TODO|TBD|MISSING|UNAPPROVED|PLACEHOLDER)\b|待批准|待填写|未批准|\{[^}]+\})/i.test(
        v,
      ),
    "Must reference an approved, completed value",
  );
const evidence = {
  status: z.literal("APPROVED"),
  reference: approvedText,
  approvedBy: approvedText,
  approvedAt: z.iso.datetime(),
};
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** No group has a default. All approvals must be supplied and independently verified by the institution. */
export const liveConfigSchema = z
  .object({
    mode: z.literal("LIVE"),
    ethics: z.object({
      ...evidence,
      protocolVersion: approvedText,
      eligibilityPolicy: approvedText,
      compensationPolicy: approvedText,
    }),
    consent: z.object({
      ...evidence,
      instrumentVersion: approvedText,
      withdrawalWindow: approvedText,
      secondarySharingVersion: approvedText,
    }),
    provider: z.object({
      ...evidence,
      name: z.literal("ANTHROPIC"),
      exactModelId: approvedText.refine(
        (v) => !/(latest|alias|auto)/i.test(v) && /-\d{8}$/.test(v),
        "A dated immutable model snapshot is required",
      ),
      region: approvedText,
      retentionAgreement: approvedText,
      allowedFeatures: z.tuple([z.literal("MESSAGES_TEXT")]),
      timeoutMs: z.number().int().min(100).max(120000),
      technicalRetries: z.number().int().min(0).max(2),
      maxTokens: z.number().int().min(64).max(4096),
      maxGraphemes: z.number().int().min(20).max(2000),
      maxBurstCount: z.number().int().min(1).max(6),
    }),
    hosting: z.object({
      ...evidence,
      institutionalEnvironment: approvedText,
      encryptionPolicy: approvedText,
      keyManagementPolicy: approvedText,
      identityServiceReference: approvedText,
      outboundAllowlist: z.tuple([z.literal("api.anthropic.com")]),
    }),
    safety: z.object({
      ...evidence,
      policyVersion: approvedText,
      primaryStaffReference: approvedText,
      backupStaffReference: approvedText,
      serviceWindow: approvedText,
      escalationProtocol: approvedText,
      responseDeadlineSeconds: z.number().positive(),
      localSupportResources: approvedText,
    }),
    retention: z.object({
      ...evidence,
      dataPlanVersion: approvedText,
      corpusStagingHours: z.number().positive(),
      researchRetentionDays: z.number().positive(),
      deletionDeadlineDays: z.number().positive(),
      backupExpiryDays: z.number().positive(),
      deletionModesPolicy: approvedText,
      exportRecipients: approvedText,
    }),
    measurements: z.object({
      ...evidence,
      surveyVersion: approvedText,
      iosVersion: approvedText,
      matchedRatingVersion: approvedText,
      missingnessPolicy: approvedText,
    }),
    randomization: z.object({
      ...evidence,
      seedCustodianReference: approvedText,
      planHash: hash,
      topicVersion: approvedText,
      scheduledHumanAvailabilityReference: approvedText,
      samplePlan: approvedText,
      stoppingRule: approvedText,
    }),
    offline: z.object({
      ...evidence,
      excerptSamplingVersion: approvedText,
      familiarRatingsPerExcerpt: z.number().int().positive(),
      unfamiliarRatingsPerExcerpt: z.number().int().positive(),
      maximumRaterBurden: z.number().int().positive(),
      stagedDebriefWindowHours: z.number().positive(),
      stoppingRule: approvedText,
    }),
    validation: z.object({
      ...evidence,
      independentTimingReportHash: hash,
      metadataLeakageReportHash: hash,
      safetyDrillReportHash: hash,
      deletionRestoreReportHash: hash,
      precisionSimulationHash: hash,
      pilotReportHash: hash,
      preregistrationHash: hash,
      approvedToleranceReference: approvedText,
      humanRedTeamReportHash: hash,
    }),
    freeze: z.object({
      ...evidence,
      codeCommit: z.string().regex(/^[a-f0-9]{40}$/),
      policyHash: hash,
      personaManifestHash: hash,
    }),
  })
  .strict();
export type LiveConfig = z.infer<typeof liveConfigSchema>;
export const LIVE_GATE_GROUPS = [
  "ethics",
  "consent",
  "provider",
  "hosting",
  "safety",
  "retention",
  "measurements",
  "randomization",
  "offline",
  "validation",
  "freeze",
] as const;
export function assessLiveReadiness(raw: unknown): {
  ready: boolean;
  missing: string[];
  config?: LiveConfig;
} {
  const parsed = liveConfigSchema.safeParse(raw);
  if (parsed.success) return { ready: true, missing: [], config: parsed.data };
  return {
    ready: false,
    missing: [
      ...new Set(
        parsed.error.issues.map((i) => i.path.join(".") || "configuration"),
      ),
    ],
  };
}
export function requireLiveConfig(raw: unknown): LiveConfig {
  const result = assessLiveReadiness(raw);
  if (!result.ready || !result.config)
    throw new DomainError(
      "LIVE_APPROVALS_REQUIRED",
      "正式研究配置缺失或未批准，当前仅允许合成数据模式。",
    );
  return result.config;
}
