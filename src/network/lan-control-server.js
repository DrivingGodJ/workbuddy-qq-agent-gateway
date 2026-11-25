import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

const COOKIE_NAME = "laodai_lan_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RESERVED_PORTS = new Set([3000, 3001, 5099, 6081]);
const STATIC_ASSET_PATHS = new Set(["/client.css", "/client.js", "/client-status.js"]);

export function isPrivateLanAddress(address) {
  let raw = String(address || "").trim();
  if (!raw) return false;
  if (raw.startsWith("::ffff:")) raw = raw.slice(7);
  const zone = raw.indexOf("%");
  if (zone >= 0) raw = raw.slice(0, zone);

  if (raw === "::1") return true;
  const lower = raw.toLowerCase();
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) {
    return true;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
  if (!ipv4) return false;
  const [a, b, c, d] = ipv4.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n < 0 || n > 255)) return false;

  if (a === 127) return true; // Loopback
  if (a === 10) return true; // RFC1918 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16.0.0/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168.0.0/16
  if (a === 169 && b === 254) return true; // Link-local
  return false;
}

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const derived = scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash: derived };
}

export function verifyPassword(password, salt, expectedHash) {
  if (!password || !salt || !expectedHash) return false;
  const actual = scryptSync(String(password), String(salt), 64);
  const expected = Buffer.from(String(expectedHash), "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export class LanControlServer {
  constructor({
    filePath,
    hubPort = 3789,
    publicDir,
    handleAuthorizedApi,
    serveStatic,
    onEvent = () => {},
    disableBonjour = false,
    defaultEnabled = false,
    defaultPort = 3790,
    clock = () => Date.now(),
  } = {}) {
    this.filePath = filePath;
    this.hubPort = Number(hubPort) || 3789;
    this.publicDir = publicDir;
    this.handleAuthorizedApi = handleAuthorizedApi;
    this.serveStatic = serveStatic;
    this.onEvent = onEvent;
    this.disableBonjour = Boolean(disableBonjour);
    this.clock = clock;

    this.state = {
      enabled: Boolean(defaultEnabled),
      port: Number(defaultPort) || 3790,
      bonjourEnabled: true,
      passwordSalt: null,
      passwordHash: null,
    };
    this.server = null;
    this.boundPort = null;
    this.bonjourProcess = null;
    this.bonjourActive = false;
    this.lastError = null;
    this.sessions = new Map();
    this.loginFailures = new Map();
    this.saveChain = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.filePath, "utf8"));
      if (saved && typeof saved === "object") {
        this.state = {
          enabled: Boolean(saved.enabled),
          port: normalizePort(saved.port, this.hubPort, 3790),
          bonjourEnabled: saved.bonjourEnabled !== false,
          passwordSalt: typeof saved.passwordSalt === "string" ? saved.passwordSalt : null,
          passwordHash: typeof saved.passwordHash === "string" ? saved.passwordHash : null,
        };
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.save();
    }

    if (this.state.enabled && this.state.passwordHash && this.state.passwordSalt) {
      await this.startListener().catch((error) => {
        this.lastError = error.message;
        console.warn(`LAN control panel startup failed: ${error.message}`);
      });
    }
  }

  status() {
    this.pruneExpiredSessions();
    const running = Boolean(this.server && this.server.listening);
    const activePort = running ? (this.boundPort || this.state.port) : this.state.port;
    const rawHost = hostname().replace(/\.local$/i, "");
    return {
      enabled: this.state.enabled,
      running,
      port: activePort,
      bonjourEnabled: this.state.bonjourEnabled,
      bonjourActive: this.bonjourActive,
      hasPassword: Boolean(this.state.passwordHash && this.state.passwordSalt),
      activeSessions: this.sessions.size,
      urls: running ? lanUrlsForPort(activePort) : [],
      bonjourHost: running && this.bonjourActive && rawHost ? `http://${rawHost}.local:${activePort}` : null,
      lastError: this.lastError,
    };
  }

  async configure(input = {}) {
    const nextEnabled = input.enabled !== undefined ? Boolean(input.enabled) : this.state.enabled;
    const nextBonjour = input.bonjourEnabled !== undefined ? Boolean(input.bonjourEnabled) : this.state.bonjourEnabled;
    const nextPort = input.port !== undefined
      ? validatePort(input.port, this.hubPort)
      : this.state.port;

    let nextSalt = this.state.passwordSalt;
    let nextHash = this.state.passwordHash;
    let passwordChanged = false;

    if (input.password !== undefined && input.password !== null && String(input.password) !== "") {
      const password = String(input.password);
      if (password.length < 6 || password.length > 128) {
        const err = new Error("局域网控制密码长度须为 6–128 位");
        err.statusCode = 400;
        throw err;
      }
      const hashed = hashPassword(password);
      nextSalt = hashed.salt;
      nextHash = hashed.hash;
      passwordChanged = true;
    }

    if (nextEnabled && (!nextHash || !nextSalt)) {
      const err = new Error("开启局域网广播控制面板前请先设置访问密码（至少 6 位）");
      err.statusCode = 400;
      throw err;
    }

    const needsRestart = nextEnabled && (
      !this.server?.listening ||
      nextPort !== this.state.port ||
      nextBonjour !== this.state.bonjourEnabled
    );

    if (!nextEnabled || passwordChanged || input.revokeSessions === true) {
      this.sessions.clear();
    }

    this.state = {
      enabled: nextEnabled,
      port: nextPort,
      bonjourEnabled: nextBonjour,
      passwordSalt: nextSalt,
      passwordHash: nextHash,
    };
    this.lastError = null;
    await this.save();

    if (!nextEnabled) {
      await this.stopListener();
    } else if (needsRestart) {
      await this.stopListener();
      await this.startListener();
    }

    this.onEvent({
      type: "lan-panel-updated",
      enabled: this.state.enabled,
      port: this.state.port,
      at: new Date(this.clock()).toISOString(),
    });
    return this.status();
  }

  async startListener() {
    if (this.server?.listening) return;
    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        if (!res.headersSent) {
          sendJson(res, error.statusCode || 500, { error: String(error?.message || error) });
        } else {
          res.end();
        }
      });
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.state.port, "0.0.0.0", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    this.server = server;
    this.boundPort = server.address()?.port || this.state.port;
    this.lastError = null;
    this.startBonjour();
  }

  async stopListener() {
    this.stopBonjour();
    this.sessions.clear();
    if (!this.server) return;
    const current = this.server;
    this.server = null;
    this.boundPort = null;
    await new Promise((resolve) => {
      current.close(() => resolve());
      current.closeAllConnections?.();
    });
  }

  async close() {
    await this.stopListener();
  }

  startBonjour() {
    this.stopBonjour();
    if (this.disableBonjour || !this.state.bonjourEnabled || !this.boundPort) return;
    if (process.platform !== "darwin" || !existsSync("/usr/bin/dns-sd")) return;
    try {
      const child = spawn("/usr/bin/dns-sd", [
        "-R",
        "WorkBuddy QQ Gateway",
        "_http._tcp",
        "local",
        String(this.boundPort),
        "path=/",
      ], {
        stdio: "ignore",
      });
      child.on("error", () => {
        this.bonjourActive = false;
      });
      child.on("exit", () => {
        if (this.bonjourProcess === child) {
          this.bonjourProcess = null;
          this.bonjourActive = false;
        }
      });
      this.bonjourProcess = child;
      this.bonjourActive = true;
    } catch {
      this.bonjourActive = false;
    }
  }

  stopBonjour() {
    if (this.bonjourProcess) {
      try {
        this.bonjourProcess.kill("SIGTERM");
      } catch {
        // Ignore cleanup failure
      }
      this.bonjourProcess = null;
    }
    this.bonjourActive = false;
  }

  async handleRequest(req, res) {
    const remoteIp = normalizeIp(req.socket?.remoteAddress);
    if (!isPrivateLanAddress(remoteIp)) {
      sendJson(res, 403, { error: "仅允许局域网内网地址访问此控制面板" });
      return;
    }

    const port = this.boundPort || this.state.port;
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, lanCorsHeaders());
      res.end();
      return;
    }

    if (req.method === "GET" && pathname === "/api/lan-auth/status") {
      const session = this.getSession(req);
      sendJson(res, 200, {
        lanMode: true,
        authenticated: Boolean(session),
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/lan-auth/login") {
      await this.handleLogin(req, res, remoteIp);
      return;
    }

    if (req.method === "POST" && pathname === "/api/lan-auth/logout") {
      const sid = parseCookie(req.headers.cookie, COOKIE_NAME);
      if (sid) this.sessions.delete(sid);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      });
      res.end(`${JSON.stringify({ ok: true })}\n`);
      return;
    }

    // Hard security boundaries on LAN interface
    if (pathname === "/api/onebot/event") {
      sendJson(res, 403, { error: "OneBot event callback is restricted to loopback" });
      return;
    }
    if (pathname.startsWith("/api/lan-panel/")) {
      sendJson(res, 403, { error: "局域网广播配置仅限在本机控制台修改" });
      return;
    }

    const session = this.getSession(req);

    if (pathname === "/login" || pathname === "/login.html") {
      await this.serveStatic(req, res, "/login.html");
      return;
    }

    if (STATIC_ASSET_PATHS.has(pathname)) {
      await this.serveStatic(req, res, pathname);
      return;
    }

    if (!pathname.startsWith("/api/")) {
      if (!session) {
        res.writeHead(302, { location: "/login.html", "cache-control": "no-store" });
        res.end();
        return;
      }
      await this.serveStatic(req, res, pathname);
      return;
    }

    if (!session) {
      sendJson(res, 401, { error: "请先登录局域网控制面板" });
      return;
    }

    const rawBody = req.method === "POST" ? await readRawBody(req) : null;
    await this.handleAuthorizedApi(req, res, url, rawBody);
  }

  async handleLogin(req, res, remoteIp) {
    const now = this.clock();
    const failureState = this.loginFailures.get(remoteIp);
    if (failureState && now < failureState.blockedUntil) {
      const retryAfterSeconds = Math.max(1, Math.ceil((failureState.blockedUntil - now) / 1000));
      sendJson(res, 429, {
        error: `登录失败次数过多，请 ${retryAfterSeconds} 秒后再试`,
        retryAfterSeconds,
      });
      return;
    }

    if (req.headers["content-type"] && !String(req.headers["content-type"]).toLowerCase().startsWith("application/json")) {
      sendJson(res, 415, { error: "Content-Type must be application/json" });
      return;
    }

    const rawBody = await readRawBody(req);
    let body = {};
    try {
      body = rawBody?.length ? JSON.parse(rawBody.toString("utf8")) : {};
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const password = String(body.password || "");
    const ok = verifyPassword(password, this.state.passwordSalt, this.state.passwordHash);
    if (!ok) {
      this.recordLoginFailure(remoteIp, now);
      sendJson(res, 401, { error: "密码不正确" });
      return;
    }

    this.loginFailures.delete(remoteIp);
    this.pruneExpiredSessions();
    const sid = randomBytes(32).toString("hex");
    this.sessions.set(sid, {
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      remoteIp,
    });

    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": `${COOKIE_NAME}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    });
    res.end(`${JSON.stringify({ ok: true })}\n`);
  }

  recordLoginFailure(ip, now) {
    const prev = this.loginFailures.get(ip);
    const windowValid = prev && now - prev.firstAttemptAt < RATE_LIMIT_WINDOW_MS;
    const count = windowValid ? prev.count + 1 : 1;
    const firstAttemptAt = windowValid ? prev.firstAttemptAt : now;
    const blockedUntil = count >= RATE_LIMIT_MAX_ATTEMPTS ? now + RATE_LIMIT_WINDOW_MS : 0;
    this.loginFailures.set(ip, { count, firstAttemptAt, blockedUntil });
  }

  getSession(req) {
    this.pruneExpiredSessions();
    const sid = parseCookie(req.headers.cookie, COOKIE_NAME);
    if (!sid) return null;
    const entry = this.sessions.get(sid);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock()) {
      this.sessions.delete(sid);
      return null;
    }
    return entry;
  }

  pruneExpiredSessions() {
    const now = this.clock();
    for (const [sid, entry] of this.sessions) {
      if (entry.expiresAt <= now) this.sessions.delete(sid);
    }
  }

  save() {
    const payload = JSON.stringify(this.state, null, 2);
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    this.saveChain = this.saveChain.catch(() => {}).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporary, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    return this.saveChain;
  }
}

function lanUrlsForPort(port) {
  const urls = [];
  const interfaces = networkInterfaces();
  for (const [name, list] of Object.entries(interfaces)) {
    for (const info of list || []) {
      if (info.family === "IPv4" && !info.internal) {
        urls.push({ interface: name, address: info.address, url: `http://${info.address}:${port}` });
      }
    }
  }
  return urls;
}

function normalizePort(candidate, hubPort, fallback) {
  const num = Number(candidate);
  if (!Number.isInteger(num) || num < 1024 || num > 65535) return fallback;
  if (num === hubPort || RESERVED_PORTS.has(num)) return fallback;
  return num;
}

function validatePort(candidate, hubPort) {
  const num = Number(candidate);
  if (!Number.isInteger(num) || num < 1024 || num > 65535) {
    const err = new Error("局域网端口须为 1024–65535 之间的整数");
    err.statusCode = 400;
    throw err;
  }
  if (num === hubPort || RESERVED_PORTS.has(num)) {
    const err = new Error(`端口 ${num} 与系统服务冲突，请换用其他端口（如 3790）`);
    err.statusCode = 400;
    throw err;
  }
  return num;
}

function normalizeIp(address) {
  const value = String(address || "").trim();
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function parseCookie(cookieHeader, targetName) {
  if (!cookieHeader) return null;
  for (const part of String(cookieHeader).split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === targetName) return part.slice(eq + 1).trim();
  }
  return null;
}

async function readRawBody(req, limit = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const err = new Error("Request body is too large");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...lanCorsHeaders(),
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function lanCorsHeaders() {
  return {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
