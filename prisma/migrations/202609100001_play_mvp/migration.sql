CREATE TABLE "PlayPersona" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL DEFAULT '',
  "bio" TEXT NOT NULL DEFAULT '',
  "style" TEXT NOT NULL DEFAULT '',
  "memories" TEXT NOT NULL DEFAULT '',
  "examplesText" TEXT NOT NULL DEFAULT '',
  "savedAt" TIMESTAMPTZ(3),
  "heartbeatAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlayPersona_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PlayPersona_ownerId_key" ON "PlayPersona"("ownerId");

CREATE TABLE "PlayRoom" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'WAITING',
  "inviteHash" TEXT,
  "guestHash" TEXT,
  "guestName" TEXT,
  "personaSnapshot" JSONB NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "consentVersion" TEXT,
  "consentedAt" TIMESTAMPTZ(3),
  "turnsCompleted" INTEGER NOT NULL DEFAULT 0,
  "nextSequence" INTEGER NOT NULL DEFAULT 1,
  "pendingTurn" INTEGER,
  "pendingSince" TIMESTAMPTZ(3),
  "guess" TEXT,
  "reason" TEXT,
  "revealedAt" TIMESTAMPTZ(3),
  "cancelledAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlayRoom_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PlayRoom_mode_check" CHECK ("mode" IN ('HUMAN', 'AI')),
  CONSTRAINT "PlayRoom_status_check" CHECK ("status" IN ('WAITING', 'ACTIVE', 'GUESSING', 'REVEALED', 'CANCELLED')),
  CONSTRAINT "PlayRoom_guess_check" CHECK ("guess" IS NULL OR "guess" IN ('HUMAN', 'AI')),
  CONSTRAINT "PlayRoom_turns_check" CHECK ("turnsCompleted" BETWEEN 0 AND 5 AND "nextSequence" BETWEEN 1 AND 11),
  CONSTRAINT "PlayRoom_pending_check" CHECK (("pendingTurn" IS NULL) = ("pendingSince" IS NULL)),
  CONSTRAINT "PlayRoom_pending_range_check" CHECK ("pendingTurn" IS NULL OR "pendingTurn" BETWEEN 1 AND 5),
  CONSTRAINT "PlayRoom_reveal_check" CHECK (("status" = 'REVEALED') = ("revealedAt" IS NOT NULL AND "guess" IS NOT NULL))
);
CREATE UNIQUE INDEX "PlayRoom_inviteHash_key" ON "PlayRoom"("inviteHash");
CREATE UNIQUE INDEX "PlayRoom_guestHash_key" ON "PlayRoom"("guestHash");
CREATE INDEX "PlayRoom_ownerId_createdAt_idx" ON "PlayRoom"("ownerId", "createdAt");
CREATE INDEX "PlayRoom_status_pendingSince_idx" ON "PlayRoom"("status", "pendingSince");
-- The database also enforces this invariant across multiple application workers.
CREATE UNIQUE INDEX "PlayRoom_one_open_per_owner" ON "PlayRoom"("ownerId") WHERE "status" IN ('WAITING', 'ACTIVE', 'GUESSING');

CREATE TABLE "PlayMessage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "roomId" TEXT NOT NULL,
  "speaker" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlayMessage_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "PlayRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PlayMessage_speaker_check" CHECK ("speaker" IN ('FRIEND', 'SOURCE')),
  CONSTRAINT "PlayMessage_sequence_check" CHECK ("sequence" BETWEEN 1 AND 10),
  CONSTRAINT "PlayMessage_text_check" CHECK (length("text") BETWEEN 1 AND 2000)
);
CREATE UNIQUE INDEX "PlayMessage_roomId_sequence_key" ON "PlayMessage"("roomId", "sequence");
CREATE UNIQUE INDEX "PlayMessage_roomId_speaker_idempotencyKey_key" ON "PlayMessage"("roomId", "speaker", "idempotencyKey");
