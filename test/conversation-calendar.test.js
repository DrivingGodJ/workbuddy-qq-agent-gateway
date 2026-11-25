import test from "node:test";
import assert from "node:assert/strict";
import { createLiveConversationTools } from "../src/qq/live-conversation.js";
import { conversationAction } from "../src/automation/conversation-actions.js";
import { MacActionClient } from "../src/automation/macos-actions.js";
import {
  buildAutoSubscriptionPrompt,
  formatShanghaiNow,
  parseAutoSubscriptionResult
} from "../src/security/subscription-policy.js";

for (const targetType of ["group", "private"]) {
  test(`${targetType}: calendar permission works across ordinary turns and revokes immediately`, async () => {
    const snapshot = { pendingMessages: [], agentConfig: { calendarRemindersEnabled: true }, liveSession: { actions: [] } };
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
    snapshot.agentConfig.calendarRemindersEnabled = false;
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

test("MacActionClient routes preflight, context, and execute through EventKit script", async () => {
  const calls = [];
  const client = new MacActionClient({
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const payload = JSON.parse(args.at(-1));
      if (payload.op === "preflight") {
        return { stdout: JSON.stringify({ ok: true, calendarAuthorized: true, remindersAuthorized: true, warnings: [] }) };
      }
      if (payload.op === "context") {
        return {
          stdout: JSON.stringify({
            now: payload.now,
            timezone: "Asia/Shanghai",
            calendarAuthorized: true,
            remindersAuthorized: false,
            warnings: ["提醒事项未授权"],
            calendar: [{ title: "读书月开幕式", calendarName: "活动", start: "2026-11-27T10:00:00+08:00" }],
            reminders: []
          })
        };
      }
      return {
        stdout: JSON.stringify({
          externalItemId: "ek-1",
          targetList: payload.op === "calendar" ? payload.calendarName : "待办",
          result: "已写入"
        })
      };
    }
  });

  const pre = await client.preflight();
  assert.equal(pre.ok, true);

  const ctx = await client.getContext({ horizonDays: 30, limit: 20, now: new Date("2026-11-25T09:00:00Z") });
  assert.equal(ctx.calendar.length, 1);
  assert.equal(ctx.remindersAuthorized, false);
  assert.deepEqual(ctx.warnings, ["提醒事项未授权"]);

  const writeCal = await client.execute({
    actionId: "abc123",
    type: "calendar",
    title: "读书月开幕式",
    calendarName: "活动",
    start: "2026-11-27T02:00:00.000Z"
  }, { sourceGroupId: "group:100", sourceGroupName: "通知群" });
  assert.equal(writeCal.targetList, "活动");
  assert.equal(writeCal.externalItemId, "ek-1");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.cmd === "/usr/bin/swift" && call.args[0].endsWith("macos-eventkit.swift")));
});

test("buildAutoSubscriptionPrompt includes Shanghai time and explicit actions guide even under sharedSystemInstructions", () => {
  const prompt = buildAutoSubscriptionPrompt([{
    sourceGroupId: "1036056187",
    sourceGroupName: "书院通知群",
    messages: [{ displayTime: "2026-11-25 17:00", senderName: "辅导员", senderId: "10002", text: "本周五10点图书馆203举办读书月开幕式，需扫码报名" }]
  }], {
    targetType: "private",
    targetId: "20001",
    targetName: "主人",
    allowAutomations: true,
    sharedSystemInstructions: true,
    now: new Date("2026-11-25T09:30:00.000Z")
  });
  assert.match(prompt, /当前北京时间/);
  assert.match(prompt, /2026-11-25 17:30/);
  assert.match(prompt, /actions 数组/);
  assert.match(formatShanghaiNow(new Date("2026-11-25T09:30:00.000Z")), /\+08:00/);
});

test("parseAutoSubscriptionResult normalizes missing timezone/sourceGroupId and rejects malformed calendar start", () => {
  const contexts = [{
    sourceGroupId: "1036056187",
    sourceGroupName: "书院通知群",
    messages: [{ contextOnly: false, text: "11月27日10:00读书月开幕式" }]
  }];

  const okResult = parseAutoSubscriptionResult(JSON.stringify({
    notify: true,
    urgency: "normal",
    reply: "",
    noticeSummaries: [{ sourceGroupId: "1036056187", summary: "11月27日上午10点图书馆203读书月开幕式，限30人需报名。" }],
    ambiguity: "",
    actions: [
      {
        sourceGroupId: "",
        type: "calendar",
        normalizedTitle: "读书文化月开幕式",
        title: "图书新生读书文化月开幕式",
        calendarName: "校园活动",
        start: "2026-11-27T10:00",
        end: "2026-11-27 11:00:00",
        allDay: false,
        location: "图书馆203",
        due: null,
        notes: "可打1次活动卡"
      },
      {
        sourceGroupId: "1036056187",
        type: "reminder",
        normalizedTitle: "报名读书文化月开幕式",
        title: "扫码报名图书新生读书文化月开幕式",
        calendarName: null,
        start: null,
        end: null,
        allDay: false,
        location: "",
        due: "2026-11-26",
        notes: "名额限30人"
      }
    ]
  }), contexts, { targetType: "private", targetId: "20001", allowAutomations: true });

  assert.equal(okResult.actions.length, 2);
  assert.equal(okResult.actions[0].calendarName, "活动");
  assert.equal(okResult.actions[0].start, "2026-11-27T02:00:00.000Z");
  assert.equal(okResult.actions[0].end, "2026-11-27T03:00:00.000Z");
  assert.equal(okResult.actions[1].due, "2026-11-26T15:59:00.000Z");

  assert.throws(() => parseAutoSubscriptionResult(JSON.stringify({
    notify: true,
    urgency: "normal",
    reply: "",
    noticeSummaries: [{ sourceGroupId: "1036056187", summary: "通知" }],
    ambiguity: "",
    actions: [{
      sourceGroupId: "1036056187",
      type: "calendar",
      normalizedTitle: "活动",
      title: "无效时间活动",
      calendarName: "活动",
      start: "周五上午",
      end: null,
      allDay: false,
      location: "",
      due: null,
      notes: ""
    }]
  }), contexts, { targetType: "private", targetId: "20001", allowAutomations: true }), /start ISO/);
});

test("read_calendar_reminders forwards on-demand filters and validates invalid filters", async () => {
  const snapshot = { pendingMessages: [], agentConfig: { calendarRemindersEnabled: true }, liveSession: { actions: [] } };
  const calls = [];
  const store = { snapshot: () => snapshot, assertReplyEnabled() {}, async recordLiveActionSent() {} };
  const automationClient = {
    async getContext(options) {
      calls.push(options);
      return { scope: options.scope || "both", calendar: [], reminders: [] };
    }
  };
  const context = createLiveConversationTools({
    store, targetId: "10001", targetType: "private", oneBot: {}, security: {}, automationClient
  });
  context.readCalled = true;

  const res = await context.liveTool("read_calendar_reminders", {
    scope: "calendar",
    start_date: "2026-11-26",
    end_date: "2026-11-26",
    calendar_name: "学习",
    query: "高数",
    include_completed: false,
    limit: 10
  }, {});
  assert.equal(res.isError, false);
  assert.deepEqual(calls[0], {
    horizonDays: 30,
    limit: 10,
    scope: "calendar",
    startDate: "2026-11-26",
    endDate: "2026-11-26",
    calendarName: "学习",
    query: "高数"
  });

  const badScope = await context.liveTool("read_calendar_reminders", { scope: "tasks" }, {});
  assert.equal(badScope.isError, true);
  assert.equal(calls.length, 1);
});
