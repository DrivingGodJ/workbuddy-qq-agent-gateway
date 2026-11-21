import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SpeakerGreetingCoordinator } from "../src/qq/speaker-greeting-coordinator.js";
import { normalizeSpeakerGreetings } from "../src/qq/speaker-greeting-settings.js";
import { speakerWeatherText } from "../src/qq/speaker-greeting-weather.js";

test("weekly plans select each occurrence and retain legacy receipts without repeating playback", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "speaker-plan-test-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const filePath = join(dir, "jobs.json");
  const clock = () => new Date("2026-11-22T23:00:15Z"); // Monday 07:00 in Shanghai.
  const legacyId = "group:10001:2026-11-23:morning";
  await writeFile(filePath, JSON.stringify({ version: 1, jobs: { [legacyId]: {
    id: legacyId, slot: "morning", type: "group", targetId: "10001", time: "07:00",
    date: "2026-11-23", scheduledAt: clock().toISOString(), stage: "completed", attempted: true
  } } }));
  const migrated = normalizeSpeakerGreetings({ morning: true, noon: false, night: false });
  assert.deepEqual(migrated[0], { id: "morning", time: "07:00", days: [0, 1, 2, 3, 4, 5, 6], enabled: true, weather: false });
  const custom = { id: "test-plan", time: "07:00", days: [1], enabled: true, weather: true };
  const plans = [...migrated, custom, { ...custom, id: "plain", weather: false },
    { ...custom, id: "tuesday", days: [2] }, { ...custom, id: "disabled", enabled: false }];
  const snapshot = { codexConfig: { homeAssistantPermission: "owner", speakerGreetings: plans } };
  const spoken = [];
  let weatherRequests = 0;
  const options = { filePath, clock, weatherLocation: { name: "示例市" },
    weatherText: async (location, date) => {
      weatherRequests++;
      assert.equal(location.name, "示例市");
      assert.equal(date, "2026-11-23");
      return "示例市有雨。出门带伞。";
    },
    homeAssistant: {
      enabled: true, allowedSpeakers: new Set(["notify.test"]),
      async read() { return { devices: [{ entity_id: "notify.test" }] }; },
      async speak({ text }, { beforeSend }) {
        await beforeSend();
        spoken.push(text);
        return { accepted: true };
      }
    },
    listTargets: () => [{ type: "group", id: "10001", store: { snapshot: () => snapshot }, worker: {
      async runQzoneSequence(_id, run) {
        await run(async (_prompt, { qqToolContext: context }) => {
          const args = { request_message_id: context.greetingJobId, entity_id: "notify.test", text: "早上好" };
          assert.equal((await context.liveTool("read_home_devices", args)).isError, false);
          assert.equal((await context.liveTool("speak_home_speaker", args)).isError, false);
        });
      }
    } }]
  };
  const first = await new SpeakerGreetingCoordinator(options).init();
  await first.tick();
  await first.drain();
  assert.deepEqual(spoken.sort(), ["早上好", "早上好 示例市有雨。出门带伞。"]);
  assert.equal(weatherRequests, 1);
  const restarted = await new SpeakerGreetingCoordinator(options).init();
  await restarted.tick();
  await restarted.drain();
  assert.equal(spoken.length, 2);
});

test("weather uses today's forecast and provides a graceful fallback", async () => {
  const place = { name: "示例市", latitude: 31.2, longitude: 121.5 };
  const date = "2026-11-23";
  const mock = async () => ({ ok: true, json: async () => ({ daily: { time: [date],
    temperature_2m_min: [9], temperature_2m_max: [15], weather_code: [61] } }) });
  assert.match(await speakerWeatherText(place, date, mock), /示例市有雨.*9到15度.*外套.*带伞/u);
  assert.equal(await speakerWeatherText(place, "2026-11-24", mock), "今天的天气暂时查不到。");
  assert.throws(() => normalizeSpeakerGreetings([{ id: "empty", time: "07:00", days: [], enabled: true, weather: true }], { strict: true }), /星期/u);
});
