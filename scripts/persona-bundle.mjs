#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PersonaStore, validatePersonaBundle } from "../src/persona/persona-store.js";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return { command, flags };
}

function resolveDeploymentPersonaPaths(fromDir) {
  const base = resolve(fromDir);
  const directCore = join(base, "core.json");
  const directExamples = join(base, "examples.json");
  if (existsSync(directCore) && existsSync(directExamples)) {
    return {
      corePath: directCore,
      examplesPath: directExamples,
      ownerStylePath: existsSync(join(base, "persona-owner-style.json"))
        ? join(base, "persona-owner-style.json")
        : null
    };
  }
  const dataPersonaCore = join(base, "runtime", "qq-only-data", "persona", "core.json");
  const dataPersonaExamples = join(base, "runtime", "qq-only-data", "persona", "examples.json");
  const ownerStyleCandidate = join(base, "runtime", "qq-only-data", "persona-owner-style.json");
  if (existsSync(dataPersonaCore) && existsSync(dataPersonaExamples)) {
    return {
      corePath: dataPersonaCore,
      examplesPath: dataPersonaExamples,
      ownerStylePath: existsSync(ownerStyleCandidate) ? ownerStyleCandidate : null
    };
  }
  const privateCore = join(base, "config", "private", "persona", "core.json");
  const privateExamples = join(base, "config", "private", "persona", "examples.json");
  if (existsSync(privateCore) && existsSync(privateExamples)) {
    return {
      corePath: privateCore,
      examplesPath: privateExamples,
      ownerStylePath: existsSync(ownerStyleCandidate) ? ownerStyleCandidate : null
    };
  }
  const publicCore = join(base, "persona", "core.json");
  const publicExamples = join(base, "persona", "examples.json");
  if (existsSync(publicCore) && existsSync(publicExamples)) {
    return {
      corePath: publicCore,
      examplesPath: publicExamples,
      ownerStylePath: existsSync(ownerStyleCandidate) ? ownerStyleCandidate : null
    };
  }
  throw new Error(`未在目录中发现有效的 core.json 与 examples.json：${base}`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === "export") {
    const fromDir = flags.from;
    const outPath = flags.out;
    if (!fromDir || !outPath) {
      throw new Error("用法: node scripts/persona-bundle.mjs export --from <目录> --out <输出文件.laodai-persona.json>");
    }
    const { corePath, examplesPath, ownerStylePath } = resolveDeploymentPersonaPaths(fromDir);
    const core = JSON.parse(await readFile(corePath, "utf8"));
    const examplesRaw = JSON.parse(await readFile(examplesPath, "utf8"));
    const ownerRaw = ownerStylePath ? JSON.parse(await readFile(ownerStylePath, "utf8")) : {};
    const store = new PersonaStore({
      corePath,
      examplesPath,
      ownerStylePath: ownerStylePath || join(dirname(corePath), ".unused-owner-style.json")
    });
    // Read-only export without touching source directory files
    store.core = validatePersonaBundle({ core, examples: examplesRaw, ownerStyle: ownerRaw }).core;
    store.examples = validatePersonaBundle({ core, examples: examplesRaw, ownerStyle: ownerRaw }).examples;
    store.ownerStyle = validatePersonaBundle({ core, examples: examplesRaw, ownerStyle: ownerRaw }).ownerStyle;
    const bundle = store.exportBundle();
    const resolvedOut = resolve(outPath);
    await mkdir(dirname(resolvedOut), { recursive: true });
    await writeFile(resolvedOut, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    console.log(JSON.stringify({
      ok: true,
      out: resolvedOut,
      name: bundle.ownerStyle.agentName || bundle.core.name,
      exampleCount: bundle.examples.examples.length,
      catchphraseCount: (bundle.ownerStyle.activeCatchphrases ?? bundle.core.catchphrases).length
    }));
    return;
  }

  if (command === "import") {
    const filePath = flags.file;
    const dataDir = flags["data-dir"];
    if (!filePath || !dataDir) {
      throw new Error("用法: node scripts/persona-bundle.mjs import --file <人格文件> --data-dir <目标数据目录>");
    }
    const payload = JSON.parse(await readFile(resolve(filePath), "utf8"));
    const targetDataDir = resolve(dataDir);
    const fallbackCore = new URL("../persona/core.json", import.meta.url);
    const fallbackExamples = new URL("../persona/examples.json", import.meta.url);
    const store = new PersonaStore({
      corePath: fallbackCore,
      examplesPath: fallbackExamples,
      ownerStylePath: join(targetDataDir, "persona-owner-style.json"),
      importedDir: join(targetDataDir, "persona")
    });
    await store.init();
    const result = await store.importBundle(payload);
    console.log(JSON.stringify({
      ok: true,
      dataDir: targetDataDir,
      name: result.name,
      exampleCount: result.exampleCount,
      catchphraseCount: result.catchphraseCount
    }));
    return;
  }

  if (command === "inspect") {
    const filePath = flags.file;
    if (!filePath) {
      throw new Error("用法: node scripts/persona-bundle.mjs inspect --file <人格文件>");
    }
    const payload = JSON.parse(await readFile(resolve(filePath), "utf8"));
    const validated = validatePersonaBundle(payload);
    const name = validated.ownerStyle.agentName || validated.core.name;
    const catchphrases = validated.ownerStyle.activeCatchphrases ?? validated.core.catchphrases;
    console.log(JSON.stringify({
      ok: true,
      format: payload.format || "legacy",
      formatVersion: payload.formatVersion || 1,
      name,
      source: validated.core.source,
      exampleCount: validated.examples.length,
      catchphraseCount: catchphrases.length
    }));
    return;
  }

  throw new Error("支持命令: export | import | inspect");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
