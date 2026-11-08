import test from "node:test";
import assert from "node:assert/strict";
import { createLiveConversationTools } from "../src/qq/live-conversation.js";
import { conversationAction } from "../src/automation/conversation-actions.js";

for (const targetType of ["group", "private"]) {
  test(`${targetType}: calendar permission works across ordinary turns and revokes immediately`, async () => {
    const snapshot = { pendingMessages: [], codexConfig: { calendarRemindersEnabled: true }, liveSession: { actions: [] } };
    const writes = [], reads = [], receipts = [];
    const store = { snapshot: () => snapshot, assertReplyEnabled() {},
      async recordLiveActionSent(_id, action) { receipts.push(action); } };
    const automationClient = {
      async execute(action) { writes.push(action); return { targetList: "待办", result: "已写入", externalItemId: "mock" }; },
      async getContext(options) { reads.push(options); return { calendar: [], reminders: [] }; }
    };
    const make = () => {
      const context = createLiveConversationTools({ store, targetId: "10001", targetType, oneBot: {}, security: {}, automationClient });
      context.readCalled = true;
      return context;
    };
    const args = { type: "reminder", title: "交作业", due: null };
    const first = make();
    assert.equal((await first.liveTool("add_calendar_reminder", args, {})).isError, false);
    assert.equal((await first.liveTool("add_calendar_reminder", args, {})).isError, true, "same turn must not duplicate");
    const next = make();
    assert.equal((await next.liveTool("add_calendar_reminder", args, {})).isError, false);
    assert.equal(writes[0].actionId, writes[1].actionId, "writer reuses marker across turns");
    assert.equal((await next.liveTool("read_calendar_reminders", {}, {})).isError, false);
    assert.equal(receipts[0].chatReply, false, "writing must not claim a QQ notification was delivered");
    snapshot.codexConfig.calendarRemindersEnabled = false;
    assert.equal((await next.liveTool("read_calendar_reminders", {}, {})).isError, true);
    assert.equal((await next.liveTool("add_calendar_reminder", { ...args, title: "另一个" }, {})).isError, true);
    assert.equal(writes.length, 2);
    assert.equal(reads.length, 1);
  });
}

test("calendar parameters are validated before script execution", () => {
  const valid = { type: "calendar", title: "开会", calendarName: "社团", start: "2026-11-09T19:00:00+08:00" };
  assert.equal(conversationAction(valid, "group", "10001").start, "2026-11-09T11:00:00.000Z");
  for (const extra of [{ calendarName: "私人" }, { start: "明天" }, { start: "2026-11-09T19:00:00" },
    { end: "2026-11-09T18:00:00+08:00" }, { actionId: "override" }]) {
    assert.throws(() => conversationAction({ ...valid, ...extra }, "group", "10001"));
  }
});
