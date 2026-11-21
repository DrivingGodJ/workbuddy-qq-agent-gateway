import assert from "node:assert/strict";
import test from "node:test";
import { createLiveConversationTools } from "../src/qq/live-conversation.js";
import { OneBotClient } from "../src/qq/onebot-client.js";
import { QzoneCoordinator } from "../src/qq/qzone-coordinator.js";

test("explicit QQ Space comment rejection preserves receipts and lets the scan continue", async () => {
  const calls = [];
  const receipts = {};
  const oneBot = new OneBotClient({ fetchImpl: async (url, request) => {
    const { tid } = JSON.parse(request.body);
    calls.push(tid);
    if (tid === "timeout") throw new Error("request timed out");
    const body = tid === "rejected"
      ? { status: "failed", retcode: 1200, wording: "qzone comment failed: code=-10004 参数错误" }
      : { status: "ok", retcode: 0 };
    return { ok: true, status: 200, json: async () => body };
  } });
  const qzone = new QzoneCoordinator({ oneBot, store: {
    snapshot: () => ({ actions: receipts }),
    hasAction: (key) => Object.hasOwn(receipts, key),
    async claimAction(key) {
      if (Object.hasOwn(receipts, key)) return false;
      receipts[key] = { status: "pending" };
      return true;
    },
    async finishAction(key, receipt) { receipts[key] = receipt; }
  } });
  const store = {
    snapshot: () => ({ pendingMessages: [], codexConfig: { calendarRemindersEnabled: false } }),
    assertReplyEnabled() {}
  };
  const target = { id: "10001", type: "group", worker: {
    createScheduledToolContext(id, qzoneActions) {
      return createLiveConversationTools({ store, targetId: id, targetType: "group",
        oneBot, qzone, qzoneActions, scheduledTask: true, security: {} });
    }
  } };
  qzone.assertTargetActive = () => {};
  const feeds = ["rejected", "accepted", "timeout"].map((tid) => ({
    id: `10002:${tid}`, uin: "10002", tid, timeMs: 1_000
  }));
  const scope = qzone.scheduledFeedContext(target, feeds);
  const comment = (tid) => scope.liveTool("engage_qzone_feed", { type: "comment", uin: "10002", tid, content: "测试" }, {});
  await scope.liveTool("read_qzone_feeds", {}, {});
  assert.match((await comment("rejected")).content[0].text, /-10004/u);
  assert.equal(scope.failed, false);
  assert.equal(scope.failedActions, 1);
  assert.equal(receipts["comment:10002:rejected"].status, "failed");
  await comment("rejected");
  assert.equal((await comment("accepted")).isError, false);
  assert.equal(scope.comments, 1);
  assert.equal((await comment("timeout")).isError, true);
  assert.equal(scope.failed, true);
  assert.deepEqual(calls, ["rejected", "accepted", "timeout"]);
});
