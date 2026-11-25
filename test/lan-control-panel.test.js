import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LanControlServer, hashPassword, isPrivateLanAddress, verifyPassword } from "../src/network/lan-control-server.js";

test("isPrivateLanAddress accepts RFC1918/loopback/link-local/ULA and rejects public IPs", () => {
  assert.equal(isPrivateLanAddress("127.0.0.1"), true);
  assert.equal(isPrivateLanAddress("::1"), true);
  assert.equal(isPrivateLanAddress("::ffff:192.168.1.42"), true);
  assert.equal(isPrivateLanAddress("10.0.0.5"), true);
  assert.equal(isPrivateLanAddress("172.16.4.8"), true);
  assert.equal(isPrivateLanAddress("172.31.255.1"), true);
  assert.equal(isPrivateLanAddress("192.168.31.100"), true);
  assert.equal(isPrivateLanAddress("169.254.12.3"), true);
  assert.equal(isPrivateLanAddress("fe80::1%en0"), true);
  assert.equal(isPrivateLanAddress("fd12:3456:789a::1"), true);

  assert.equal(isPrivateLanAddress("8.8.8.8"), false);
  assert.equal(isPrivateLanAddress("172.32.0.1"), false);
  assert.equal(isPrivateLanAddress("1.2.3.4"), false);
  assert.equal(isPrivateLanAddress(""), false);
});

test("hashPassword and verifyPassword round-trip securely", () => {
  const { salt, hash } = hashPassword("my-lan-secret-123");
  assert.equal(verifyPassword("my-lan-secret-123", salt, hash), true);
  assert.equal(verifyPassword("wrong-secret", salt, hash), false);
});

test("LanControlServer enforces password, cookie auth, rate limiting, and host-only security boundaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qq-lan-panel-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const publicDir = fileURLToPath(new URL("../modules/web-console/public", import.meta.url));
  let nowMs = 1_700_000_000_000;
  let apiCalls = 0;

  const lanServer = new LanControlServer({
    filePath: join(root, "lan-panel.json"),
    hubPort: 3789,
    publicDir,
    disableBonjour: true,
    clock: () => nowMs,
    serveStatic: async (_req, res, path) => {
      const content = await readFile(join(publicDir, path === "/" ? "client.html" : path.slice(1)));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(content);
    },
    handleAuthorizedApi: async (_req, res, url) => {
      apiCalls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: url.pathname }));
    }
  });
  await lanServer.init();
  t.after(() => lanServer.close());

  // Refuses enabling without password
  await assert.rejects(
    lanServer.configure({ enabled: true, port: 14790 }),
    /密码/u
  );
  // Refuses invalid port 0
  await assert.rejects(
    lanServer.configure({ enabled: true, port: 0, password: "lan-password-1" }),
    /1024–65535/u
  );
  // Refuses conflicting ports
  await assert.rejects(
    lanServer.configure({ enabled: true, port: 3789, password: "lan-password-1" }),
    /冲突/u
  );

  const status = await lanServer.configure({
    enabled: true,
    port: 14790,
    bonjourEnabled: false,
    password: "lan-password-1"
  }).catch(async () => {
    // Fallback if port 14790 happened to be occupied in CI
    return lanServer.configure({
      enabled: true,
      port: 24790,
      bonjourEnabled: false,
      password: "lan-password-1"
    });
  });

  assert.equal(status.enabled, true);
  assert.equal(status.running, true);
  assert.equal(status.hasPassword, true);
  const base = `http://127.0.0.1:${status.port}`;

  // Unauthenticated /client.html redirects to /login.html
  const unauthPage = await fetch(`${base}/client.html`, { redirect: "manual" });
  assert.equal(unauthPage.status, 302);
  assert.equal(unauthPage.headers.get("location"), "/login.html");

  // Unauthenticated API returns 401
  const unauthApi = await fetch(`${base}/api/state`);
  assert.equal(unauthApi.status, 401);

  // Blocked host-only routes always return 403 on LAN port
  const onebotBlocked = await fetch(`${base}/api/onebot/event`, { method: "POST", body: "{}" });
  assert.equal(onebotBlocked.status, 403);
  const lanCfgBlocked = await fetch(`${base}/api/lan-panel/status`);
  assert.equal(lanCfgBlocked.status, 403);

  // Rate-limiting after 5 wrong passwords
  for (let i = 0; i < 5; i++) {
    const bad = await fetch(`${base}/api/lan-auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" })
    });
    assert.equal(bad.status, 401);
  }
  const locked = await fetch(`${base}/api/lan-auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "lan-password-1" })
  });
  assert.equal(locked.status, 429);

  // Advance clock past 5 min cooldown and login successfully
  nowMs += 6 * 60 * 1000;
  const loginRes = await fetch(`${base}/api/lan-auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "lan-password-1" })
  });
  assert.equal(loginRes.status, 200);
  const cookieHeader = loginRes.headers.get("set-cookie");
  assert.ok(cookieHeader && cookieHeader.includes("laodai_lan_session="));
  const cookie = cookieHeader.split(";")[0];

  // Authenticated API succeeds
  const authedState = await fetch(`${base}/api/state`, {
    headers: { cookie }
  });
  assert.equal(authedState.status, 200);
  assert.equal(apiCalls, 1);

  // OneBot and lan-panel remain 403 even when logged in
  const authedLanCfg = await fetch(`${base}/api/lan-panel/config`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(authedLanCfg.status, 403);

  // Password change revokes active session
  await lanServer.configure({ password: "lan-password-2" });
  const afterReset = await fetch(`${base}/api/state`, { headers: { cookie } });
  assert.equal(afterReset.status, 401);

  // Re-login and logout cleanly
  const login2 = await fetch(`${base}/api/lan-auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "lan-password-2" })
  });
  assert.equal(login2.status, 200);
  const cookie2 = login2.headers.get("set-cookie").split(";")[0];
  const logoutRes = await fetch(`${base}/api/lan-auth/logout`, {
    method: "POST",
    headers: { cookie: cookie2 }
  });
  assert.equal(logoutRes.status, 200);
  const afterLogout = await fetch(`${base}/api/state`, { headers: { cookie: cookie2 } });
  assert.equal(afterLogout.status, 401);
});
