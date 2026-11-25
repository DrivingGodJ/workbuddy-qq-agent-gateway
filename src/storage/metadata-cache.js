import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const VALID_ROLES = new Set(["owner", "admin", "member"]);

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return VALID_ROLES.has(role) ? role : null;
}

function normalizeLabel(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeCachePayload(raw) {
  const groups = {};
  for (const [groupId, entry] of Object.entries(raw?.groups || {})) {
    if (!/^\d{5,14}$/u.test(String(groupId))) continue;
    groups[groupId] = {
      groupId: String(groupId),
      groupName: normalizeLabel(entry?.groupName),
      botRole: normalizeRole(entry?.botRole)
    };
  }
  const privateChats = {};
  for (const [userId, entry] of Object.entries(raw?.privateChats || {})) {
    if (!/^\d{5,14}$/u.test(String(userId))) continue;
    privateChats[userId] = {
      displayName: normalizeLabel(entry?.displayName)
    };
  }
  return {
    groups,
    privateChats,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : null
  };
}

export class MetadataCache {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { groups: {}, privateChats: {}, updatedAt: null };
    this.saveChain = Promise.resolve();
  }

  async init() {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.state = normalizeCachePayload(parsed);
      }
    } catch {
      this.state = { groups: {}, privateChats: {}, updatedAt: null };
    }
  }

  snapshot() {
    return {
      groups: structuredClone(this.state.groups),
      privateChats: structuredClone(this.state.privateChats),
      updatedAt: this.state.updatedAt
    };
  }

  save({ groups = {}, privateChats = {} } = {}) {
    const next = normalizeCachePayload({
      groups,
      privateChats,
      updatedAt: new Date().toISOString()
    });
    this.saveChain = this.saveChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.filePath);
      this.state = next;
    });
    return this.saveChain;
  }
}
