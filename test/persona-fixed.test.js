import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonaStore } from "../src/persona/persona-store.js";
import { eventMetadata } from "../src/security/event-metadata.js";

async function fixture(t, preferences = {}) {
  const root = await mkdtemp(join(tmpdir(), "qq-fixed-persona-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ownerStylePath = join(root, "preferences.json");
  await writeFile(ownerStylePath, JSON.stringify(preferences));
  const store = new PersonaStore({
    corePath: new URL("../persona/core.json", import.meta.url),
    examplesPath: new URL("../persona/examples.json", import.meta.url),
    ownerStylePath
  });
  await store.init();
  return { store, ownerStylePath };
}

test("startup keeps manual identity and catchphrases but purges learned rules and raw sample copies", async (t) => {
  const entries = [{ text: "了解", when: "意外的好消息" }];
  const { store, ownerStylePath } = await fixture(t, {
    agentName: "测试代", activeCatchphrases: [{ text: "好", when: "确认" }],
    pendingCatchphrases: entries, pendingCatchphrasesAt: "2099-10-22T20:00:00.000Z",
    publishedStyleRules: ["不要保留的旧自动规则"], sampleCount: 8,
    samples: [{ text: "PRIVATE_CHAT_COPY" }]
  });
  assert.equal(store.name(), "测试代");
  assert.deepEqual(store.catchphrases(), entries);
  assert.deepEqual(JSON.parse(await readFile(ownerStylePath, "utf8")), {
    agentName: "测试代", activeCatchphrases: entries
  });
  assert.doesNotMatch(store.systemPromptForClient(), /不要保留的旧自动规则|PRIVATE_CHAT_COPY|自动归纳的表达习惯/u);
  assert.equal(store.stableSystemPrompt(), store.systemPromptForClient());
});

test("manual catchphrases apply immediately and survive restart without a daily job", async (t) => {
  const { store, ownerStylePath } = await fixture(t);
  const entries = [{ text: "了解", when: "条件意外不错" }];
  assert.deepEqual(await store.stageCatchphrases(entries), { entries });
  assert.match(store.systemPrompt(), /了解：条件意外不错/u);
  assert.equal(Object.hasOwn(store.publicState(), "pendingCatchphrases"), false);
  const restored = new PersonaStore({ corePath: store.corePath, examplesPath: store.examplesPath, ownerStylePath });
  await restored.init();
  assert.deepEqual(restored.catchphrases(), entries);
  await assert.rejects(store.stageCatchphrases([{ text: "好", when: "" }]), /使用场景/u);
});

test("original positive and negative examples are both injected beyond the old eight-scenario cap", async (t) => {
  const { store } = await fixture(t);
  store.examples = Array.from({ length: 24 }, (_, i) => ({
    situation: `原场景${i}`, behavior: "保持原判断", examples: [`原回答${i}`], avoid: [`原反例${i}`]
  }));
  const before = structuredClone(store.examples);
  const prompt = store.systemPrompt();
  assert.equal(store.publicState().injectedExampleCount, 24);
  assert.match(prompt, /不要「原反例23」；可以「原回答23」/u);
  assert.deepEqual(store.examples, before);
  assert.equal(store.systemPrompt(), prompt);
});

test("public persona contains only generic examples with verified system injection", async (t) => {
  const { store } = await fixture(t);
  const prompt = store.systemPromptForClient();
  assert.equal(store.publicState().injectedExampleCount, store.examples.length);
  assert.match(prompt, /你有权主动发起话题/u);
  assert.match(prompt, /不要为了反对而反对/u);
  assert.match(prompt, /你只是群友之一/u);
  assert.match(prompt, /群里多人连续复读同一句话时，可以看气氛原样跟一句/u);
  assert.match(prompt, /群友复读接龙除外/u);
  assert.doesNotMatch(prompt, /不要变成复读机/u);
  assert.match(prompt, /可以「？ 你要啥推荐 \/ 退钱吗」/u);
  for (const sample of store.examples.filter((item) => item.source)) {
    assert.match(sample.source, /a56164e70a0521a7829138a42eee76066fde2b8b/u);
    for (const positive of sample.examples) assert.doesNotMatch(positive,
      /小鲸鱼|DeepSeek|大肥鱼|V我50|用户彻底怒了|偷吃.?token|服务器繁忙|先吃饭吧|已经点了/u);
  }
  assert.equal(store.stableSystemPrompt(), store.systemPromptForClient());
});

test("daily style capture and scheduled summary are not wired into the gateway", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /DailyStyleCoordinator|dailyStyle\.|persona-style-samples/u);
});

test("sticker-only scenarios are injected as tool actions without a spurious silence fallback", async (t) => {
  const { store } = await fixture(t);
  const prompt = store.systemPromptForClient();
  assert.match(prompt, /默认先选 QQ 原生表情包，不先写一句文字/u);
  assert.match(prompt, /表情优先于短吐槽和口头禅/u);
  assert.match(prompt, /口头禅只是文字备选/u);
  const scenes = prompt.split("\n").filter((line) => /群友抛来离谱或好笑的梗|只想表示赞同、无奈/.test(line));
  assert.equal(scenes.length, 2);
  for (const line of scenes) {
    assert.match(line, /list_reactions/u);
    assert.match(line, /send_reaction/u);
    assert.doesNotMatch(line, /可以不发消息|；可以「/u);
  }
  assert.match(prompt, /不为凑比例硬发/u);
  assert.equal(store.publicState().injectedExampleCount, store.examples.length);
});

test("event status ring cannot retain chat bodies, replies, tools payloads or attachments", () => {
  assert.deepEqual(eventMetadata({ type: "turn-completed", groupId: "123456789", at: "now", count: 2,
    message: { text: "SECRET", images: ["PRIVATE"] }, reply: "SECRET", text: "SECRET",
    params: { prompt: "SECRET" }, attachments: ["PRIVATE"]
  }), { type: "turn-completed", groupId: "123456789", at: "now", count: 2 });
});
