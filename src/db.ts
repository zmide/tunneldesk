const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { DATA_DIR, LOG_DIR, DB_PATH } = require("./config");
const { decryptText, encryptText } = require("./crypto-store");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

let db: any = null;

function openDatabase() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
CREATE TABLE IF NOT EXISTS tunnels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('local', 'remote', 'socks')),
  ssh_host TEXT NOT NULL,
  ssh_port INTEGER NOT NULL DEFAULT 22,
  ssh_user TEXT NOT NULL,
  identity_file TEXT,
  bind_host TEXT NOT NULL DEFAULT '127.0.0.1',
  bind_port INTEGER NOT NULL,
  target_host TEXT,
  target_port INTEGER,
  forwards TEXT,
  extra_args TEXT,
  autostart INTEGER NOT NULL DEFAULT 0,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'stopped',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '默认分组',
  ssh_host TEXT NOT NULL,
  ssh_port INTEGER NOT NULL DEFAULT 22,
  ssh_user TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'key',
  identity_file TEXT,
  ssh_password TEXT,
  tags TEXT,
  extra_args TEXT,
  autostart_forwards INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 1,
  terminal_encoding TEXT NOT NULL DEFAULT 'utf8',
  terminal_font_family TEXT NOT NULL DEFAULT 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  terminal_font_size INTEGER NOT NULL DEFAULT 13,
  terminal_line_height REAL NOT NULL DEFAULT 1,
  terminal_font_weight TEXT NOT NULL DEFAULT 'normal',
  sftp_text_encoding TEXT NOT NULL DEFAULT 'auto',
  sftp_filename_encoding TEXT NOT NULL DEFAULT 'utf8',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connection_groups (
  name TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connection_forwards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('local', 'remote', 'socks')),
  service_name TEXT,
  service_type TEXT,
  service_note TEXT,
  url_scheme TEXT,
  bind_host TEXT NOT NULL DEFAULT '127.0.0.1',
  bind_port INTEGER NOT NULL,
  target_host TEXT,
  target_port INTEGER,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'stopped',
  restore INTEGER NOT NULL DEFAULT 0,
  reconnect_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS forward_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('local', 'remote', 'socks')),
  service_name TEXT,
  service_type TEXT,
  service_note TEXT,
  url_scheme TEXT,
  bind_host TEXT NOT NULL DEFAULT '127.0.0.1',
  bind_port INTEGER NOT NULL,
  target_host TEXT,
  target_port INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
  `);

  const connectionColumns = new Set(all("PRAGMA table_info(connections)").map((row) => row.name));
  if (!connectionColumns.has("autostart_forwards")) {
    run("ALTER TABLE connections ADD COLUMN autostart_forwards INTEGER NOT NULL DEFAULT 0");
  }
  if (!connectionColumns.has("tags")) run("ALTER TABLE connections ADD COLUMN tags TEXT");
  if (!connectionColumns.has("auth_type")) run("ALTER TABLE connections ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'key'");
  if (!connectionColumns.has("ssh_password")) run("ALTER TABLE connections ADD COLUMN ssh_password TEXT");
  if (!connectionColumns.has("sort_order")) {
    run("ALTER TABLE connections ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 1");
  }
  if (!connectionColumns.has("terminal_encoding")) run("ALTER TABLE connections ADD COLUMN terminal_encoding TEXT NOT NULL DEFAULT 'utf8'");
  if (!connectionColumns.has("terminal_font_family")) run("ALTER TABLE connections ADD COLUMN terminal_font_family TEXT NOT NULL DEFAULT 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'");
  if (!connectionColumns.has("terminal_font_size")) run("ALTER TABLE connections ADD COLUMN terminal_font_size INTEGER NOT NULL DEFAULT 13");
  if (!connectionColumns.has("terminal_line_height")) run("ALTER TABLE connections ADD COLUMN terminal_line_height REAL NOT NULL DEFAULT 1");
  if (!connectionColumns.has("terminal_font_weight")) run("ALTER TABLE connections ADD COLUMN terminal_font_weight TEXT NOT NULL DEFAULT 'normal'");
  if (!connectionColumns.has("sftp_text_encoding")) run("ALTER TABLE connections ADD COLUMN sftp_text_encoding TEXT NOT NULL DEFAULT 'auto'");
  if (!connectionColumns.has("sftp_filename_encoding")) run("ALTER TABLE connections ADD COLUMN sftp_filename_encoding TEXT NOT NULL DEFAULT 'utf8'");
  const existingGroups = all("SELECT DISTINCT group_name FROM connections ORDER BY group_name COLLATE NOCASE");
  existingGroups.forEach((row, index) => run(
    "INSERT OR IGNORE INTO connection_groups(name,sort_order,created_at,updated_at) VALUES(?,?,?,?)",
    [row.group_name, index + 1, now(), now()]
  ));
  run("UPDATE connection_forwards SET status='stopped' WHERE pid IS NULL AND status='running'");
  const forwardColumns = new Set(all("PRAGMA table_info(connection_forwards)").map((row) => row.name));
  if (!forwardColumns.has("service_name")) run("ALTER TABLE connection_forwards ADD COLUMN service_name TEXT");
  if (!forwardColumns.has("service_type")) run("ALTER TABLE connection_forwards ADD COLUMN service_type TEXT");
  if (!forwardColumns.has("service_note")) run("ALTER TABLE connection_forwards ADD COLUMN service_note TEXT");
  if (!forwardColumns.has("restore")) run("ALTER TABLE connection_forwards ADD COLUMN restore INTEGER NOT NULL DEFAULT 0");
  if (!forwardColumns.has("reconnect_count")) run("ALTER TABLE connection_forwards ADD COLUMN reconnect_count INTEGER NOT NULL DEFAULT 0");
  if (!forwardColumns.has("last_error")) run("ALTER TABLE connection_forwards ADD COLUMN last_error TEXT");
  if (!forwardColumns.has("started_at")) run("ALTER TABLE connection_forwards ADD COLUMN started_at INTEGER");
  if (!forwardColumns.has("url_scheme")) run("ALTER TABLE connection_forwards ADD COLUMN url_scheme TEXT");
  run("CREATE INDEX IF NOT EXISTS idx_connection_forwards_connection_id ON connection_forwards(connection_id,id)");
  run("CREATE INDEX IF NOT EXISTS idx_connections_group_sort ON connections(group_name,sort_order,created_at,id)");
  run("CREATE INDEX IF NOT EXISTS idx_connection_groups_sort ON connection_groups(sort_order,name)");
  return db;
}

openDatabase();

function now() {
  return Math.floor(Date.now() / 1000);
}

function run(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
}

function get(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.get(...params) : stmt.get(params);
}

function all(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
}

function validatePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} 必须在 1-65535 之间`);
  }
  return port;
}

function validateSortOrder(value) {
  const order = Number(value);
  if (!Number.isInteger(order) || order < 1 || order > 2147483647) {
    throw new Error("排序值必须是 1-2147483647 之间的整数");
  }
  return order;
}

const TERMINAL_ENCODINGS = new Set(["utf8", "gb18030", "gbk", "big5", "shift_jis", "euc-kr", "latin1"]);
const SFTP_TEXT_ENCODINGS = new Set(["auto", "utf8", "utf8bom", "gb18030", "gbk", "big5", "shift_jis", "euc-kr", "latin1"]);
const SFTP_FILENAME_ENCODINGS = new Set(["utf8", "gb18030", "gbk", "big5", "shift_jis", "euc-kr", "latin1"]);
const TERMINAL_FONT_WEIGHTS = new Set(["normal", "500", "600", "bold"]);
const DEFAULT_TERMINAL_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function cleanTerminalPreferences(data, existing = null) {
  const terminalEncoding = String(data.terminal_encoding ?? existing?.terminal_encoding ?? "utf8").toLowerCase();
  if (!TERMINAL_ENCODINGS.has(terminalEncoding)) throw new Error("不支持的终端编码");
  const terminalFontFamily = String(data.terminal_font_family ?? existing?.terminal_font_family ?? DEFAULT_TERMINAL_FONT).trim();
  if (!terminalFontFamily || terminalFontFamily.length > 300) throw new Error("终端字体设置长度必须在 1-300 个字符之间");
  const terminalFontSize = Number(data.terminal_font_size ?? existing?.terminal_font_size ?? 13);
  if (!Number.isInteger(terminalFontSize) || terminalFontSize < 10 || terminalFontSize > 32) throw new Error("终端字号必须是 10-32 之间的整数");
  const terminalLineHeight = Number(data.terminal_line_height ?? existing?.terminal_line_height ?? 1);
  if (!Number.isFinite(terminalLineHeight) || terminalLineHeight < 1 || terminalLineHeight > 2) throw new Error("终端行距必须在 1.0-2.0 之间");
  const terminalFontWeight = String(data.terminal_font_weight ?? existing?.terminal_font_weight ?? "normal").toLowerCase();
  if (!TERMINAL_FONT_WEIGHTS.has(terminalFontWeight)) throw new Error("不支持的终端字重");
  return {
    terminal_encoding: terminalEncoding,
    terminal_font_family: terminalFontFamily,
    terminal_font_size: terminalFontSize,
    terminal_line_height: Math.round(terminalLineHeight * 10) / 10,
    terminal_font_weight: terminalFontWeight
  };
}

function cleanSftpTextEncoding(value, fallback = "auto") {
  const encoding = String(value ?? fallback ?? "auto").toLowerCase();
  if (!SFTP_TEXT_ENCODINGS.has(encoding)) throw new Error("不支持的 SFTP 文本编码");
  return encoding;
}

function cleanSftpFilenameEncoding(value, fallback = "utf8") {
  const encoding = String(value ?? fallback ?? "utf8").toLowerCase();
  if (!SFTP_FILENAME_ENCODINGS.has(encoding)) throw new Error("不支持的 SFTP 文件名编码");
  return encoding;
}

function ensureConnectionGroup(name) {
  const groupName = String(name || "").trim();
  if (!groupName) return;
  const next = Number(get("SELECT COALESCE(MAX(sort_order),0)+1 AS value FROM connection_groups")?.value || 1);
  run("INSERT OR IGNORE INTO connection_groups(name,sort_order,created_at,updated_at) VALUES(?,?,?,?)", [groupName, next, now(), now()]);
}

function pidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function cleanConnection(data, defaultExtraArgs, existing = null) {
  for (const key of ["name", "ssh_host", "ssh_user"]) {
    if (!data[key]) throw new Error(`缺少字段: ${key}`);
  }
  const authType = String(data.auth_type || existing?.auth_type || "key") === "password" ? "password" : "key";
  if (authType === "key" && data.identity_file && !fs.existsSync(data.identity_file)) {
    throw new Error("私钥路径不存在");
  }
  const submittedPassword = String(data.ssh_password || "");
  const password = authType === "password"
    ? (submittedPassword || (existing?.ssh_password ? decryptText(existing.ssh_password) : ""))
    : "";
  if (authType === "password" && !password) throw new Error("密码登录需要填写 SSH 密码");
  return {
    name: String(data.name).trim(),
    group_name: String(data.group_name || "默认分组").trim() || "默认分组",
    ssh_host: String(data.ssh_host).trim(),
    ssh_port: validatePort(data.ssh_port || 22, "SSH 端口"),
    ssh_user: String(data.ssh_user).trim(),
    auth_type: authType,
    identity_file: authType === "key" && data.identity_file ? encryptText(String(data.identity_file).trim()) : null,
    ssh_password: password ? encryptText(password) : null,
    tags: String(data.tags || "").split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean).join(","),
    extra_args: encryptText(String(data.extra_args || defaultExtraArgs).trim()),
    autostart_forwards: Number(data.autostart_forwards || 0) ? 1 : 0,
    sort_order: validateSortOrder(data.sort_order ?? existing?.sort_order ?? 1),
    ...cleanTerminalPreferences(data, existing),
    sftp_text_encoding: cleanSftpTextEncoding(data.sftp_text_encoding, existing?.sftp_text_encoding),
    sftp_filename_encoding: cleanSftpFilenameEncoding(data.sftp_filename_encoding, existing?.sftp_filename_encoding)
  };
}

function cleanForward(data) {
  if (!["local", "remote", "socks"].includes(data.mode)) {
    throw new Error("转发类型只能是 local、remote 或 socks");
  }
  const item = {
    mode: data.mode,
    service_name: String(data.service_name || "").trim() || null,
    service_type: String(data.service_type || "").trim() || null,
    service_note: String(data.service_note || "").trim() || null,
    url_scheme: ["", "http", "https"].includes(String(data.url_scheme || "")) ? String(data.url_scheme || "") || null : null,
    bind_host: String(data.bind_host || "127.0.0.1").trim(),
    bind_port: validatePort(data.bind_port, "监听端口"),
    target_host: String(data.target_host || "127.0.0.1").trim(),
    target_port: data.target_port
  };
  if (item.mode === "socks") {
    item.target_host = null;
    item.target_port = null;
  } else {
    item.target_port = validatePort(item.target_port, "目标端口");
  }
  return item;
}

function listConnections() {
  const rows = all(`SELECT connections.*, connection_groups.sort_order AS group_sort_order
    FROM connections LEFT JOIN connection_groups ON connection_groups.name=connections.group_name
    ORDER BY COALESCE(connection_groups.sort_order,2147483647), connections.sort_order, connections.created_at, connections.id`);
  const forwardsByConnection = new Map();
  for (const forward of all("SELECT * FROM connection_forwards ORDER BY connection_id,id")) {
    const item = {
      ...forward,
      status: forward.pid && pidRunning(forward.pid) ? "running" : forward.status === "running" && !forward.pid ? "running" : forward.status === "failed" ? "failed" : "stopped",
      pid: forward.pid && pidRunning(forward.pid) ? forward.pid : null
    };
    if (!forwardsByConnection.has(forward.connection_id)) forwardsByConnection.set(forward.connection_id, []);
    forwardsByConnection.get(forward.connection_id).push(item);
  }
  return rows.map((conn) => ({
    ...conn,
    identity_file: decryptText(conn.identity_file),
    ssh_password: undefined,
    has_password: Boolean(conn.ssh_password),
    extra_args: decryptText(conn.extra_args),
    forwards: forwardsByConnection.get(conn.id) || []
  }));
}

function getConnection(id) {
  const row = get("SELECT * FROM connections WHERE id = ?", [Number(id)]);
  if (!row) throw new Error("连接不存在");
  return { ...row, identity_file: decryptText(row.identity_file), ssh_password: decryptText(row.ssh_password), extra_args: decryptText(row.extra_args) };
}

function getForward(id) {
  const row = get("SELECT * FROM connection_forwards WHERE id = ?", [Number(id)]);
  if (!row) throw new Error("转发不存在");
  return row;
}

function insertConnection(data, defaultExtraArgs) {
  const item = cleanConnection(data, defaultExtraArgs);
  ensureConnectionGroup(item.group_name);
  const ts = now();
  const result = run(
    `INSERT INTO connections
     (name, group_name, ssh_host, ssh_port, ssh_user, auth_type, identity_file, ssh_password, tags, extra_args, autostart_forwards, sort_order, terminal_encoding, terminal_font_family, terminal_font_size, terminal_line_height, terminal_font_weight, sftp_text_encoding, sftp_filename_encoding, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [item.name, item.group_name, item.ssh_host, item.ssh_port, item.ssh_user, item.auth_type, item.identity_file, item.ssh_password, item.tags, item.extra_args, item.autostart_forwards, item.sort_order, item.terminal_encoding, item.terminal_font_family, item.terminal_font_size, item.terminal_line_height, item.terminal_font_weight, item.sftp_text_encoding, item.sftp_filename_encoding, ts, ts]
  );
  return Number(result.lastInsertRowid);
}

function updateConnection(id, data, defaultExtraArgs) {
  const existing = get("SELECT * FROM connections WHERE id=?", [Number(id)]);
  if (!existing) throw new Error("连接不存在");
  const item = cleanConnection(data, defaultExtraArgs, existing);
  ensureConnectionGroup(item.group_name);
  run(
    `UPDATE connections SET name=?, group_name=?, ssh_host=?, ssh_port=?, ssh_user=?, auth_type=?, identity_file=?, ssh_password=?, tags=?, extra_args=?, autostart_forwards=?, sort_order=?, terminal_encoding=?, terminal_font_family=?, terminal_font_size=?, terminal_line_height=?, terminal_font_weight=?, sftp_text_encoding=?, sftp_filename_encoding=?, updated_at=? WHERE id=?`,
    [item.name, item.group_name, item.ssh_host, item.ssh_port, item.ssh_user, item.auth_type, item.identity_file, item.ssh_password, item.tags, item.extra_args, item.autostart_forwards, item.sort_order, item.terminal_encoding, item.terminal_font_family, item.terminal_font_size, item.terminal_line_height, item.terminal_font_weight, item.sftp_text_encoding, item.sftp_filename_encoding, now(), Number(id)]
  );
}

function updateTerminalPreferences(id, data) {
  const existing = get("SELECT * FROM connections WHERE id=?", [Number(id)]);
  if (!existing) throw new Error("连接不存在");
  const item = cleanTerminalPreferences(data, existing);
  run("UPDATE connections SET terminal_encoding=?,terminal_font_family=?,terminal_font_size=?,terminal_line_height=?,terminal_font_weight=?,updated_at=? WHERE id=?",
    [item.terminal_encoding, item.terminal_font_family, item.terminal_font_size, item.terminal_line_height, item.terminal_font_weight, now(), Number(id)]);
  return item;
}

function updateSftpTextEncoding(id, value) {
  getConnection(id);
  const encoding = cleanSftpTextEncoding(value);
  run("UPDATE connections SET sftp_text_encoding=?,updated_at=? WHERE id=?", [encoding, now(), Number(id)]);
  return { sftp_text_encoding: encoding };
}

function updateSftpFilenameEncoding(id, value) {
  getConnection(id);
  const encoding = cleanSftpFilenameEncoding(value);
  run("UPDATE connections SET sftp_filename_encoding=?,updated_at=? WHERE id=?", [encoding, now(), Number(id)]);
  return { sftp_filename_encoding: encoding };
}

function bulkUpdateConnections(connectionIds, changes: any = {}) {
  const ids = [...new Set((connectionIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) throw new Error("请选择要修改的 SSH 连接");
  if (ids.length > 500) throw new Error("单次最多批量修改 500 个 SSH 连接");

  const assignments = [];
  const values = [];
  if (Object.prototype.hasOwnProperty.call(changes, "group_name")) {
    const groupName = String(changes.group_name || "").trim();
    if (!groupName || groupName.length > 100) throw new Error("分组名称长度必须在 1-100 个字符之间");
    assignments.push("group_name=?");
    values.push(groupName);
    ensureConnectionGroup(groupName);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "ssh_port")) {
    assignments.push("ssh_port=?");
    values.push(validatePort(changes.ssh_port, "SSH 端口"));
  }
  if (changes.auth) {
    const authType = String(changes.auth.type || "");
    if (authType === "password") {
      const password = String(changes.auth.password || "");
      if (!password || password.length > 4096) throw new Error("SSH 密码长度必须在 1-4096 个字符之间");
      assignments.push("auth_type=?", "identity_file=?", "ssh_password=?");
      values.push("password", null, encryptText(password));
    } else if (authType === "key") {
      const identityFile = String(changes.auth.identity_file || "").trim();
      if (!identityFile || !fs.existsSync(identityFile)) throw new Error("请选择存在的私钥文件");
      assignments.push("auth_type=?", "identity_file=?", "ssh_password=?");
      values.push("key", encryptText(identityFile), null);
    } else {
      throw new Error("不支持的认证方式");
    }
  }
  if (!assignments.length) throw new Error("请至少选择一项批量设置");

  const placeholders = ids.map(() => "?").join(",");
  const existing = all(`SELECT id FROM connections WHERE id IN (${placeholders})`, ids);
  if (existing.length !== ids.length) throw new Error("部分 SSH 连接不存在，请刷新后重试");
  db.exec("BEGIN IMMEDIATE");
  try {
    const timestamp = now();
    for (const id of ids) {
      run(`UPDATE connections SET ${assignments.join(", ")}, updated_at=? WHERE id=?`, [...values, timestamp, id]);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { ok: true, updated: ids.length };
}

function renameConnectionGroup(currentName, nextName) {
  const source = String(currentName || "").trim();
  const target = String(nextName || "").trim();
  if (!source || source.length > 100 || !target || target.length > 100) {
    throw new Error("分组名称长度必须在 1-100 个字符之间");
  }
  const existing = get("SELECT COUNT(*) AS count FROM connections WHERE group_name=?", [source]);
  if (!Number(existing?.count)) throw new Error("分组不存在，请刷新后重试");
  if (source === target) return { ok: true, updated: 0, group_name: target };
  const conflict = get("SELECT 1 AS found FROM connections WHERE group_name=? LIMIT 1", [target]);
  if (conflict) throw new Error("该分组名称已存在，请使用其他名称");
  const result = run("UPDATE connections SET group_name=?, updated_at=? WHERE group_name=?", [target, now(), source]);
  run("DELETE FROM connection_groups WHERE name=?", [target]);
  run("UPDATE connection_groups SET name=?,updated_at=? WHERE name=?", [target, now(), source]);
  return { ok: true, updated: Number(result?.changes || 0), group_name: target };
}

function reorderConnectionGroups(names) {
  const requested = [...new Set((names || []).map((name) => String(name || "").trim()).filter(Boolean))];
  const active = all("SELECT DISTINCT group_name FROM connections").map((row) => row.group_name);
  if (requested.length !== active.length || active.some((name) => !requested.includes(name))) throw new Error("分组列表已变化，请刷新后重试");
  db.exec("BEGIN IMMEDIATE");
  try {
    requested.forEach((name, index) => {
      ensureConnectionGroup(name);
      run("UPDATE connection_groups SET sort_order=?,updated_at=? WHERE name=?", [index + 1, now(), name]);
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { ok: true, groups: requested.length };
}

function isEncryptedText(value) {
  return String(value || "").startsWith("tdenc:v1:");
}

function rewriteConnectionSecrets(transform) {
  const rows = all("SELECT id, identity_file, ssh_password, extra_args FROM connections");
  const update = db.prepare("UPDATE connections SET identity_file=?, ssh_password=?, extra_args=?, updated_at=? WHERE id=?");
  let changed = 0;
  for (const row of rows) {
    const identityFile = row.identity_file ? transform(row.identity_file) : row.identity_file;
    const sshPassword = row.ssh_password ? transform(row.ssh_password) : row.ssh_password;
    const extraArgs = row.extra_args ? transform(row.extra_args) : row.extra_args;
    if (identityFile !== row.identity_file || sshPassword !== row.ssh_password || extraArgs !== row.extra_args) {
      update.run(identityFile, sshPassword, extraArgs, now(), row.id);
      changed += 1;
    }
  }
  return changed;
}

function encryptStoredConnectionSecrets() {
  return rewriteConnectionSecrets((value) => isEncryptedText(value) ? value : encryptText(value));
}

function decryptStoredConnectionSecrets() {
  return rewriteConnectionSecrets((value) => isEncryptedText(value) ? decryptText(value) : value);
}

function insertForward(connectionId, data) {
  getConnection(connectionId);
  const item = cleanForward(data);
  const ts = now();
  const result = run(
    `INSERT INTO connection_forwards
     (connection_id, mode, service_name, service_type, service_note, url_scheme, bind_host, bind_port, target_host, target_port, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [Number(connectionId), item.mode, item.service_name, item.service_type, item.service_note, item.url_scheme, item.bind_host, item.bind_port, item.target_host, item.target_port, ts, ts]
  );
  return Number(result.lastInsertRowid);
}

function updateForward(id, data) {
  getForward(id);
  const item = cleanForward(data);
  run(
    `UPDATE connection_forwards
     SET mode=?, service_name=?, service_type=?, service_note=?, url_scheme=?, bind_host=?, bind_port=?, target_host=?, target_port=?, updated_at=?
     WHERE id=?`,
    [item.mode, item.service_name, item.service_type, item.service_note, item.url_scheme, item.bind_host, item.bind_port, item.target_host, item.target_port, now(), Number(id)]
  );
}

function deleteConnection(id, stopForward) {
  for (const forward of all("SELECT id FROM connection_forwards WHERE connection_id=?", [Number(id)])) {
    stopForward(forward.id);
  }
  run("DELETE FROM connection_forwards WHERE connection_id=?", [Number(id)]);
  run("DELETE FROM connections WHERE id=?", [Number(id)]);
}

function deleteForward(id, stopForward) {
  stopForward(id);
  run("DELETE FROM connection_forwards WHERE id=?", [Number(id)]);
}

function listForwardTemplates() {
  return all("SELECT * FROM forward_templates ORDER BY name, id");
}

function cleanForwardTemplate(data) {
  const item = cleanForward(data);
  const name = String(data.name || "").trim();
  if (!name) throw new Error("缺少模板名称");
  return { name, ...item };
}

function insertForwardTemplate(data) {
  const item = cleanForwardTemplate(data);
  const ts = now();
  const result = run(
    `INSERT INTO forward_templates
     (name, mode, service_name, service_type, service_note, url_scheme, bind_host, bind_port, target_host, target_port, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [item.name, item.mode, item.service_name, item.service_type, item.service_note, item.url_scheme, item.bind_host, item.bind_port, item.target_host, item.target_port, ts, ts]
  );
  return Number(result.lastInsertRowid);
}

function updateForwardTemplate(id, data) {
  const item = cleanForwardTemplate(data);
  run(
    `UPDATE forward_templates
     SET name=?, mode=?, service_name=?, service_type=?, service_note=?, url_scheme=?, bind_host=?, bind_port=?, target_host=?, target_port=?, updated_at=?
     WHERE id=?`,
    [item.name, item.mode, item.service_name, item.service_type, item.service_note, item.url_scheme, item.bind_host, item.bind_port, item.target_host, item.target_port, now(), Number(id)]
  );
}

function deleteForwardTemplate(id) {
  run("DELETE FROM forward_templates WHERE id=?", [Number(id)]);
}

function getForwardTemplate(id) {
  const row = get("SELECT * FROM forward_templates WHERE id=?", [Number(id)]);
  if (!row) throw new Error("转发模板不存在");
  return row;
}

function applyForwardTemplate(templateId, connectionIds) {
  const template = getForwardTemplate(templateId);
  const ids = [...new Set((connectionIds || []).map(Number).filter(Boolean))];
  if (!ids.length) throw new Error("请选择要应用的连接");
  const created = [];
  for (const connectionId of ids) {
    getConnection(connectionId);
    created.push(insertForward(connectionId, template));
  }
  return { ok: true, created };
}

function ensureBuiltinForwardTemplates() {
  if (get("SELECT value FROM app_meta WHERE key='builtin_forward_templates_v1'")) return;
  const templates = [
    { name:"Web HTTP", mode:"local", service_name:"Web", service_type:"web", url_scheme:"http", bind_host:"127.0.0.1", bind_port:8080, target_host:"127.0.0.1", target_port:80 },
    { name:"MySQL", mode:"local", service_name:"MySQL", service_type:"mysql", bind_host:"127.0.0.1", bind_port:3306, target_host:"127.0.0.1", target_port:3306 },
    { name:"Redis", mode:"local", service_name:"Redis", service_type:"redis", bind_host:"127.0.0.1", bind_port:6379, target_host:"127.0.0.1", target_port:6379 },
    { name:"Memcached", mode:"local", service_name:"Memcached", service_type:"other", bind_host:"127.0.0.1", bind_port:11211, target_host:"127.0.0.1", target_port:11211 },
    { name:"SSH", mode:"local", service_name:"SSH", service_type:"ssh", bind_host:"127.0.0.1", bind_port:2222, target_host:"127.0.0.1", target_port:22 },
    { name:"SOCKS5", mode:"socks", service_name:"SOCKS5", service_type:"socks", bind_host:"127.0.0.1", bind_port:1080, target_host:"", target_port:null }
  ];
  for (const template of templates) insertForwardTemplate(template);
  run("INSERT OR REPLACE INTO app_meta(key,value) VALUES('builtin_forward_templates_v1',?)", [String(Date.now())]);
}

function exportConfigSnapshot() {
  return {
    version: 1,
    connections: all("SELECT * FROM connections ORDER BY id"),
    connection_groups: all("SELECT * FROM connection_groups ORDER BY sort_order,name"),
    forwards: all("SELECT * FROM connection_forwards ORDER BY id").map(row => ({...row, pid:null, status:"stopped", restore:0, reconnect_count:0, started_at:null})),
    forward_templates: all("SELECT * FROM forward_templates ORDER BY id")
  };
}

function restoreConfigSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.connections) || !Array.isArray(snapshot.forwards) || !Array.isArray(snapshot.forward_templates)) throw new Error("配置快照格式无效");
  db.exec("BEGIN IMMEDIATE");
  try {
    run("DELETE FROM connection_forwards");
    run("DELETE FROM connections");
    run("DELETE FROM connection_groups");
    run("DELETE FROM forward_templates");
    const groups = Array.isArray(snapshot.connection_groups) ? snapshot.connection_groups : [...new Set(snapshot.connections.map((row) => row.group_name))].map((name,index) => ({name,sort_order:index+1,created_at:now(),updated_at:now()}));
    for (const row of groups) run("INSERT INTO connection_groups(name,sort_order,created_at,updated_at) VALUES(?,?,?,?)", [row.name,row.sort_order,row.created_at,row.updated_at]);
    for (const row of snapshot.connections) run("INSERT INTO connections(id,name,group_name,ssh_host,ssh_port,ssh_user,auth_type,identity_file,ssh_password,tags,extra_args,autostart_forwards,sort_order,terminal_encoding,terminal_font_family,terminal_font_size,terminal_line_height,terminal_font_weight,sftp_text_encoding,sftp_filename_encoding,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [row.id,row.name,row.group_name,row.ssh_host,row.ssh_port,row.ssh_user,row.auth_type || "key",row.identity_file,row.ssh_password || null,row.tags,row.extra_args,row.autostart_forwards,Number.isInteger(Number(row.sort_order)) && Number(row.sort_order) > 0 ? Number(row.sort_order) : 1,row.terminal_encoding || "utf8",row.terminal_font_family || DEFAULT_TERMINAL_FONT,Number(row.terminal_font_size) || 13,Number(row.terminal_line_height) || 1,row.terminal_font_weight || "normal",row.sftp_text_encoding || "auto",row.sftp_filename_encoding || "utf8",row.created_at,row.updated_at]);
    for (const row of snapshot.forwards) run("INSERT INTO connection_forwards(id,connection_id,mode,service_name,service_type,service_note,url_scheme,bind_host,bind_port,target_host,target_port,pid,status,restore,reconnect_count,last_error,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [row.id,row.connection_id,row.mode,row.service_name,row.service_type,row.service_note,row.url_scheme,row.bind_host,row.bind_port,row.target_host,row.target_port,null,"stopped",0,0,row.last_error || null,null,row.created_at,row.updated_at]);
    for (const row of snapshot.forward_templates) run("INSERT INTO forward_templates(id,name,mode,service_name,service_type,service_note,url_scheme,bind_host,bind_port,target_host,target_port,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", [row.id,row.name,row.mode,row.service_name,row.service_type,row.service_note,row.url_scheme,row.bind_host,row.bind_port,row.target_host,row.target_port,row.created_at,row.updated_at]);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { ok:true, connections:snapshot.connections.length, forwards:snapshot.forwards.length, templates:snapshot.forward_templates.length };
}

ensureBuiltinForwardTemplates();

function closeDatabase() {
  if (!db) return;
  db.close();
  db = null;
}

function reopenDatabase() {
  closeDatabase();
  openDatabase();
  ensureBuiltinForwardTemplates();
  return db;
}

function exportDatabaseFile(includePasswords = false) {
  const temporary = path.join(DATA_DIR, `database-export-${process.pid}-${Date.now()}.db`);
  let exportedDb = null;
  try {
    db.exec(`VACUUM INTO '${temporary.replace(/'/g, "''")}'`);
    if (!includePasswords) {
      exportedDb = new DatabaseSync(temporary);
      const table = exportedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connections'").get();
      if (table) {
        const columns = new Set(exportedDb.prepare("PRAGMA table_info(connections)").all().map((item) => item.name));
        if (columns.has("ssh_password")) exportedDb.exec("UPDATE connections SET ssh_password=NULL");
      }
      exportedDb.close();
      exportedDb = null;
    }
    return {
      path: temporary,
      size: fs.statSync(temporary).size,
      cleanup() {
        try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
      }
    };
  } catch (error) {
    try { exportedDb?.close(); } catch {}
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function exportDatabaseBuffer(includePasswords = false) {
  const exported = exportDatabaseFile(includePasswords);
  try {
    return fs.readFileSync(exported.path);
  } finally {
    exported.cleanup();
  }
}

module.exports = {
  get db() { return db; },
  now,
  run,
  get,
  all,
  validatePort,
  validateSortOrder,
  pidRunning,
  cleanConnection,
  cleanForward,
  listConnections,
  getConnection,
  getForward,
  insertConnection,
  updateConnection,
  updateTerminalPreferences,
  updateSftpTextEncoding,
  updateSftpFilenameEncoding,
  bulkUpdateConnections,
  renameConnectionGroup,
  reorderConnectionGroups,
  encryptStoredConnectionSecrets,
  decryptStoredConnectionSecrets,
  insertForward,
  updateForward,
  deleteConnection,
  deleteForward,
  listForwardTemplates,
  insertForwardTemplate,
  updateForwardTemplate,
  deleteForwardTemplate,
  getForwardTemplate,
  applyForwardTemplate,
  exportConfigSnapshot,
  restoreConfigSnapshot,
  ensureBuiltinForwardTemplates,
  closeDatabase,
  reopenDatabase,
  exportDatabaseFile,
  exportDatabaseBuffer
};
