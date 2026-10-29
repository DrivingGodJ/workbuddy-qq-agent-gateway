import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PersonaStore, MAX_PERSONA_EXAMPLES, MAX_PERSONA_EXAMPLE_CHARS } from "../src/persona/persona-store.js";
import { getAgentName, setAgentName } from "../src/security/policy.js";
import { normalizeOneBotGroupMessage } from "../src/qq/message-normalizer.js";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qq-persona-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = {
    corePath: join(projectDir, "persona", "core.json"),
    examplesPath: join(projectDir, "persona", "examples.json"),
    statePath: join(directory, "legacy-state.json"),
    relationshipsPath: join(directory, "legacy-relationships.json"),
    ownerStylePath: join(directory, "owner-style.json")
  };
  const store = new PersonaStore(paths);
  await store.init();
  return { store, paths };
}

test("one shared persona keeps identity and safety without a per-turn runtime block", async (t) => {
  const { store } = await fixture(t);
  const prompt = store.systemPromptForClient();
  assert.match(prompt, /你是老代/);
  assert.match(prompt, /不能冒充 OWNER/);
  assert.match(prompt, /高优先级表达规则/);
  assert.match(prompt, /不泄露个人信息/);
  assert.match(prompt, /文字默认不用 Unicode emoji/);
  assert.match(prompt, /固定口头禅/);
  assert.match(prompt, /反 AI 味黑名单/);
  assert.match(prompt, /<qq_gateway_rules>/);
  assert.match(prompt, /send_message/);
  assert.match(prompt, /read_source_messages/);
  assert.match(prompt, /read_qzone_feeds/);
  assert.match(prompt, /post_qzone/);
  assert.doesNotMatch(prompt, /小鲸鱼|DeepSeek|大肥鱼/);
  assert.doesNotMatch(prompt, /人格运行态|熟悉度|社交精力|最近人格反馈/);
  assert.ok(prompt.length < 12000);
});

test("different conversations add no dynamic persona text to their turn prompt", async (t) => {
  const { store } = await fixture(t);
  const shared = store.systemPromptForClient();
  const groupTask = "【本轮任务】先读取群消息";
  const privateTask = "【本轮任务】先读取私聊消息";
  assert.equal(await store.compileTurn({
    targetType: "group", targetId: "200000002", targetName: "133",
    messages: [{ messageId: "1", text: "我很难受" }], taskPrompt: groupTask, includeStable: false
  }), groupTask);
  assert.equal(await store.compileTurn({
    targetType: "private", targetId: "100000001", targetName: "OWNER",
    messages: [{ messageId: "2", text: "笑死" }], taskPrompt: privateTask, includeStable: false
  }), privateTask);
  assert.equal(store.systemPromptForClient(), shared);
  assert.equal(store.targetState("group", "200000002").promptPreview,
    store.targetState("private", "100000001").promptPreview);
  assert.doesNotMatch(store.previewPrompt(), /人格运行态|本轮社交精力|相关风格示例/);
});

test("legacy long-term rule files are ignored without automatic style learning", async (t) => {
  const { store, paths } = await fixture(t);
  const legacyRulesPath = join(dirname(paths.ownerStylePath), "rules.json");
  const legacyRules = JSON.stringify({ rules: ["旧规则不再注入"] });
  await writeFile(legacyRulesPath, legacyRules);
  const restored = new PersonaStore(paths);
  await restored.init();
  assert.doesNotMatch(restored.systemPromptForClient(), /旧规则不再注入|OWNER 教过的长期规则/);
  assert.equal(Object.hasOwn(restored.publicState(), "globalRules"), false);
  assert.equal(typeof restored.publishStyleRules, "undefined");
  assert.equal(typeof restored.publishDailyUpdate, "undefined");
  assert.equal(await readFile(legacyRulesPath, "utf8"), legacyRules);
});

test("legacy social-state files are neither read nor rewritten after migration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-persona-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = {
    corePath: join(projectDir, "persona", "core.json"),
    examplesPath: join(projectDir, "persona", "examples.json"),
    statePath: join(directory, "persona-state.json"),
    relationshipsPath: join(directory, "relationship-memory.json"),
    ownerStylePath: join(directory, "owner-style.json")
  };
  const legacy = JSON.stringify({ secretOldState: "kept for recovery" });
  await writeFile(paths.statePath, legacy);
  await writeFile(paths.relationshipsPath, legacy);
  const store = new PersonaStore(paths);
  await store.init();
  await store.stageCatchphrases([{ text: "了解", when: "简短确认" }]);
  assert.equal(await readFile(paths.statePath, "utf8"), legacy);
  assert.equal(await readFile(paths.relationshipsPath, "utf8"), legacy);
  assert.doesNotMatch(JSON.stringify(store.publicState()), /secretOldState/);
});

test("nickname persists and changes both persona identity and text wake word", async (t) => {
  t.after(() => setAgentName("老代"));
  const { store, paths } = await fixture(t);
  assert.equal(await store.setName("小代"), "小代");
  assert.equal(getAgentName(), "小代");
  assert.match(store.systemPromptForClient(), /你是小代/);
  assert.match(store.systemPromptForClient(), /你在 QQ 中叫“小代”/);
  assert.doesNotMatch(store.systemPromptForClient(), /你是老代|你在 QQ 中叫“老代”/);
  const incoming = (text) => normalizeOneBotGroupMessage({ self_id: "2", user_id: "3", group_id: "4", message: [{ type: "text", data: { text } }] });
  assert.equal(incoming("小代在吗").mentionedBot, true);
  assert.equal(incoming("老代在吗").mentionedBot, false);
  assert.equal(normalizeOneBotGroupMessage({ self_id: "2", user_id: "3", group_id: "4", message: [{ type: "at", data: { qq: "2" } }] }).mentionedBot, true);
  const restored = new PersonaStore(paths);
  await restored.init();
  assert.equal(restored.name(), "小代");
  await assert.rejects(store.setName("不 合法"), /昵称/);
});

test("edited catchphrases apply immediately and can be cleared without a scheduled job", async (t) => {
  const { paths, store } = await fixture(t);
  const updated = [{ text: "了解", when: "简短确认时自然说" }];
  const stage = await store.stageCatchphrases(updated);
  assert.deepEqual(stage.entries, updated);
  assert.deepEqual(store.catchphrases(), updated);
  assert.equal(Object.hasOwn(store.publicState(), "pendingCatchphrases"), false);
  const restored = new PersonaStore(paths);
  await restored.init();
  assert.deepEqual(restored.catchphrases(), updated);
  assert.match(restored.systemPromptForClient(), /- 了解：简短确认时自然说/);
  await restored.stageCatchphrases([]);
  assert.deepEqual(restored.catchphrases(), []);
  assert.doesNotMatch(restored.systemPromptForClient(), /固定口头禅/);
  await assert.rejects(restored.stageCatchphrases([{ text: "重复", when: "一" }, { text: "重复", when: "二" }]), /重复/);
});

test("scene examples are stable, bounded system instructions, never repeated per turn", async (t) => {
  const { store } = await fixture(t);
  store.examples = Array.from({length:40}, (_,i)=>({situation:`情况${i}`,behavior:"自行判断是否有必要接话",examples:["一句短回复","老代不必跟读"]}));
  const prompt = store.systemPromptForClient();
  const block = prompt.split("情境对照（")[1].split("兴趣倾向：")[0];
  const examples = block.split("\n").filter(line=>line.includes(" → "));
  assert.equal(examples.length,MAX_PERSONA_EXAMPLES);
  assert.ok(examples.join("").length <= MAX_PERSONA_EXAMPLE_CHARS);
  assert.equal(store.publicState().injectedExampleCount,MAX_PERSONA_EXAMPLES);
  assert.equal(await store.compileTurn({includeStable:false,taskPrompt:"预读取消息"}),"预读取消息");
  assert.equal(store.systemPromptForClient(),prompt);
  await store.setName("小代");
  assert.doesNotMatch(store.systemPromptForClient(),/老代不必跟读/);
  assert.match(store.systemPromptForClient(),/小代不必跟读/);
  t.after(()=>setAgentName("老代"));
});

test("saving unchanged manual preferences preserves the exact system prefix", async (t) => {
  const {store} = await fixture(t);
  const entries = [{text:"了解",when:"简短确认"}];
  await store.stageCatchphrases(entries);
  const before = store.systemPromptForClient();
  await store.stageCatchphrases(entries);
  assert.equal(store.systemPromptForClient(),before);
});
