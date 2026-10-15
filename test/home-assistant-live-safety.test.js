import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HomeAssistantClient, homeAssistantRequest } from "../src/automation/home-assistant.js";
import { createLiveConversationTools } from "../src/qq/live-conversation.js";
import { SessionStore } from "../src/storage/session-store.js";
import { OWNER_QQ_ID } from "../src/security/policy.js";

const groupId = "12345", memberId = "100000009";
const light = { entity_id: "light.desk", state: "on", attributes: { friendly_name: "台灯", brightness: 100, supported_color_modes: ["color_temp"], min_color_temp_kelvin: 2700, max_color_temp_kelvin: 6500 } };
const speaker = { entity_id: "notify.xiaomi_test_l05c_play_text_a_5_3", state: "unknown", attributes: { friendly_name: "小爱音箱 播放文本" } };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { permission = "group", text = "请打开台灯", senderId = memberId, messageId = "101" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "crc-ha-live-safety-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(directory, "state.json") });
  await store.init({ allowedGroups: [groupId] });
  await store.setCodexConfig(groupId, { homeAssistantPermission: permission });
  const message = await store.appendMessage({ groupId, messageId, senderId, source: "qq", trust: senderId === OWNER_QQ_ID ? "OWNER" : "UNTRUSTED", text });
  await store.requestTrigger(groupId, "mention", message);
  await store.beginWork(groupId);
  const posts = [];
  let nextReadGate = null;
  const ha = new HomeAssistantClient({ baseUrl: "http://ha.invalid:8123", token: "offline-test-token", enabled: true,
    allowedSpeakers: [speaker.entity_id], fetchImpl: async (url, options) => {
      if (options.method === "GET" && url.includes("/api/states/") && nextReadGate) {
        const gate = nextReadGate; nextReadGate = null;
        gate.started.resolve(); await gate.release.promise;
      }
      let value;
      if (options.method === "POST") { posts.push(JSON.parse(options.body)); value = []; }
      else if (url.endsWith("/api/services")) value = [{ domain: "light", services: { turn_on: {} } }, { domain: "notify", services: { send_message: {} } }];
      else if (url.endsWith("/api/states")) value = [light, speaker];
      else value = url.endsWith(speaker.entity_id) ? speaker : light;
      return new Response(JSON.stringify(value));
    } });
  const context = createLiveConversationTools({ store, targetId: groupId, targetType: "group", homeAssistant: ha,
    trigger: { trust: message.trust, reason: "mention" }, triggerMessages: [message], security: {},
    initialImageSequence: message.sequence, renderMessages: (messages) => messages.map((item) => item.text).join("\n") });
  const active = { cancelRequested: false };
  assert.equal((await context.liveTool("read_messages", {}, active)).isError, false);
  return { store, context, active, posts, ha, request: { request_message_id: message.messageId },
    async readDevices() { assert.equal((await context.liveTool("read_home_devices", { request_message_id: message.messageId }, active)).isError, false); },
    blockNextDeviceRead() { const gate = { started: deferred(), release: deferred() }; nextReadGate = gate; return gate; } };
}

test("group permission uses direct current members only; disabled and private group permission fail closed", () => {
  const original = { groupId, messageId: "101", senderId: OWNER_QQ_ID, trust: "OWNER", source: "qq", sequence: 1, text: "打开台灯", receivedAt: new Date().toISOString() };
  let permission = "owner", message = original, recalled = false, pending = [original];
  const args = { store: { snapshot: () => ({ pendingMessages: pending, codexConfig: { homeAssistantPermission: permission } }), isRecalled: () => recalled },
    messageReader: { messages: new Map() }, targetId: groupId, targetType: "group", ownerId: OWNER_QQ_ID, messageId: "101" };
  const check = (patch = {}, expected = true) => {
    args.messageReader.messages.set("101", message);
    if (expected) assert.equal(homeAssistantRequest({ ...args, ...patch }), message);
    else assert.throws(() => homeAssistantRequest({ ...args, ...patch }));
  };
  check();
  message = { ...original, senderId: memberId, trust: "UNTRUSTED" }; check({}, false);
  permission = "group"; check();
  for (const source of ["codex-ui", "forward", "subscription"]) { message = { ...message, source }; check({}, false); }
  message = { ...original, senderId: memberId, trust: "UNTRUSTED" };
  check({ targetType: "private" }, false); check({ scheduledTask: true }, false);
  recalled = true; check({}, false); recalled = false;
  pending = []; check({}, false); pending = [original];
  message = { ...message, receivedAt: new Date(Date.now() - 16 * 60_000).toISOString() }; check({}, false);
  message = original;
  for (const mode of ["disabled", "invalid"]) { permission = mode; check({}, false); }
});

test("the ordinary follow-up that was rejected by message 2048865280 can now read devices", async (t) => {
  const f = await fixture(t, { text: "老代你现在能用了吗", messageId: "2048865280", senderId: OWNER_QQ_ID });
  const result = await f.context.liveTool("read_home_devices", f.request, f.active);
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0].text).devices.map((item) => item.entity_id), [light.entity_id, speaker.entity_id]);
  assert.equal(f.posts.length, 0);
});

test("group members can act on contextual instructions and perform a lamp show", async (t) => {
  for (const text of ["来个灯光秀", "就按刚才的方案"]) await t.test(text, async (child) => {
    const f = await fixture(child, { text }); await f.readDevices();
    const result = await f.context.liveTool("control_home_device", { ...f.request, entity_id: light.entity_id, service: "turn_on", data: { brightness_pct: 60 } }, f.active);
    assert.equal(result.isError, false);
    assert.deepEqual(f.posts, [{ brightness_pct: 60, entity_id: light.entity_id }]);
  });
});

test("parallel identical live controls produce exactly one mock physical effect", async (t) => {
  const f = await fixture(t); await f.readDevices();
  const args = { ...f.request, entity_id: light.entity_id, service: "turn_on" };
  const results = await Promise.all([f.context.liveTool("control_home_device", args, f.active), f.context.liveTool("control_home_device", args, f.active)]);
  assert.equal(results.filter((result) => !result.isError).length, 1);
  assert.equal(f.posts.length, 1);
  assert.equal(f.store.snapshot(groupId).homeAssistantAttempts.length, 1);
});

test("cancellation and permission revocation during a device read prevent the physical effect", async (t) => {
  for (const stop of ["cancel", "disable"]) await t.test(stop, async (child) => {
    const f = await fixture(child); await f.readDevices();
    const gate = f.blockNextDeviceRead();
    const running = f.context.liveTool("control_home_device", { ...f.request, entity_id: light.entity_id, service: "turn_on" }, f.active);
    await gate.started.promise;
    if (stop === "cancel") f.active.cancelRequested = true;
    else await f.store.setCodexConfig(groupId, { homeAssistantPermission: "disabled" });
    gate.release.resolve();
    assert.equal((await running).isError, true);
    assert.equal(f.posts.length, 0);
  });
});

test("ending or failing the model turn during a device read prevents the physical effect", async (t) => {
  for (const stop of ["end", "fail"]) await t.test(stop, async (child) => {
    const f = await fixture(child); await f.readDevices();
    const gate = f.blockNextDeviceRead();
    const running = f.context.liveTool("control_home_device", { ...f.request, entity_id: light.entity_id, service: "turn_on" }, f.active);
    await gate.started.promise;
    if (stop === "end") assert.equal((await f.context.liveTool("end_conversation", {}, f.active)).isError, false);
    else f.context.failed = true;
    gate.release.resolve();
    assert.equal((await running).isError, true);
    assert.equal(f.posts.length, 0);
  });
});

test("speaker negations never play text, while literal speech content can include a warning", async (t) => {
  for (const text of ["小爱不用播报这条消息", "小爱不要读这段话", "别让小爱说话"]) await t.test(text, async (child) => {
    const f = await fixture(child, { text }); await f.readDevices();
    assert.equal((await f.context.liveTool("speak_home_speaker", { ...f.request, entity_id: speaker.entity_id, text: "晚上好" }, f.active)).isError, true);
    assert.equal(f.posts.length, 0);
  });
  const f = await fixture(t, { text: "小爱说：不要迟到" }); await f.readDevices();
  assert.equal((await f.context.liveTool("speak_home_speaker", { ...f.request, entity_id: speaker.entity_id, text: "不要迟到" }, f.active)).isError, false);
  assert.deepEqual(f.posts, [{ entity_id: speaker.entity_id, message: "不要迟到" }]);
});

test("equivalent trimmed speaker payloads cannot bypass duplicate protection", async (t) => {
  const f = await fixture(t, { text: "小爱说晚上好" }); await f.readDevices();
  const args = { ...f.request, entity_id: speaker.entity_id, text: "晚上好" };
  assert.equal((await f.context.liveTool("speak_home_speaker", args, f.active)).isError, false);
  assert.equal((await f.context.liveTool("speak_home_speaker", { ...args, text: " 晚上好 " }, f.active)).isError, true);
  assert.equal(f.posts.length, 1);
});

test("speaker actions accept contextual references without requiring fixed speech verbs", async (t) => {
  for (const text of ["小爱说两句", "就按刚才那句话"]) await t.test(text, async (child) => {
    const f = await fixture(child, { text }); await f.readDevices();
    const result = await f.context.liveTool("speak_home_speaker", { ...f.request, entity_id: speaker.entity_id, text: "晚上好" }, f.active);
    assert.equal(result.isError, false);
    assert.deepEqual(f.posts, [{ entity_id: speaker.entity_id, message: "晚上好" }]);
  });
});

test("speaker requests cannot bypass owner-only permissions through the group live path", async (t) => {
  const f = await fixture(t, { permission: "owner", text: "小爱说晚上好" });
  assert.equal((await f.context.liveTool("read_home_devices", f.request, f.active)).isError, true);
  assert.equal((await f.context.liveTool("speak_home_speaker", { ...f.request, entity_id: speaker.entity_id, text: "晚上好" }, f.active)).isError, true);
  assert.equal(f.posts.length, 0);
});

test("HA tool errors distinguish panel permissions, invalid requests and network failures", async (t) => {
  const denied = await fixture(t, { permission: "disabled", text: "老代你现在能用了吗" });
  const deniedResult = await denied.context.liveTool("read_home_devices", denied.request, denied.active);
  assert.equal(deniedResult.isError, true);
  const permission = JSON.parse(deniedResult.content[0].text);
  assert.equal(permission.error.code, "HOME_ASSISTANT_PERMISSION_DENIED");
  assert.equal(permission.error.category, "permission");
  assert.equal(denied.posts.length, 0);

  const invalid = await fixture(t); await invalid.readDevices();
  const invalidResult = await invalid.context.liveTool("control_home_device", { ...invalid.request, entity_id: light.entity_id, service: "turn_on", data: { rgb_color: [255, 0, 0] } }, invalid.active);
  assert.equal(invalidResult.isError, true);
  const request = JSON.parse(invalidResult.content[0].text);
  assert.equal(request.error.code, "HOME_ASSISTANT_DENIED");
  assert.equal(request.error.category, "request");
  assert.equal(invalid.posts.length, 0);

  const offline = await fixture(t, { text: "老代你现在能用了吗" });
  offline.ha.fetch = async () => { throw new Error("offline-test-token should not be echoed"); };
  const offlineResult = await offline.context.liveTool("read_home_devices", offline.request, offline.active);
  assert.equal(offlineResult.isError, true);
  const network = JSON.parse(offlineResult.content[0].text);
  assert.equal(network.error.code, "HOME_ASSISTANT_OFFLINE");
  assert.equal(network.error.category, "network");
  assert.equal(offlineResult.content[0].text.includes("offline-test-token"), false);
  assert.equal(offline.posts.length, 0);
});

test("a lost physical-action response is categorized uncertain and keeps its durable claim", async (t) => {
  const f = await fixture(t); await f.readDevices();
  const original = f.ha.fetch;
  let attempted = 0;
  f.ha.fetch = async (url, options) => {
    if (options.method === "POST") { attempted++; throw new Error("connection lost"); }
    return original(url, options);
  };
  const result = await f.context.liveTool("control_home_device", { ...f.request, entity_id: light.entity_id, service: "turn_on" }, f.active);
  assert.equal(result.isError, true);
  const error = JSON.parse(result.content[0].text).error;
  assert.equal(error.code, "HOME_ASSISTANT_UNCERTAIN");
  assert.equal(error.category, "uncertain");
  assert.equal(attempted, 1);
  assert.equal(f.store.snapshot(groupId).homeAssistantAttempts.length, 1);
});
