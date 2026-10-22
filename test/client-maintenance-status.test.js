import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationStatus } from "../modules/web-console/public/client-status.js";

test("sticker maintenance queue remains visible without daily style state", () => {
  const status = conversationStatus({ pendingTrigger: { reason: "mention" }, pendingCount: 2 }, {
    taskGate: { blocked: true },
    qq: { stickers: { curation: { status: "running" } } }
  });
  assert.equal(status.short, "排队中");
  assert.match(status.detail, /等待表情筛选/u);
  assert.doesNotMatch(status.detail, /人格总结/u);
});

test("an unblocked pending trigger is not shown as maintenance work", () => {
  const status = conversationStatus({ pendingTrigger: { reason: "mention" }, pendingCount: 2 }, {
    taskGate: { blocked: false }
  });
  assert.equal(status.short, "2");
});
