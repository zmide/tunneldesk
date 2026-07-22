const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");
const { Server } = require("ssh2");
const { openSshShell } = require("../dist/ssh2-client");

const expected = Buffer.from("a\x7f\x1b[A\x1b[B\x1b[C\x1b[D");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tunneldesk-pty-"));
const keyFile = path.join(tempDir, "id_rsa");
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" }
});
fs.writeFileSync(keyFile, privateKey, { mode: 0o600 });

let client = null;
let stream = null;
let server = null;

function closeAll() {
  try { stream?.close(); } catch {}
  try { client?.end(); } catch {}
  try { server?.close(); } catch {}
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

async function main() {
  let received = Buffer.alloc(0);
  server = new Server({ hostKeys: [privateKey] }, (connection) => {
    connection.on("authentication", context => context.accept());
    connection.on("ready", () => {
      connection.once("session", accept => {
        const session = accept();
        session.once("pty", acceptPty => acceptPty?.());
        session.once("shell", acceptShell => {
          const channel = acceptShell();
          channel.on("data", chunk => {
            received = Buffer.concat([received, chunk]);
            if (received.length >= expected.length) channel.end();
          });
        });
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  ({ client, stream } = await openSshShell({
    auth_type: "key",
    ssh_host: "127.0.0.1",
    ssh_port: address.port,
    ssh_user: "test",
    identity_file: keyFile
  }, { term: "xterm-256color", cols: 100, rows: 30 }));

  stream.write(expected);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("远程 PTY 按键序列验证超时")), 5000);
    const check = () => {
      if (received.length < expected.length) return setTimeout(check, 10);
      clearTimeout(timer);
      resolve();
    };
    check();
  });

  if (!received.subarray(0, expected.length).equals(expected)) {
    throw new Error(`远程 PTY 按键序列不一致：${received.toString("hex")}`);
  }
  console.log("远程 PTY 按键序列验证通过：Backspace/Delete、上、下、右、左");
}

main().then(() => {
  closeAll();
}).catch(error => {
  closeAll();
  console.error(error);
  process.exitCode = 1;
});
