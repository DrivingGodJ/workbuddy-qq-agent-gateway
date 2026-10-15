// Manual, explicitly requested slow-light/speech demo. Never run on a schedule.
// Credentials stay in this process; snapshots contain device settings only.
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { HomeAssistantClient } from "../src/automation/home-assistant.js";

const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const split = arg.indexOf("=");
  if (!arg.startsWith("--") || split < 0) throw new Error("Use --name=value arguments.");
  return [arg.slice(2, split), arg.slice(split + 1)];
}));
const lightIds = (options.lights || "").split(",").filter(Boolean);
if (!options.url || !options.snapshot || !options.speaker || !options.player
  || !lightIds.length || lightIds.length > 3 || lightIds.some((id) => !/^light\.[a-z0-9_]+$/u.test(id))
  || !/^media_player\.[a-z0-9_]+$/u.test(options.player)) throw new Error("Specify URL, snapshot, 1–3 lights, speaker and player.");
let token;
try { token = execFileSync("/usr/bin/security", ["find-generic-password", "-s", "Codex Remote Contact QQ", "-a", "home-assistant-api-token", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
catch { throw new Error("Home Assistant Keychain credential unavailable."); }
const ha = new HomeAssistantClient({ enabled: true, baseUrl: options.url, token, allowedSpeakers: [options.speaker] });
token = undefined;
const get = (id) => ha.request(`/api/states/${encodeURIComponent(id)}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lightStates = await Promise.all(lightIds.map(get));
const player = await get(options.player);
for (const state of lightStates) {
  if (!["on", "off"].includes(state.state) || !state.attributes?.supported_color_modes?.includes("color_temp")
    || !Number.isFinite(state.attributes.brightness) || !Number.isFinite(state.attributes.color_temp_kelvin)
    || !Number.isFinite(state.attributes.min_color_temp_kelvin) || !Number.isFinite(state.attributes.max_color_temp_kelvin)) throw new Error("Demo requires available lights with restorable brightness and color temperature.");
}
if (typeof player.attributes?.is_volume_muted !== "boolean" || !Number.isFinite(player.attributes?.volume_level)) throw new Error("Cannot safely restore speaker mute/volume settings.");
const services = await ha.loadServices();
if (!services.some((entry) => entry.domain === "media_player" && entry.services?.volume_mute && entry.services?.volume_set)) throw new Error("Speaker mute/volume services unavailable.");
await ha.read({ entity_id: options.speaker });
const original = { lights: lightStates.map(({ entity_id, state, attributes: a }) => ({ entity_id, state, brightness: a.brightness,
  color_temp_kelvin: a.color_temp_kelvin, effect: a.effect || null })),
  speaker: { entity_id: options.player, volume_level: player.attributes.volume_level, is_volume_muted: player.attributes.is_volume_muted }, at: new Date().toISOString() };
await writeFile(options.snapshot, JSON.stringify(original, null, 2), { mode: 0o600, flag: "wx" });
const restoreErrors = [];
let lightsRestored = false, failure = null, speechAccepted = 0;
const restoreLights = async () => {
  for (const before of original.lights) {
    try {
      await ha.request("/api/services/light/turn_on", { method: "POST", body: { entity_id: before.entity_id, brightness: before.brightness,
        color_temp_kelvin: before.color_temp_kelvin, ...(before.effect ? { effect: before.effect } : {}) } });
      if (before.state === "off") await ha.request("/api/services/light/turn_off", { method: "POST", body: { entity_id: before.entity_id } });
    } catch (error) { restoreErrors.push({ entity_id: before.entity_id, message: error.message }); }
  }
  lightsRestored = true; // Never blindly repeat a restoration whose POST result is uncertain.
};
const say = async (text) => { await ha.speak({ entity_id: options.speaker, text }); speechAccepted++; };
try {
  if (original.speaker.is_volume_muted) await ha.request("/api/services/media_player/volume_mute", { method: "POST", body: { entity_id: options.player, is_volume_muted: false } });
  if (original.speaker.volume_level > 0.5) await ha.request("/api/services/media_player/volume_set", { method: "POST", body: { entity_id: options.player, volume_level: 0.3 } });
  await say("我是老代。宿舍灯光秀现在开始。别眨眼。");
  // At least three seconds between changes; no fast flashing or RGB assumptions.
  const stages = [{ brightness: 40, cool: 0 }, { brightness: 75, cool: 0.7 }, { brightness: 35, cool: 0.2 }, { brightness: 85, cool: 0.9 }];
  for (const [index, stage] of stages.entries()) {
    for (const state of lightStates) {
      const a = state.attributes;
      const kelvin = Math.round(a.min_color_temp_kelvin + (a.max_color_temp_kelvin - a.min_color_temp_kelvin) * stage.cool);
      await ha.control({ entity_id: state.entity_id, service: "turn_on", data: { brightness_pct: stage.brightness, color_temp_kelvin: kelvin } },
        { ownerText: "请把宿舍灯打开，调整亮度和色温进行灯光秀" });
    }
    if (index === 1) await say("这波氛围感还行。宿舍不是夜店。咱们悠着点。");
    await sleep(3000);
  }
  await restoreLights();
  if (restoreErrors.length) throw new Error("Light restoration needs attention; stop speech/show and inspect saved snapshot.");
  await say("表演结束。灯光恢复原样。这么好。准备收工。");
  await sleep(4500);
} catch (error) { failure = error.message; }
finally {
  if (!lightsRestored) await restoreLights();
  try {
    if (original.speaker.volume_level > 0.5) await ha.request("/api/services/media_player/volume_set", { method: "POST", body: { entity_id: options.player, volume_level: original.speaker.volume_level } });
    if (original.speaker.is_volume_muted) await ha.request("/api/services/media_player/volume_mute", { method: "POST", body: { entity_id: options.player, is_volume_muted: true } });
  } catch (error) { restoreErrors.push({ entity_id: options.player, message: error.message }); }
}
await sleep(1200);
const afterLights = await Promise.all(lightIds.map(get));
const afterPlayer = await get(options.player);
const verified = original.lights.map((before, index) => {
  const after = afterLights[index];
  return { entity_id: before.entity_id, restored: after.state === before.state
    && Math.abs(after.attributes.brightness - before.brightness) <= 1
    && Math.abs(after.attributes.color_temp_kelvin - before.color_temp_kelvin) <= 80 };
});
const speakerRestored = afterPlayer.attributes.is_volume_muted === original.speaker.is_volume_muted
  && Math.abs(afterPlayer.attributes.volume_level - original.speaker.volume_level) < 0.01;
console.log(JSON.stringify({ completed: !failure, failure, speechAccepted, lights: verified, speakerRestored, restoreErrors,
  note: "HA 状态已独立回读；无法从接口确认是否实际听到声音。" }, null, 2));
if (failure || restoreErrors.length || verified.some((entry) => !entry.restored) || !speakerRestored) process.exitCode = 1;
