const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function availablePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`认证验证服务器提前退出，退出码 ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/auth/status`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("等待认证验证服务器启动超时");
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tunneldesk-auth-integration-"));
  const previousData = process.env.TUNNELDESK_DATA_DIR;
  const previousSsh = process.env.TUNNELDESK_SSH_DIR;
  process.env.TUNNELDESK_DATA_DIR = path.join(root, "data");
  process.env.TUNNELDESK_SSH_DIR = path.join(root, ".ssh");
  const password = `Td-${crypto.randomBytes(18).toString("base64url")}`;
  const security = require("../dist/security");
  security.setPassword(password);
  security.updateSecurityOptions({
    auth_mode: "always",
    secure_cookie_mode: "always",
    trusted_proxy_enabled: true,
    trusted_proxy_addresses: ["127.0.0.1"],
    session_ttl_minutes: 90,
    session_max_sessions: 7,
    session_cleanup_minutes: 2
  });
  assert.throws(
    () => security.updateSecurityOptions({ session_ttl_minutes:4 }),
    /会话有效期必须是 5-43200 之间的整数/
  );
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join("dist", "server.js"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: path.resolve(__dirname, ".."),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const output = [];
  server.stdout.on("data", chunk => output.push(chunk.toString()));
  server.stderr.on("data", chunk => output.push(chunk.toString()));
  try {
    await waitForServer(url, server);
    assert.equal((await fetch(`${url}/api/about`)).status, 401);
    for (let index = 0; index < 4; index += 1) {
      const response = await fetch(`${url}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type":"application/json", "X-Forwarded-For":"192.0.2.10" },
        body: JSON.stringify({ password:"wrong-password" })
      });
      assert.equal(response.status, 401);
    }
    const locked = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type":"application/json", "X-Forwarded-For":"192.0.2.10" },
      body: JSON.stringify({ password:"wrong-password" })
    });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get("retry-after")) >= 1);

    const login = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type":"application/json", "X-Forwarded-For":"192.0.2.11" },
      body: JSON.stringify({ password })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /td_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Max-Age=5400/);
    const sessionCookie = cookie.split(";")[0];
    assert.equal((await fetch(`${url}/api/about`, { headers:{Cookie:sessionCookie} })).status, 200);
    const sessionSettingsResponse = await fetch(`${url}/api/security`, {
      method:"PUT",
      headers:{Cookie:sessionCookie, "Content-Type":"application/json"},
      body:JSON.stringify({
        session_ttl_minutes:60,
        session_max_sessions:6,
        session_cleanup_minutes:3
      })
    });
    assert.equal(sessionSettingsResponse.status, 200);
    const sessionSettings = await sessionSettingsResponse.json();
    assert.deepEqual(sessionSettings.session_management, {
      ttl_minutes:60,
      max_sessions:6,
      cleanup_minutes:3,
      limits:{
        ttl_minutes:{min:5,max:43200},
        max_sessions:{min:1,max:10000},
        cleanup_minutes:{min:1,max:1440}
      }
    });
    assert.equal(sessionSettings.active_sessions, 1);
    assert.equal((await fetch(`${url}/api/auth/logout`, {
      method:"POST",
      headers:{Cookie:sessionCookie, "Content-Type":"application/json"},
      body:"{}"
    })).status, 200);
    assert.equal((await fetch(`${url}/api/about`, { headers:{Cookie:sessionCookie} })).status, 401);
    console.log("Web 登录集成检查通过：来源锁定、Retry-After、随机密码、会话策略保存、动态 Cookie 有效期和注销");
  } catch (error) {
    if (output.length) console.error(output.join("").slice(-12000));
    throw error;
  } finally {
    try { server.kill("SIGTERM"); } catch {}
    await new Promise(resolve => {
      if (server.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        try { server.kill("SIGKILL"); } catch {}
        resolve();
      }, 3000);
      server.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    fs.rmSync(root, { recursive:true, force:true });
    if (previousData === undefined) delete process.env.TUNNELDESK_DATA_DIR;
    else process.env.TUNNELDESK_DATA_DIR = previousData;
    if (previousSsh === undefined) delete process.env.TUNNELDESK_SSH_DIR;
    else process.env.TUNNELDESK_SSH_DIR = previousSsh;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
