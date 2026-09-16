-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Study" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'SYNTHETIC',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "seed" TEXT NOT NULL,
    "algorithmVersion" TEXT NOT NULL,
    "assignmentHash" TEXT NOT NULL,
    "balance" JSONB NOT NULL,
    "config" JSONB NOT NULL,
    "frozenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Study_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Participant" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "pseudonym" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Australia/Sydney',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "participation" BOOLEAN NOT NULL DEFAULT false,
    "aiProcessing" BOOLEAN NOT NULL DEFAULT false,
    "corpusUse" BOOLEAN NOT NULL DEFAULT false,
    "familiarSharing" BOOLEAN NOT NULL DEFAULT false,
    "unfamiliarSharing" BOOLEAN NOT NULL DEFAULT false,
    "targetReview" BOOLEAN NOT NULL DEFAULT false,
    "secondarySharing" BOOLEAN NOT NULL DEFAULT false,
    "quotation" BOOLEAN NOT NULL DEFAULT false,
    "version" TEXT NOT NULL DEFAULT 'synthetic-v1',
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dyad" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "friendId" TEXT NOT NULL,
    "blockIndex" INTEGER NOT NULL,

    CONSTRAINT "Dyad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "dyadId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "privateCondition" TEXT NOT NULL,
    "assignedTopic" TEXT NOT NULL,
    "actualTopic" TEXT NOT NULL,
    "switchReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "nextSequence" INTEGER NOT NULL DEFAULT 1,
    "currentTurnId" TEXT,
    "personaVersionId" TEXT,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "destroyedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "clientIdempotencyKey" TEXT,
    "authorId" TEXT,
    "publicRole" TEXT NOT NULL,
    "text" TEXT,
    "epoch" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DELIVERED',
    "generatedAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "acknowledgedAt" TIMESTAMPTZ(3),
    "destroyedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Generation" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "turnId" TEXT NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "triggeredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),

    CONSTRAINT "Generation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outbox" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "generationId" TEXT,
    "epoch" INTEGER NOT NULL,
    "turnId" TEXT,
    "sourceVersion" TEXT,
    "publicRole" TEXT NOT NULL,
    "text" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "eligibleAt" TIMESTAMPTZ(3) NOT NULL,
    "generatedAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "messageId" TEXT,

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actorId" TEXT,
    "epoch" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorpusItem" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "partition" TEXT NOT NULL,
    "text" TEXT,
    "contentHash" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'TARGET_PASTE',
    "reviewStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "riskCodes" JSONB NOT NULL,
    "duplicateOf" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "destroyedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorpusItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonaVersion" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "style" JSONB NOT NULL,
    "interaction" JSONB NOT NULL,
    "boundaries" JSONB NOT NULL,
    "buildCorpusIds" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "previewCount" INTEGER NOT NULL DEFAULT 0,
    "frozenAt" TIMESTAMPTZ(3),
    "destroyedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonaVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeItem" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "personaVersionId" TEXT NOT NULL,
    "corpusItemId" TEXT NOT NULL,
    "permissionScope" TEXT NOT NULL DEFAULT 'CURRENT_TARGET_SESSION',
    "text" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT true,
    "destroyedAt" TIMESTAMPTZ(3),

    CONSTRAINT "KnowledgeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalibrationAnswer" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "answer" TEXT,
    "partition" TEXT NOT NULL DEFAULT 'BUILD',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalibrationAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BaselineSample" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "firstInputToSendMs" INTEGER NOT NULL,
    "responseMs" INTEGER NOT NULL,
    "burstCount" INTEGER NOT NULL,
    "intervalMs" INTEGER,
    "device" TEXT NOT NULL,
    "inputTool" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BaselineSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveSurvey" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "guess" TEXT,
    "confidence" INTEGER,
    "pAI" DOUBLE PRECISION,
    "likeness" INTEGER,
    "relationalFit" INTEGER,
    "naturalness" INTEGER,
    "trust" INTEGER,
    "comfort" INTEGER,
    "reason" TEXT,
    "answers" JSONB NOT NULL,
    "submittedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "excluded" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LiveSurvey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StimulusExcerpt" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "text" TEXT,
    "context" TEXT,
    "sourceMessageIds" JSONB NOT NULL,
    "privateCondition" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "contextVersion" TEXT NOT NULL,
    "eligibilityRuleVersion" TEXT NOT NULL,
    "destroyedAt" TIMESTAMPTZ(3),

    CONSTRAINT "StimulusExcerpt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FamiliarityScreen" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "knowsTarget" BOOLEAN NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FamiliarityScreen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineAssignment" (
    "id" TEXT NOT NULL,
    "stimulusId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "familiarityRole" TEXT NOT NULL,
    "displayPseudonym" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OfflineAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineRating" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "guess" TEXT,
    "confidence" INTEGER,
    "pAI" DOUBLE PRECISION,
    "naturalness" INTEGER,
    "personLikeness" INTEGER,
    "contamination" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "excluded" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OfflineRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchedRating" (
    "id" TEXT NOT NULL,
    "stimulusId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "sourceDisclosed" BOOLEAN NOT NULL,
    "contextVersion" TEXT NOT NULL,
    "likeness" INTEGER,
    "predictedFriendRating" INTEGER,
    "endorsement" TEXT,
    "sharedContextApproved" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "excluded" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MatchedRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelationshipTimepoint" (
    "id" TEXT NOT NULL,
    "dyadId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "timepoint" TEXT NOT NULL,
    "ios" INTEGER NOT NULL,
    "submittedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "excluded" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RelationshipTimepoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "actorId" TEXT,
    "acknowledgedBy" TEXT,
    "outcome" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "SafetyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataLineage" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "parentType" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "childType" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataLineage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithdrawalRequest" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "sessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "affectedCounts" JSONB NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "backupPurgeDue" TIMESTAMPTZ(3),

    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeletionTombstone" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "contentHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeletionTombstone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportManifest" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'VALID',
    "datasetNames" JSONB NOT NULL,
    "participantIds" JSONB NOT NULL,
    "checksums" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedAt" TIMESTAMPTZ(3),
    "invalidationReason" TEXT,

    CONSTRAINT "ExportManifest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "Consent_participantId_recordedAt_idx" ON "Consent"("participantId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Dyad_studyId_targetId_friendId_key" ON "Dyad"("studyId", "targetId", "friendId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_dyadId_index_key" ON "Session"("dyadId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "Message_sessionId_sequence_key" ON "Message"("sessionId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Message_sessionId_clientIdempotencyKey_key" ON "Message"("sessionId", "clientIdempotencyKey");

-- CreateIndex
CREATE INDEX "Outbox_status_eligibleAt_idx" ON "Outbox"("status", "eligibleAt");

-- CreateIndex
CREATE INDEX "CorpusItem_targetId_partition_reviewStatus_idx" ON "CorpusItem"("targetId", "partition", "reviewStatus");

-- CreateIndex
CREATE UNIQUE INDEX "PersonaVersion_targetId_version_key" ON "PersonaVersion"("targetId", "version");

-- CreateIndex
CREATE INDEX "KnowledgeItem_targetId_personaVersionId_permissionScope_idx" ON "KnowledgeItem"("targetId", "personaVersionId", "permissionScope");

-- CreateIndex
CREATE UNIQUE INDEX "CalibrationAnswer_targetId_questionId_key" ON "CalibrationAnswer"("targetId", "questionId");

-- CreateIndex
CREATE UNIQUE INDEX "LiveSurvey_sessionId_participantId_key" ON "LiveSurvey"("sessionId", "participantId");

-- CreateIndex
CREATE UNIQUE INDEX "FamiliarityScreen_participantId_targetId_key" ON "FamiliarityScreen"("participantId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineAssignment_stimulusId_participantId_key" ON "OfflineAssignment"("stimulusId", "participantId");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineRating_assignmentId_key" ON "OfflineRating"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchedRating_stimulusId_participantId_key" ON "MatchedRating"("stimulusId", "participantId");

-- CreateIndex
CREATE UNIQUE INDEX "RelationshipTimepoint_dyadId_participantId_timepoint_key" ON "RelationshipTimepoint"("dyadId", "participantId", "timepoint");

-- CreateIndex
CREATE INDEX "DataLineage_ownerId_idx" ON "DataLineage"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "DeletionTombstone_entityType_entityId_key" ON "DeletionTombstone"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dyad" ADD CONSTRAINT "Dyad_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dyad" ADD CONSTRAINT "Dyad_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dyad" ADD CONSTRAINT "Dyad_friendId_fkey" FOREIGN KEY ("friendId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_dyadId_fkey" FOREIGN KEY ("dyadId") REFERENCES "Dyad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outbox" ADD CONSTRAINT "Outbox_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionEvent" ADD CONSTRAINT "SessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorpusItem" ADD CONSTRAINT "CorpusItem_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaVersion" ADD CONSTRAINT "PersonaVersion_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeItem" ADD CONSTRAINT "KnowledgeItem_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveSurvey" ADD CONSTRAINT "LiveSurvey_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StimulusExcerpt" ADD CONSTRAINT "StimulusExcerpt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflineAssignment" ADD CONSTRAINT "OfflineAssignment_stimulusId_fkey" FOREIGN KEY ("stimulusId") REFERENCES "StimulusExcerpt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflineRating" ADD CONSTRAINT "OfflineRating_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "OfflineAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchedRating" ADD CONSTRAINT "MatchedRating_stimulusId_fkey" FOREIGN KEY ("stimulusId") REFERENCES "StimulusExcerpt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SafetyEvent" ADD CONSTRAINT "SafetyEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Research invariants are enforced below the application boundary.
ALTER TABLE "Participant" ADD CONSTRAINT "participant_role_check" CHECK (role IN ('RESEARCHER','ANALYST','TARGET','FRIEND'));
ALTER TABLE "Dyad" ADD CONSTRAINT "distinct_dyad_members" CHECK ("targetId" <> "friendId");
ALTER TABLE "Session" ADD CONSTRAINT "session_index_range" CHECK (index BETWEEN 1 AND 6);
ALTER TABLE "Session" ADD CONSTRAINT "session_condition_check" CHECK ("privateCondition" IN ('HUMAN','AI'));
ALTER TABLE "Session" ADD CONSTRAINT "session_state_check" CHECK (status IN ('SCHEDULED','READY','ACTIVE','PAUSED_TECHNICAL','PAUSED_SAFETY','STAFF_CONTACT','ENDED','WITHDRAWN'));
ALTER TABLE "Message" ADD CONSTRAINT "message_role_check" CHECK ("publicRole" IN ('FRIEND','SOURCE','STUDY_NOTICE'));
ALTER TABLE "CorpusItem" ADD CONSTRAINT "corpus_partition_check" CHECK (partition IN ('BUILD','DEV','HOLDOUT'));
ALTER TABLE "LiveSurvey" ADD CONSTRAINT "live_confidence_range" CHECK (confidence IS NULL OR confidence BETWEEN 50 AND 100);
ALTER TABLE "LiveSurvey" ADD CONSTRAINT "live_rating_range" CHECK ((likeness IS NULL OR likeness BETWEEN 1 AND 5) AND ("relationalFit" IS NULL OR "relationalFit" BETWEEN 1 AND 5) AND (naturalness IS NULL OR naturalness BETWEEN 1 AND 5) AND (trust IS NULL OR trust BETWEEN 1 AND 5) AND (comfort IS NULL OR comfort BETWEEN 1 AND 5));
ALTER TABLE "OfflineRating" ADD CONSTRAINT "offline_confidence_range" CHECK (confidence IS NULL OR confidence BETWEEN 50 AND 100);
ALTER TABLE "OfflineRating" ADD CONSTRAINT "offline_rating_range" CHECK (("personLikeness" IS NULL OR "personLikeness" BETWEEN 1 AND 5) AND (naturalness IS NULL OR naturalness BETWEEN 1 AND 5));
ALTER TABLE "RelationshipTimepoint" ADD CONSTRAINT "ios_seven_level" CHECK (ios BETWEEN 1 AND 7);
ALTER TABLE "Study" ADD CONSTRAINT "live_disabled_without_release" CHECK (mode = 'SYNTHETIC');

CREATE FUNCTION protect_frozen_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."privateCondition" <> OLD."privateCondition" OR NEW."assignedTopic" <> OLD."assignedTopic" OR NEW.index <> OLD.index OR NEW."dyadId" <> OLD."dyadId" THEN
    RAISE EXCEPTION 'Frozen assignment is immutable';
  END IF;
  IF NEW."personaVersionId" IS DISTINCT FROM OLD."personaVersionId" AND OLD."startedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Started session persona selection is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_assignment_immutable BEFORE UPDATE ON "Session" FOR EACH ROW EXECUTE FUNCTION protect_frozen_assignment();

CREATE FUNCTION protect_frozen_persona() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'FROZEN' AND NEW.status NOT IN ('DESTROYED','INVALIDATED') AND (NEW.style <> OLD.style OR NEW.interaction <> OLD.interaction OR NEW.boundaries <> OLD.boundaries OR NEW."buildCorpusIds" <> OLD."buildCorpusIds" OR NEW."contentHash" <> OLD."contentHash" OR NEW.version <> OLD.version OR NEW."targetId" <> OLD."targetId") THEN
    RAISE EXCEPTION 'Frozen persona content is immutable';
  END IF;
  IF OLD.status = 'DESTROYED' AND NEW.status <> 'DESTROYED' THEN
    RAISE EXCEPTION 'Destroyed persona cannot be restored';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER persona_content_immutable BEFORE UPDATE ON "PersonaVersion" FOR EACH ROW EXECUTE FUNCTION protect_frozen_persona();
