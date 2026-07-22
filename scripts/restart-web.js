const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const parentPid = Number(process.argv[2]);
const payload = JSON.parse(Buffer.from(String(process.argv[3] || ""), "base64").toString("utf8"));

function running(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function main() {
  for (let attempt = 0; attempt < 120 && running(parentPid); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (running(parentPid)) throw new Error("旧 TunnelDesk 进程未能按时退出");
  fs.mkdirSync(path.dirname(payload.logFile), { recursive: true });
  const output = fs.openSync(payload.logFile, "a");
  const child = spawn(process.execPath, [payload.entry, ...(payload.args || [])], {
    cwd: payload.cwd,
    env: payload.env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", output, output]
  });
  child.unref();
}

main().catch(error => {
  try {
    fs.mkdirSync(path.dirname(payload.logFile), { recursive: true });
    fs.appendFileSync(payload.logFile, `[restart] ${error.stack || error.message}\n`, "utf8");
  } catch {}
  process.exitCode = 1;
});
