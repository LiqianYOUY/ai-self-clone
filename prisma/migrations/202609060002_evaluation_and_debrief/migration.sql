-- DropIndex
DROP INDEX "MatchedRating_stimulusId_participantId_key";

-- AlterTable
ALTER TABLE "MatchedRating" ADD COLUMN     "contextHash" TEXT,
ADD COLUMN     "track" TEXT NOT NULL DEFAULT 'MATCHED';

-- AlterTable
ALTER TABLE "RelationshipTimepoint" ALTER COLUMN "ios" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ExcerptSharingApproval" (
    "id" TEXT NOT NULL,
    "stimulusId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "contextVersion" TEXT NOT NULL,
    "contextHash" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExcerptSharingApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebriefRecord" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "revealRequested" BOOLEAN NOT NULL DEFAULT false,
    "countingStrategy" BOOLEAN NOT NULL DEFAULT false,
    "inferredRatio" BOOLEAN NOT NULL DEFAULT false,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebriefRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceRevealGrant" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "revealedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceRevealGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExcerptSharingApproval_stimulusId_participantId_scope_key" ON "ExcerptSharingApproval"("stimulusId", "participantId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRevealGrant_participantId_sessionId_key" ON "SourceRevealGrant"("participantId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchedRating_stimulusId_participantId_track_key" ON "MatchedRating"("stimulusId", "participantId", "track");

-- AddForeignKey
ALTER TABLE "ExcerptSharingApproval" ADD CONSTRAINT "ExcerptSharingApproval_stimulusId_fkey" FOREIGN KEY ("stimulusId") REFERENCES "StimulusExcerpt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE FUNCTION protect_shared_excerpt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_condition text;
BEGIN
  SELECT "privateCondition" INTO expected_condition FROM "Session" WHERE id = NEW."sessionId";
  IF NEW."privateCondition" <> expected_condition THEN RAISE EXCEPTION 'Excerpt source must match originating session'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status <> 'DESTROYED' AND
     (EXISTS(SELECT 1 FROM "ExcerptSharingApproval" WHERE "stimulusId"=OLD.id) OR EXISTS(SELECT 1 FROM "MatchedRating" WHERE "stimulusId"=OLD.id)) AND
     (NEW."privateCondition" IS DISTINCT FROM OLD."privateCondition" OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId" OR NEW."contextVersion" IS DISTINCT FROM OLD."contextVersion" OR NEW.text IS DISTINCT FROM OLD.text OR NEW.context IS DISTINCT FROM OLD.context OR NEW."sourceMessageIds" IS DISTINCT FROM OLD."sourceMessageIds") THEN
    RAISE EXCEPTION 'Shared excerpt context is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shared_excerpt_immutable BEFORE INSERT OR UPDATE ON "StimulusExcerpt" FOR EACH ROW EXECUTE FUNCTION protect_shared_excerpt();
