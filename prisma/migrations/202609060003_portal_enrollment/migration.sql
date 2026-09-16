ALTER TABLE "AuthSession" ADD COLUMN "portal" TEXT;
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_portal_check" CHECK ("portal" IS NULL OR "portal" IN ('research', 'target', 'friend'));

CREATE TABLE "Account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "username" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "participantId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Account_username_check" CHECK ("username" ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  CONSTRAINT "Account_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Account_username_key" ON "Account"("username");
CREATE UNIQUE INDEX "Account_participantId_key" ON "Account"("participantId");

CREATE TABLE "EnrollmentInvitation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenHash" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "targetId" TEXT,
  "acceptedById" TEXT,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "acceptedAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnrollmentInvitation_kind_check" CHECK ("kind" IN ('TARGET','FRIEND','ANALYST')),
  CONSTRAINT "EnrollmentInvitation_target_check" CHECK (("kind" = 'FRIEND') = ("targetId" IS NOT NULL)),
  CONSTRAINT "EnrollmentInvitation_acceptance_check" CHECK (("acceptedAt" IS NULL) = ("acceptedById" IS NULL)),
  CONSTRAINT "EnrollmentInvitation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EnrollmentInvitation_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Participant"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "EnrollmentInvitation_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "Participant"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EnrollmentInvitation_tokenHash_key" ON "EnrollmentInvitation"("tokenHash");
CREATE UNIQUE INDEX "EnrollmentInvitation_acceptedById_key" ON "EnrollmentInvitation"("acceptedById");
CREATE INDEX "EnrollmentInvitation_targetId_expiresAt_idx" ON "EnrollmentInvitation"("targetId", "expiresAt");
CREATE INDEX "EnrollmentInvitation_createdById_createdAt_idx" ON "EnrollmentInvitation"("createdById", "createdAt");

CREATE TABLE "PreparationRoom" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "targetId" TEXT NOT NULL,
  "friendId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "nextSequence" INTEGER NOT NULL DEFAULT 1,
  "stoppedById" TEXT,
  "stoppedAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreparationRoom_status_check" CHECK ("status" IN ('ACTIVE','PAUSED','ENDED','WITHDRAWN')),
  CONSTRAINT "PreparationRoom_pair_check" CHECK ("targetId" <> "friendId"),
  CONSTRAINT "PreparationRoom_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PreparationRoom_friendId_fkey" FOREIGN KEY ("friendId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PreparationRoom_targetId_friendId_key" ON "PreparationRoom"("targetId", "friendId");

CREATE TABLE "PreparationMessage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "roomId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "text" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "destroyedAt" TIMESTAMPTZ(3),
  CONSTRAINT "PreparationMessage_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "PreparationMessage_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "PreparationRoom"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PreparationMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PreparationMessage_roomId_sequence_key" ON "PreparationMessage"("roomId", "sequence");
CREATE UNIQUE INDEX "PreparationMessage_roomId_authorId_idempotencyKey_key" ON "PreparationMessage"("roomId", "authorId", "idempotencyKey");

-- Retained tombstones also protect a restored preparation transcript from
-- accidentally resurrecting text that a participant has already destroyed.
CREATE FUNCTION prevent_preparation_content_resurrection() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DeletionTombstone" WHERE "entityType" = 'PreparationMessage' AND "entityId" = NEW."id") THEN
    NEW."text" := NULL;
    NEW."destroyedAt" := COALESCE(NEW."destroyedAt", CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER preparation_content_tombstone BEFORE INSERT OR UPDATE ON "PreparationMessage" FOR EACH ROW EXECUTE FUNCTION prevent_preparation_content_resurrection();
