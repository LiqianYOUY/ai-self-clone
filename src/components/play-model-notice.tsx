"use client";

import { useLanguage } from "./language-provider";
import {
  generatedReplyPolicy,
  playProcessingCopy,
  type PlayProcessingKind,
} from "./play-model-copy";

export function PlayModelNotice({ kind }: { kind: PlayProcessingKind }) {
  const { t } = useLanguage();
  return (
    <p className="play-caption">
      {t(...playProcessingCopy(kind))} {t(...generatedReplyPolicy)}
    </p>
  );
}
