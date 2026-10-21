import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpeakerGreetingCoordinator } from "../src/qq/speaker-greeting-coordinator.js";
import { HomeAssistantClient } from "../src/automation/home-assistant.js";

const SPEAKER = "notify.xiaomi_test_speaker_play_text_a_5_3";
const speakerArgs = (context, text = "早上好 今天也慢慢来") => ({ request_message_id: context.greetingJobId, entity_id: SPEAKER, text });
async function greeting(_prompt, { qqToolContext: context }) {
  assert.equal(context.requireRead, false);
  assert.equal((await context.liveTool("read_home_devices", speakerArgs(context))).isError, false);
  assert.equal((await context.liveTool("speak_home_speaker", speakerArgs(context))).isError, false);
  assert.equal((await context.liveTool("end_conversation", {})).isError, false);
  return { text: "最终文字不要播报" };
}

async function fixture(t, { configs = [{ morning: true, noon: false, night: false }], model = greeting, held = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "crc-speaker-greeting-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "speaker-greetings.json");
  let now = new Date("2026-10-13T23:00:00Z"), enabled = true;
  const calls = { model: [], speech: [], reads: [], releases: [] };
  const homeAssistant = { enabled: true, allowedSpeakers: new Set([SPEAKER]),
    read: async (args) => { calls.reads.push(args); return { devices: [{ entity_id: SPEAKER, state: "unknown" }] }; },
    speak: async (args, { beforeSend }) => {
      await beforeSend();
      const ledger = JSON.parse(await readFile(filePath, "utf8"));
      assert.equal(Object.values(ledger.jobs).some((job) => job.attempted && job.stage === "speaking"), true);
      calls.speech.push(args);
      return { accepted: true, confirmation: "HA 已接受，声音未经核实" };
    } };
  const targets = configs.map((config, index) => {
    const state = { replyEnabled: true, codexConfig: { homeAssistantPermission: "owner", speakerGreetings: config }, pendingMessages: [{ text: "未处理消息" }] };
    return { type: index % 2 ? "private" : "group", id: String(10000 + index), store: { snapshot: () => state },
      state, worker: { runQzoneSequence: async (id, callback) => {
        if (held) await new Promise((resolve) => calls.releases.push(resolve));
        return callback(async (prompt, options) => { calls.model.push({ id, prompt, options }); return model(prompt, options); });
      } } };
  });
  const options = { filePath, homeAssistant, listTargets: () => targets, canRun: () => enabled, clock: () => now };
  const coordinator = await new SpeakerGreetingCoordinator(options).init();
  return { coordinator, options, homeAssistant, targets, calls, filePath,
    clock: (value) => { now = new Date(value); }, global: (value) => { enabled = value; } };
}

test("fixed Shanghai slots default off and each target/slot is independently enabled", async (t) => {
  const off = await fixture(t, { configs: [{}] });
  for (const at of ["2026-10-13T23:00:00Z", "2026-10-14T05:00:00Z", "2026-10-14T15:30:00Z"]) {
    off.clock(at); await off.coordinator.tick();
  }
  await off.coordinator.drain();
  assert.equal(off.calls.model.length, 0);
  const f = await fixture(t, { configs: [{ morning: true, night: true }, { noon: true }] });
  await f.coordinator.tick(); await f.coordinator.drain();
  f.clock("2026-10-14T05:00:00Z"); await f.coordinator.tick(); await f.coordinator.drain();
  f.clock("2026-10-14T15:30:00Z"); await f.coordinator.tick(); await f.coordinator.drain();
  assert.deepEqual(f.calls.model.map((call) => [call.id, call.options.qqToolContext.greetingJobId.split(":").at(-1)]), [["10000", "morning"], ["10001", "noon"], ["10000", "night"]]);
  assert.equal(f.calls.model.every((call) => call.options.trigger === "speaker-greeting" && !call.prompt.includes("未处理消息")), true);
  for (const { prompt } of f.calls.model) {
    assert.match(prompt, /mcp__qq_gateway__read_home_devices/);
    assert.match(prompt, /mcp__qq_gateway__speak_home_speaker/);
    assert.match(prompt, /只在小爱播报一次/);
    assert.match(prompt, /不向 QQ 发送.*不读取聊天/);
    assert.doesNotMatch(prompt, /ToolSearch|DeferExecuteTool/);
  }
  assert.equal(f.targets.every((target) => target.state.pendingMessages.length === 1), true);
});

test("same day slot is claimed once across repeated ticks and restart; a new day is separate", async (t) => {
  const f = await fixture(t);
  await Promise.all([f.coordinator.tick(), f.coordinator.tick(), f.coordinator.tick()]);
  await f.coordinator.drain();
  const restarted = await new SpeakerGreetingCoordinator(f.options).init();
  await restarted.tick(); await restarted.drain();
  assert.equal(f.calls.speech.length, 1);
  f.clock("2026-10-14T23:00:00Z");
  await restarted.tick(); await restarted.drain();
  assert.equal(f.calls.speech.length, 2);
});

test("tick reserves different targets without blocking on the first and queued jobs recover before speech", async (t) => {
  const f = await fixture(t, { configs: [{ morning: true }, { morning: true }], held: true });
  await f.coordinator.tick();
  assert.equal(f.calls.releases.length, 2);
  assert.equal(f.coordinator.activityFor("group", "10000").stage, "queued");
  assert.equal(f.coordinator.activityFor("private", "10001").stage, "queued");
  // Simulate the old process disappearing before either queued callback began.
  for (const target of f.targets) target.worker.runQzoneSequence = async (id, callback) => callback(async (prompt, options) => { f.calls.model.push({ id, prompt, options }); return greeting(prompt, options); });
  const restarted = await new SpeakerGreetingCoordinator(f.options).init();
  f.clock("2026-10-13T23:03:00Z");
  await restarted.tick(); await restarted.drain();
  assert.equal(f.calls.speech.length, 2);
  assert.equal(restarted.activityFor("group", "10000").stage, "completed");
});

test("global off skips activation; cancel and permission/switch changes stop queued jobs before generation", async (t) => {
  const off = await fixture(t);
  off.global(false); await off.coordinator.tick(); await off.coordinator.drain();
  assert.equal(Object.keys(off.coordinator.jobs).length, 0);
  for (const mode of ["cancel", "global", "slot", "permission", "reply"]) {
    const f = await fixture(t, { held: true });
    await f.coordinator.tick();
    if (mode === "cancel") {
      assert.equal(await f.coordinator.cancel("group", "10000"), 1);
      assert.equal(f.coordinator.running.size, 1, "cancel keeps its older FIFO reservation until that reservation is released");
      assert.equal(f.calls.model.length, 0);
    }
    if (mode === "global") f.global(false);
    if (mode === "slot") f.targets[0].state.codexConfig.speakerGreetings.morning = false;
    if (mode === "permission") f.targets[0].state.codexConfig.homeAssistantPermission = "disabled";
    if (mode === "reply") f.targets[0].state.replyEnabled = false;
    f.calls.releases[0](); await f.coordinator.drain();
    assert.equal(f.calls.model.length, 0, mode);
    assert.equal(f.calls.speech.length, 0, mode);
    assert.equal(f.coordinator.activityFor("group", "10000").stage, "cancelled", mode);
  }
});

test("a switch changing after read is checked again before speech and no final text is implicitly spoken", async (t) => {
  let f;
  f = await fixture(t, { model: async (_prompt, { qqToolContext: context }) => {
    await context.liveTool("read_home_devices", speakerArgs(context));
    f.global(false);
    assert.equal((await context.liveTool("speak_home_speaker", speakerArgs(context))).isError, true);
    return { text: "不应播报" };
  } });
  await f.coordinator.tick(); await f.coordinator.drain();
  assert.equal(f.calls.speech.length, 0);
  assert.equal(f.coordinator.activityFor("group", "10000").stage, "cancelled");
  const textOnly = await fixture(t, { model: async () => ({ text: "只有最终回复不能成为语音" }) });
  await textOnly.coordinator.tick(); await textOnly.coordinator.drain();
  assert.equal(textOnly.calls.speech.length, 0);
  assert.equal(textOnly.coordinator.activityFor("group", "10000").stage, "failed");
});

test("scheduled tool scope rejects QQ/control/other speakers and cannot authorize ordinary home control", async (t) => {
  for (const tool of ["read_messages", "send_message", "control_home_device", "post_qzone"]) {
    const f = await fixture(t, { model: async (_prompt, { qqToolContext: context }) => {
      assert.equal((await context.liveTool(tool, { text: "hello" })).isError, true);
      assert.equal((await context.liveTool("read_home_devices", speakerArgs(context))).isError, true);
      return { text: "no implicit delivery" };
    } });
    await f.coordinator.tick(); await f.coordinator.drain();
    assert.equal(f.calls.speech.length, 0);
  }
  const target = await fixture(t, { model: async (_prompt, { qqToolContext: context }) => {
    assert.equal((await context.liveTool("read_home_devices", { ...speakerArgs(context), entity_id: "notify.xiaomi_cn_other_play_text_a_5_3" })).isError, true);
    return {};
  } });
  await target.coordinator.tick(); await target.coordinator.drain();
  assert.equal(target.calls.reads.length, 0);
});

test("speech attempt is durable before transmission, failures are uncertain and never repeated after restart", async (t) => {
  const f = await fixture(t, { model: async (_prompt, { qqToolContext: context }) => {
    await context.liveTool("read_home_devices", speakerArgs(context));
    assert.equal((await context.liveTool("speak_home_speaker", speakerArgs(context))).isError, true);
    assert.equal((await context.liveTool("speak_home_speaker", speakerArgs(context))).isError, true);
    return {};
  } });
  f.homeAssistant.speak = async (_args, { beforeSend }) => {
    await beforeSend();
    const ledger = JSON.parse(await readFile(f.filePath, "utf8"));
    assert.equal(Object.values(ledger.jobs)[0].attempted, true);
    f.calls.speech.push("uncertain attempt");
    throw new Error("Home Assistant response lost; execution unknown");
  };
  await f.coordinator.tick(); await f.coordinator.drain();
  assert.equal(f.calls.speech.length, 1);
  assert.equal(f.coordinator.activityFor("group", "10000").stage, "uncertain");
  const ledger = JSON.parse(await readFile(f.filePath, "utf8"));
  Object.values(ledger.jobs)[0].stage = "speaking";
  await writeFile(f.filePath, JSON.stringify(ledger));
  const restarted = await new SpeakerGreetingCoordinator(f.options).init();
  await restarted.tick(); await restarted.drain();
  assert.equal(f.calls.speech.length, 1);
  assert.equal(restarted.activityFor("group", "10000").stage, "uncertain");
});

test("old terminal receipts are bounded without discarding current or queued jobs", async (t) => {
  const f = await fixture(t, { held: true });
  const jobs = {};
  for (let index = 0; index < 610; index++) {
    const id = `group:${20000 + index}:2026-10-13:morning`;
    jobs[id] = { id, type: "group", targetId: String(20000 + index), date: "2026-10-13", slot: "morning", time: "07:00", scheduledAt: "2026-10-12T23:00:00Z", stage: "completed", attempted: true, text: "old", error: null };
  }
  const id = "group:10000:2026-10-14:morning";
  jobs[id] = { id, type: "group", targetId: "10000", date: "2026-10-14", slot: "morning", time: "07:00", scheduledAt: "2026-10-13T23:00:00Z", stage: "queued", attempted: false, text: "", error: null };
  await writeFile(f.filePath, JSON.stringify({ version: 1, jobs }));
  const restarted = await new SpeakerGreetingCoordinator(f.options).init();
  assert.equal(Object.keys(restarted.jobs).length, 601);
  assert.equal(restarted.jobs[id].stage, "queued");
});

test("real HomeAssistantClient read shape works and presentation callback errors cannot suppress speech", async (t) => {
  const f = await fixture(t);
  let posts = 0;
  f.coordinator.homeAssistant = new HomeAssistantClient({ baseUrl: "http://test.invalid", token: "fake-token", enabled: true, allowedSpeakers: [SPEAKER],
    fetchImpl: async (url, options) => {
      if (options.method === "POST") { posts++; return new Response("[]"); }
      if (url.endsWith("/api/services")) return new Response(JSON.stringify([{ domain: "notify", services: { send_message: {} } }]));
      return new Response(JSON.stringify({ entity_id: SPEAKER, state: "unknown", attributes: { friendly_name: "小爱播放文本" } }));
    } });
  f.coordinator.onActivityChange = () => { throw new Error("panel disconnected"); };
  f.coordinator.onEvent = () => Promise.reject(new Error("event listener disconnected"));
  await f.coordinator.tick(); await f.coordinator.drain();
  assert.equal(posts, 1);
  assert.equal(f.coordinator.activityFor("group", "10000").stage, "completed");
  await f.coordinator.tick(); await f.coordinator.drain();
  assert.equal(posts, 1);
});
