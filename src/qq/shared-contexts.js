import { mkdir, readFile } from "node:fs/promises";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

function targetId(value) {
  const id = String(value ?? "");
  if (!/^[1-9]\d{0,19}$/u.test(id)) throw new TypeError("QQ target id must be a positive numeric id");
  return id;
}

function targetType(value) {
  if (!["group", "private"].includes(value)) throw new TypeError("Unknown QQ target type");
  return value;
}

function cancelled() {
  return Object.assign(new Error("Queued shared-context task was cancelled"), { code: "CANCELLED" });
}

function summary(entry) {
  return entry ? { targetType: entry.targetType, targetId: entry.targetId, kind: entry.kind } : null;
}

export class SharedContexts {
  constructor({ filePath, groupStore, privateStore, onChange = () => {}, onIdle = () => {}, groupWorkspace = () => null }) {
    this.filePath = filePath;
    this.groupStore = groupStore;
    this.privateStore = privateStore;
    this.onChange = onChange;
    this.onIdle = onIdle;
    this.groupWorkspace = groupWorkspace;
    this.state = { version: 1, privateGroups: {} };
    this.lanes = new Map();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    let loaded;
    try {
      loaded = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (loaded !== undefined) {
      if (!loaded || loaded.version !== 1 || !loaded.privateGroups || typeof loaded.privateGroups !== "object" || Array.isArray(loaded.privateGroups)) {
        throw new Error("Invalid shared-context settings");
      }
      for (const [id, groupId] of Object.entries(loaded.privateGroups)) this.state.privateGroups[targetId(id)] = targetId(groupId);
    } else {
      this.persist(this.state);
    }
    return this;
  }

  persist(state) {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      // This tiny, rarely changed mapping commits synchronously: no worker can
      // enter an old lane between the busy check and the atomic mapping change.
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.filePath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  groupFor(type, id) {
    targetType(type);
    id = targetId(id);
    if (type === "private") return this.state.privateGroups[id] || null;
    return Object.values(this.state.privateGroups).includes(id) ? id : null;
  }

  linkedPrivates(groupId) {
    groupId = targetId(groupId);
    return Object.keys(this.state.privateGroups).filter((id) => this.state.privateGroups[id] === groupId);
  }

  setPrivateGroup(id, groupId) {
    id = targetId(id);
    groupId = groupId == null ? null : targetId(groupId);
    const previous = this.state.privateGroups[id] || null;
    if (previous === groupId) return this.snapshot("private", id);
    for (const group of [previous, groupId].filter(Boolean)) {
      const lane = this.lanes.get(group);
      if (lane?.active || lane?.queued.length) throw Object.assign(new Error("Shared conversation is busy"), { code: "BUSY" });
    }
    const next = structuredClone(this.state);
    if (groupId) next.privateGroups[id] = groupId;
    else delete next.privateGroups[id];
    this.persist(next);
    this.state = next;
    for (const group of new Set([previous, groupId].filter(Boolean))) this.publish(group);
    // The unbound private target is no longer included in the group's members.
    if (!groupId) {
      try { this.privateStore?.messageEvents?.emit(id); } catch {}
    }
    return this.snapshot("private", id);
  }

  snapshot(type, id) {
    const groupId = this.groupFor(type, id);
    if (!groupId) return null;
    const lane = this.lanes.get(groupId);
    return {
      groupId,
      linkedPrivateIds: this.linkedPrivates(groupId),
      active: summary(lane?.active),
      queued: (lane?.queued || []).map(summary)
    };
  }

  contextFor(type, id) {
    const groupId = this.groupFor(type, id);
    if (type !== "private" || !groupId) return null;
    return { groupId, group: this.groupStore.snapshot(groupId), cwd: this.groupWorkspace(groupId) };
  }

  busy(type, id) {
    const groupId = this.groupFor(type, id);
    const lane = groupId && this.lanes.get(groupId);
    return Boolean(lane?.active || lane?.queued.length);
  }

  shouldYield(type, id) {
    const groupId = this.groupFor(type, id);
    return Boolean(groupId && this.lanes.get(groupId)?.queued.length);
  }

  run(type, id, kind, task) {
    targetType(type);
    id = targetId(id);
    if (typeof task !== "function") throw new TypeError("Shared-context task must be a function");
    const groupId = this.groupFor(type, id);
    if (!groupId) {
      const promise = Promise.resolve().then(task);
      promise.catch(() => {});
      return promise;
    }
    let lane = this.lanes.get(groupId);
    if (!lane) {
      lane = { groupId, active: null, queued: [] };
      this.lanes.set(groupId, lane);
    }
    if (kind === "chat") {
      // Once another task is waiting, a fresh trigger belongs after it, not to
      // the active chat that will yield. Keep one deduplicated queued slot.
      const candidates = lane.queued.length ? lane.queued : [lane.active];
      const duplicate = candidates.find((entry) => entry?.kind === kind && entry.targetType === type && entry.targetId === id);
      if (duplicate) return duplicate.promise;
    }
    const entry = { targetType: type, targetId: id, kind, task };
    entry.promise = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
    // Queues may be cancelled before their caller starts awaiting them.
    entry.promise.catch(() => {});
    lane.queued.push(entry);
    this.startNext(lane);
    this.publish(groupId);
    return entry.promise;
  }

  startNext(lane) {
    if (lane.active || !lane.queued.length) return;
    const entry = lane.queued.shift();
    lane.active = entry;
    Promise.resolve().then(entry.task).then(
      (result) => { this.finish(lane, entry); entry.resolve(result); },
      (error) => { this.finish(lane, entry); entry.reject(error); }
    );
  }

  finish(lane, entry) {
    lane.active = null;
    this.startNext(lane);
    if (!lane.active && !lane.queued.length) this.lanes.delete(lane.groupId);
    this.publish(lane.groupId);
    queueMicrotask(() => {
      try { Promise.resolve(this.onIdle(entry.targetType, entry.targetId)).catch(() => {}); } catch {}
    });
  }

  cancelQueued(type, id) {
    targetType(type);
    id = targetId(id);
    const groupId = this.groupFor(type, id);
    const lane = groupId && this.lanes.get(groupId);
    if (!lane) return 0;
    const removed = lane.queued.filter((entry) => entry.targetType === type && entry.targetId === id);
    lane.queued = lane.queued.filter((entry) => !removed.includes(entry));
    for (const entry of removed) entry.reject(cancelled());
    if (removed.length) this.publish(groupId);
    return removed.length;
  }

  cancelTarget(type, id) {
    targetType(type);
    id = targetId(id);
    const count = this.cancelQueued(type, id);
    const groupId = this.groupFor(type, id);
    const active = groupId && this.lanes.get(groupId)?.active;
    if (active?.targetType !== type || active?.targetId !== id || active.cancelled) return count;
    active.cancelled = true;
    this.publish(groupId);
    return count + 1;
  }

  isCancelled(type, id) {
    targetType(type);
    id = targetId(id);
    const groupId = this.groupFor(type, id);
    const active = groupId && this.lanes.get(groupId)?.active;
    return Boolean(active?.targetType === type && active?.targetId === id && active.cancelled);
  }

  settleTarget(type, id, worker) {
    targetType(type);
    id = targetId(id);
    const store = type === "group" ? this.groupStore : this.privateStore;
    if (store.state?.groups && !Object.hasOwn(store.state.groups, id)) return;
    const conversation = store.snapshot(id);
    if (conversation.lastError || !worker.canRun(id) || worker.followup.cancelled.has(id)) return;
    if (conversation.pendingTrigger) {
      try { worker.kick(id).catch(() => {}); } catch {}
      return;
    }
    const before = worker.live.get(id);
    const status = before?.status;
    const waitUntil = before?.waitUntil;
    worker.followup.publishWaiting(id);
    const after = worker.live.get(id);
    if (status === after?.status && waitUntil === after?.waitUntil) return;
    const groupId = this.groupFor(type, id);
    if (groupId) this.publish(groupId);
    else {
      try { Promise.resolve(this.onChange()).catch(() => {}); } catch {}
    }
  }

  publish(groupId) {
    try { this.groupStore?.messageEvents?.emit(groupId); } catch {}
    for (const id of this.linkedPrivates(groupId)) {
      try { this.privateStore?.messageEvents?.emit(id); } catch {}
    }
    try { Promise.resolve(this.onChange()).catch(() => {}); } catch {}
  }
}
