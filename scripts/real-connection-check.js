const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const database = require("../dist/db");
const { runSshCommandForConnection } = require("../dist/ssh");
const { openSshShell } = require("../dist/ssh2-client");
const { deleteRemotePath, listRemoteDir, makeRemoteDir, readRemoteDirectorySize, readRemoteTextFile, writeRemoteFile } = require("../dist/sftp");

function waitForTerminalText(stream, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("真实终端回显验证超时")), timeoutMs);
    const onData = chunk => {
      output += Buffer.from(chunk).toString("latin1");
      if (predicate(output)) finish(null, output);
    };
    const finish = (error, value = "") => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      if (error) reject(error);
      else resolve(value);
    };
    stream.on("data", onData);
  });
}

async function checkTerminalInteraction(connection, marker) {
  const { client, stream } = await openSshShell(connection, { term:"xterm-256color", cols:100, rows:30 });
  try {
    await Promise.race([
      waitForTerminalText(stream, output => /[%$#>]\s*$/.test(output), 8000),
      new Promise(resolve => setTimeout(resolve, 1200))
    ]);
    const probe = "Qz9_";
    const startedAt = Date.now();
    const echoed = waitForTerminalText(stream, output => output.includes(probe), 5000);
    stream.write(probe);
    await echoed;
    const echoLatencyMs = Date.now() - startedAt;
    stream.write("\x7f".repeat(probe.length));
    const commandOutput = waitForTerminalText(stream, output => output.split(marker).length >= 3, 10000);
    stream.write(`printf '\\n${marker}\\n'\r`);
    await commandOutput;
    return echoLatencyMs;
  } finally {
    try { stream.close(); } catch {}
    try { client.end(); } catch {}
  }
}

async function main() {
  const requestedName = process.argv[2] || process.env.TUNNELDESK_TEST_CONNECTION_NAME || "测试";
  const requestedGroup = process.env.TUNNELDESK_TEST_CONNECTION_GROUP || "";
  const matches = database.listConnections().filter(item =>
    item.name === requestedName && (!requestedGroup || item.group_name === requestedGroup)
  );
  if (!matches.length) {
    const scope = requestedGroup ? `“${requestedGroup}”分组中的` : "";
    throw new Error(`未找到${scope}“${requestedName}”连接`);
  }
  if (matches.length > 1) {
    throw new Error(`存在多个名为“${requestedName}”的连接，请设置 TUNNELDESK_TEST_CONNECTION_GROUP 指定分组`);
  }
  const connection = matches[0];
  const fullConnection = database.getConnection(connection.id);
  const marker = `tunneldesk-real-check-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const remoteDirectory = `./.tunneldesk-test-${crypto.randomUUID()}`;
  const remotePath = `${remoteDirectory}/marker.txt`;
  const nestedDirectory = `${remoteDirectory}/nested`;
  const nestedPath = `${nestedDirectory}/payload.bin`;
  const markerBody = Buffer.from(`${marker}\n`, "utf8");
  const nestedBody = Buffer.alloc(4097, 0x61);
  let created = false;
  try {
    const command = await runSshCommandForConnection(fullConnection, `printf '%s' '${marker}'`, 20000);
    assert.equal(command.status, 0, command.stderr || command.error?.message || "SSH 命令失败");
    assert.equal(command.stdout, marker);

    await makeRemoteDir(connection.id, nestedDirectory);
    created = true;
    await writeRemoteFile(connection.id, remotePath, markerBody);
    await writeRemoteFile(connection.id, nestedPath, nestedBody);
    const text = await readRemoteTextFile(connection.id, remotePath, "utf8");
    assert.equal(text.content, `${marker}\n`);
    assert.equal(text.encoding, "utf8");
    const rootListing = await listRemoteDir(connection.id, ".", { query:pathBasename(remoteDirectory), refresh:true, page_size:10 });
    assert.equal(rootListing.entries.some(item => item.name === pathBasename(remoteDirectory) && item.type === "dir"), true);
    const childListing = await listRemoteDir(connection.id, remoteDirectory, { refresh:true, page_size:10 });
    assert.equal(childListing.entries.some(item => item.name === "marker.txt"), true);
    assert.equal(childListing.entries.some(item => item.name === "nested" && item.type === "dir"), true);
    const nestedListing = await listRemoteDir(connection.id, nestedDirectory, { refresh:true, page_size:10 });
    assert.equal(nestedListing.entries.some(item => item.name === "payload.bin" && item.size === nestedBody.length), true);
    const returnedListing = await listRemoteDir(connection.id, ".", { query:pathBasename(remoteDirectory), refresh:true, page_size:10 });
    assert.equal(returnedListing.entries.some(item => item.name === pathBasename(remoteDirectory)), true);
    const directorySize = await readRemoteDirectorySize(connection.id, remoteDirectory);
    assert.equal(directorySize.size_bytes, String(markerBody.length + nestedBody.length));
    const terminalLatency = await checkTerminalInteraction(fullConnection, marker);
    console.log(`真实连接检查通过：${connection.name} 的 SSH 命令、SFTP 进入/返回/递归精确大小 ${directorySize.size_bytes} 字节、PTY 回显 ${terminalLatency}ms`);
  } finally {
    if (created) {
      try { await deleteRemotePath(connection.id, remoteDirectory); } catch (error) {
        console.error(`清理远端测试目录失败：${error.message}`);
        process.exitCode = 1;
      }
    }
    try { database.closeDatabase(); } catch {}
  }
}

function pathBasename(value) {
  return String(value).replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
}

main().catch(error => {
  console.error(error);
  try { database.closeDatabase(); } catch {}
  process.exitCode = 1;
});
