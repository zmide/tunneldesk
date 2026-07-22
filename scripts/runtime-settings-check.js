const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  normalizeListenHosts,
  normalizeListenPort,
  normalizeRuntimeSettings
} = require("../dist/runtime-settings");

const root = path.resolve(__dirname, "..");
const temporaryRoots = [];

function closeServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise(resolve => server.close(() => resolve()));
}

function listen(host, port = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host, port }, () => {
      server.removeListener("error", reject);
      resolve({ server, port: server.address().port });
    });
  });
}

async function freePort() {
  const { server, port } = await listen("127.0.0.1");
  await closeServer(server);
  return port;
}

async function waitForFile(file, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function waitForExit(child, timeoutMs = 8000) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : {} };
}

async function main() {
  assert.deepEqual(normalizeListenHosts(["127.0.0.1", "0.0.0.0", "127.0.0.1"]), ["0.0.0.0"]);
  assert.deepEqual(normalizeRuntimeSettings({ listen_hosts: "127.0.0.1,127.0.0.2", listen_port: "8123" }), {
    schema_version: 2,
    listen_hosts: ["127.0.0.1", "127.0.0.2"],
    listen_port: 8123,
    sftp_recycle_bin_enabled: false
  });
  assert.equal(normalizeRuntimeSettings({ sftp_recycle_bin_enabled: true }).sftp_recycle_bin_enabled, true);
  assert.equal(normalizeRuntimeSettings({}, { sftp_recycle_bin_enabled: true }).sftp_recycle_bin_enabled, true);
  assert.throws(() => normalizeListenPort(0), /1-65535/);
  assert.throws(() => normalizeListenHosts(["not-an-ip"]), /IPv4/);
  console.log("PASS runtime listener normalization");

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunneldesk-runtime-settings-check-"));
  temporaryRoots.push(temporaryRoot);
  const dataDir = path.join(temporaryRoot, "data");
  const sshDir = path.join(temporaryRoot, ".ssh");
  const runtimeFile = path.join(dataDir, "runtime-settings.json");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(sshDir, { recursive: true });

  let child = null;
  let startupBlocker = null;
  let checkBlocker = null;
  try {
    const occupied = await listen("127.0.0.1");
    startupBlocker = occupied.server;
    fs.writeFileSync(runtimeFile, JSON.stringify({
      listen_hosts: ["127.0.0.1", "127.0.0.2"],
      listen_port: occupied.port,
      sftp_recycle_bin_enabled: true
    }, null, 2), "utf8");

    child = spawn(process.execPath, [path.join(root, "dist", "server.js")], {
      cwd: root,
      env: {
        ...process.env,
        TUNNELDESK_DATA_DIR: dataDir,
        TUNNELDESK_SSH_DIR: sshDir,
        TUNNELDESK_DISABLE_UPDATE_CHECK: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let childOutput = "";
    child.stdout.on("data", chunk => { childOutput += chunk; });
    child.stderr.on("data", chunk => { childOutput += chunk; });

    const info = await waitForFile(path.join(dataDir, "web.json"));
    assert.equal(info.requested_port, occupied.port);
    assert.equal(info.actual_port, occupied.port + 1);
    assert.equal(info.fallback_count, 1);
    assert.deepEqual(info.actual_hosts, ["127.0.0.1", "127.0.0.2"]);
    assert.equal(info.urls.includes(info.local_url), true);
    const persistedAfterFallback = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    assert.equal(persistedAfterFallback.listen_port, info.actual_port);
    assert.equal(persistedAfterFallback.sftp_recycle_bin_enabled, true);
    console.log("PASS multi-address startup uses one fallback port and persists it");

    const base = info.local_url;
    const currentCheck = await request(base, "/api/runtime-settings/check", {
      method: "POST",
      body: JSON.stringify({ listen_hosts: info.actual_hosts, listen_port: info.actual_port })
    });
    assert.equal(currentCheck.response.ok, true);
    assert.equal(currentCheck.body.available, true);
    assert.equal(currentCheck.body.occupied_by_current, true);
    assert.equal(currentCheck.body.requested_port, info.actual_port);

    const settings = await request(base, "/api/runtime-settings");
    assert.equal(settings.response.ok, true);
    assert.deepEqual(settings.body.saved.listen_hosts, ["127.0.0.1", "127.0.0.2"]);
    assert.equal(settings.body.saved.listen_port, info.actual_port);
    assert.equal(settings.body.saved.sftp_recycle_bin_enabled, true);
    assert.equal(settings.body.effective.listen_port, info.actual_port);
    assert.equal(settings.body.local_url, base);
    assert.deepEqual(settings.body.actual_hosts, ["127.0.0.1", "127.0.0.2"]);
    console.log("PASS runtime settings API reports saved and actual listener state");

    const recycleDisabled = await request(base, "/api/runtime-settings", {
      method: "PUT",
      body: JSON.stringify({ sftp_recycle_bin_enabled: false })
    });
    assert.equal(recycleDisabled.response.ok, true);
    assert.equal(recycleDisabled.body.saved.sftp_recycle_bin_enabled, false);
    assert.deepEqual(recycleDisabled.body.saved.listen_hosts, ["127.0.0.1", "127.0.0.2"]);
    assert.equal(recycleDisabled.body.saved.listen_port, info.actual_port);
    console.log("PASS SFTP recycle setting saves independently without listener validation");

    const blocked = await listen("127.0.0.1");
    checkBlocker = blocked.server;
    const unavailable = await request(base, "/api/runtime-settings/check", {
      method: "POST",
      body: JSON.stringify({ listen_hosts: ["127.0.0.1"], listen_port: blocked.port })
    });
    assert.equal(unavailable.response.ok, true);
    assert.equal(unavailable.body.available, false);
    assert.equal(unavailable.body.occupied_by_current, false);
    assert.equal(unavailable.body.requested_port, blocked.port);
    assert.ok(unavailable.body.suggested_port > blocked.port);

    const rejectedSave = await request(base, "/api/runtime-settings", {
      method: "PUT",
      body: JSON.stringify({ listen_hosts: ["127.0.0.1"], listen_port: blocked.port })
    });
    assert.equal(rejectedSave.response.status, 409);
    assert.equal(rejectedSave.body.available, false);
    console.log("PASS occupied external port is reported and rejected on save");

    const nextPort = await freePort();
    const saved = await request(base, "/api/runtime-settings", {
      method: "PUT",
      body: JSON.stringify({ listen_hosts: ["127.0.0.1"], listen_port: nextPort })
    });
    assert.equal(saved.response.ok, true);
    assert.deepEqual(saved.body.saved.listen_hosts, ["127.0.0.1"]);
    assert.equal(saved.body.saved.listen_port, nextPort);
    assert.equal(saved.body.saved.sftp_recycle_bin_enabled, false);
    assert.equal(saved.body.restart_required, true);
    console.log("PASS valid listener configuration saves for the next restart");

    const shutdown = await request(base, "/api/shutdown", { method: "POST", body: "{}" });
    assert.equal(shutdown.response.ok, true);
    await waitForExit(child);
    assert.notEqual(child.exitCode, null, `Server did not exit. Output: ${childOutput}`);
  } finally {
    if (child && child.exitCode === null) child.kill();
    if (child) await waitForExit(child, 2000);
    await closeServer(checkBlocker);
    await closeServer(startupBlocker);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  for (const directory of temporaryRoots) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});
