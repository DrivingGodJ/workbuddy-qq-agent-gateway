import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PersonaStore, PERSONA_BUNDLE_FORMAT, PERSONA_BUNDLE_VERSION, validatePersonaBundle } from "../src/persona/persona-store.js";

const execFileAsync = promisify(execFile);

test("persona bundle export/import preserves baseline, examples metadata, ownerStyle, and survives restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qq-persona-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceDataDir = join(root, "source-data");
  const targetDataDir = join(root, "target-data");
  await mkdir(sourceDataDir, { recursive: true });
  await mkdir(targetDataDir, { recursive: true });

  const customCore = {
    version: 2,
    name: "测试人格源",
    source: "人工问卷导入",
    highPriorityStyle: ["短句优先"],
    identity: ["你是测试人格源。"],
    speech: ["自然直白"],
    rhythm: ["不用每句都接"],
    judgement: ["先核验再判断"],
    subjectivity: ["有主见"],
    social: ["尊重他人"],
    actions: ["可发文字也可发表情"],
    adaptation: ["群聊隔离"],
    catchphrases: [{ text: "这么好", when: "收到不错消息时" }],
    antiAi: ["别说好的我明白了"],
    interests: ["编程", "摄影"],
    baseline: { energy: 0.75, sociability: 0.55, playfulness: 0.65, patience: 0.8 }
  };
  const customExamples = {
    version: 1,
    examples: [
      {
        id: "ex-1",
        tags: ["吐槽", "日常"],
        source: "commit-abc",
        situation: "群友晒深夜加班",
        behavior: "简短共情，不长篇说教",
        examples: ["辛苦了早点睡", "这还没下班啊"],
        avoid: ["建议你合理安排时间注意身体"]
      }
    ]
  };
  await writeFile(join(sourceDataDir, "core.json"), JSON.stringify(customCore));
  await writeFile(join(sourceDataDir, "examples.json"), JSON.stringify(customExamples));

  const sourceStore = new PersonaStore({
    corePath: join(sourceDataDir, "core.json"),
    examplesPath: join(sourceDataDir, "examples.json"),
    ownerStylePath: join(sourceDataDir, "persona-owner-style.json"),
    importedDir: join(sourceDataDir, "persona")
  });
  await sourceStore.init();
  await sourceStore.setName("老代二号");
  await sourceStore.stageCatchphrases([{ text: "有点东西", when: "遇到有意思的事情" }]);

  const bundle = sourceStore.exportBundle();
  assert.equal(bundle.format, PERSONA_BUNDLE_FORMAT);
  assert.equal(bundle.formatVersion, PERSONA_BUNDLE_VERSION);
  assert.deepEqual(bundle.core.baseline, customCore.baseline);
  assert.equal(bundle.examples.examples[0].id, "ex-1");
  assert.deepEqual(bundle.examples.examples[0].tags, ["吐槽", "日常"]);
  assert.equal(bundle.examples.examples[0].source, "commit-abc");
  assert.equal(bundle.ownerStyle.agentName, "老代二号");

  const targetStore = new PersonaStore({
    corePath: new URL("../persona/core.json", import.meta.url),
    examplesPath: new URL("../persona/examples.json", import.meta.url),
    ownerStylePath: join(targetDataDir, "persona-owner-style.json"),
    importedDir: join(targetDataDir, "persona")
  });
  await targetStore.init();
  assert.equal(targetStore.publicState().isImported, false);

  const importResult = await targetStore.importBundle(bundle);
  assert.equal(importResult.imported, true);
  assert.equal(importResult.name, "老代二号");
  assert.equal(importResult.exampleCount, 1);
  assert.equal(importResult.catchphraseCount, 1);
  assert.equal(targetStore.publicState().isImported, true);
  assert.match(targetStore.systemPromptForClient(), /有点东西：遇到有意思的事情/u);
  assert.match(targetStore.systemPromptForClient(), /辛苦了早点睡/u);

  // Restart with fresh PersonaStore instance
  const restarted = new PersonaStore({
    corePath: new URL("../persona/core.json", import.meta.url),
    examplesPath: new URL("../persona/examples.json", import.meta.url),
    ownerStylePath: join(targetDataDir, "persona-owner-style.json"),
    importedDir: join(targetDataDir, "persona")
  });
  await restarted.init();
  assert.equal(restarted.publicState().isImported, true);
  assert.equal(restarted.name(), "老代二号");
  assert.deepEqual(restarted.core.baseline, customCore.baseline);
  assert.deepEqual(restarted.examples, customExamples.examples);

  // Reset imported restores base template
  const resetResult = await restarted.resetImported();
  assert.equal(resetResult.reset, true);
  assert.equal(restarted.publicState().isImported, false);
  assert.equal(restarted.core.name, "小伴");
});

test("validatePersonaBundle rejects malformed payloads", () => {
  assert.throws(() => validatePersonaBundle(null), /JSON 对象/u);
  assert.throws(() => validatePersonaBundle({ format: "wrong", core: { name: "老代" }, examples: [] }), /不支持的人格文件格式/u);
  assert.throws(() => validatePersonaBundle({ formatVersion: 99, core: { name: "老代" }, examples: [] }), /不支持的人格文件版本/u);
  assert.throws(() => validatePersonaBundle({ core: { name: "A" }, examples: [] }), /2–40/u);
  assert.throws(() => validatePersonaBundle({ core: { name: "老代" }, examples: "bad" }), /examples/u);
  assert.throws(() => validatePersonaBundle({
    core: { name: "老代" },
    examples: [],
    ownerStyle: { agentName: "bad name@" }
  }), /昵称/u);
});

test("persona-bundle.mjs CLI exports, inspects, and imports persona files cleanly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qq-persona-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const fakeDeploy = join(root, "deploy");
  await mkdir(join(fakeDeploy, "config", "private", "persona"), { recursive: true });
  await mkdir(join(fakeDeploy, "runtime", "qq-only-data"), { recursive: true });
  await writeFile(join(fakeDeploy, "config", "private", "persona", "core.json"), JSON.stringify({
    version: 1,
    name: "CLI测试人格",
    source: "私有配置",
    identity: ["你是CLI测试人格"],
    catchphrases: [{ text: "没毛病", when: "同意时" }]
  }));
  await writeFile(join(fakeDeploy, "config", "private", "persona", "examples.json"), JSON.stringify({
    version: 1,
    examples: [{ situation: "测试场景", behavior: "测试响应", examples: ["行"], avoid: ["不行"] }]
  }));
  await writeFile(join(fakeDeploy, "runtime", "qq-only-data", "persona-owner-style.json"), JSON.stringify({
    agentName: "小代",
    activeCatchphrases: [{ text: "确实", when: "表示赞同" }]
  }));

  const bundlePath = join(root, "backup.laodai-persona.json");
  const cliPath = fileURLToPath(new URL("../scripts/persona-bundle.mjs", import.meta.url));

  const exp = await execFileAsync(process.execPath, [cliPath, "export", "--from", fakeDeploy, "--out", bundlePath]);
  const expJson = JSON.parse(exp.stdout);
  assert.equal(expJson.ok, true);
  assert.equal(expJson.name, "小代");
  assert.equal(expJson.exampleCount, 1);

  const insp = await execFileAsync(process.execPath, [cliPath, "inspect", "--file", bundlePath]);
  const inspJson = JSON.parse(insp.stdout);
  assert.equal(inspJson.name, "小代");
  assert.equal(inspJson.catchphraseCount, 1);

  const targetData = join(root, "new-data");
  const imp = await execFileAsync(process.execPath, [cliPath, "import", "--file", bundlePath, "--data-dir", targetData]);
  const impJson = JSON.parse(imp.stdout);
  assert.equal(impJson.ok, true);
  assert.equal(impJson.name, "小代");

  const savedCore = JSON.parse(await readFile(join(targetData, "persona", "core.json"), "utf8"));
  assert.equal(savedCore.name, "CLI测试人格");
});
