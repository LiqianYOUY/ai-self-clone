CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");
CREATE INDEX "Generation_status_triggeredAt_idx" ON "Generation"("status", "triggeredAt");
