import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Templates are public; deployments may keep their private personality elsewhere.
// An explicit override must never silently fall back to a generic personality.
export function resolvePersonaFiles(projectDir, configuredDir = "") {
  const directory = resolve(projectDir, String(configuredDir || "").trim() || "persona");
  const corePath = join(directory, "core.json");
  const examplesPath = join(directory, "examples.json");
  try {
    const core = JSON.parse(readFileSync(corePath, "utf8"));
    const examples = JSON.parse(readFileSync(examplesPath, "utf8"));
    if (!core || Array.isArray(core) || typeof core.name !== "string" || !core.name.trim()) {
      throw new Error("core.json requires a named personality object");
    }
    if (!examples || !Array.isArray(examples.examples)) {
      throw new Error("examples.json requires an examples array");
    }
  } catch {
    throw new Error("Personality configuration is missing or invalid; check WORKBUDDY_QQ_PERSONA_DIR/core.json and examples.json");
  }
  return { corePath, examplesPath };
}

export function validateRuntimeConfig({ ownerId, botId, host, authDisabled, apiToken, oneBotToken }) {
  for (const [label, value] of [["OWNER QQ", ownerId], ["bot QQ", botId]]) {
    if (!/^[1-9][0-9]{4,11}$/.test(String(value || ""))) throw new Error("Configure a valid " + label + " ID in config/qq-only.env");
  }
  if (ownerId === botId) throw new Error("OWNER and bot must be different QQ accounts");
  if (authDisabled && !["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Unauthenticated Hub access is only allowed on loopback");
  if (!authDisabled && !apiToken) throw new Error("Hub authentication token is missing");
  if (!oneBotToken) throw new Error("OneBot authentication token is missing");
}
