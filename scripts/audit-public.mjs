import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const FORBIDDEN_PATHS = [
  "config/private",
  "config/qq-only.env",
  "modules/workbuddy-agent/.session-map.json",
  "modules/workbuddy-agent/.venv",
  "runtime",
  "data"
];

const IGNORED_DIRS = new Set([
  ".git",
  ".build",
  ".swiftpm",
  "node_modules",
  "build",
  "dist",
  "__pycache__"
]);

const TEXT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".py", ".swift", ".sh", ".command", ".json",
  ".html", ".css", ".md", ".txt", ".plist", ".example", ".applescript", ".c"
]);

const SECRET_PATTERNS = [
  { name: "Home directory path", regex: /\/Users\/[A-Za-z0-9._-]{2,}\//g },
  { name: "Hardcoded Bearer token", regex: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
  { name: "Private key block", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "Real owner/bot env assignment", regex: /^(?:WORKBUDDY_QQ_OWNER_QQ_ID|WORKBUDDY_QQ_BOT_QQ_ID)=(?!10000000[12]$)[0-9]{5,14}$/gm }
];

async function walk(dir, results = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    const rel = relative(ROOT, full);
    if (entry.isDirectory()) {
      await walk(full, results);
    } else if (entry.isFile()) {
      results.push({ full, rel });
    }
  }
  return results;
}

async function runAudit() {
  const errors = [];

  for (const forbidden of FORBIDDEN_PATHS) {
    if (existsSync(join(ROOT, forbidden))) {
      errors.push(`Forbidden private/runtime path present in repository: ${forbidden}`);
    }
  }

  const configDir = join(ROOT, "config");
  if (existsSync(configDir)) {
    for (const name of await readdir(configDir)) {
      if (name.endsWith(".plist")) {
        errors.push(`Non-example plist present in config/: ${name}`);
      }
    }
  }

  const files = await walk(ROOT);
  for (const { full, rel } of files) {
    if (rel.startsWith("test/") || rel === "scripts/audit-public.mjs") continue;
    if (!TEXT_EXTENSIONS.has(extname(rel).toLowerCase())) continue;
    const text = await readFile(full, "utf8");
    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      const match = pattern.regex.exec(text);
      if (match) {
        errors.push(`${pattern.name} detected in ${rel}: ${match[0].slice(0, 60)}`);
      }
    }
  }

  if (errors.length) {
    for (const err of errors) console.error(`AUDIT FAIL: ${err}`);
    process.exit(1);
  }
  console.log(`audit:public passed (${files.length} tracked files checked)`);
}

runAudit().catch((error) => {
  console.error(error);
  process.exit(1);
});
