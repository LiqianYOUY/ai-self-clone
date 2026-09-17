import { HostPlayApp } from "@/components/play-app";
import { playProcessingKind } from "@/components/play-model-copy";

export const dynamic = "force-dynamic";

export default function PlayPage() {
  return (
    <HostPlayApp
      processingKind={playProcessingKind(
        process.env.PLAY_MODEL_PROVIDER,
        process.env.PLAY_MODEL_BASE_URL,
      )}
    />
  );
}
