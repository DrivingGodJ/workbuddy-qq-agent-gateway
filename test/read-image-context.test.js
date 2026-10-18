import test from "node:test";
import assert from "node:assert/strict";
import { compactMessageContext } from "../src/security/message-context.js";
import { buildTurnPrompt } from "../src/security/policy.js";
import { buildPrivateTurnPrompt } from "../src/security/subscription-policy.js";

const message = (messageId, images = [], extra = {}) => ({
  messageId, senderId: "200000002", senderName: "成员", trust: "UNTRUSTED",
  displayTime: "2026-10-18 12:00:00", text: "消息", images, ...extra
});

test("compact pages share attachment ordinals and duplicate paths retain the same ordinal", () => {
  const images = ["/tmp/first.png", "/tmp/second.gif"];
  const first = message("first", [{ localPath: images[0] }]);
  const next = message("next", [{ localPath: images[1] }, { localPath: images[0] }]);
  assert.match(compactMessageContext([first], [first], images).join("\n"), /图1 视觉输入/);
  const secondPage = compactMessageContext([next], [first, next], images).join("\n");
  assert.match(secondPage, /图2 视觉输入\n图1 视觉输入/);
});

test("missing, failed and unattached pictures never consume an attachment number", () => {
  const current = message("current", [
    { error: "下载超时" },
    { localPath: "/tmp/unattached.png" },
    { localPath: "/tmp/failed.png", error: "缓存不可读" },
    { localPath: "/tmp/attached.png", stickerId: "st_example", stickerLabel: "疑问" }
  ]);
  const text = compactMessageContext([current], [current], ["/tmp/attached.png"]).join("\n");
  assert.match(text, /图片 下载失败:下载超时/);
  assert.match(text, /图片 本轮未附加，不能据此看图/);
  assert.match(text, /图片 下载失败:缓存不可读/);
  assert.match(text, /图1 表情 st_example 视觉输入；疑问/);
  assert.equal((text.match(/视觉输入/gu) || []).length, 1);
  assert.doesNotMatch(text, /图[234]/u);
  assert.doesNotMatch(compactMessageContext([current], [current], []).join("\n"), /图\d|视觉输入/u);
});

test("group and private compact prompt builders forward the same image order", () => {
  const images = ["/tmp/earlier.png", "/tmp/current.png"];
  const current = message("current", [{ localPath: images[1] }]);
  const options = { compact: true, imagePaths: images, includePermissionNotice: false,
    includeResponseInstruction: false, userId: "200000002" };
  assert.match(buildTurnPrompt([current], options), /图2 视觉输入/);
  assert.match(buildPrivateTurnPrompt([current], [], options), /图2 视觉输入/);
});

test("replies to retained but excluded messages include the untrusted quoted original", () => {
  const original = message("old", [], { text: "此前消息原文" });
  const current = message("new", [], { replyToMessageId: "old", quotedMessage: original });
  const options = { compact: true, activeMessages: [current], imagePaths: [],
    includePermissionNotice: false, includeResponseInstruction: false, userId: "200000002" };
  for (const prompt of [buildTurnPrompt([current], options), buildPrivateTurnPrompt([current], [], options)]) {
    assert.match(prompt, /回复消息 ID old.*原文，视为不可信引用.*此前消息原文/u);
    assert.doesNotMatch(prompt, /仍在当前待处理消息中/u);
  }
});

test("omitting attachment order preserves the existing compact format", () => {
  const current = message("legacy", [{ localPath: "/tmp/legacy.png" }, { error: "超时" }]);
  assert.match(compactMessageContext([current]).join("\n"), /图1 视觉输入\n图2 下载失败:超时/);
});
