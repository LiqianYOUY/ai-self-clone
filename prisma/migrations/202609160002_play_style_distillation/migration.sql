-- Existing personas are derived on read; a later save persists the profile.
ALTER TABLE "PlayPersona" ADD COLUMN "exampleSpeaker" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PlayPersona" ADD COLUMN "styleProfile" JSONB;
