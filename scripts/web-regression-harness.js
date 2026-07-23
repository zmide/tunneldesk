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
      const port = typeof address === "object" && address ? address.port : 0;
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`验证服务器提前退出，退出码 ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/about`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("等待验证服务器启动超时");
}

function runRegression(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "regression-check.js")], {
      cwd: path.resolve(__dirname, ".."),
      env: environment,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`Web 回归退出码 ${code}`)));
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tunneldesk-web-regression-"));
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const output = [];
  const server = spawn(process.execPath, [path.join("dist", "server.js"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      TUNNELDESK_DATA_DIR: path.join(root, "data"),
      TUNNELDESK_SSH_DIR: path.join(root, ".ssh")
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stdout.on("data", chunk => output.push(chunk.toString()));
  server.stderr.on("data", chunk => output.push(chunk.toString()));
  try {
    await waitForServer(url, server);
    await runRegression({ ...process.env, TUNNELDESK_CHECK_URL:url });
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
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
