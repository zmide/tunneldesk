const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const database = require("../dist/db");
const { runSshCommandForConnection } = require("../dist/ssh");
const { deleteRemotePath, listRemoteDir, readRemoteTextFile, writeRemoteFile } = require("../dist/sftp");

async function main() {
  const connection = database.listConnections().find(item => item.group_name === "测试" && item.name === "测试");
  if (!connection) throw new Error('未找到“测试”分组中的“测试”连接');
  const fullConnection = database.getConnection(connection.id);
  const marker = `tunneldesk-real-check-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const remotePath = `./.tunneldesk-test-${crypto.randomUUID()}.txt`;
  let created = false;
  try {
    const command = await runSshCommandForConnection(fullConnection, `printf '%s' '${marker}'`, 20000);
    assert.equal(command.status, 0, command.stderr || command.error?.message || "SSH 命令失败");
    assert.equal(command.stdout, marker);

    await writeRemoteFile(connection.id, remotePath, Buffer.from(`${marker}\n`, "utf8"));
    created = true;
    const text = await readRemoteTextFile(connection.id, remotePath, "utf8");
    assert.equal(text.content, `${marker}\n`);
    assert.equal(text.encoding, "utf8");
    const listing = await listRemoteDir(connection.id, ".", { query:pathBasename(remotePath), refresh:true, page_size:10 });
    assert.equal(listing.entries.some(item => item.name === pathBasename(remotePath)), true);
    console.log(`真实连接检查通过：${connection.name} 的 SSH 命令、SFTP 写入/读取/列举`);
  } finally {
    if (created) {
      try { await deleteRemotePath(connection.id, remotePath); } catch (error) {
        console.error(`清理远端测试文件失败：${error.message}`);
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
