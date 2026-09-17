import { PrivacyNotice } from "@/components/privacy-notice";
import { playProcessingKind } from "@/components/play-model-copy";
import "../play/play.css";
import "./privacy.css";

export const dynamic = "force-dynamic";

export default function PrivacyPage() {
  return (
    <PrivacyNotice
      processingKind={playProcessingKind(
        process.env.PLAY_MODEL_PROVIDER,
        process.env.PLAY_MODEL_BASE_URL,
      )}
    />
  );
}
