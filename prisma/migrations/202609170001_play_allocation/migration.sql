-- Existing personas receive a private plan lazily when creating an invitation.
ALTER TABLE "PlayPersona" ADD COLUMN "allocationState" JSONB;
