import test from "node:test";
import assert from "node:assert/strict";
import { HomeAssistantClient } from "../src/automation/home-assistant.js";

const speaker = { entity_id: "notify.xiaomi_test_l05c_play_text_a_5_3", state: "unknown", attributes: { friendly_name: "小爱音箱 播放文本" } };
const directive = { ...speaker, entity_id: "notify.xiaomi_test_l05c_execute_text_directive_a_5_4" };
const response = (value) => new Response(JSON.stringify(value), { status: 200 });
const client = (fetchImpl, allowedSpeakers = [speaker.entity_id]) => new HomeAssistantClient({ baseUrl: "http://ha.local:8123", token: "test-private-token", enabled: true, allowedSpeakers, fetchImpl });
const speechServices = [{ domain: "notify", services: { send_message: { fields: { message: { required: true } } } } }];

test("device reads expose only allowlisted playback endpoints, as a separate speech tool", async () => {
  const ha = client(async () => response([speaker, directive, { ...speaker, entity_id: "notify.mobile_app_owner" }]));
  const result = await ha.read({ domain: "notify" });
  assert.equal(result.total, 1);
  assert.equal(result.devices[0].speaker.tool, "speak_home_speaker");
  assert.deepEqual(result.devices[0].services, []);
  assert.deepEqual(result.devices[0].service_data, {});
  await assert.rejects(ha.read({ entity_id: directive.entity_id }), /只能查询/);
  const unavailable = client(async () => response([speaker]), []);
  assert.equal((await unavailable.read({ domain: "notify" })).total, 0);
  assert.throws(() => client(async () => response([]), [directive.entity_id]), /白名单/);
  assert.equal(client(async () => response([]), ` ${speaker.entity_id} `).canSpeak(speaker.entity_id), true);
});

test("speech validates one safe target and bounded text before sending the exact notify payload", async () => {
  const calls = [];
  let recorded = false;
  const ha = client(async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    if (url.endsWith("/api/services")) return response(speechServices);
    if (options.method === "POST") { assert.equal(recorded, true); return response([]); }
    return response(speaker);
  });
  for (const patch of [{ entity_id: [speaker.entity_id] }, { entity_id: directive.entity_id }, { entity_id: "notify.notify" }, { text: " " }, { text: "a".repeat(501) }, { text: "hi\u0000" }]) {
    await assert.rejects(ha.speak({ entity_id: speaker.entity_id, text: "晚上好", ...patch }));
  }
  assert.equal(calls.length, 0);
  const result = await ha.speak({ entity_id: speaker.entity_id, text: " 晚上好 " }, { beforeSend: () => { recorded = true; } });
  assert.equal(result.accepted, true);
  assert.match(result.confirmation, /无法核实实际声音/);
  assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => call.body), [{ entity_id: speaker.entity_id, message: "晚上好" }]);
  assert.equal(JSON.stringify(result).includes("test-private-token"), false);
  await assert.rejects(ha.control({ entity_id: speaker.entity_id, service: "send_message", data: { message: "test" } }, { ownerText: "请打开小爱音箱" }), /白名单/);
});

test("unavailable endpoint, absent service and canceled receipt never send speech", async () => {
  let posts = 0;
  const make = (state, services = speechServices) => client(async (url, options) => {
    if (options.method === "POST") { posts++; return response([]); }
    return response(url.endsWith("/api/services") ? services : state);
  });
  await assert.rejects(make({ ...speaker, state: "unavailable" }).speak({ entity_id: speaker.entity_id, text: "晚上好" }), /不可用/);
  await assert.rejects(make(speaker, []).speak({ entity_id: speaker.entity_id, text: "晚上好" }), /未提供/);
  await assert.rejects(make(speaker).speak({ entity_id: speaker.entity_id, text: "晚上好" }, { beforeSend: () => { throw new Error("canceled"); } }), /canceled/);
  assert.equal(posts, 0);
});

test("lost speech response is uncertain and is never retried or described as physically confirmed", async () => {
  let posts = 0;
  const ha = client(async (url, options) => {
    if (options.method === "POST") { posts++; throw new Error("test-private-token"); }
    return response(url.endsWith("/api/services") ? speechServices : speaker);
  });
  await assert.rejects(ha.speak({ entity_id: speaker.entity_id, text: "晚上好" }), (error) => error.code === "HOME_ASSISTANT_UNCERTAIN" && !error.message.includes("test-private-token"));
  assert.equal(posts, 1);
});
