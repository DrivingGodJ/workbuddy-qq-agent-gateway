import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { SessionStore } from "../src/storage/session-store.js";
import { conversationStatus, isSpeakerGreetingBusy, speakerGreetingStatus } from "../modules/web-console/public/client-status.js";

async function configValidator(speakerGreetingsAvailable = true) {
  // Test the actual boundary function without starting a gateway or touching live state.
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const options = source.match(/const homeAssistantPermissionOptions = \[[\s\S]*?\n\];/u)?.[0];
  const start = source.indexOf("function validateCodexConfig(");
  const end = source.indexOf("\nfunction normalizeWorkBuddyContextLimit", start);
  assert.ok(options && start >= 0 && end > start);
  return runInNewContext(`${options}\n${source.slice(start, end)}\nvalidateCodexConfig`, {
    codexModels: [{ model: "test-model", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }],
    contextTokenOptions: [{ value: 100000 }],
    permissionModeOptions: [{ value: "workspaceWrite", targetTypes: ["group", "private"] }],
    speakerGreetingsAvailable,
    HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } }
  });
}

test("Home Assistant permissions persist independently and invalid stored permissions fail closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-home-permissions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "sessions.json");
  const first = new SessionStore({ filePath });
  await first.init({ allowedGroups: ["100000001", "100000002", "100000003", "100000004"] });
  assert.equal(first.snapshot("100000004").codexConfig.homeAssistantPermission, "owner");
  await first.setCodexConfig("100000001", { homeAssistantPermission: "group" });
  await first.setCodexConfig("100000002", { homeAssistantPermission: "disabled" });
  await first.setCodexConfig("100000003", { homeAssistantPermission: "full-access" });
  const restored = new SessionStore({ filePath });
  await restored.init();
  assert.equal(restored.snapshot("100000001").codexConfig.homeAssistantPermission, "group");
  assert.equal(restored.snapshot("100000002").codexConfig.homeAssistantPermission, "disabled");
  assert.equal(restored.snapshot("100000003").codexConfig.homeAssistantPermission, "disabled");
  assert.equal(restored.snapshot("100000004").codexConfig.homeAssistantPermission, "owner");
});

test("config validation rejects full-group permission in private chats and unknown permission values", async () => {
  const validate = await configValidator();
  const config = { model: "test-model", reasoningEffort: "low", contextTokenLimit: 100000,
    permissionMode: "workspaceWrite", calendarRemindersEnabled: false };
  assert.equal(validate(config).homeAssistantPermission, "owner");
  assert.equal(validate(config, { currentConfig: { homeAssistantPermission: "disabled" } }).homeAssistantPermission, "disabled");
  for (const permission of ["owner", "disabled", "group"]) {
    assert.equal(validate({ ...config, homeAssistantPermission: permission }, { targetType: "group" }).homeAssistantPermission, permission);
  }
  assert.throws(() => validate({ ...config, homeAssistantPermission: "group" }, { targetType: "private" }), /私聊不能开放全群权限/u);
  for (const permission of ["", "unknown", 1, {}]) {
    assert.throws(() => validate({ ...config, homeAssistantPermission: permission }), /智能家居权限/u);
  }
});

test("speaker greetings are off by default, persist independently and malformed stored schedules fail closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-speaker-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "sessions.json");
  const first = new SessionStore({ filePath });
  await first.init({ allowedGroups: ["100000001", "100000002", "100000003"] });
  const off = { morning: false, noon: false, night: false };
  assert.deepEqual(first.snapshot("100000001").codexConfig.speakerGreetings, off);
  await first.setCodexConfig("100000001", { speakerGreetings: { morning: true, noon: false, night: true } });
  await first.setCodexConfig("100000003", { speakerGreetings: { morning: true, noon: "true", night: false } });
  const restored = new SessionStore({ filePath });
  await restored.init();
  assert.deepEqual(restored.snapshot("100000001").codexConfig.speakerGreetings, { morning: true, noon: false, night: true });
  assert.deepEqual(restored.snapshot("100000002").codexConfig.speakerGreetings, off);
  assert.deepEqual(restored.snapshot("100000003").codexConfig.speakerGreetings, off);
  for (const raw of [null, true, [], {}, { morning: true }, { morning: true, noon: false, night: false, extra: false }]) {
    await first.setCodexConfig("100000003", { speakerGreetings: raw });
    assert.deepEqual(first.snapshot("100000003").codexConfig.speakerGreetings, off);
  }
});

test("speaker greeting API validation preserves old clients and checks prerequisites only when enabling a new slot", async () => {
  const validate = await configValidator();
  const offline = await configValidator(false);
  const config = { model: "test-model", reasoningEffort: "low", contextTokenLimit: 100000,
    permissionMode: "workspaceWrite", calendarRemindersEnabled: false, homeAssistantPermission: "owner" };
  const schedule = { morning: true, noon: false, night: false };
  assert.deepEqual({ ...validate(config).speakerGreetings }, { morning: false, noon: false, night: false });
  assert.deepEqual({ ...validate(config, { currentConfig: { speakerGreetings: schedule } }).speakerGreetings }, schedule);
  assert.deepEqual({ ...offline(config, { currentConfig: { speakerGreetings: schedule } }).speakerGreetings }, schedule);
  assert.deepEqual({ ...validate({ ...config, speakerGreetings: schedule }).speakerGreetings }, schedule);
  assert.throws(() => validate({ ...config, homeAssistantPermission: "disabled", speakerGreetings: schedule }), /先开启/u);
  assert.throws(() => offline({ ...config, speakerGreetings: schedule }), /先配置/u);
  for (const raw of [null, true, "false", [], {}, { morning: true }, { morning: true, noon: 0, night: false }, { morning: true, noon: false, night: false, extra: true }]) {
    assert.throws(() => validate({ ...config, speakerGreetings: raw }), /分别设置/u);
  }
});

test("speaker greeting status and receipts remain distinct from QQ sends, including cancellation and uncertainty", async () => {
  for (const stage of ["queued", "generating", "speaking"]) {
    const data = { speakerGreetingActivity: { label: "早安", stage }, activeReply: { running: false } };
    assert.equal(isSpeakerGreetingBusy(data), true);
    assert.deepEqual(conversationStatus(data), speakerGreetingStatus(data.speakerGreetingActivity));
  }
  for (const stage of ["completed", "failed", "cancelled", "uncertain"]) assert.equal(isSpeakerGreetingBusy({ speakerGreetingActivity: { stage } }), false);
  assert.equal(speakerGreetingStatus({ stage: "uncertain" }).tone, "attention");
  const source = await readFile(new URL("../modules/web-console/public/client.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderSpeakerGreeting(");
  const end = source.indexOf("\nfunction sourceProgressLabel", start);
  const render = runInNewContext(`${source.slice(start, end)}\nrenderSpeakerGreeting`, {
    speakerGreetingStatus, agentName: () => "老代", formatTime: () => "07:00", escapeHtml: (v) => String(v).replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  });
  const receipt = render({ stage: "completed", label: "早安", time: "07:00", text: "<script>hello</script>" });
  assert.match(receipt, /小爱定时问候/u);
  assert.match(receipt, /HA 已接受播报/u);
  assert.match(receipt, /&lt;script&gt;/u);
  assert.doesNotMatch(receipt, /已发送到 QQ/u);
  assert.match(render({ stage: "uncertain", text: "晚安" }), /请勿自动重试/u);
});

test("frontend permission choices reflect backend target types and preserve explicit selection", async () => {
  const source = await readFile(new URL("../modules/web-console/public/client.js", import.meta.url), "utf8");
  const start = source.indexOf("function populateHomeAssistantPermissionOptions(");
  const end = source.indexOf("\nfunction updateParameterExplanation", start);
  const control = { innerHTML: "", value: "" };
  const populate = runInNewContext(`${source.slice(start, end)}\npopulateHomeAssistantPermissionOptions`, {
    state: { ai: { homeAssistantPermissionOptions: [
      { value: "disabled", label: "关闭", targetTypes: ["group", "private"] },
      { value: "owner", label: "仅 OWNER", targetTypes: ["group", "private"] },
      { value: "group", label: "全群成员", targetTypes: ["group"] }
    ] } }, els: { agentHomeAssistantPermission: control }, escapeHtml: String
  });
  populate("group", "group");
  assert.equal(control.value, "group");
  assert.match(control.innerHTML, /value="group"/u);
  populate("disabled", "private");
  assert.equal(control.value, "disabled");
  assert.doesNotMatch(control.innerHTML, /value="group"/u);
  const html = await readFile(new URL("../modules/web-console/public/client.html", import.meta.url), "utf8");
  assert.match(html, /<label for="agentHomeAssistantPermission">智能家居与小爱发言权限/u);
  assert.match(source, /homeAssistantPermission: els\.agentHomeAssistantPermission\.value/u);
});
