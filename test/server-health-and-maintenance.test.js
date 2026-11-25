import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { WorkBuddyClient } from "../src/workbuddy/client.js";
import { HomeAssistantClient } from "../src/automation/home-assistant.js";
import { OneBotClient } from "../src/qq/onebot-client.js";

test("QQ login status follows OneBot across sign-in and sign-out", async () => {
  let login = {};
  let online = false;
  const client = new OneBotClient({
    fetchImpl: async (url, { method, signal }) => {
      assert.equal(method, "GET");
      assert.ok(signal instanceof AbortSignal);
      return Response.json({ status: "ok", data: url.endsWith("/get_login_info") ? login : { online } });
    }
  });

  assert.equal((await client.loginStatus()).ok, false);
  login = { user_id: "123456", nickname: "测试账号" };
  online = true;
  assert.deepEqual((await client.loginStatus()).login, { user_id: 123456, nickname: "测试账号" });
  online = false;
  assert.equal((await client.loginStatus()).ok, false);
});

test("HA readiness distinguishes rejected credentials, connected HA and an available speaker", async () => {
  const speaker = "notify.xiaomi_test_play_text_a_1_1";
  let tokenAccepted = false;
  let speakerState = "unavailable";
  const client = new HomeAssistantClient({
    enabled: true, baseUrl: "http://ha.test", token: "test", greetingSpeaker: speaker,
    fetchImpl: async (url, request) => {
      assert.equal(request.method, "GET");
      if (!tokenAccepted) return new Response("", { status: 401 });
      const value = url.endsWith("/api/services")
        ? [{ domain: "notify", services: { send_message: {} } }]
        : { entity_id: speaker, state: speakerState };
      return Response.json(value);
    }
  });
  assert.equal((await client.readiness()).ready, false);
  tokenAccepted = true;
  assert.deepEqual(await client.readiness(), {
    ready: true, speakerReady: false, reason: "当前配置的小爱播报设备不可用。"
  });
  speakerState = "unknown";
  assert.deepEqual(await client.readiness(), { ready: true, speakerReady: true, reason: null });
  tokenAccepted = false;
  assert.equal((await client.readiness()).ready, false);
});

test("HA discovers newly added buttons and speakers without individual configuration", async () => {
  const button = "button.ir_ac_turn_on_1";
  const speaker = "notify.xiaomi_test_play_text_a_1_1";
  const offline = { entity_id: "notify.xiaomi_a_play_text_a_1_1", state: "unavailable" };
  const other = { entity_id: "notify.xiaomi_test_execute_text_a_1_1", state: "unknown" };
  const states = [{ entity_id: button, state: "unknown" }, { entity_id: speaker, state: "unknown" }, offline, other];
  const sent = [];
  const client = new HomeAssistantClient({
    enabled: true, baseUrl: "http://ha.test", token: "test",
    fetchImpl: async (url, { method, body }) => {
      const path = new URL(url).pathname;
      if (method === "POST") {
        sent.push({ path, body: JSON.parse(body) });
        return Response.json([]);
      }
      if (path === "/api/services") return Response.json([
        { domain: "button", services: { press: {} } },
        { domain: "notify", services: { send_message: {} } }
      ]);
      if (path === "/api/states") return Response.json(states);
      return Response.json(states.find((state) => path === `/api/states/${state.entity_id}`) ?? {});
    }
  });

  assert.equal(await client.resolveGreetingSpeaker(), speaker);
  const { devices } = await client.read();
  assert.deepEqual(devices.find((device) => device.entity_id === button)?.services, ["press"]);
  assert.equal(devices.some((device) => device.entity_id === other.entity_id), false);
  await client.control({ entity_id: button, service: "press" }, { ownerText: "打开空调" });
  await client.speak({ entity_id: speaker, text: "早上好" });
  assert.deepEqual(sent, [
    { path: "/api/services/button/press", body: { entity_id: button } },
    { path: "/api/services/notify/send_message", body: { entity_id: speaker, message: "早上好" } }
  ]);
});

test("WorkBuddyClient whitelists WB_AGENT_SESSION_MAP_PATH and tracks engineStatus", () => {
  const client = new WorkBuddyClient({
    cwd: "/tmp",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/tmp",
      WB_AGENT_SESSION_MAP_PATH: "/tmp/custom-session-map.json",
      ELECTRON_RUN_AS_NODE: "1",
      CLIENT_INFO_IDE_TYPE: "should-be-dropped"
    }
  });
  const env = client.childEnv();
  assert.equal(env.WB_AGENT_SESSION_MAP_PATH, "/tmp/custom-session-map.json");
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.CLIENT_INFO_IDE_TYPE, undefined);

  const initial = client.engineStatus();
  assert.equal(initial.engine, "workbuddy");
  assert.equal(initial.engineReady, false);
});

test("bridge.py supports WB_AGENT_SESSION_MAP_PATH override and engine/status method", async () => {
  const pySource = await readFile(new URL("../modules/workbuddy-agent/bridge.py", import.meta.url), "utf8");
  assert.match(pySource, /os\.environ\.get\("WB_AGENT_SESSION_MAP_PATH"\)/u);
  assert.match(pySource, /"engine\/status":\s*self\.engine_status/u);
});

test("server.js exposes unauthenticated /api/health and persona import/export endpoints", async () => {
  const serverSource = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(serverSource, /url\.pathname === "\/api\/health"/u);
  assert.match(serverSource, /url\.pathname === "\/api\/qq\/persona\/export"/u);
  assert.match(serverSource, /url\.pathname === "\/api\/qq\/persona\/import"/u);
  assert.match(serverSource, /url\.pathname === "\/api\/qq\/persona\/reset-imported"/u);
  assert.match(serverSource, /WORKBUDDY_QQ_WORKSPACE_DIR/u);
});
