import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./db";
import { GatewayError } from "./http";
import { type Actor } from "../domain/types";
import { scanPII } from "../domain/privacy";
import { inspectText } from "../domain/safety";

export const EVALUATION_TRACKS = ["MATCHED", "ECOLOGICAL"] as const;
export type EvaluationTrack = (typeof EVALUATION_TRACKS)[number];
export type ExcerptApprovalScope =
  "MATCHED_CONTEXT" | "ECOLOGICAL_TARGET_REVIEW";
type Tx = Prisma.TransactionClient;
const terminal = ["ENDED", "WITHDRAWN"];
const scopeFor = (track: EvaluationTrack): ExcerptApprovalScope =>
  track === "MATCHED" ? "MATCHED_CONTEXT" : "ECOLOGICAL_TARGET_REVIEW";
function requireCondition(
  ok: unknown,
  code = "INELIGIBLE",
  status = 409,
): asserts ok {
  if (!ok) throw new GatewayError(status, code);
}
const approvalSchema = z
  .object({
    stimulusId: z.string().min(1).max(150),
    scope: z.enum(["MATCHED_CONTEXT", "ECOLOGICAL_TARGET_REVIEW"]),
    approved: z.boolean(),
  })
  .strict();
const score = z.number().int().min(1).max(5).nullable();
const submissionSchema = z
  .object({
    stimulusId: z.string().min(1).max(150),
    track: z.enum(EVALUATION_TRACKS),
    likeness: score,
    predictedFriendRating: score.optional(),
    endorsement: z.enum(["YES", "NO", "UNSURE"]).nullable().optional(),
  })
  .strict();
const includeExcerpt = {
  session: { include: { dyad: true, safety: { select: { id: true } } } },
  sharingApprovals: true,
  ratings: true,
} satisfies Prisma.StimulusExcerptInclude;
type Excerpt = Prisma.StimulusExcerptGetPayload<{
  include: typeof includeExcerpt;
}>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GatewayError(422, "INVALID_INPUT");
  return parsed.data;
}
async function validateActor(tx: Tx, actor: Actor) {
  const person = await tx.participant.findUnique({ where: { id: actor.id } });
  requireCondition(
    person?.active && person.role === actor.role,
    "FORBIDDEN",
    403,
  );
}
function originating(actor: Actor, excerpt: Excerpt): boolean {
  return (
    (actor.role === "FRIEND" && excerpt.session.dyad.friendId === actor.id) ||
    (actor.role === "TARGET" && excerpt.session.dyad.targetId === actor.id)
  );
}
async function currentConsent(tx: Tx, participantId: string) {
  return tx.consent.findFirst({
    where: { participantId },
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
  });
}
async function consentAllowsReview(tx: Tx, excerpt: Excerpt): Promise<boolean> {
  const [target, friend] = await Promise.all([
    currentConsent(tx, excerpt.session.dyad.targetId),
    currentConsent(tx, excerpt.session.dyad.friendId),
  ]);
  return Boolean(
    target?.participation &&
    friend?.participation &&
    !target.revokedAt &&
    !friend.revokedAt &&
    target.targetReview &&
    friend.targetReview,
  );
}
async function blockComplete(tx: Tx, targetId: string): Promise<boolean> {
  const dyads = await tx.dyad.findMany({
    where: { targetId },
    include: { sessions: { select: { status: true } } },
  });
  return (
    dyads.length > 0 &&
    dyads.every(
      (d) =>
        d.sessions.length === 6 &&
        d.sessions.every((s) => terminal.includes(s.status)),
    )
  );
}
/** This hash deliberately excludes source: a blinded client could otherwise try both possible values. */
function contextHash(excerpt: Excerpt): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contextVersion: excerpt.contextVersion,
        text: excerpt.text,
        context: excerpt.context,
        sourceMessageIds: excerpt.sourceMessageIds,
      }),
    )
    .digest("hex");
}
function approved(
  excerpt: Excerpt,
  participantId: string,
  scope: ExcerptApprovalScope,
): boolean {
  return excerpt.sharingApprovals.some(
    (grant) =>
      grant.participantId === participantId &&
      grant.scope === scope &&
      grant.approved &&
      grant.contextVersion === excerpt.contextVersion &&
      grant.contextHash === contextHash(excerpt),
  );
}
async function eligibleExcerpt(tx: Tx, excerpt: Excerpt): Promise<boolean> {
  if (
    excerpt.status !== "APPROVED" ||
    excerpt.destroyedAt ||
    !excerpt.text ||
    excerpt.session.destroyedAt ||
    excerpt.session.excluded ||
    excerpt.session.status !== "ENDED" ||
    excerpt.session.safety.length > 0 ||
    excerpt.privateCondition !== excerpt.session.privateCondition
  )
    return false;
  const content = excerpt.text + "\n" + (excerpt.context ?? "");
  if (scanPII(content).length > 0 || inspectText(content).decision !== "ALLOW")
    return false;
  const ids = excerpt.sourceMessageIds;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.some((id) => typeof id !== "string") ||
    new Set(ids).size !== ids.length
  )
    return false;
  const count = await tx.message.count({
    where: {
      id: { in: ids as string[] },
      sessionId: excerpt.sessionId,
      publicRole: "SOURCE",
      status: "DELIVERED",
      destroyedAt: null,
      text: { not: null },
    },
  });
  return count === ids.length;
}
async function lockedExcerpt(
  tx: Tx,
  actor: Actor,
  stimulusId: string,
): Promise<Excerpt> {
  // Same session-first lock order as stop/delete; consent revocation and pending submission serialize here.
  const reference = await tx.stimulusExcerpt.findUnique({
    where: { id: stimulusId },
    select: { sessionId: true },
  });
  requireCondition(reference, "NOT_FOUND", 404);
  await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${reference.sessionId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "StimulusExcerpt" WHERE id = ${stimulusId} FOR UPDATE`;
  const excerpt = await tx.stimulusExcerpt.findUniqueOrThrow({
    where: { id: stimulusId },
    include: includeExcerpt,
  });
  requireCondition(originating(actor, excerpt), "FORBIDDEN", 403);
  return excerpt;
}
function ownRating(excerpt: Excerpt, actor: Actor, track: EvaluationTrack) {
  const rating = excerpt.ratings.find(
    (r) => r.participantId === actor.id && r.track === track && !r.excluded,
  );
  return rating
    ? {
        id: rating.id,
        likeness: rating.likeness,
        predictedFriendRating: rating.predictedFriendRating,
        endorsement: rating.endorsement,
        submittedAt: rating.submittedAt.toISOString(),
      }
    : null;
}
async function recordDisclosure(tx: Tx, actor: Actor, sessionId: string) {
  await tx.sourceRevealGrant.upsert({
    where: { participantId_sessionId: { participantId: actor.id, sessionId } },
    create: { participantId: actor.id, sessionId },
    update: {},
  });
}

export async function getEvaluations(actor: Actor) {
  return prisma.$transaction(
    async (tx) => {
      await validateActor(tx, actor);
      requireCondition(
        ["FRIEND", "TARGET"].includes(actor.role),
        "FORBIDDEN",
        403,
      );
      const candidates = await tx.stimulusExcerpt.findMany({
        where: {
          session: {
            dyad:
              actor.role === "FRIEND"
                ? { friendId: actor.id }
                : { targetId: actor.id },
          },
        },
        select: { id: true },
        orderBy: { sessionId: "asc" },
      });
      const items: Record<string, unknown>[] = [];
      let targetBlockIncomplete = false,
        permissionsMissing = false;
      for (const candidate of candidates) {
        const excerpt = await lockedExcerpt(tx, actor, candidate.id);
        if (!(await eligibleExcerpt(tx, excerpt))) continue;
        const complete = await blockComplete(tx, excerpt.session.dyad.targetId);
        const consent = await consentAllowsReview(tx, excerpt);
        if (!complete) targetBlockIncomplete = true;
        if (!consent) {
          permissionsMissing = true;
          continue;
        }
        for (const track of EVALUATION_TRACKS) {
          const scope = scopeFor(track);
          const friendApproved = approved(
            excerpt,
            excerpt.session.dyad.friendId,
            scope,
          );
          const targetApproved = approved(
            excerpt,
            excerpt.session.dyad.targetId,
            scope,
          );
          // A Target cannot see AI content merely because another Friend has finished.
          if (actor.role === "TARGET" && (!complete || !friendApproved)) {
            permissionsMissing ||= !friendApproved;
            continue;
          }
          const own = ownRating(excerpt, actor, track);
          const canRate =
            complete &&
            friendApproved &&
            targetApproved &&
            (track === "MATCHED" || actor.role === "TARGET");
          const sourceDisclosed = canRate;
          if (sourceDisclosed)
            await recordDisclosure(tx, actor, excerpt.sessionId);
          const item: Record<string, unknown> = {
            stimulusId: excerpt.id,
            sessionId: excerpt.sessionId,
            track,
            scope,
            contextVersion: excerpt.contextVersion,
            excerpt: excerpt.text,
            context: excerpt.context ?? "",
            sourceDisclosed,
            approval: {
              ownApproved:
                actor.role === "FRIEND" ? friendApproved : targetApproved,
              friendApproved,
              targetApproved,
            },
            canSubmit: canRate && !own,
            submitted: Boolean(own),
            ownRating: own,
            waitingForTargetBlock: !complete,
            comparisonNote:
              track === "MATCHED"
                ? "双方针对相同片段、相同上下文及相同来源披露独立评价；不会显示对方答案。"
                : "生态版本保留 Target 来源知情评价与 Friend 原始 live-blind 评价，不直接作分数差。",
          };
          if (sourceDisclosed) item.source = excerpt.privateCondition;
          if (track === "ECOLOGICAL" && actor.role === "FRIEND") {
            const original = await tx.liveSurvey.findUnique({
              where: {
                sessionId_participantId: {
                  sessionId: excerpt.sessionId,
                  participantId: actor.id,
                },
              },
            });
            item.liveObservation =
              original && !original.excluded
                ? {
                    likeness: original.likeness,
                    relationalFit: original.relationalFit,
                    sourceDisclosed: false,
                    submittedAt: original.submittedAt.toISOString(),
                  }
                : null;
          }
          items.push(item);
        }
      }
      return {
        items,
        blocked: { targetBlockIncomplete, permissionsMissing },
        policy: {
          peerAnswersVisible: false,
          sourceKnownRequiresCompleteBlock: true,
          ecologicalDirectDifference: false,
        },
      };
    },
    { timeout: 30000 },
  );
}

export async function approveExcerptSharing(actor: Actor, payload: unknown) {
  const input = parse(approvalSchema, payload);
  return prisma.$transaction(async (tx) => {
    await validateActor(tx, actor);
    requireCondition(
      ["FRIEND", "TARGET"].includes(actor.role),
      "FORBIDDEN",
      403,
    );
    const excerpt = await lockedExcerpt(tx, actor, input.stimulusId);
    if (input.approved) {
      requireCondition(
        (await eligibleExcerpt(tx, excerpt)) &&
          (await consentAllowsReview(tx, excerpt)),
      );
      if (actor.role === "TARGET")
        requireCondition(
          (await blockComplete(tx, excerpt.session.dyad.targetId)) &&
            approved(excerpt, excerpt.session.dyad.friendId, input.scope),
        );
    }
    const key = {
      stimulusId: excerpt.id,
      participantId: actor.id,
      scope: input.scope,
    };
    await tx.excerptSharingApproval.upsert({
      where: { stimulusId_participantId_scope: key },
      create: {
        ...key,
        contextVersion: excerpt.contextVersion,
        contextHash: contextHash(excerpt),
        approved: input.approved,
      },
      update: {
        contextVersion: excerpt.contextVersion,
        contextHash: contextHash(excerpt),
        approved: input.approved,
        recordedAt: new Date(),
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        action: input.approved
          ? "EXCERPT_SCOPE_APPROVED"
          : "EXCERPT_SCOPE_REVOKED",
        entityType: "StimulusExcerpt",
        entityId: excerpt.id,
        metadata: {
          scope: input.scope,
          contextVersion: excerpt.contextVersion,
          contextHash: contextHash(excerpt),
        },
      },
    });
    return {
      ok: true,
      stimulusId: excerpt.id,
      scope: input.scope,
      approved: input.approved,
    };
  });
}

export async function submitMatched(actor: Actor, payload: unknown) {
  const input = parse(submissionSchema, payload);
  return prisma.$transaction(async (tx) => {
    await validateActor(tx, actor);
    requireCondition(
      ["FRIEND", "TARGET"].includes(actor.role),
      "FORBIDDEN",
      403,
    );
    const excerpt = await lockedExcerpt(tx, actor, input.stimulusId);
    requireCondition(
      (await eligibleExcerpt(tx, excerpt)) &&
        (await consentAllowsReview(tx, excerpt)) &&
        (await blockComplete(tx, excerpt.session.dyad.targetId)),
    );
    const scope = scopeFor(input.track);
    requireCondition(
      approved(excerpt, excerpt.session.dyad.friendId, scope) &&
        approved(excerpt, excerpt.session.dyad.targetId, scope),
    );
    requireCondition(
      input.track === "MATCHED" || actor.role === "TARGET",
      "FORBIDDEN",
      403,
    );
    requireCondition(
      actor.role === "TARGET" ||
        ((input.predictedFriendRating === undefined ||
          input.predictedFriendRating === null) &&
          (input.endorsement === undefined || input.endorsement === null)),
      "INVALID_INPUT",
      422,
    );
    requireCondition(
      await tx.sourceRevealGrant.findUnique({
        where: {
          participantId_sessionId: {
            participantId: actor.id,
            sessionId: excerpt.sessionId,
          },
        },
      }),
    );
    requireCondition(
      !excerpt.ratings.some(
        (r) => r.participantId === actor.id && r.track === input.track,
      ),
      "FROZEN",
    );
    const row = await tx.matchedRating.create({
      data: {
        stimulusId: excerpt.id,
        participantId: actor.id,
        role: actor.role,
        track: input.track,
        sourceDisclosed: true,
        contextVersion: excerpt.contextVersion,
        contextHash: contextHash(excerpt),
        likeness: input.likeness,
        predictedFriendRating:
          actor.role === "TARGET"
            ? (input.predictedFriendRating ?? null)
            : null,
        endorsement:
          actor.role === "TARGET" ? (input.endorsement ?? null) : null,
        sharedContextApproved: true,
      },
    });
    await recordDisclosure(tx, actor, excerpt.sessionId);
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        action: "EVALUATION_SUBMITTED",
        entityType: "MatchedRating",
        entityId: row.id,
        metadata: {
          track: input.track,
          contextVersion: excerpt.contextVersion,
          contextHash: contextHash(excerpt),
        },
      },
    });
    return {
      ok: true,
      ratingId: row.id,
      track: input.track,
      submittedAt: row.submittedAt.toISOString(),
    };
  });
}

export async function getEvaluationOverview(actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await validateActor(tx, actor);
    requireCondition(
      ["RESEARCHER", "ANALYST"].includes(actor.role),
      "FORBIDDEN",
      403,
    );
    const [
      stimuli,
      familiarPending,
      unfamiliarPending,
      offlineCompleted,
      matchedRatings,
      ecologicalTargetRatings,
      approvedScopes,
      eligiblePairs,
    ] = await Promise.all([
      tx.stimulusExcerpt.count({
        where: { status: "APPROVED", destroyedAt: null },
      }),
      tx.offlineAssignment.count({
        where: { familiarityRole: "FAMILIAR", status: "PENDING" },
      }),
      tx.offlineAssignment.count({
        where: { familiarityRole: "UNFAMILIAR", status: "PENDING" },
      }),
      tx.offlineRating.count({ where: { excluded: false } }),
      tx.matchedRating.count({ where: { track: "MATCHED", excluded: false } }),
      tx.matchedRating.count({
        where: { track: "ECOLOGICAL", role: "TARGET", excluded: false },
      }),
      tx.excerptSharingApproval.count({ where: { approved: true } }),
      tx.matchedRating.groupBy({
        by: ["stimulusId"],
        where: { track: "MATCHED", excluded: false },
        _count: { _all: true },
      }),
    ]);
    return {
      stats: {
        stimuli,
        familiarPending,
        unfamiliarPending,
        offlineCompleted,
        matchedRatings,
        ecologicalTargetRatings,
        approvedScopes,
        completedMatchedPairs: eligiblePairs.filter(
          (group) => group._count._all === 2,
        ).length,
      },
      policy: {
        textIncluded: false,
        ecologicalDirectDifference: false,
        offlineCountsAreOperational: true,
      },
    };
  });
}
