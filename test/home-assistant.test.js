import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HomeAssistantClient, ownerHomeRequest } from "../src/automation/home-assistant.js";
import { SessionStore } from "../src/storage/session-store.js";
import { createLiveConversationTools } from "../src/qq/live-conversation.js";
import { OWNER_QQ_ID } from "../src/security/policy.js";
import { WorkBuddyClient } from "../src/workbuddy/client.js";

const device = { entity_id: "light.desk", state: "on", attributes: { friendly_name: "台灯", brightness: 150, supported_color_modes: ["color_temp"], min_color_temp_kelvin: 2700, max_color_temp_kelvin: 6500 } };
function client(fetchImpl) {
  return new HomeAssistantClient({ baseUrl: "http://homeassistant.local:8123", token: "test-private-token", enabled: true, fetchImpl });
}
const response = (value) => new Response(JSON.stringify(value), { status: 200 });

test("Home Assistant reads bounded actual devices, strips unrelated private attributes and never leaks its credential", async () => {
  const ha = client(async (_url, options) => {
    assert.equal(options.headers.authorization, "Bearer test-private-token");
    assert.equal(options.redirect, "error");
    return response([device, { ...device, entity_id: "light.ceiling" }, { entity_id: "person.owner", state: "home" }]);
  });
  const read = await ha.read({ query: "台灯", limit: 1 });
  assert.equal(read.total, 2);
  assert.equal(read.devices.length, 1);
  assert.equal(read.next_offset, 1);
  assert.equal(JSON.stringify(read).includes("test-private-token"), false);
  await assert.rejects(ha.read({ domain: "person" }), /不能读取人员/);
  await assert.rejects(ha.read({ entity_id: "../config" }), /格式无效/);
});

test("controls validate ranges, service availability and one exact target before recording an attempt and sending", async () => {
  const calls = [];
  const ha = client(async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    if (url.endsWith("/api/services")) return response([{ domain: "light", services: { turn_on: {} } }]);
    return response(url.includes("/api/services/") ? [] : device);
  });
  await assert.rejects(ha.control({ entity_id: "light.desk", service: "turn_on", data: { brightness_pct: 101 } }, { ownerText: "打开台灯" }), /超出/);
  await assert.rejects(ha.control({ entity_id: "light.desk", service: "turn_on", data: { entity_id: "all" } }, { ownerText: "打开台灯" }), /未获准/);
  await assert.rejects(ha.control({ entity_id: "homeassistant.restart", service: "restart" }, { ownerText: "请开启家居设备" }), /白名单/);
  let recorded = false;
  const result = await ha.control({ entity_id: "light.desk", service: "turn_on", data: { brightness_pct: 70 } }, {
    ownerText: "请把台灯打开，亮度调到70", beforeSend: () => { recorded = true; }
  });
  assert.equal(recorded, true);
  assert.equal(result.accepted, true);
  assert.equal(result.observed.entity_id, "light.desk");
  assert.deepEqual(calls.filter((item) => item.method === "POST").map((item) => item.body), [{ brightness_pct: 70, entity_id: "light.desk" }]);
  await assert.rejects(ha.control({ entity_id: "light.desk", service: "turn_off" }, { ownerText: "不要关台灯" }), (error) => error.code === "HOME_ASSISTANT_ACTION_NOT_REQUESTED");
  await assert.rejects(ha.control({ entity_id: "light.desk", service: "turn_off" }, { ownerText: "台灯现在什么状态" }), (error) => error.code === "HOME_ASSISTANT_ACTION_NOT_REQUESTED");
  await assert.rejects(ha.control({ entity_id: "light.desk", service: "turn_on" }, { ownerText: "关闭台灯" }), (error) => error.code === "HOME_ASSISTANT_ACTION_NOT_REQUESTED");
});

test("unlisted buttons and arbitrary service data are rejected; IR press returns only accepted, not physical confirmation", async () => {
  const button = { entity_id: "button.ac_on", state: "unknown", attributes: { friendly_name: "空调开机" } };
  const ha = client(async (url) => response(url.endsWith("/api/services") ? [{ domain: "button", services: { press: {} } }] : url.includes("/api/services/") ? [] : button));
  await assert.rejects(ha.control({ entity_id: button.entity_id, service: "press" }, { ownerText: "请打开空调" }), /白名单/);
  ha.allowedButtons.add(button.entity_id);
  const result = await ha.control({ entity_id: button.entity_id, service: "press" }, { ownerText: "请打开空调" });
  assert.equal(result.accepted, true);
  assert.match(result.confirmation, /无法核实/);
});

test("an accepted command survives readback failure; a lost POST response is uncertain and is not retried", async () => {
  let posted = false;
  const ha = client(async (url, options) => {
    if (url.endsWith("/api/services")) return response([{ domain: "light", services: { turn_off: {} } }]);
    if (options.method === "POST") { posted = true; return response([]); }
    if (posted) throw new Error("network failure");
    return response(device);
  });
  const result = await ha.control({ entity_id: "light.desk", service: "turn_off" }, { ownerText: "关闭台灯" });
  assert.equal(result.accepted, true);
  assert.match(result.confirmation, /无法核实/);
  let posts = 0;
  ha.fetch = async (url, options) => {
    if (options.method === "POST") { posts++; throw new Error("test-private-token must not leak"); }
    return response(device);
  };
  await assert.rejects(ha.control({ entity_id: "light.desk", service: "turn_off" }, { ownerText: "关闭台灯" }), /状态未知/);
  assert.equal(posts, 1);
});

test("only actually read, pending, direct OWNER requests from this target authorize HA", () => {
  const owner = { messageId: "101", senderId: "100000001", groupId: "12345", sequence: 1, source: "qq", trust: "OWNER", text: "请打开台灯", receivedAt: new Date().toISOString() };
  let pending = [owner], recalled = false;
  const args = { store: { snapshot: () => ({ pendingMessages: pending }), isRecalled: () => recalled },
    messageReader: { messages: new Map([["101", owner]]) }, targetId: "12345", ownerId: "100000001", messageId: "101" };
  assert.equal(ownerHomeRequest(args), owner);
  for (const text of ["你好", "老代你现在能用了吗", "就按刚才的方案"]) {
    const ordinary = { ...owner, text };
    args.messageReader.messages.set("101", ordinary);
    assert.equal(ownerHomeRequest(args), ordinary);
  }
  for (const patch of [{ senderId: "100000009" }, { source: "forward" }, { trust: "UNTRUSTED" }, { groupId: "other" }, { receivedAt: new Date(Date.now() - 16 * 60_000).toISOString() }]) {
    args.messageReader.messages.set("101", { ...owner, ...patch });
    assert.throws(() => ownerHomeRequest(args), /家居权限/);
  }
  args.messageReader.messages.set("101", owner);
  assert.throws(() => ownerHomeRequest({ ...args, scheduledTask: true }), /家居权限/);
  recalled = true;
  assert.throws(() => ownerHomeRequest(args), /家居权限/);
  recalled = false; pending = [];
  assert.throws(() => ownerHomeRequest(args), /家居权限/);
});

test("HA credentials stay out of the WorkBuddy bridge/MCP process environment", () => {
  const wb = new WorkBuddyClient({ env: { PATH: "/usr/bin", CODEX_REMOTE_CONTACT_HA_TOKEN: "test-private-token" } });
  assert.equal(Object.hasOwn(wb.childEnv(), "CODEX_REMOTE_CONTACT_HA_TOKEN"), false);
});

test("live HA MCP requires a real OWNER message and device read; canceled and repeated attempts cannot POST", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crc-ha-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(directory, "state.json") });
  await store.init({ allowedGroups: ["12345"] });
  const owner = await store.appendMessage({ groupId: "12345", messageId: "101", senderId: OWNER_QQ_ID,
    source: "qq", trust: "OWNER", text: "请打开台灯", senderName: "OWNER" });
  await store.requestTrigger("12345", "mention", owner);
  await store.beginWork("12345");
  let posts = 0;
  const ha = client(async (url, options) => {
    if (options.method === "POST") { posts++; return response([]); }
    if (url.endsWith("/api/services")) return response([{ domain: "light", services: { turn_on: {} } }]);
    return response(url.endsWith("/api/states") ? [device] : device);
  });
  const context = createLiveConversationTools({ store, targetId: "12345", targetType: "group",
    homeAssistant: ha, trigger: { trust: "OWNER", reason: "mention" }, triggerMessages: [owner],
    security: {}, initialImageSequence: owner.sequence, renderMessages: (messages) => messages.map((m) => m.text).join("\n") });
  const active = { cancelRequested: false };
  const args = { request_message_id: "101", entity_id: "light.desk", service: "turn_on" };
  assert.equal((await context.liveTool("control_home_device", args, active)).isError, true);
  await context.liveTool("read_messages", {}, active);
  assert.equal((await context.liveTool("control_home_device", args, active)).isError, true);
  assert.equal((await context.liveTool("read_home_devices", { request_message_id: "101" }, active)).isError, false);
  const parallel = await Promise.all([context.liveTool("control_home_device", args, active), context.liveTool("control_home_device", args, active)]);
  assert.equal(parallel.filter((result) => !result.isError).length, 1);
  assert.equal(posts, 1);
  assert.equal((await context.liveTool("control_home_device", args, active)).isError, true);
  active.cancelRequested = true;
  assert.equal((await context.liveTool("control_home_device", { ...args, data: { brightness_pct: 50 } }, active)).isError, true);
  assert.equal(posts, 1);
  assert.equal(store.snapshot("12345").pendingMessages.length, 1);
  assert.equal(store.snapshot("12345").liveSession.actions[0].kind, "home_assistant_attempt");
  assert.equal(store.snapshot("12345").homeAssistantAttempts.length, 1);
});

test("group members authorize HA only in a group explicitly opened to all members", () => {
  const message = { messageId: "101", senderId: "100000009", groupId: "12345", sequence: 1, source: "qq", trust: "UNTRUSTED", text: "请打开台灯", receivedAt: new Date().toISOString() };
  let permission = "group";
  const args = { store: { snapshot: () => ({ codexConfig: { homeAssistantPermission: permission }, pendingMessages: [message] }) }, messageReader: { messages: new Map([["101", message]]) }, targetId: "12345", ownerId: "100000001", messageId: "101" };
  assert.equal(ownerHomeRequest(args), message);
  assert.throws(() => ownerHomeRequest({ ...args, targetType: "private" }), /家居权限/);
  for (permission of ["disabled", "owner", "unknown"]) assert.throws(() => ownerHomeRequest(args), /家居权限/);
});

test("actual light capabilities and query/narrative intent cannot become controls", async () => {
  let posts = 0;
  const ha = client(async (url, options) => {
    if (options.method === "POST") { posts++; return response([]); }
    return response(url.endsWith("/api/services") ? [{ domain: "light", services: { turn_on: {} } }] : device);
  });
  await assert.rejects(ha.control({ entity_id: device.entity_id, service: "turn_on", data: { rgb_color: [255, 0, 0] } }, { ownerText: "把台灯颜色调红" }), /支持的能力/);
  assert.equal((await ha.read({ entity_id: device.entity_id })).devices[0].service_data.turn_on.includes("rgb_color"), false);
  for (const ownerText of ["灯现在开着吗", "我今天开了台灯", "灯目前关了吗"]) await assert.rejects(ha.control({ entity_id: device.entity_id, service: "turn_on" }, { ownerText }), (error) => error.code === "HOME_ASSISTANT_ACTION_NOT_REQUESTED");
  assert.equal(posts, 0);
  await ha.control({ entity_id: device.entity_id, service: "turn_on" }, { ownerText: "能帮我开台灯吗" });
  assert.equal(posts, 1);
});

test("contextual instructions and lamp shows need no home noun or fixed positive verb", async () => {
  const posts = [];
  const ha = client(async (url, options) => {
    if (options.method === "POST") { posts.push(JSON.parse(options.body)); return response([]); }
    return response(url.endsWith("/api/services") ? [{ domain: "light", services: { turn_on: {}, turn_off: {} } }] : device);
  });
  for (const ownerText of ["来个灯光秀", "就按刚才的方案", "分别调整台灯亮度"]) {
    assert.equal((await ha.control({ entity_id: device.entity_id, service: "turn_on", data: { brightness_pct: 60 } }, { ownerText })).accepted, true);
  }
  assert.equal(posts.length, 3);
  for (const [service, ownerText] of [["turn_on", "关闭台灯"], ["turn_off", "打开台灯"], ["turn_on", "先别开灯"], ["turn_on", "台灯现在什么状态"], ["turn_on", ""]]) {
    await assert.rejects(ha.control({ entity_id: device.entity_id, service }, { ownerText }), (error) => error.code === "HOME_ASSISTANT_ACTION_NOT_REQUESTED");
  }
  assert.equal(posts.length, 3);
});

test("a lamp-show request cannot bypass an explicitly opposite non-light operation", async () => {
  let calls = 0;
  const ha = client(async () => { calls++; return response([]); });
  await assert.rejects(ha.control({ entity_id: "switch.socket", service: "turn_on" }, { ownerText: "关闭插座，再来个灯光秀" }),
    (error) => error.code === "HOME_ASSISTANT_ACTION_NOT_REQUESTED");
  assert.equal(calls, 0);
});
