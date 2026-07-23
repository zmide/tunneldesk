const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readSftpJobHistory, writeSftpJobHistoryAtomic } = require("../dist/sftp-job-store");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tunneldesk-faults-"));
try {
  const state = path.join(root, "sftp-jobs.json");
  fs.writeFileSync(state, "{\"jobs\":[", "utf8");
  assert.deepEqual(readSftpJobHistory(state), []);

  const rows = [
    { id: "older", created_at: 1, status: "failed" },
    { id: "newer", created_at: 2, status: "done" },
    null,
    "invalid"
  ];
  const saved = writeSftpJobHistoryAtomic(state, rows, 2);
  assert.deepEqual(saved.map(item => item.id), ["newer", "older"]);
  assert.deepEqual(readSftpJobHistory(state).map(item => item.id), ["newer", "older"]);
  assert.equal(fs.readdirSync(root).some(name => name.endsWith(".tmp")), false);

  fs.writeFileSync(`${state}.interrupted.tmp`, "{\"jobs\":", "utf8");
  assert.deepEqual(readSftpJobHistory(state).map(item => item.id), ["newer", "older"]);
  console.log("故障注入检查通过：损坏的 SFTP 状态自动隔离、原子状态不受中断临时文件影响");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
