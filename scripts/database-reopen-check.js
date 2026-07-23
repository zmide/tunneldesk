const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunneldesk-db-reopen-"));
process.env.TUNNELDESK_DATA_DIR = path.join(temporaryRoot, "data");
process.env.TUNNELDESK_SSH_DIR = path.join(temporaryRoot, ".ssh");
fs.mkdirSync(process.env.TUNNELDESK_DATA_DIR, {recursive:true});
const legacy = new DatabaseSync(path.join(process.env.TUNNELDESK_DATA_DIR, "tunnels.db"));
legacy.exec(`CREATE TABLE connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '默认分组',
  ssh_host TEXT NOT NULL, ssh_port INTEGER NOT NULL DEFAULT 22, ssh_user TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'key', identity_file TEXT, ssh_password TEXT, tags TEXT, extra_args TEXT,
  autostart_forwards INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);`);
const legacyInsert = legacy.prepare("INSERT INTO connections(name,group_name,ssh_host,ssh_port,ssh_user,auth_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
legacyInsert.run("legacy-a", "测试", "a.invalid", 22, "root", "key", 1, 1);
legacyInsert.run("legacy-b", "测试", "b.invalid", 22, "root", "key", 2, 2);
legacy.close();

const database = require("../dist/db");

try {
  const migrated = database.listConnections();
  assert.deepEqual(migrated.map(item => item.sort_order), [1, 1]);
  assert.deepEqual(migrated.map(item => [item.terminal_line_height, item.terminal_font_weight]), [[1, "normal"], [1, "normal"]]);
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
  assert.deepEqual(database.listConnections().map(item => item.name), ["legacy-a", "legacy-b", "reopen-check"]);
  const display = database.updateTerminalPreferences(id, {
    terminal_encoding: "gb18030",
    terminal_font_family: "Cascadia Mono, monospace",
    terminal_font_size: 16,
    terminal_line_height: 1.4,
    terminal_font_weight: "600"
  });
  assert.deepEqual(display, {
    terminal_encoding: "gb18030",
    terminal_font_family: "Cascadia Mono, monospace",
    terminal_font_size: 16,
    terminal_line_height: 1.4,
    terminal_font_weight: "600"
  });
  assert.throws(() => database.updateTerminalPreferences(id, { terminal_line_height: 2.5 }), /行距/);
  const snapshot = database.exportConfigSnapshot();
  database.updateTerminalPreferences(id, { terminal_line_height:1.6, terminal_font_weight:"bold" });
  database.restoreConfigSnapshot(snapshot);
  assert.equal(database.getConnection(id).terminal_line_height, 1.4);
  assert.equal(database.getConnection(id).terminal_font_weight, "600");
  database.updateConnection(2, {...database.getConnection(2), sort_order:2}, "");
  assert.deepEqual(database.listConnections().map(item => item.name), ["legacy-a", "reopen-check", "legacy-b"]);
  database.closeDatabase();
  database.reopenDatabase();
  const restored = database.listConnections().find(item => item.id === id);
  assert.equal(restored?.name, "reopen-check");
  assert.equal(restored?.identity_file, null);
  assert.equal(restored?.sort_order, 1);
  assert.equal(restored?.terminal_line_height, 1.4);
  assert.equal(restored?.terminal_font_weight, "600");
  console.log("Database close/reopen and connection ordering passed.");
} finally {
  try { database.closeDatabase(); } catch {}
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
