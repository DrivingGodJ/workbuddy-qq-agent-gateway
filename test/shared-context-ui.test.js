import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { conversationStatus, sharedContextStatus } from "../modules/web-console/public/client-status.js";

const source = await readFile(new URL("../modules/web-console/public/client.js", import.meta.url), "utf8");
const html = await readFile(new URL("../modules/web-console/public/client.html", import.meta.url), "utf8");
const slice = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing UI boundary: ${start}`);
  return source.slice(from, to);
};
const noop = () => {};
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
function element() {
  return { hidden: false, value: "", innerHTML: "", textContent: "", disabled: false, className: "", attributes: {}, listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(type, handler) { this.listeners[type] = handler; } };
}
function linkUi({ confirm = () => true, api = async () => ({ contextLink: { groupId: "200", groupName: "测试群" }, contextQueue: null }), link = null } = {}) {
  const item = { key: "private:100", kind: "private", data: { targetType: "private", targetId: "100", contextLink: link } };
  const context = {
    state: { qq: { groups: { 200: { groupId: "200", groupName: "测试群" }, 201: { groupId: "201", groupName: "第二群" } } } },
    settingsSavingKey: "", settingsSignature: "previous", contextLinkDrafts: new Map(),
    els: Object.fromEntries(["contextLinkForm", "contextLinkGroup", "contextLinkHint", "contextLinkStatus", "saveContextLinkButton", "sharedContextInfo"].map((id) => [id, element()])),
    window: { confirm }, api, refresh: async () => {}, escapeHtml, isSpeakerGreetingBusy: () => false,
    currentTarget: () => context.item, item, renderAgentSettings: (target) => context.renderContextLink(target)
  };
  runInNewContext(slice("function renderContextLink(", "\nfunction renderPersona("), context);
  runInNewContext(slice('els.contextLinkGroup.addEventListener("change"', 'els.agentSettingsForm.addEventListener("submit"'), context);
  context.renderContextLink(item);
  const select = (value) => { context.els.contextLinkGroup.value = value; context.els.contextLinkGroup.listeners.change(); };
  const submit = () => context.els.contextLinkForm.listeners.submit({ preventDefault: noop });
  return { context, select, submit };
}

test("shared context settings have labels, live feedback and a separate non-nested form", () => {
  assert.match(html, /label for="contextLinkGroup">共享群聊上下文/u);
  assert.match(html, /id="contextLinkGroup"[^>]*aria-describedby="contextLinkHelp contextLinkHint"/u);
  assert.match(html, /id="contextLinkStatus"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(html, /id="contextLinkForm"[^>]*hidden[\s\S]*?<\/form>\s*<form id="agentSettingsForm"/u);
  const { context } = linkUi();
  assert.equal(context.els.contextLinkGroup.value, "");
  assert.equal(context.els.saveContextLinkButton.disabled, true);
  assert.match(context.els.contextLinkGroup.innerHTML, /独立私聊.*测试群.*第二群/u);
  assert.equal(context.els.contextLinkForm.hidden, false);
  context.renderContextLink({ kind: "group", data: { contextQueue: { linkedPrivateIds: ["100", "101"] } } });
  assert.equal(context.els.contextLinkForm.hidden, true);
  assert.match(context.els.sharedContextInfo.textContent, /2 个私聊/u);
});

test("SSE rendering preserves an edited link and shared queue keeps the save action unavailable", () => {
  const { context, select } = linkUi();
  select("201");
  context.item.data.contextLink = { groupId: "200", groupName: "测试群", parkedThreadId: "old-private" };
  context.item.data.contextQueue = { active: { targetType: "group", targetId: "200", kind: "reply" }, queued: [], linkedPrivateIds: ["100"] };
  context.renderContextLink(context.item);
  assert.equal(context.els.contextLinkGroup.value, "201");
  assert.equal(context.contextLinkDrafts.get("private:100").dirty, true);
  assert.equal(context.els.saveContextLinkButton.disabled, true);
  assert.match(context.els.contextLinkHint.textContent, /先终止相关任务.*选择会保留/u);
  assert.match(context.els.sharedContextInfo.textContent, /old-private/u);
  context.item.data.contextQueue = null;
  context.renderContextLink(context.item);
  assert.equal(context.els.saveContextLinkButton.disabled, false);
  context.state.qq.groups = {};
  context.renderContextLink(context.item);
  assert.equal(context.els.contextLinkGroup.value, "201");
  assert.equal(context.els.saveContextLinkButton.disabled, true);
  assert.match(context.els.contextLinkGroup.innerHTML, /当前不可用/u);
});

test("binding requires privacy acknowledgement, prevents duplicate POSTs and leaves other channels untouched", async () => {
  let finish;
  let calls = 0;
  const ui = linkUi({ confirm: (warning) => {
    assert.match(warning, /共享模型上下文和群工作区/u);
    assert.match(warning, /无法抹除.*私聊内容/u);
    assert.match(warning, /不会继承群权限/u);
    return true;
  }, api: (path, options) => {
    calls++;
    assert.equal(path, "/api/qq/private/100/context-link");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { groupId: "200", acknowledgeSharedContext: true });
    return new Promise((resolve) => { finish = resolve; });
  } });
  ui.select("200");
  const running = ui.submit();
  assert.equal(ui.context.els.contextLinkGroup.disabled, true);
  assert.equal(ui.context.els.contextLinkForm.attributes["aria-busy"], "true");
  await ui.submit();
  assert.equal(calls, 1);
  finish({ contextLink: { groupId: "200", groupName: "测试群", parkedThreadId: "private-old" }, contextQueue: null });
  await running;
  assert.equal(ui.context.contextLinkDrafts.get("private:100").dirty, false);
  assert.equal(ui.context.item.data.contextLink.parkedThreadId, "private-old");
  assert.match(ui.context.els.contextLinkStatus.textContent, /已关联/u);
  assert.equal(ui.context.state.qq.groups[200].groupName, "测试群");
});

test("cancel, concurrent config save and missing destinations cannot mutate links; failure keeps draft", async () => {
  let calls = 0;
  const cancelled = linkUi({ confirm: () => false, api: async () => { calls++; } });
  cancelled.select("200");
  await cancelled.submit();
  assert.equal(calls, 0);
  cancelled.context.settingsSavingKey = "private:100";
  await cancelled.submit();
  assert.equal(calls, 0);
  const failed = linkUi({ api: async () => { throw new Error("HTTP 409：共享会话仍有运行任务"); } });
  failed.select("201");
  await failed.submit();
  assert.equal(failed.context.els.contextLinkGroup.value, "201");
  assert.equal(failed.context.contextLinkDrafts.get("private:100").dirty, true);
  assert.equal(failed.context.els.contextLinkStatus.className, "form-status error");
  assert.match(failed.context.els.contextLinkStatus.textContent, /409.*选择已保留.*等待队列完成/u);
});

test("unlink restores the parked session only after confirmation and preserves privacy warning", async () => {
  let payload;
  const ui = linkUi({ link: { groupId: "200", groupName: "测试群", parkedThreadId: "old" }, confirm: (warning) => {
    assert.match(warning, /恢复搁置的原私聊会话/u);
    assert.match(warning, /不能通过解绑抹除/u);
    return true;
  }, api: async (_, options) => { payload = JSON.parse(options.body); return { contextLink: null, contextQueue: null }; } });
  ui.select("");
  await ui.submit();
  assert.deepEqual(payload, { groupId: null, acknowledgeSharedContext: true });
  assert.equal(ui.context.item.data.contextLink, null);
  assert.match(ui.context.els.contextLinkStatus.textContent, /已解绑/u);
});

test("shared model controls inherit only three parameters and linked config submits only channel permissions", async () => {
  const renderSource = slice("function renderAgentSettings(", "\nfunction renderContextLink(");
  const controls = ["agentSettingsSummary", "agentModel", "agentReasoningEffort", "agentContextTokenLimit", "agentPermissionMode", "agentCalendarRemindersEnabled", "agentHomeAssistantPermission", "agentSpeakerMorning", "agentSpeakerNoon", "agentSpeakerNight", "speakerGreetingsHint", "saveAgentSettingsButton", "agentSettingsHint", "agentSettingsStatus", "agentSettingsForm"];
  const item = { key: "private:100", kind: "private", data: {
    targetId: "100", contextLink: { groupId: "200" }, codexConfig: { model: "private-model", reasoningEffort: "high", contextTokenLimit: 100000, permissionMode: "readOnly", calendarRemindersEnabled: false, homeAssistantPermission: "disabled" },
    effectiveCodexConfig: { model: "group-model", reasoningEffort: "low", contextTokenLimit: 200000, permissionMode: "dangerFullAccess", calendarRemindersEnabled: true, homeAssistantPermission: "group" }
  } };
  let payload;
  const context = {
    state: { ai: {} }, item, settingsDirty: false, settingsSignature: "", settingsContextKey: "", settingsSavingKey: "", contextLinkDrafts: new Map(),
    els: Object.fromEntries(controls.map((id) => [id, element()])),
    renderContextLink: noop, modelInfo: () => null, permissionModeLabel: String, effortLabel: String, updateParameterExplanation: noop,
    isSpeakerGreetingBusy: () => false, agentName: () => "测试助手", currentTarget: () => item, scheduleRefresh: noop, window: { confirm: () => { throw new Error("private must not open group authorization dialog"); } },
    api: async (_, options) => { payload = JSON.parse(options.body); return { codexConfig: item.data.codexConfig }; }
  };
  for (const [fn, control] of [["populateModelOptions", "agentModel"], ["populateEffortOptions", "agentReasoningEffort"], ["populateContextOptions", "agentContextTokenLimit"], ["populatePermissionOptions", "agentPermissionMode"], ["populateHomeAssistantPermissionOptions", "agentHomeAssistantPermission"]]) context[fn] = (value) => { context.els[control].value = value; };
  runInNewContext(renderSource, context);
  context.renderAgentSettings(item);
  assert.equal(context.els.agentModel.value, "group-model");
  assert.equal(context.els.agentReasoningEffort.value, "low");
  assert.equal(context.els.agentContextTokenLimit.value, 200000);
  assert.equal(context.els.agentModel.disabled, true);
  assert.equal(context.els.agentReasoningEffort.disabled, true);
  assert.equal(context.els.agentContextTokenLimit.disabled, true);
  assert.equal(context.els.agentPermissionMode.disabled, false);
  assert.equal(context.els.agentPermissionMode.value, "readOnly");
  assert.equal(context.els.agentCalendarRemindersEnabled.checked, false);
  assert.equal(context.els.agentHomeAssistantPermission.value, "disabled");
  assert.match(context.els.agentSettingsHint.textContent, /继承关联群聊.*当前私聊/u);
  context.settingsDirty = true;
  context.els.agentPermissionMode.value = "workspaceWrite";
  context.renderAgentSettings(item);
  assert.equal(context.els.agentPermissionMode.value, "workspaceWrite");
  runInNewContext(slice('els.agentSettingsForm.addEventListener("submit"', 'els.personaNameInput.addEventListener("input"'), context);
  await context.els.agentSettingsForm.listeners.submit({ preventDefault: noop });
  assert.equal(Object.hasOwn(payload, "model"), false);
  assert.equal(Object.hasOwn(payload, "reasoningEffort"), false);
  assert.equal(Object.hasOwn(payload, "contextTokenLimit"), false);
  assert.equal(payload.permissionMode, "workspaceWrite");
  assert.equal(payload.calendarRemindersEnabled, false);
  assert.equal(payload.homeAssistantPermission, "disabled");
});

test("context queue accurately distinguishes own running work, queued channel and linked-channel activity", () => {
  const data = { targetType: "private", targetId: "100", contextQueue: { groupId: "200", active: { targetType: "group", targetId: "200", kind: "qzone-feed" }, queued: [{ targetType: "private", targetId: "101", kind: "reply" }, { targetType: "private", targetId: "100", kind: "reply" }] } };
  assert.equal(sharedContextStatus(data).short, "共享排队");
  assert.match(conversationStatus(data).detail, /第 2 个等待任务.*消息仍保留/u);
  assert.equal(conversationStatus(data, { agentDispatch: { enabled: false } }).short, "已暂停");
  data.contextQueue.queued = [];
  assert.equal(conversationStatus(data).short, "共享处理中");
  assert.match(conversationStatus(data).detail, /群聊任务/u);
  data.contextQueue.active = { targetType: "private", targetId: "100", kind: "reply" };
  data.activeReply = { running: true };
  assert.equal(sharedContextStatus(data), null);
  assert.equal(conversationStatus(data).short, "生成中");
  assert.equal(sharedContextStatus({ targetId: "100" }), null);
});
