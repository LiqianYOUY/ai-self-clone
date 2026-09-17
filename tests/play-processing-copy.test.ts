import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivacyNotice } from "../src/components/privacy-notice";
import { PlayModelNotice } from "../src/components/play-model-notice";
import {
  generatedReplyPolicy,
  playProcessingCopy,
  playProcessingKind,
} from "../src/components/play-model-copy";

test("private processing disclosure identifies both devices and the encrypted model transfer", () => {
  const [zh, en] = playProcessingCopy(playProcessingKind("private-ollama"));
  for (const term of [
    "树莓派",
    "Mac",
    "加密连接",
    "参考资料",
    "当前对话",
    "不使用云端模型",
  ])
    assert(zh.includes(term));
  for (const term of [
    "Raspberry Pi",
    "Mac",
    "encrypted connection",
    "persona references",
    "current conversation",
    "No cloud model",
  ])
    assert(en.includes(term));
});

test("local and compatible processing disclosures never imply the private Mac route", () => {
  for (const raw of [undefined, "", "ollama"]) {
    const text = playProcessingCopy(playProcessingKind(raw)).join(" ");
    assert(text.includes("No cloud model"));
    assert(!text.includes("Mac"));
  }
  const external = playProcessingCopy(playProcessingKind("compatible")).join(
    " ",
  );
  assert(external.includes("external service"));
  assert(!external.includes("No cloud model"));
  assert(!external.includes("Mac"));
  assert.equal(playProcessingKind("unknown"), "unavailable");
  assert.equal(
    playProcessingKind(undefined, "https://model.example.test"),
    "compatible",
  );
  assert.equal(
    playProcessingKind("  ", "http://127.0.0.1:11434"),
    "compatible",
  );
  assert.equal(
    playProcessingKind(" ollama ", "http://127.0.0.1:11434"),
    "ollama",
  );
});

test("generated replies are distinguished from participant-authored saved references", () => {
  assert(generatedReplyPolicy[0].includes("不会自动"));
  assert(generatedReplyPolicy[0].includes("亲自填写并保存"));
  assert(generatedReplyPolicy[1].includes("not automatically"));
  assert(generatedReplyPolicy[1].includes("write and save"));
});

test("privacy and participation components render the selected processing mode", () => {
  for (const kind of ["ollama", "private-ollama", "compatible"] as const) {
    const expected = playProcessingCopy(kind)[0];
    for (const element of [
      createElement(PrivacyNotice, { processingKind: kind }),
      createElement(PlayModelNotice, { kind }),
    ]) {
      const html = renderToStaticMarkup(element);
      assert(html.includes(expected));
      assert(html.includes(generatedReplyPolicy[0]));
      assert(!html.includes("树莓派本地生成"));
    }
  }
});
