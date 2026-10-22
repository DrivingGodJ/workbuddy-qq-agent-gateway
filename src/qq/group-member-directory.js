import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export const GROUP_MEMBER_DIRECTORY_FILE = "qq-members.json";
const QQ_ID = /^\d{5,14}$/u;
const MAX_KNOWN_NAMES = 24;

function cleanName(value, qqId = "") {
  const name = [...String(value || "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim()]
    .slice(0, 100).join("");
  return name && name !== qqId && name !== "群成员" ? name : null;
}

function directoryState(groupId) {
  return { version: 1, groupId, members: {} };
}

function mergeSpeaker(state, message, sender, clock) {
  if (message?.eventType === "poke" || message?.source !== "qq") return false;
  const qqId = String(message.senderId || "");
  if (!QQ_ID.test(qqId)) return false;
  const previous = state.members[qqId];
  const nickname = sender && Object.hasOwn(sender, "nickname")
    ? cleanName(sender.nickname, qqId) : previous?.nickname || null;
  const groupCard = sender && Object.hasOwn(sender, "card")
    ? cleanName(sender.card, qqId) : previous?.groupCard || null;
  const displayName = groupCard || nickname || cleanName(message.senderName, qqId);
  const oldNames = Array.isArray(previous?.knownNames) ? previous.knownNames : [];
  const knownNames = [...new Set([...oldNames, nickname, groupCard, displayName].filter(Boolean))]
    .slice(-MAX_KNOWN_NAMES);
  if (previous && previous.nickname === nickname
    && previous.groupCard === groupCard
    && previous.displayName === (displayName || previous.displayName || null)
    && JSON.stringify(previous.knownNames) === JSON.stringify(knownNames)) return false;
  state.members[qqId] = {
    qqId,
    displayName: displayName || previous?.displayName || null,
    nickname: nickname || previous?.nickname || null,
    groupCard,
    knownNames,
    updatedAt: message.timestamp || clock().toISOString()
  };
  return true;
}

/** A per-group, local-only name index. Message contents are never stored here. */
export class GroupMemberDirectory {
  constructor({ rootDir, clock = () => new Date() } = {}) {
    if (!rootDir) throw new Error("Group member directory root is required");
    this.rootDir = resolve(rootDir);
    this.clock = clock;
    this.cache = new Map();
    this.chains = new Map();
  }

  pathFor(groupId) {
    const id = String(groupId || "");
    if (!QQ_ID.test(id)) throw new Error("Invalid QQ group ID for member directory");
    const groupDir = resolve(this.rootDir, id);
    if (!groupDir.startsWith(`${this.rootDir}${sep}`)) throw new Error("QQ member directory escaped its root");
    return join(groupDir, GROUP_MEMBER_DIRECTORY_FILE);
  }

  async initGroup(groupId, retainedMessages = []) {
    const id = String(groupId);
    return this.enqueue(id, async () => {
      const { state, exists } = await this.load(id);
      if (exists) return false;
      for (const message of [...retainedMessages].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))) {
        mergeSpeaker(state, message, null, this.clock);
      }
      await this.save(id, state);
      this.cache.set(id, state);
      return true;
    });
  }

  async record(message, sender = null) {
    const id = String(message?.groupId || "");
    return this.enqueue(id, async () => {
      const { state } = await this.load(id);
      const next = { ...state, members: { ...state.members } };
      if (!mergeSpeaker(next, message, sender, this.clock)) return false;
      await this.save(id, next);
      this.cache.set(id, next);
      return true;
    });
  }

  knownMemberIds(groupId) {
    return Object.keys(this.cache.get(String(groupId))?.members || {}).filter((id) => QQ_ID.test(id));
  }

  enqueue(groupId, action) {
    const previous = this.chains.get(groupId) || Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    this.chains.set(groupId, task);
    task.finally(() => { if (this.chains.get(groupId) === task) this.chains.delete(groupId); }).catch(() => {});
    return task;
  }

  async load(groupId) {
    this.pathFor(groupId);
    if (this.cache.has(groupId)) return { state: this.cache.get(groupId), exists: true };
    try {
      const state = JSON.parse(await readFile(this.pathFor(groupId), "utf8"));
      if (state?.version !== 1 || state.groupId !== groupId || !state.members || typeof state.members !== "object"
        || Array.isArray(state.members)) throw new Error(`Invalid QQ member directory for group ${groupId}`);
      this.cache.set(groupId, state);
      return { state, exists: true };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { state: directoryState(groupId), exists: false };
    }
  }

  async save(groupId, state) {
    const path = this.pathFor(groupId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(resolve(this.rootDir, groupId), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}
