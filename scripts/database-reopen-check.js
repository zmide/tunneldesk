const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunneldesk-db-reopen-"));
process.env.TUNNELDESK_DATA_DIR = path.join(temporaryRoot, "data");
process.env.TUNNELDESK_SSH_DIR = path.join(temporaryRoot, ".ssh");

const database = require("../dist/db");

try {
  const id = database.insertConnection({
    name: "reopen-check",
    group_name: "测试",
    ssh_host: "example.invalid",
    ssh_port: 22,
    ssh_user: "root",
    auth_type: "key",
    identity_file: ""
  }, "");
  assert.ok(id > 0);
  database.closeDatabase();
  database.reopenDatabase();
  const restored = database.listConnections().find(item => item.id === id);
  assert.equal(restored?.name, "reopen-check");
  assert.equal(restored?.identity_file, null);
  console.log("Database close/reopen lifecycle passed.");
} finally {
  try { database.closeDatabase(); } catch {}
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
