import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const defaultExecFile = promisify(execFileCallback);
const defaultEventKitScript = fileURLToPath(new URL("../../scripts/macos-eventkit.swift", import.meta.url));
const defaultActionScript = fileURLToPath(new URL("../../scripts/macos-notification-action.js", import.meta.url));
const defaultReminderScript = fileURLToPath(new URL("../../scripts/macos-reminder-action.applescript", import.meta.url));
const compilePromises = new Map();

export class MacActionClient {
  constructor({
    executable = "/usr/bin/swift",
    swiftCompiler = "/usr/bin/swiftc",
    eventKitScript = defaultEventKitScript,
    actionScript = defaultActionScript,
    reminderScript = defaultReminderScript,
    execFileImpl = defaultExecFile,
    timeoutMs = 20_000,
    useEventKit = true
  } = {}) {
    this.executable = executable;
    this.swiftCompiler = swiftCompiler;
    this.eventKitScript = eventKitScript;
    this.actionScript = actionScript;
    this.reminderScript = reminderScript;
    this.execFileImpl = execFileImpl;
    this.timeoutMs = timeoutMs;
    this.useEventKit = useEventKit;
  }

  async resolveEventKitRunner() {
    if (!this.useEventKit || this.execFileImpl !== defaultExecFile) {
      return { command: this.executable || "/usr/bin/swift", prefixArgs: [this.eventKitScript] };
    }
    let sourceBuffer;
    try {
      sourceBuffer = readFileSync(this.eventKitScript);
    } catch {
      return { command: this.executable || "/usr/bin/swift", prefixArgs: [this.eventKitScript] };
    }
    const hash = createHash("sha256").update(sourceBuffer).digest("hex").slice(0, 12);
    const binPath = join(tmpdir(), `wbqq-eventkit-${hash}`);
    try {
      accessSync(binPath, fsConstants.X_OK);
      return { command: binPath, prefixArgs: [] };
    } catch { /* need compile */ }

    if (!compilePromises.has(binPath)) {
      const promise = (async () => {
        const tmpBin = `${binPath}.tmp.${process.pid}`;
        await this.execFileImpl(this.swiftCompiler, ["-O", this.eventKitScript, "-o", tmpBin], {
          timeout: 60_000,
          maxBuffer: 1024 * 1024
        });
        await rename(tmpBin, binPath);
        return binPath;
      })().finally(() => {
        compilePromises.delete(binPath);
      });
      compilePromises.set(binPath, promise);
    }

    try {
      const compiled = await compilePromises.get(binPath);
      return { command: compiled, prefixArgs: [] };
    } catch {
      return { command: this.executable || "/usr/bin/swift", prefixArgs: [this.eventKitScript] };
    }
  }

  async runEventKit(payload) {
    const { command, prefixArgs } = await this.resolveEventKitRunner();
    let stdout = "";
    try {
      ({ stdout = "" } = await this.execFileImpl(command, [...prefixArgs, JSON.stringify(payload)], {
        timeout: this.timeoutMs,
        maxBuffer: 2 * 1024 * 1024
      }));
    } catch (error) {
      const detail = String(error?.stderr || "").trim();
      if (detail && !String(error.message || "").includes(detail)) error.message = `${error.message}\n${detail}`;
      throw error;
    }
    try {
      return JSON.parse(String(stdout || "{}").trim() || "{}");
    } catch {
      return { externalItemId: String(stdout || "").trim() || null };
    }
  }

  async execute(action, { sourceGroupId, sourceGroupName } = {}) {
    const payload = {
      ...action,
      sourceGroupId: String(sourceGroupId || ""),
      sourceGroupName: String(sourceGroupName || "学校通知群"),
      marker: `[WorkBuddyQQ:${action.actionId}]`
    };
    const parsed = this.useEventKit
      ? await this.runEventKit({ ...payload, op: action.type })
      : await this.executeLegacy(action, payload);
    return {
      externalItemId: parsed.externalItemId || null,
      result: parsed.result || (action.type === "calendar" ? "日历已写入" : "待办已写入"),
      targetList: parsed.targetList || (action.type === "calendar" ? action.calendarName : "待办")
    };
  }

  async executeLegacy(action, payload) {
    const args = action.type === "reminder"
      ? reminderArguments(this.reminderScript, payload)
      : ["-l", "JavaScript", this.actionScript, JSON.stringify(payload)];
    let stdout = "";
    try {
      ({ stdout = "" } = await this.execFileImpl("/usr/bin/osascript", args, {
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024
      }));
    } catch (error) {
      const detail = String(error?.stderr || "").trim();
      if (detail && !String(error.message || "").includes(detail)) error.message = `${error.message}\n${detail}`;
      throw error;
    }
    try {
      return JSON.parse(String(stdout || "{}").trim() || "{}");
    } catch {
      return { externalItemId: String(stdout || "").trim() || null };
    }
  }

  async preflight() {
    if (this.useEventKit) {
      return this.runEventKit({ op: "preflight" });
    }
    const { stdout = "" } = await this.execFileImpl("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      this.actionScript,
      JSON.stringify({ type: "preflight" })
    ], { timeout: this.timeoutMs, maxBuffer: 1024 * 1024 });
    return JSON.parse(String(stdout || "{}").trim() || "{}");
  }

  async getContext({
    horizonDays = 60,
    limit = 80,
    now = new Date(),
    scope = "both",
    startDate = null,
    endDate = null,
    calendarName = null,
    query = null,
    includeCompleted = false
  } = {}) {
    const parsed = await this.runEventKit({
      op: "context",
      now: (now instanceof Date ? now : new Date(now)).toISOString(),
      horizonDays,
      limit,
      scope,
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(calendarName ? { calendarName } : {}),
      ...(query ? { query } : {}),
      ...(includeCompleted ? { includeCompleted: true } : {})
    });
    return {
      now: parsed.now || (now instanceof Date ? now : new Date(now)).toISOString(),
      timezone: parsed.timezone || "Asia/Shanghai",
      scope: parsed.scope || scope,
      startDate: parsed.startDate || null,
      endDate: parsed.endDate || null,
      calendarName: parsed.calendarName ?? (calendarName || null),
      query: parsed.query ?? (query || null),
      calendarAuthorized: parsed.calendarAuthorized ?? null,
      remindersAuthorized: parsed.remindersAuthorized ?? null,
      calendars: Array.isArray(parsed.calendars) ? parsed.calendars : [],
      reminderLists: Array.isArray(parsed.reminderLists) ? parsed.reminderLists : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      calendar: Array.isArray(parsed.calendar) ? parsed.calendar.slice(0, limit) : [],
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders.slice(0, limit) : []
    };
  }
}

function reminderArguments(scriptPath, payload) {
  const due = payload.due ? new Date(payload.due) : null;
  const validDue = due && !Number.isNaN(due.getTime());
  return [
    scriptPath,
    String(payload.title || ""),
    validDue ? "1" : "0",
    String(validDue ? due.getFullYear() : 0),
    String(validDue ? due.getMonth() + 1 : 0),
    String(validDue ? due.getDate() : 0),
    String(validDue ? due.getHours() : 0),
    String(validDue ? due.getMinutes() : 0),
    String(validDue ? due.getSeconds() : 0),
    String(payload.notes || ""),
    String(payload.marker || ""),
    String(payload.sourceGroupName || "学校通知群"),
    String(payload.sourceGroupId || "")
  ];
}
