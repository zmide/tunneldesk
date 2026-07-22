const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");
const {
  DATA_DIR,
  BASE_DIR,
  RUNTIME_ROOT,
  STORAGE_SETTINGS_FILE,
  DB_PATH,
  LOG_DIR,
  PID_FILE,
  PUBLIC_DIR,
  PROJECT_SSH_DIR,
  DEFAULT_HOST,
  DEFAULT_HOSTS,
  DEFAULT_PORT,
  DEFAULT_EXTRA_ARGS,
  RUNTIME_SETTINGS_FILE,
  WEB_INFO_FILE,
  WEB_URL_FILE
} = require("./config");
const {
  listConnections,
  getConnection,
  getForward,
  insertConnection,
  updateConnection,
  bulkUpdateConnections,
  insertForward,
  updateForward,
  deleteConnection,
  deleteForward,
  listForwardTemplates,
  insertForwardTemplate,
  updateForwardTemplate,
  deleteForwardTemplate,
  applyForwardTemplate,
  encryptStoredConnectionSecrets,
  decryptStoredConnectionSecrets,
  run,
  closeDatabase,
  reopenDatabase,
  exportDatabaseBuffer
} = require("./db");
const {
  listIdentityFiles,
  identityPermissionStatus,
  repairIdentityFile,
  saveUploadedKey,
  startForward,
  stopForward,
  startConnectionForwards,
  stopConnectionForwards,
  stopAllForwards,
  autostartConnections,
  restorePreviousForwards,
  restoreStateSummary,
  configuredPortOwner,
  diagnosePortUsage,
  recommendPort,
  killPortOwner,
  connectionHealth,
  allConnectionsHealth,
  startForwardHealthMonitor,
  stopForwardHealthMonitor,
  testSsh,
  batchRunCommands,
  runSshCommandForConnection,
  clearConnectionHealthCache
} = require("./ssh");
const { getPart } = require("./multipart");
const { parseConfigText, batchTest, saveImported, exportConfig } = require("./importer");
const { handleTerminalUpgrade, closeAllTerminals } = require("./terminal");
const { deleteCommandTemplate, handleBatchCommandUpgrade, listCommandTemplates, saveCommandTemplate, updateCommandTemplate } = require("./commands");
const { clearRemoteRecycleItems, copyRemotePaths, createRemoteFile, deleteRemotePath, deleteRemoteRecycleItem, extractRemoteArchive, invalidateRemoteDirectoryCache, listRemoteDir, listRemoteRecycleItems, makeRemoteDir, moveRemotePaths, normalizeRemotePermissionRequest, readRemoteTextFile, recycleRemotePath, renameRemotePath, restoreRemoteRecycleItem, setRemotePermissions, writeRemoteFile, streamRemoteFile } = require("./sftp");
const { cancelSftpJob, clearFinishedSftpJobs, compressJob, copyJob, deleteSftpJob, extractJob, getSftpJobFile, listSftpJobs, moveJob, pauseSftpJob, resumeSftpJob, startDownloadJob, startUploadJob } = require("./sftp-jobs");
const { appendSystemLog, deleteLogs, listLogs, readLog, readRawLog } = require("./logs");
const { listNotifications, notifyEvent } = require("./notifications");
const { authRequired, isAuthenticated, isLocalRequest, login, logout, publicSecuritySettings, readSecuritySettings, resetWebAccessSecurity, sameOrigin, secureHeaders, setPassword, setToken, updateSecurityOptions, writeSecuritySettings } = require("./security");
const { disableEncryption, enableEncryption, encryptionReady, encryptText, lockEncryption, unlockEncryption } = require("./crypto-store");
const { createConfigSnapshot, deleteConfigSnapshot, listConfigSnapshots, restoreConfigSnapshotById } = require("./config-snapshots");
const { ptyRuntimeStatus } = require("./pty-runtime");
const { createUpdateChecker } = require("./update-checker");
const {
  MAX_PORT_FALLBACKS,
  availableListenHosts,
  isLoopbackHost,
  normalizeListenHosts,
  normalizeListenPort,
  normalizeRuntimeSettings,
  readRuntimeSettings,
  writeRuntimeSettings
} = require("./runtime-settings");

const PACKAGE_ROOT = path.resolve(PUBLIC_DIR, "..");
const STARTUP_STATUS_FILE = path.join(DATA_DIR, "startup-status.json");
let startupStatus: any = { state:"starting", started_at:Date.now(), local_url:"", lan_urls:[], autostart:{ok:0,failed:0,errors:[]}, restore:{ok:0,failed:0,errors:[]} };
const updateChecker = createUpdateChecker({
  dataDir: DATA_DIR,
  packagePath: path.join(PACKAGE_ROOT, "package.json"),
  onUpdate(result) {
    notifyEvent({
      type: "update",
      level: "info",
      key: `update:${result.latest_version}`,
      title: "发现 TunnelDesk 新版本",
      message: `当前版本 ${result.current_version}，最新版本 ${result.latest_version}${result.name ? `（${result.name}）` : ""}。`,
      action: { url: result.release_url }
    }, { cooldown_ms: 0 });
  }
});

function aboutInfo() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  const resourcesPath = (process as typeof process & { resourcesPath?: string }).resourcesPath;
  const licenseCandidates = [
    resourcesPath ? path.join(resourcesPath, "LICENSE") : "",
    path.join(PACKAGE_ROOT, "LICENSE")
  ].filter(Boolean);
  const licensePath = licenseCandidates.find(candidate => fs.existsSync(candidate));
  const repository = typeof packageJson.repository === "string" ? packageJson.repository : packageJson.repository?.url;
  const author = typeof packageJson.author === "string"
    ? packageJson.author.replace(/\s*<[^>]+>\s*$/, "").trim()
    : String(packageJson.author?.name || "").trim();
  return {
    product_name: "TunnelDesk",
    version: packageJson.version,
    author,
    license: packageJson.license,
    license_name: "GNU General Public License v3.0 only",
    repository_url: String(packageJson.homepage || repository || "").replace(/^git\+/, "").replace(/\.git$/, ""),
    license_available: Boolean(licensePath),
    license_error: licensePath ? "" : "未找到随程序提供的开源许可正文",
    license_text: licensePath ? fs.readFileSync(licensePath, "utf8") : ""
  };
}

function writeStartupStatus(next: any = {}) {
  startupStatus = {...startupStatus, ...next, updated_at:Date.now()};
  fs.mkdirSync(DATA_DIR, {recursive:true});
  fs.writeFileSync(STARTUP_STATUS_FILE, JSON.stringify(startupStatus, null, 2), "utf8");
  return startupStatus;
}

function vendorFile(packageName, relativePath) {
  const local = path.resolve(__dirname, "../node_modules", packageName, relativePath);
  if (fs.existsSync(local)) return local;
  try {
    return require.resolve(`${packageName}/${relativePath}`);
  } catch {
    return local;
  }
}

const VENDOR_FILES = new Map([
  ["/vendor/lucide/lucide.min.js", vendorFile("lucide", "dist/umd/lucide.min.js")],
  ["/vendor/xterm/xterm.css", vendorFile("@xterm/xterm", "css/xterm.css")],
  ["/vendor/xterm/xterm.js", vendorFile("@xterm/xterm", "lib/xterm.js")],
  ["/vendor/xterm/xterm.mjs", vendorFile("@xterm/xterm", "lib/xterm.mjs")],
  ["/vendor/xterm/addon-fit.js", vendorFile("@xterm/addon-fit", "lib/addon-fit.js")],
  ["/vendor/xterm/addon-fit.mjs", vendorFile("@xterm/addon-fit", "lib/addon-fit.mjs")]
]);

function readBody(req, maxBytes = 100 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req): Promise<any> {
  const body = await readBody(req, 2 * 1024 * 1024);
  return body.length ? JSON.parse(body.toString("utf8")) : {};
}

function safeUploadName(value) {
  return path.basename(String(value || "upload.bin")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "upload.bin";
}

function receiveUploadToTemp(req, filename): Promise<any> {
  return new Promise((resolve, reject) => {
    const dir = path.join(DATA_DIR, "uploads");
    fs.mkdirSync(dir, { recursive: true });
    const safe = safeUploadName(filename);
    const temp = path.join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}-${safe}`);
    const out = fs.createWriteStream(temp, { flags: "wx" });
    let size = 0;
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (error) {
        try { out.destroy(); } catch {}
        try { fs.unlinkSync(temp); } catch {}
        reject(error);
      } else {
        resolve({ path: temp, filename: safe, size });
      }
    };
    req.on("data", (chunk) => { size += chunk.length; });
    req.on("error", finish);
    out.on("error", finish);
    out.on("finish", () => finish());
    req.pipe(out);
  });
}

function send(res, status, data, headers = {}) {
  const body = Buffer.from(typeof data === "string" ? data : JSON.stringify(data), "utf8");
  res.writeHead(status, {
    "Content-Length": body.length,
    "Content-Type": typeof data === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...secureHeaders(headers)
  });
  res.end(body);
}

function sendJson(res, data, status = 200) {
  send(res, status, data, { "Content-Type": "application/json; charset=utf-8" });
}

function forwardLogLabel(id) {
  const forwardId = Number(id);
  for (const connection of listConnections()) {
    const forward = (connection.forwards || []).find((item) => item.id === forwardId);
    if (!forward) continue;
    const target = forward.mode === "socks"
      ? `${forward.bind_host}:${forward.bind_port}`
      : `${forward.bind_host}:${forward.bind_port} -> ${forward.target_host}:${forward.target_port}`;
    return `${connection.name} / ${forward.service_name || target}`;
  }
  return `转发规则 ${forwardId}`;
}

async function inspectServer(connectionId) {
  const connection = getConnection(Number(connectionId));
  const script = [
    "printf '## system\\n'",
    "(uname -a 2>/dev/null || true)",
    "printf '\\n## os\\n'",
    "(cat /etc/os-release 2>/dev/null | sed -n '1,6p' || true)",
    "printf '\\n## uptime\\n'",
    "(uptime 2>/dev/null || true)",
    "printf '\\n## memory\\n'",
    "(free -h 2>/dev/null || vm_stat 2>/dev/null || true)",
    "printf '\\n## disk\\n'",
    "(df -h 2>/dev/null | sed -n '1,12p' || true)",
    "printf '\\n## ports\\n'",
    "(ss -tuln 2>/dev/null | sed -n '1,12p' || netstat -tuln 2>/dev/null | sed -n '1,12p' || true)"
  ].join("\n");
  const result: any = await runSshCommandForConnection(connection, script, 20000);
  const output = `${result.stdout || ""}${result.stderr || ""}${result.error ? result.error.message : ""}`.trim();
  return {
    id: connection.id,
    name: connection.name,
    ok: result.status === 0,
    exit_code: result.status,
    checked_at: Date.now(),
    output: output || (result.status === 0 ? "巡检完成，无输出" : `巡检失败，退出码 ${result.status}`)
  };
}

function withDatabaseBuffer(body, callback) {
  if (body.length < 16) throw new Error("数据库文件为空或无效");
  if (!body.subarray(0, 16).toString("utf8").startsWith("SQLite format 3")) throw new Error("请选择 SQLite 数据库备份文件");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = path.join(DATA_DIR, `restore-check-${process.pid}-${Date.now()}.db`);
  fs.writeFileSync(temp, body);
  let tempDb = null;
  try {
    tempDb = new DatabaseSync(temp);
    return callback(tempDb);
  } finally {
    try { tempDb?.close(); } catch {}
    try { fs.unlinkSync(temp); } catch {}
  }
}

function connectionRowsFromBackup(tempDb) {
  const table = tempDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connections'").get();
  if (!table) return [];
  const columns = new Set(tempDb.prepare("PRAGMA table_info(connections)").all().map((item: any) => item.name));
  if (!columns.has("id") || !columns.has("name")) return [];
  const optional = [
    ["ssh_host", "''"], ["ssh_port", "22"], ["ssh_user", "''"], ["auth_type", "'key'"],
    ["identity_file", "NULL"], ["ssh_password", "NULL"], ["extra_args", "''"]
  ].map(([name, fallback]) => columns.has(name) ? name : `${fallback} AS ${name}`);
  return tempDb.prepare(`SELECT id, name, ${optional.join(", ")} FROM connections ORDER BY id`).all();
}

function storageSettingsView() {
  return {
    root:RUNTIME_ROOT,
    data_dir:DATA_DIR,
    ssh_dir:PROJECT_SSH_DIR,
    environment_override:Boolean(process.env.TUNNELDESK_DATA_DIR || process.env.TUNNELDESK_SSH_DIR)
  };
}

function pathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function copyRuntimeDirectory(source, target) {
  if (!fs.existsSync(source) || path.resolve(source) === path.resolve(target)) return;
  if (pathInside(source, target)) throw new Error("新目录不能位于当前数据目录内部");
  fs.mkdirSync(target, { recursive:true });
  fs.cpSync(source, target, { recursive:true, force:false, errorOnExist:false });
}

function saveWebStorageSettings(data) {
  if (desktopIntegration?.saveSettings) throw new Error("桌面端请使用桌面数据路径模式");
  const rootValue = String(data?.root || "").trim();
  if (!rootValue || rootValue.includes("\0") || !path.isAbsolute(rootValue)) throw new Error("请选择有效的绝对运行根目录");
  const root = path.resolve(rootValue);
  const targetData = path.join(root, "data");
  const targetSsh = path.join(root, ".ssh");
  if (Boolean(data?.migrate) && path.resolve(root) !== path.resolve(RUNTIME_ROOT)) {
    const targetDb = path.join(targetData, "tunnels.db");
    if (fs.existsSync(targetDb)) throw new Error("目标目录已有 TunnelDesk 数据库，已拒绝覆盖");
    copyRuntimeDirectory(DATA_DIR, targetData);
    copyRuntimeDirectory(PROJECT_SSH_DIR, targetSsh);
  } else {
    fs.mkdirSync(targetData, { recursive:true });
    fs.mkdirSync(targetSsh, { recursive:true });
  }
  const temporary = `${STORAGE_SETTINGS_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify({root, updated_at:new Date().toISOString()}, null, 2), "utf8");
  fs.renameSync(temporary, STORAGE_SETTINGS_FILE);

  const environment = {...process.env};
  delete environment.TUNNELDESK_DATA_DIR;
  delete environment.TUNNELDESK_SSH_DIR;
  const restartPayload = {
    cwd:BASE_DIR,
    entry:path.join(BASE_DIR, "dist", "server.js"),
    args:["--host", (args.requested_hosts || args.listen_hosts).join(","), "--port", String(args.requested_port || args.listen_port)],
    env:environment,
    logFile:path.join(targetData, "web.log")
  };
  const encoded = Buffer.from(JSON.stringify(restartPayload), "utf8").toString("base64");
  const helper = spawn(process.execPath, [path.join(BASE_DIR, "scripts", "restart-web.js"), String(process.pid), encoded], {
    cwd:BASE_DIR,
    detached:true,
    windowsHide:true,
    stdio:"ignore"
  });
  helper.unref();
  setTimeout(() => shutdown().catch(error => console.error(`storage restart failed: ${error.message}`)), 250);
  return {ok:true, restart_required:true, root, data_dir:targetData, ssh_dir:targetSsh};
}

function listLocalDirectories(requestedPath) {
  const current = path.resolve(String(requestedPath || RUNTIME_ROOT));
  const stat = fs.statSync(current);
  if (!stat.isDirectory()) throw new Error("所选路径不是目录");
  const roots = process.platform === "win32"
    ? Array.from({length:26}, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
      .filter(root => fs.existsSync(root))
      .map(root => ({name:root, path:root}))
    : [{name:"/", path:"/"}];
  const directories = fs.readdirSync(current, {withFileTypes:true})
    .filter(entry => entry.isDirectory())
    .slice(0, 500)
    .map(entry => ({name:entry.name, path:path.join(current, entry.name)}));
  const parent = path.dirname(current);
  return {current, parent:parent === current ? "" : parent, roots, directories};
}

function normalizeIdentityBindings(value) {
  const bindings = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    const connectionId = Number(item?.connection_id);
    const identityPath = String(item?.identity_path || "").trim();
    if (Number.isInteger(connectionId) && connectionId > 0 && identityPath) bindings.set(connectionId, identityPath);
  }
  return bindings;
}

function identityTargetMap(rows, requestedBindings = []) {
  const identities = listIdentityFiles();
  const allowedPaths: Map<string, any> = new Map(identities.map(item => [path.resolve(item.path), item]));
  const bindings = normalizeIdentityBindings(requestedBindings);
  const mappings = [];
  const unresolved = [];
  const encrypted = [];
  const missingByName = new Map();
  for (const row of rows) {
    if (String(row.identity_file || "").startsWith("tdenc:v1:")) {
      encrypted.push({ connection_id:row.id, connection_name:row.name });
      continue;
    }
    const keyName = path.posix.basename(String(row.identity_file || "").replace(/\\/g, "/"));
    const requested = bindings.get(Number(row.id));
    if (requested && !allowedPaths.has(path.resolve(requested))) throw new Error(`连接 ${row.name || row.id} 的私钥绑定无效，请重新选择`);
    const target = requested ? allowedPaths.get(path.resolve(requested))?.path : null;
    const item = {
      connection_id: row.id,
      connection_name: row.name,
      ssh_host: row.ssh_host || "",
      ssh_port: Number(row.ssh_port || 22),
      ssh_user: row.ssh_user || "",
      auth_type: row.auth_type || "key",
      extra_args: row.extra_args || "",
      key_name: keyName,
      old_path: row.identity_file,
      target_path: target || path.join(PROJECT_SSH_DIR, keyName)
    };
    if (target && fs.existsSync(target)) mappings.push(item);
    else {
      unresolved.push(item);
      if (!missingByName.has(keyName)) {
        missingByName.set(keyName, { ...item, connection_count: 1, connection_names: [row.name] });
      } else {
        const missingItem = missingByName.get(keyName);
        missingItem.connection_count += 1;
        if (row.name && !missingItem.connection_names.includes(row.name)) missingItem.connection_names.push(row.name);
      }
    }
  }
  return { missing: [...missingByName.values()], unresolved, encrypted, mappings };
}

function normalizeCredentialBindings(value) {
  const bindings = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    const connectionId = Number(item?.connection_id);
    if (!Number.isInteger(connectionId) || connectionId <= 0) continue;
    const authType = String(item?.auth_type || "") === "password" ? "password" : "key";
    if (authType === "key") {
      const identityPath = String(item?.identity_path || "").trim();
      if (identityPath) bindings.set(connectionId, {connection_id:connectionId, auth_type:"key", identity_path:identityPath});
      continue;
    }
    const passwordAction = ["preserve", "replace", "clear"].includes(String(item?.password_action)) ? String(item.password_action) : "preserve";
    const password = passwordAction === "replace" ? String(item?.password || "") : "";
    if (passwordAction === "replace" && !password) throw new Error(`连接 ${connectionId} 的新密码不能为空`);
    if (password.length > 4096) throw new Error(`连接 ${connectionId} 的密码过长`);
    bindings.set(connectionId, {connection_id:connectionId, auth_type:"password", password_action:passwordAction, password});
  }
  return bindings;
}

function inspectRestoreDatabase(body) {
  const payload = parseRestorePayload(body);
  return withDatabaseBuffer(payload.database, (tempDb) => {
    const rows = connectionRowsFromBackup(tempDb);
    const requestedCredentials = normalizeCredentialBindings(payload.credential_bindings);
    const keyRows = rows.filter((row) => {
      const requested = requestedCredentials.get(Number(row.id));
      return requested?.auth_type === "key" || (requested?.auth_type !== "password" && String(row.auth_type || "key") !== "password" && String(row.identity_file || "").trim());
    });
    const requestedIdentities = [
      ...(Array.isArray(payload.identity_bindings) ? payload.identity_bindings : []),
      ...[...requestedCredentials.values()].filter((item) => item.auth_type === "key" && item.identity_path).map((item) => ({connection_id:item.connection_id, identity_path:item.identity_path}))
    ];
    const identities = identityTargetMap(keyRows, requestedIdentities);
    return {
      ok: true,
      connections: rows.map((row) => {
        const authType = String(row.auth_type || "key") === "password" ? "password" : "key";
        const identityFile = String(row.identity_file || "");
        const password = String(row.ssh_password || "");
        return {
          connection_id: Number(row.id),
          connection_name: row.name || `连接 ${row.id}`,
          ssh_host: row.ssh_host || "",
          ssh_port: Number(row.ssh_port || 22),
          ssh_user: row.ssh_user || "",
          auth_type: authType,
          original_auth_type: authType,
          key_name: identityFile && !identityFile.startsWith("tdenc:v1:") ? path.posix.basename(identityFile.replace(/\\/g, "/")) : "",
          identity_encrypted: identityFile.startsWith("tdenc:v1:"),
          has_password: Boolean(password),
          password_encrypted: password.startsWith("tdenc:v1:"),
          extra_args: row.extra_args || ""
        };
      }),
      identity_bindings_complete: identities.missing.length === 0,
      missing_identities: identities.missing,
      unresolved_identities: identities.unresolved,
      encrypted_identities: identities.encrypted,
      mapped_identities: identities.mappings,
      available_identities: listIdentityFiles(),
      upload_directory: PROJECT_SSH_DIR,
      encrypted_bundle: Boolean(payload.security?.encryption_enabled),
      password_replacement_allowed: payload.security
        ? !Boolean(payload.security.encryption_enabled)
        : (!readSecuritySettings().encryption_enabled || encryptionReady())
    };
  });
}

function parseRestorePayload(body) {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (parsed && parsed.type === "tunneldesk-restore-request-v1" && parsed.payload_base64) {
      const nested = parseRestorePayload(Buffer.from(parsed.payload_base64, "base64"));
      return {
        ...nested,
        identity_bindings: Array.isArray(parsed.identity_bindings) ? parsed.identity_bindings : [],
        credential_bindings: Array.isArray(parsed.credential_bindings) ? parsed.credential_bindings : []
      };
    }
    if (parsed && parsed.type === "tunneldesk-backup-v1" && parsed.database_base64) {
      return {
        database: Buffer.from(parsed.database_base64, "base64"),
        security: parsed.security || null,
        identity_bindings: [],
        credential_bindings: []
      };
    }
  } catch {}
  return { database: body, security: null, identity_bindings: [], credential_bindings: [] };
}

function backupBundle() {
  if (!fs.existsSync(DB_PATH)) throw new Error("Database not found");
  const security = readSecuritySettings();
  return {
    type: "tunneldesk-backup-v1",
    created_at: new Date().toISOString(),
    database_base64: fs.readFileSync(DB_PATH).toString("base64"),
    security: {
      encryption_enabled: Boolean(security.encryption_enabled),
      encryption_salt: security.encryption_salt || "",
      encryption_check: security.encryption_check || ""
    }
  };
}

function normalizeRestoredCredentials(dbPath, identityBindings = [], credentialBindings = [], encryptedBundle = false, encryptionEnabled = false) {
  const restoredDb = new DatabaseSync(dbPath);
  try {
    const rows = connectionRowsFromBackup(restoredDb);
    const credentials = normalizeCredentialBindings(credentialBindings);
    const keyRows = rows.filter((row) => {
      const requested = credentials.get(Number(row.id));
      return requested?.auth_type === "key" || (requested?.auth_type !== "password" && String(row.auth_type || "key") !== "password" && String(row.identity_file || "").trim());
    });
    const requestedIdentities = [
      ...(Array.isArray(identityBindings) ? identityBindings : []),
      ...[...credentials.values()].filter((item) => item.auth_type === "key" && item.identity_path).map((item) => ({connection_id:item.connection_id, identity_path:item.identity_path}))
    ];
    const identities = identityTargetMap(keyRows, requestedIdentities);
    const updateIdentity = restoredDb.prepare("UPDATE connections SET auth_type='key', identity_file=?, ssh_password=NULL WHERE id=?");
    for (const item of identities.mappings) {
      updateIdentity.run(item.target_path, item.connection_id);
    }
    for (const item of identities.unresolved) {
      updateIdentity.run(null, item.connection_id);
    }
    const updatePassword = restoredDb.prepare("UPDATE connections SET auth_type='password', identity_file=NULL, ssh_password=? WHERE id=?");
    const preservePassword = restoredDb.prepare("UPDATE connections SET auth_type='password', identity_file=NULL WHERE id=?");
    for (const item of credentials.values()) {
      if (item.auth_type !== "password") continue;
      if (item.password_action === "replace" && encryptedBundle) throw new Error("加密迁移包不能在恢复前改写密码；请恢复并解锁后在连接设置中修改");
      if (item.password_action === "replace") updatePassword.run(encryptionEnabled ? encryptText(item.password) : item.password, item.connection_id);
      else if (item.password_action === "clear") updatePassword.run(null, item.connection_id);
      else preservePassword.run(item.connection_id);
    }
    return { ...identities, credential_bindings: [...credentials.values()].map((item) => ({...item, password:item.password ? "(replaced)" : ""})) };
  } finally {
    restoredDb.close();
  }
}

function loginPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TunnelDesk 登录</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font:14px system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f6f8;color:#1f2933}.card{width:min(360px,calc(100vw - 32px));background:#fff;border:1px solid #d6dde3;border-radius:6px;padding:22px;box-shadow:0 12px 32px rgba(15,23,42,.12)}h1{font-size:22px;margin:0 0 8px}.muted{color:#687782;margin-bottom:18px}label{display:block;font-size:12px;color:#687782;margin-bottom:6px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccd4dc;border-radius:4px}button{width:100%;margin-top:14px;padding:10px;border:0;border-radius:4px;background:#2563eb;color:#fff;font-weight:600}.err{color:#b42318;min-height:20px;margin-top:10px}</style><div class="card"><h1>TunnelDesk</h1><div class="muted">请输入 Web 访问密码。</div><label>密码</label><input id="password" type="password" autofocus><button onclick="login()">登录</button><div id="err" class="err"></div></div><script>
async function login(){const password=document.getElementById('password').value;const res=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});if(res.ok){location.href='/';return;}let text='登录失败';try{text=(await res.json()).error||text}catch{}document.getElementById('err').textContent=text}
document.getElementById('password').addEventListener('keydown',e=>{if(e.key==='Enter')login()});
</script></html>`;
}

function serveStatic(req, res, pathname) {
  if (pathname === "/favicon.ico") {
    res.writeHead(204, secureHeaders());
    res.end();
    return;
  }
  if (pathname === "/login") return send(res, 200, loginPage(), { "Content-Type": "text/html; charset=utf-8" });
  if (!isAuthenticated(req)) {
    if (authRequired(req)) return send(res, 302, "", { Location: "/login" });
  }
  let file;
  const isVendorFile = VENDOR_FILES.has(pathname);
  if (isVendorFile) {
    file = VENDOR_FILES.get(pathname);
  } else {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    file = path.resolve(PUBLIC_DIR, rel);
  }
  if (!isVendorFile && !file.startsWith(PUBLIC_DIR)) {
    sendJson(res, { error: "Not found" }, 404);
    return;
  }
  if (isVendorFile && (!fs.existsSync(file) || fs.statSync(file).isDirectory())) {
    sendJson(res, { error: "Vendor file not found" }, 404);
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(PUBLIC_DIR, "index.html");
  }
  const ext = path.extname(file).toLowerCase();
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  const body = fs.readFileSync(file);
  res.writeHead(200, secureHeaders({ "Content-Type": types[ext] || "application/octet-stream", "Content-Length": body.length, "Cache-Control":"no-cache" }));
  res.end(body);
}

async function handleApi(req, res, pathname) {
  if (!sameOrigin(req)) return sendJson(res, { error: "Forbidden" }, 403);
  if (req.method === "GET" && pathname === "/api/auth/status") return sendJson(res, publicSecuritySettings(req));
  if (req.method === "POST" && pathname === "/api/auth/login") {
    const data = await readJson(req);
    const token = login(data.password || "");
    return send(res, 200, { ok: true }, { "Set-Cookie": `td_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200` });
  }
  if (!isAuthenticated(req)) return sendJson(res, { error: "Unauthorized" }, 401);
  if (req.method === "POST" && pathname === "/api/auth/logout") {
    logout(req);
    return send(res, 200, { ok: true }, { "Set-Cookie": "td_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
  }
  if (req.method === "GET" && pathname === "/api/about") return sendJson(res, aboutInfo());
  if (req.method === "GET" && pathname === "/api/desktop-settings") {
    const localRequest = isLocalRequest(req);
    const storageManagementAvailable = localRequest || (!desktopIntegration && authRequired(req));
    if (!storageManagementAvailable) return sendJson(res, {available:false, storage_management_available:false});
    if (!desktopIntegration?.getSettings) return sendJson(res, {
      available:false,
      storage_management_available:true,
      settings:{
        dataMode:process.env.TUNNELDESK_DATA_DIR || process.env.TUNNELDESK_SSH_DIR ? "environment" : "project",
        customDataDir:String(process.env.TUNNELDESK_DATA_DIR || "")
      },
      paths:{dataDir:DATA_DIR, sshDir:PROJECT_SSH_DIR},
      project_mode_available:true,
      project_mode_label:"项目所在文件夹",
      base_dir:BASE_DIR,
      storage:storageSettingsView()
    });
    return sendJson(res, { available:true, storage_management_available:true, ...(await Promise.resolve(desktopIntegration.getSettings())), storage:storageSettingsView() });
  }
  if (req.method === "PUT" && pathname === "/api/desktop-settings") {
    if (!isLocalRequest(req) && (desktopIntegration || !authRequired(req))) return sendJson(res, { error:"远程修改数据路径需要启用 Web 密码并登录" }, 403);
    const data = await readJson(req);
    if (!desktopIntegration?.saveSettings) return sendJson(res, saveWebStorageSettings(data));
    return sendJson(res, await Promise.resolve(desktopIntegration.saveSettings(data)));
  }
  if (req.method === "POST" && pathname === "/api/desktop-settings/choose-data-dir") {
    if (!isLocalRequest(req) || !desktopIntegration?.chooseDataDir) return sendJson(res, { error:"目录选择仅能在本机桌面版中使用" }, 403);
    return sendJson(res, { path:await Promise.resolve(desktopIntegration.chooseDataDir()) });
  }
  if (req.method === "GET" && pathname === "/api/storage/directories") {
    if (!isLocalRequest(req) && (desktopIntegration || !authRequired(req))) return sendJson(res, {error:"远程浏览目录需要启用 Web 密码并登录"}, 403);
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    return sendJson(res, listLocalDirectories(url.searchParams.get("path") || ""));
  }
  if (req.method === "GET" && pathname === "/api/runtime-settings") return sendJson(res, runtimeSettingsView());
  if (req.method === "PUT" && pathname === "/api/runtime-settings") {
    const current = readRuntimeSettings(RUNTIME_SETTINGS_FILE);
    const data = await readJson(req);
    const next = normalizeRuntimeSettings({
      listen_hosts: data.listen_hosts ?? current.listen_hosts,
      listen_port: data.listen_port ?? current.listen_port,
      sftp_recycle_bin_enabled: data.sftp_recycle_bin_enabled ?? current.sftp_recycle_bin_enabled
    });
    if (data.listen_hosts !== undefined || data.listen_port !== undefined) {
      const availability = await checkRuntimeSettings(next);
      if (!availability.available) return sendJson(res, {
        error: availability.error || "监听地址或端口不可用",
        ...availability
      }, 409);
    }
    writeRuntimeSettings(RUNTIME_SETTINGS_FILE, next);
    return sendJson(res, runtimeSettingsView());
  }
  if (req.method === "POST" && pathname === "/api/runtime-settings/check") {
    const data = await readJson(req);
    return sendJson(res, await checkRuntimeSettings(data), 200);
  }
  if (req.method === "GET" && pathname === "/api/updates/status") {
    const cached = updateChecker.status();
    return sendJson(res, cached || {
      current_version: String(updateChecker.packageInfo.version || "").replace(/^v/i, ""),
      latest_version: "",
      update_available: false,
      checked_at: "",
      from_cache: true,
      source: "github"
    });
  }
  if (req.method === "GET" && pathname === "/api/updates/check") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      return sendJson(res, await updateChecker.check({ force: url.searchParams.get("force") === "1" }));
    } catch (error) {
      return sendJson(res, { error: error.message || "检查更新失败，请稍后重试" }, 502);
    }
  }
  if (req.method === "GET" && pathname === "/api/security") return sendJson(res, publicSecuritySettings(req));
  if (req.method === "PUT" && pathname === "/api/security") return sendJson(res, updateSecurityOptions(await readJson(req)));
  if (req.method === "POST" && pathname === "/api/security/password") {
    const data = await readJson(req);
    setPassword(data.password || "");
    return sendJson(res, publicSecuritySettings(req));
  }
  if (req.method === "POST" && pathname === "/api/security/token") {
    const token = setToken();
    return sendJson(res, { ...publicSecuritySettings(req), token });
  }
  if (req.method === "POST" && pathname === "/api/security/encryption/enable") {
    const data = await readJson(req);
    const result = enableEncryption(data.password || "");
    const encrypted_rows = encryptStoredConnectionSecrets();
    return sendJson(res, { ...result, encrypted_rows });
  }
  if (req.method === "POST" && pathname === "/api/security/encryption/unlock") return sendJson(res, unlockEncryption((await readJson(req)).password || ""));
  if (req.method === "POST" && pathname === "/api/security/encryption/disable") {
    const data = await readJson(req);
    const settings = readSecuritySettings();
    if (settings.encryption_enabled) unlockEncryption(data.password || "");
    const decrypted_rows = settings.encryption_enabled ? decryptStoredConnectionSecrets() : 0;
    const result = disableEncryption();
    return sendJson(res, { ...result, decrypted_rows });
  }
  if (req.method === "POST" && pathname === "/api/shutdown") {
    if (!isLocalRequest(req)) return sendJson(res, { error: "Forbidden" }, 403);
    sendJson(res, { ok: true });
    shutdown();
    return;
  }
  if (req.method === "GET" && pathname === "/api/identity-files") return sendJson(res, listIdentityFiles());
  if (req.method === "GET" && pathname === "/api/identity-files/info") return sendJson(res, { items:listIdentityFiles(), upload_directory:PROJECT_SSH_DIR });
  if (req.method === "POST" && pathname === "/api/identity-files/check") {
    const data = await readJson(req);
    return sendJson(res, identityPermissionStatus(data.path || ""));
  }
  if (req.method === "POST" && pathname === "/api/identity-files/repair") {
    const data = await readJson(req);
    return sendJson(res, repairIdentityFile(data.path || ""));
  }
  if (req.method === "GET" && pathname === "/api/logs") return sendJson(res, listLogs());
  if (req.method === "GET" && pathname === "/api/diagnostics/runtime") return sendJson(res, runtimeDiagnostics());
  if (req.method === "GET" && pathname === "/api/startup-status") return sendJson(res, startupStatus);
  if (req.method === "GET" && pathname === "/api/config-snapshots") return sendJson(res, listConfigSnapshots());
  if (req.method === "POST" && pathname === "/api/config-snapshots") {
    const data = await readJson(req);
    return sendJson(res, createConfigSnapshot(data.reason || "手动快照"), 201);
  }
  const snapshotRestore = pathname.match(/^\/api\/config-snapshots\/([A-Za-z0-9-]+)\/restore$/);
  if (req.method === "POST" && snapshotRestore) {
    createConfigSnapshot("回滚前自动快照");
    stopAllForwards();
    const result = restoreConfigSnapshotById(snapshotRestore[1]);
    clearConnectionHealthCache();
    return sendJson(res, result);
  }
  const snapshotDelete = pathname.match(/^\/api\/config-snapshots\/([A-Za-z0-9-]+)$/);
  if (req.method === "DELETE" && snapshotDelete) return sendJson(res, deleteConfigSnapshot(snapshotDelete[1]));
  if (req.method === "GET" && pathname === "/api/notifications") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    return sendJson(res, listNotifications(Number(url.searchParams.get("since") || 0)));
  }
  if (req.method === "GET" && pathname === "/api/logs/read") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const raw = url.searchParams.get("raw") === "1";
    return send(res, 200, raw ? readRawLog(url.searchParams.get("path") || "") : readLog(url.searchParams.get("path") || ""), { "Content-Type": "text/plain; charset=utf-8" });
  }
  if (req.method === "GET" && pathname === "/api/backup/database") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const includePasswords = url.searchParams.get("include_passwords") === "1";
    const body = exportDatabaseBuffer(includePasswords);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": body.length,
      "Content-Disposition": `attachment; filename="tunneldesk-${Date.now()}${includePasswords ? "-with-passwords" : ""}.db"`,
      "X-TunnelDesk-Passwords-Included": includePasswords ? "1" : "0"
    });
    res.end(body);
    return;
  }
  if (req.method === "GET" && pathname === "/api/backup/bundle") {
    const body = Buffer.from(JSON.stringify(backupBundle(), null, 2), "utf8");
    res.writeHead(200, secureHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Content-Disposition": `attachment; filename="tunneldesk-backup-${Date.now()}.tdbackup.json"`
    }));
    res.end(body);
    return;
  }
  if (req.method === "POST" && pathname === "/api/restore/database/check") {
    const body = await readBody(req);
    return sendJson(res, inspectRestoreDatabase(body));
  }
  if (req.method === "POST" && pathname === "/api/restore/database") {
    const body = await readBody(req);
    const payload = parseRestorePayload(body);
    inspectRestoreDatabase(body);
    createConfigSnapshot("恢复数据库前自动快照");
    const previousSecurity = readSecuritySettings();
    stopAllForwards();
    closeDatabase();
    const backup = `${DB_PATH}.bak-${Date.now()}`;
    const clearDatabaseSidecars = () => {
      for (const file of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
        try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
      }
    };
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, backup);
    try {
      clearDatabaseSidecars();
      fs.writeFileSync(DB_PATH, payload.database);
      if (payload.security) {
        writeSecuritySettings({
          encryption_enabled: Boolean(payload.security.encryption_enabled),
          encryption_salt: payload.security.encryption_salt || "",
          encryption_check: payload.security.encryption_check || ""
        });
        lockEncryption();
      }
      const identities = normalizeRestoredCredentials(
        DB_PATH,
        payload.identity_bindings,
        payload.credential_bindings,
        Boolean(payload.security?.encryption_enabled),
        Boolean(readSecuritySettings().encryption_enabled)
      );
      reopenDatabase();
      return sendJson(res, {
        ok: true,
        backup,
        restart_required: false,
        database_reopened: true,
        encrypted_bundle: Boolean(payload.security?.encryption_enabled),
        missing_identities: identities.missing,
        unresolved_identities: identities.unresolved,
        encrypted_identities: identities.encrypted,
        mapped_identities: identities.mappings
      });
    } catch (error) {
      try {
        closeDatabase();
        clearDatabaseSidecars();
        if (fs.existsSync(backup)) fs.copyFileSync(backup, DB_PATH);
        writeSecuritySettings(previousSecurity);
        lockEncryption();
        reopenDatabase();
      } catch (rollbackError) {
        console.error(`database restore rollback failed: ${rollbackError.message}`);
      }
      throw error;
    }
  }
  if (req.method === "POST" && pathname === "/api/logs/delete") {
    const data = await readJson(req);
    const result = deleteLogs(data.paths || []);
    return sendJson(res, result);
  }
  if (req.method === "GET" && pathname === "/api/connections") return sendJson(res, listConnections());
  if (req.method === "GET" && pathname === "/api/command-templates") return sendJson(res, listCommandTemplates());
  if (req.method === "GET" && pathname === "/api/forward-templates") return sendJson(res, listForwardTemplates());
  if (req.method === "GET" && pathname === "/api/sftp/jobs") return sendJson(res, listSftpJobs());
  if (req.method === "GET" && pathname === "/api/export/config") return sendJson(res, { config: exportConfig() });

  if (req.method === "POST" && pathname === "/api/identity-files") {
    const body = await readBody(req);
    const part = getPart(req.headers["content-type"], body, "key");
    return sendJson(res, saveUploadedKey(part.filename, part.data), 201);
  }
  if (req.method === "POST" && pathname === "/api/import/parse") {
    const body = await readBody(req);
    const part = getPart(req.headers["content-type"], body, "config");
    const parsed = parseConfigText(part.data.toString("utf8"));
    parsed.filename = part.filename || "config";
    return sendJson(res, parsed);
  }
  if (req.method === "POST" && pathname === "/api/import/parse-text") {
    const data = await readJson(req);
    const parsed = parseConfigText(data.text || "");
    parsed.filename = data.filename || "pasted-config";
    return sendJson(res, parsed);
  }
  if (req.method === "POST" && pathname === "/api/import/test") {
    const data = await readJson(req);
    return sendJson(res, await batchTest(data.tunnels || []));
  }
  if (req.method === "POST" && pathname === "/api/import/save") {
    const data = await readJson(req);
    createConfigSnapshot("批量导入前自动快照");
    return sendJson(res, saveImported(data.tunnels || [], DEFAULT_EXTRA_ARGS), 201);
  }
  if (req.method === "POST" && pathname === "/api/export/config") {
    const data = await readJson(req);
    return sendJson(res, { config: exportConfig(data.ids || []) });
  }
  if (req.method === "POST" && pathname === "/api/test-ssh") {
    const data = await readJson(req);
    if (data.id && data.auth_type === "password" && !data.ssh_password) {
      try { data.ssh_password = getConnection(Number(data.id)).ssh_password || ""; } catch {}
    }
    return sendJson(res, await testSsh(data));
  }
  if (req.method === "POST" && pathname === "/api/command-templates") {
    return sendJson(res, saveCommandTemplate(await readJson(req)), 201);
  }
  if (req.method === "POST" && pathname === "/api/forward-templates") {
    const id = insertForwardTemplate(await readJson(req));
    return sendJson(res, { id }, 201);
  }
  if (req.method === "POST" && pathname === "/api/commands/batch") {
    const data = await readJson(req);
    return sendJson(res, await batchRunCommands(data.ids || [], data.command || "", data));
  }
  if (req.method === "GET" && pathname === "/api/health") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    return sendJson(res, await allConnectionsHealth({force:url.searchParams.get("refresh") === "1"}));
  }
  if (req.method === "GET" && pathname === "/api/forwards/restore-state") return sendJson(res, restoreStateSummary());
  if (req.method === "POST" && pathname === "/api/forwards/restore") return sendJson(res, await restorePreviousForwards());
  if (req.method === "POST" && pathname === "/api/ports/diagnose") {
    const data = await readJson(req);
    return sendJson(res, await diagnosePortUsage(data.host || "127.0.0.1", data.port));
  }
  if (req.method === "POST" && pathname === "/api/ports/recommend") {
    const data = await readJson(req);
    const start = data.port ? Number(data.port) : 6000;
    return sendJson(res, await recommendPort(data.host || "127.0.0.1", start, data.exclude_id || 0));
  }
  if (req.method === "POST" && pathname === "/api/ports/check-forward") {
    const data = await readJson(req);
    const configured = configuredPortOwner(data.port, data.exclude_id || 0);
    const usage = await diagnosePortUsage(data.host || "127.0.0.1", data.port);
    const start = data.port ? Number(data.port) : 6000;
    const recommended = await recommendPort(data.host || "127.0.0.1", start, data.exclude_id || 0).catch(() => null);
    return sendJson(res, { configured, usage, recommended });
  }
  if (req.method === "POST" && pathname === "/api/ports/kill") {
    const data = await readJson(req);
    const result = killPortOwner(data.pid);
    appendSystemLog(`已尝试关闭端口占用进程：${result.process?.name || "未知程序"} PID ${data.pid}`);
    return sendJson(res, result);
  }
  if (req.method === "POST" && pathname === "/api/connections") {
    const id = insertConnection(await readJson(req), DEFAULT_EXTRA_ARGS);
    return sendJson(res, { id }, 201);
  }
  if (req.method === "POST" && pathname === "/api/connections/bulk-delete") {
    const data = await readJson(req);
    const ids = [...new Set((data.ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) throw new Error("请选择要删除的 SSH 连接");
    if (ids.length > 500) throw new Error("单次最多批量删除 500 个 SSH 连接");
    const existingIds = new Set(listConnections().map((item) => item.id));
    if (ids.some((id) => !existingIds.has(id))) throw new Error("部分 SSH 连接不存在，请刷新后重试");
    createConfigSnapshot("批量删除 SSH 连接前自动快照");
    for (const id of ids) deleteConnection(id, stopForward);
    return sendJson(res, { ok: true, deleted: ids.length });
  }
  if (req.method === "POST" && pathname === "/api/connections/bulk-update") {
    const data = await readJson(req);
    const ids = [...new Set((data.ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    const changes = data.changes && typeof data.changes === "object" ? {...data.changes} : {};
    if (changes.auth?.type === "key") {
      const requestedPath = path.resolve(String(changes.auth.identity_file || ""));
      const allowed = listIdentityFiles().some((item) => path.resolve(item.path).toLowerCase() === requestedPath.toLowerCase());
      if (!allowed) throw new Error("所选私钥不在允许的密钥目录中");
      changes.auth = {...changes.auth, identity_file:requestedPath};
    }
    const existingIds = new Set(listConnections().map((item) => item.id));
    if (!ids.length || ids.some((id) => !existingIds.has(id))) throw new Error("部分 SSH 连接不存在，请刷新后重试");
    createConfigSnapshot("批量修改 SSH 连接前自动快照");
    if (Object.prototype.hasOwnProperty.call(changes, "ssh_port") || changes.auth) {
      for (const id of ids) stopConnectionForwards(id);
    }
    const result = bulkUpdateConnections(ids, changes);
    ids.forEach(clearConnectionHealthCache);
    return sendJson(res, result);
  }
  if (req.method === "POST" && pathname === "/api/forwards/bulk-delete") {
    const data = await readJson(req);
    for (const id of data.ids || []) deleteForward(id, stopForward);
    return sendJson(res, { ok: true });
  }

  const parts = pathname.split("/").filter(Boolean);
  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "sftp" && parts[2] === "jobs") {
    if (req.method === "POST" && parts.length === 4 && parts[3] === "clear-finished") return sendJson(res, clearFinishedSftpJobs());
    if (req.method === "POST" && parts.length === 5 && parts[4] === "cancel") return sendJson(res, cancelSftpJob(parts[3]));
    if (req.method === "POST" && parts.length === 5 && parts[4] === "pause") return sendJson(res, pauseSftpJob(parts[3]));
    if (req.method === "POST" && parts.length === 5 && parts[4] === "resume") return sendJson(res, resumeSftpJob(parts[3]));
    if (req.method === "DELETE" && parts.length === 4) return sendJson(res, deleteSftpJob(parts[3]));
    if (req.method === "GET" && parts.length === 5 && parts[4] === "fetch") {
      const item = getSftpJobFile(parts[3]);
      const stat = fs.statSync(item.path);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(item.name)}"`,
        "Cache-Control": "no-store"
      });
      fs.createReadStream(item.path).pipe(res);
      return;
    }
  }
  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "forward-templates") {
    if (req.method === "PUT" && parts.length === 3) {
      updateForwardTemplate(parts[2], await readJson(req));
      return sendJson(res, { ok: true });
    }
    if (req.method === "DELETE" && parts.length === 3) {
      deleteForwardTemplate(parts[2]);
      return sendJson(res, { ok: true });
    }
    if (req.method === "POST" && parts.length === 4 && parts[3] === "apply") {
      const data = await readJson(req);
      createConfigSnapshot("批量应用转发模板前自动快照");
      return sendJson(res, applyForwardTemplate(parts[2], data.connection_ids || []));
    }
  }
  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "connections" && parts[3] === "forwards") {
    const connectionId = Number(parts[2]);
    const id = insertForward(connectionId, await readJson(req));
    clearConnectionHealthCache(connectionId);
    return sendJson(res, { id }, 201);
  }
  if (parts.length >= 4 && parts[0] === "api" && parts[1] === "connections" && parts[3] === "sftp") {
    const connectionId = Number(parts[2]);
    if (req.method === "GET" && parts.length === 4) {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await listRemoteDir(connectionId, url.searchParams.get("path") || ".", {
        page: url.searchParams.get("page"),
        page_size: url.searchParams.get("page_size"),
        query: url.searchParams.get("query"),
        sort: url.searchParams.get("sort"),
        dir: url.searchParams.get("dir"),
        refresh: url.searchParams.get("refresh")
      });
      return send(res, 200, result, { "Cache-Control": "no-store" });
    }
    if (req.method === "POST" && parts[4] === "download") {
      const data = await readJson(req);
      return sendJson(res, startDownloadJob(connectionId, data.path || ""), 202);
    }
    if (req.method === "GET" && parts[4] === "download") {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const remotePath = url.searchParams.get("path") || "";
      streamRemoteFile(connectionId, remotePath, res, req);
      return;
    }
    if (req.method === "GET" && parts[4] === "trash" && parts.length === 5) {
      return sendJson(res, {
        enabled: readRuntimeSettings(RUNTIME_SETTINGS_FILE).sftp_recycle_bin_enabled,
        items: await listRemoteRecycleItems(connectionId)
      });
    }
    if (req.method === "GET" && parts[4] === "read") {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const remotePath = url.searchParams.get("path") || "";
      const result = await readRemoteTextFile(connectionId, remotePath);
      return send(res, 200, { path: remotePath, ...result }, { "Cache-Control": "no-store" });
    }
    if (req.method === "POST" && parts[4] === "upload") {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const dir = url.searchParams.get("path") || ".";
      const filename = decodeURIComponent(String(req.headers["x-file-name"] || url.searchParams.get("filename") || "upload.bin"));
      const upload = await receiveUploadToTemp(req, filename);
      const remotePath = path.posix.join(dir.replace(/\\/g, "/"), path.basename(upload.filename || "upload.bin"));
      const result = startUploadJob(connectionId, upload.path, remotePath, upload.size);
      invalidateRemoteDirectoryCache(connectionId);
      return sendJson(res, result, 202);
    }
    const data = await readJson(req);
    if (req.method === "POST" && parts[4] === "trash" && parts[5] === "restore") {
      const result = await restoreRemoteRecycleItem(connectionId, data.id);
      invalidateRemoteDirectoryCache(connectionId);
      return sendJson(res, result);
    }
    if (req.method === "POST" && parts[4] === "trash" && parts[5] === "delete") {
      return sendJson(res, await deleteRemoteRecycleItem(connectionId, data.id));
    }
    if (req.method === "POST" && parts[4] === "trash" && parts[5] === "clear") {
      return sendJson(res, await clearRemoteRecycleItems(connectionId));
    }
    if (req.method === "POST" && parts[4] === "mkdir") {
      const result = await makeRemoteDir(connectionId, data.path);
      invalidateRemoteDirectoryCache(connectionId);
      return sendJson(res, result);
    }
    if (req.method === "POST" && parts[4] === "create-file") {
      const result = await createRemoteFile(connectionId, data.path);
      invalidateRemoteDirectoryCache(connectionId);
      return sendJson(res, result);
    }
    if (req.method === "POST" && parts[4] === "delete") {
      const recycleEnabled = readRuntimeSettings(RUNTIME_SETTINGS_FILE).sftp_recycle_bin_enabled;
      const result = recycleEnabled
        ? await recycleRemotePath(connectionId, data.path)
        : await deleteRemotePath(connectionId, data.path);
      invalidateRemoteDirectoryCache(connectionId);
      return sendJson(res, result);
    }
    if (req.method === "POST" && parts[4] === "rename") {
      const result = await renameRemotePath(connectionId, data.from, data.to);
      invalidateRemoteDirectoryCache(connectionId);
      return sendJson(res, result);
    }
    if (req.method === "POST" && parts[4] === "copy") {
      const result = data.background ? copyJob(connectionId, data.paths || [], data.target) : await copyRemotePaths(connectionId, data.paths || [], data.target);
      invalidateRemoteDirectoryCache(connectionId);
      return sendJson(res, result);
    }
    if (req.method === "POST" && parts[4] === "move") {
      const result = data.background ? moveJob(connectionId, data.paths || [], data.target) : await moveRemotePaths(connectionId, data.paths || [], data.target);
      invalidateRemoteDirectoryCache(connectionId);
      return sendJson(res, result);
    }
    if (req.method === "POST" && parts[4] === "extract") {
      const result = data.background ? extractJob(connectionId, data.path, data.target) : await extractRemoteArchive(connectionId, data.path, data.target);
      invalidateRemoteDirectoryCache(connectionId);
      return sendJson(res, result);
    }
    if (req.method === "POST" && parts[4] === "compress") {
      const paths = Array.isArray(data.paths) ? data.paths : [data.path];
      const result = compressJob(connectionId, paths, data.target, data.filename || data.name || "");
      invalidateRemoteDirectoryCache(connectionId);
      return sendJson(res, result, 202);
    }
    if (req.method === "POST" && ["permissions", "chmod"].includes(parts[4])) {
      const request = normalizeRemotePermissionRequest(data.paths, data.mode, data.recursive, data.owner, data.group);
      const result = await setRemotePermissions(connectionId, request.paths, request.mode, request.recursive, request.owner, request.group);
      return sendJson(res, result);
    }
    if (req.method === "POST" && parts[4] === "write") {
      const content = Buffer.from(String(data.content || ""), "utf8");
      if (content.length > 512 * 1024) throw new Error("在线编辑内容不能超过 512 KB");
      const result = await writeRemoteFile(connectionId, data.path, content, { backup: Boolean(data.backup) });
      invalidateRemoteDirectoryCache(connectionId);
      return sendJson(res, result);
    }
  }
  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "connections") {
    if (parts[3] === "health") return sendJson(res, await connectionHealth(Number(parts[2]), {force:true}));
    if (parts[3] === "inspect") return sendJson(res, await inspectServer(Number(parts[2])));
    if (parts[3] === "start-forwards") {
      const connection = getConnection(Number(parts[2]));
      try {
        await startConnectionForwards(connection.id);
        clearConnectionHealthCache(connection.id);
        appendSystemLog(`已启动连接 ${connection.name} 的全部转发`);
      } catch (error) {
        appendSystemLog(`连接 ${connection.name} 启动转发失败：${error.message}`);
        throw error;
      }
    }
    else if (parts[3] === "stop-forwards") {
      const connection = getConnection(Number(parts[2]));
      stopConnectionForwards(connection.id);
      clearConnectionHealthCache(connection.id);
      appendSystemLog(`已停止连接 ${connection.name} 的全部转发`);
    }
    else return sendJson(res, { error: "Not found" }, 404);
    return sendJson(res, { ok: true });
  }
  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "forwards") {
    if (parts[3] === "start") {
      const forward = getForward(Number(parts[2]));
      const label = forwardLogLabel(parts[2]);
      try {
        await startForward(Number(parts[2]));
        clearConnectionHealthCache(forward.connection_id);
        appendSystemLog(`已启动转发：${label}`);
      } catch (error) {
        appendSystemLog(`启动转发失败：${label}：${error.message}`);
        throw error;
      }
    }
    else if (parts[3] === "stop") {
      const forward = getForward(Number(parts[2]));
      stopForward(Number(parts[2]));
      clearConnectionHealthCache(forward.connection_id);
      appendSystemLog(`已停止转发：${forwardLogLabel(parts[2])}`);
    }
    else if (parts[3] === "health") {
      const forwardId = Number(parts[2]);
      const connection = listConnections().find((item) => (item.forwards || []).some((forward) => forward.id === forwardId));
      if (!connection) return sendJson(res, { error: "转发不存在" }, 404);
      const health = await connectionHealth(connection.id);
      return sendJson(res, health.forwards.find((forward) => forward.id === forwardId) || {});
    }
    else return sendJson(res, { error: "Not found" }, 404);
    return sendJson(res, { ok: true });
  }
  if (req.method === "PUT" && parts.length === 3 && parts[0] === "api" && parts[1] === "forwards") {
    const before = getForward(Number(parts[2]));
    updateForward(Number(parts[2]), await readJson(req));
    clearConnectionHealthCache(before.connection_id);
    appendSystemLog(`已更新转发：${forwardLogLabel(parts[2])}`);
    return sendJson(res, { ok: true, was_running: Boolean(before.pid) });
  }
  if (req.method === "PUT" && parts.length === 3 && parts[0] === "api" && parts[1] === "connections") {
    updateConnection(Number(parts[2]), await readJson(req), DEFAULT_EXTRA_ARGS);
    clearConnectionHealthCache(Number(parts[2]));
    return sendJson(res, { ok: true });
  }
  if (req.method === "DELETE" && parts.length === 3 && parts[0] === "api" && parts[1] === "connections") {
    deleteConnection(Number(parts[2]), stopForward);
    clearConnectionHealthCache(Number(parts[2]));
    return sendJson(res, { ok: true });
  }
  if (parts.length === 3 && parts[0] === "api" && parts[1] === "command-templates") {
    if (req.method === "PUT") return sendJson(res, updateCommandTemplate(parts[2], await readJson(req)));
    if (req.method === "DELETE") return sendJson(res, deleteCommandTemplate(parts[2]));
  }
  if (req.method === "DELETE" && parts.length === 3 && parts[0] === "api" && parts[1] === "forwards") {
    const forward = getForward(Number(parts[2]));
    deleteForward(Number(parts[2]), stopForward);
    clearConnectionHealthCache(forward.connection_id);
    return sendJson(res, { ok: true });
  }
  return sendJson(res, { error: "Not found" }, 404);
}

function requestHandler(req, res) {
  Promise.resolve().then(async () => {
    const { pathname } = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (pathname.startsWith("/api/")) await handleApi(req, res, pathname);
    else serveStatic(req, res, pathname);
  }).catch((error) => {
    if (!res.headersSent) sendJson(res, { error: error.message || String(error) }, 400);
    else res.destroy();
  });
}

function upgradeHandler(req, socket) {
  try {
    if (!sameOrigin(req) || !isAuthenticated(req)) return socket.destroy();
    const { pathname } = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (pathname === "/ws/terminal") return handleTerminalUpgrade(req, socket);
    if (pathname === "/ws/batch-command") return handleBatchCommandUpgrade(req, socket);
  } catch {}
  socket.destroy();
}

function createHttpListener() {
  const listener = http.createServer(requestHandler);
  listener.on("upgrade", upgradeHandler);
  return listener;
}

function parseArgs(argv = process.argv.slice(2)) {
  const out: any = { listen_hosts: [...DEFAULT_HOSTS], listen_port: DEFAULT_PORT, pidFile: PID_FILE };
  const cliHosts: string[] = [];
  let cliPort;
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--host" || item === "--hosts") {
      const value = argv[++i];
      if (value !== undefined) cliHosts.push(...String(value).split(/[\s,]+/).filter(Boolean));
    } else if (item === "--port") {
      cliPort = argv[++i];
    } else if (item === "--pid-file") {
      out.pidFile = argv[++i];
    }
  }
  if (cliHosts.length) out.listen_hosts = normalizeListenHosts(cliHosts, null);
  if (cliPort !== undefined) out.listen_port = normalizeListenPort(cliPort, null);
  out.host = out.listen_hosts.join(",");
  out.port = out.listen_port;
  out.requested_hosts = [...out.listen_hosts];
  out.requested_port = out.listen_port;
  return out;
}

function normalizeStartArgs(customArgs: any = {}) {
  const source = customArgs || {};
  let hostsValue;
  if (Object.prototype.hasOwnProperty.call(source, "listen_hosts")) hostsValue = source.listen_hosts;
  else if (Object.prototype.hasOwnProperty.call(source, "hosts")) hostsValue = source.hosts;
  else if (Object.prototype.hasOwnProperty.call(source, "host")) {
    const legacyDefault = source.host === DEFAULT_HOST && Number(source.port ?? DEFAULT_PORT) === DEFAULT_PORT && DEFAULT_HOSTS.length > 1;
    hostsValue = legacyDefault ? DEFAULT_HOSTS : source.host;
  } else hostsValue = DEFAULT_HOSTS;
  const portValue = Object.prototype.hasOwnProperty.call(source, "listen_port") ? source.listen_port
    : (Object.prototype.hasOwnProperty.call(source, "port") ? source.port : DEFAULT_PORT);
  const listen_hosts = normalizeListenHosts(hostsValue, null);
  const listen_port = normalizeListenPort(portValue, null);
  return {
    ...source,
    listen_hosts,
    listen_port,
    requested_hosts: [...listen_hosts],
    requested_port: listen_port,
    host: listen_hosts.join(","),
    port: listen_port,
    pidFile: source.pidFile || PID_FILE
  };
}

let args: any = normalizeStartArgs();
let activeServers: any[] = [];
let exitOnShutdown = true;
let onShutdown: null | (() => any) = null;
let desktopIntegration: any = null;
let updateCheckTimer = null;
let startupTaskTimer = null;
let startupEffectsStarted = false;
let shutdownPromise: Promise<any> | null = null;

function listenOne(listener, host, port) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      error.listen_host = host;
      error.listen_port = port;
      listener.removeListener("error", fail);
      listener.removeListener("listening", ready);
      try { listener.close(() => {}); } catch {}
      reject(error);
    };
    const ready = () => {
      if (settled) return;
      settled = true;
      listener.removeListener("error", fail);
      listener.removeListener("listening", ready);
      resolve(listener);
    };
    listener.once("error", fail);
    listener.once("listening", ready);
    listener.listen({ host, port });
  });
}

function closeListener(listener) {
  return new Promise<void>((resolve) => {
    if (!listener || !listener.listening) return resolve();
    try { listener.close(() => resolve()); } catch { resolve(); }
  });
}

async function closeListeners(listeners) {
  await Promise.all((listeners || []).map(closeListener));
}

async function bindAll(hosts, port, factory = createHttpListener) {
  const listeners: any[] = [];
  try {
    for (const host of hosts) {
      const listener = factory();
      await listenOne(listener, host, port);
      listeners.push(listener);
      listener.on("error", (error) => {
        appendSystemLog(`Web 监听 ${host}:${port} 运行时错误：${error.message || error}`);
      });
    }
    return listeners;
  } catch (error) {
    await closeListeners(listeners);
    throw error;
  }
}

async function bindWithFallback(hosts, requestedPort, options: any = {}) {
  const factory = options.factory || createHttpListener;
  const maxFallbacks = Number.isInteger(options.maxFallbacks) ? options.maxFallbacks : MAX_PORT_FALLBACKS;
  let lastError;
  for (let offset = 0; offset <= maxFallbacks && requestedPort + offset <= 65535; offset += 1) {
    const port = requestedPort + offset;
    try {
      const listeners = await bindAll(hosts, port, factory);
      return { listeners, port, fallback_count: offset };
    } catch (error) {
      lastError = error;
      if (error.code !== "EADDRINUSE") throw error;
      if (offset < maxFallbacks) appendSystemLog(`端口 ${port} 已被占用，尝试使用 ${port + 1}`);
    }
  }
  const error: any = lastError || new Error("没有可用的 Web 监听端口");
  error.code = error.code || "EADDRINUSE";
  error.message = `端口 ${requestedPort} 至多尝试 ${maxFallbacks + 1} 个端口后仍不可用`;
  throw error;
}

function lanUrlsForHosts(hosts, port) {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (host) => {
    if (!host || isLoopbackHost(host)) return;
    const url = `http://${host}:${port}`;
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  };
  for (const host of hosts) {
    if (host === "0.0.0.0") {
      const interfaces: any = os.networkInterfaces();
      for (const items of Object.values(interfaces) as any[]) {
        for (const item of items || []) if (item.family === "IPv4" && !item.internal) add(item.address);
      }
    } else add(host);
  }
  return urls;
}

function urlsForHosts(hosts, port) {
  const localHost = hosts.find((host) => isLoopbackHost(host)) || (hosts.includes("0.0.0.0") ? "127.0.0.1" : hosts[0]);
  const localUrl = `http://${localHost}:${port}`;
  const lanUrls = lanUrlsForHosts(hosts, port);
  return { localUrl, lanUrls, urls: [...new Set([localUrl, ...lanUrls])] };
}

function sameListenHosts(left, right) {
  return JSON.stringify([...(left || [])].sort()) === JSON.stringify([...(right || [])].sort());
}

function runtimeSources() {
  const hasPersistedSettings = fs.existsSync(RUNTIME_SETTINGS_FILE);
  return {
    listen_hosts: process.env.TUNNEL_WEB_HOSTS || process.env.TUNNEL_WEB_HOST ? "env" : (hasPersistedSettings ? "file" : "default"),
    listen_port: process.env.TUNNEL_WEB_PORT ? "env" : (hasPersistedSettings ? "file" : "default")
  };
}

function runtimeSettingsView() {
  const persisted = readRuntimeSettings(RUNTIME_SETTINGS_FILE);
  const actualHosts = args.actual_hosts || args.listen_hosts;
  const actualPort = args.actual_port || args.port;
  const urls = activeServers.length ? urlsForHosts(actualHosts, actualPort) : { localUrl: "", lanUrls: [], urls: [] };
  const sources = runtimeSources();
  const saved = {
    ...persisted,
    listen_hosts: [...persisted.listen_hosts],
    listen_port: persisted.listen_port
  };
  const effective = {
    listen_hosts: [...(actualHosts || [])],
    listen_port: actualPort,
    sources
  };
  return {
    ...saved,
    saved,
    effective,
    sources,
    requested_hosts: [...(args.requested_hosts || persisted.listen_hosts)],
    requested_port: Number(args.requested_port || persisted.listen_port),
    actual_hosts: [...(actualHosts || [])],
    actual_port: actualPort,
    available_hosts: availableListenHosts(),
    local_url: urls.localUrl,
    lan_urls: urls.lanUrls,
    urls: urls.urls,
    restart_required: Boolean(activeServers.length) && (
      !sameListenHosts(persisted.listen_hosts, actualHosts)
      || Number(persisted.listen_port) !== Number(actualPort)
    )
  };
}

async function suggestRuntimePort(hosts, requestedPort) {
  for (let offset = 1; offset <= MAX_PORT_FALLBACKS && requestedPort + offset <= 65535; offset += 1) {
    const port = requestedPort + offset;
    try {
      const listeners = await bindAll(hosts, port, () => net.createServer());
      await closeListeners(listeners);
      return port;
    } catch {}
  }
  return null;
}

async function checkRuntimeSettings(data: any = {}) {
  const persisted = readRuntimeSettings(RUNTIME_SETTINGS_FILE);
  let normalized;
  try {
    normalized = normalizeRuntimeSettings({
      listen_hosts: data.listen_hosts ?? persisted.listen_hosts,
      listen_port: data.listen_port ?? persisted.listen_port
    });
  } catch (error) {
    return { available: false, error: error.message || String(error) };
  }
  const resultBase = {
    requested_hosts: [...normalized.listen_hosts],
    requested_port: normalized.listen_port,
    listen_hosts: [...normalized.listen_hosts],
    listen_port: normalized.listen_port
  };
  const currentPort = Number(args.actual_port || args.listen_port);
  if (activeServers.length && normalized.listen_port === currentPort && sameListenHosts(normalized.listen_hosts, args.actual_hosts || args.listen_hosts)) {
    return { available: true, occupied_by_current: true, ...resultBase };
  }
  try {
    const listeners = await bindAll(normalized.listen_hosts, normalized.listen_port, () => net.createServer());
    await closeListeners(listeners);
    return { available: true, occupied_by_current: false, ...resultBase };
  } catch (error) {
    return {
      available: false,
      occupied_by_current: false,
      ...resultBase,
      error: error.message || String(error),
      code: error.code || "",
      suggested_port: error.code === "EADDRINUSE" ? await suggestRuntimePort(normalized.listen_hosts, normalized.listen_port) : null
    };
  }
}

function runtimeDiagnostics() {
  let ptyAvailable = false;
  let ptyError = "";
  const ptyStatus = ptyRuntimeStatus(true);
  try {
    require("node-pty");
    ptyAvailable = true;
  } catch (error) {
    ptyError = error.message || String(error);
  }
  const ptyOperational = ptyAvailable && (process.platform !== "darwin" || (ptyStatus.helper_exists && ptyStatus.helper_executable));
  const readText = (file) => {
    try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; }
  };
  return {
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cwd: process.cwd(),
    data_dir: DATA_DIR,
    log_dir: LOG_DIR,
    web_pid_file: args.pidFile,
    web_url_file: WEB_URL_FILE,
    web_info_file: WEB_INFO_FILE,
    web_url: readText(WEB_URL_FILE),
    web_info: readText(WEB_INFO_FILE),
    web_log: path.join(DATA_DIR, "web.log"),
    runtime_settings_file: RUNTIME_SETTINGS_FILE,
    requested_hosts: args.requested_hosts,
    requested_port: args.requested_port,
    actual_hosts: args.actual_hosts || args.listen_hosts,
    actual_port: args.actual_port || args.port,
    pty: {
      available: ptyAvailable,
      operational: ptyOperational,
      error: ptyError,
      ...ptyStatus,
      optional_dependency: "node-pty"
    }
  };
}

function completeStartup(binding) {
  if (startupEffectsStarted) return;
  startupEffectsStarted = true;
  const actualHosts = [...args.requested_hosts];
  const actualPort = binding.port;
  args.actual_hosts = actualHosts;
  args.actual_port = actualPort;
  args.listen_hosts = actualHosts;
  args.listen_port = actualPort;
  args.host = actualHosts.join(",");
  args.port = actualPort;
  const urls = urlsForHosts(actualHosts, actualPort);
  fs.writeFileSync(args.pidFile, String(process.pid));
  fs.writeFileSync(WEB_URL_FILE, urls.localUrl);
  fs.writeFileSync(WEB_INFO_FILE, JSON.stringify({
    pid: process.pid,
    host: args.host,
    port: actualPort,
    requested_hosts: args.requested_hosts,
    requested_port: args.requested_port,
    actual_hosts: actualHosts,
    actual_port: actualPort,
    fallback_count: binding.fallback_count,
    local_url: urls.localUrl,
    lan_urls: urls.lanUrls,
    urls: urls.urls,
    started_at: new Date().toISOString()
  }, null, 2), "utf8");
  writeRuntimeSettings(RUNTIME_SETTINGS_FILE, {
    ...readRuntimeSettings(RUNTIME_SETTINGS_FILE),
    listen_hosts: args.requested_hosts,
    listen_port: actualPort
  });
  writeStartupStatus({ state:"starting", local_url:urls.localUrl, lan_urls:urls.lanUrls, host:args.host, port:actualPort, requested_hosts:args.requested_hosts, requested_port:args.requested_port, actual_hosts:actualHosts, actual_port:actualPort });
  console.log(`TunnelDesk listening on http://${args.host}:${actualPort}`);
  if (urls.lanUrls.length) console.log(`TunnelDesk LAN URLs:\n${urls.lanUrls.map((url) => `  ${url}`).join("\n")}`);
  appendSystemLog(`TunnelDesk 已启动：http://${args.host}:${actualPort}`);
  if (process.env.TUNNELDESK_DISABLE_UPDATE_CHECK !== "1") {
    clearTimeout(updateCheckTimer);
    updateCheckTimer = setTimeout(() => {
      updateChecker.check().catch(() => {});
    }, 10 * 1000);
    updateCheckTimer.unref?.();
  }
  startupTaskTimer = setTimeout(async () => {
    let autostart = {ok:0,failed:0,errors:[]};
    let restore = {ok:0,failed:0,errors:[]};
    try {
      autostart = await autostartConnections();
    } catch (error) {
      console.error(`autostart failed: ${error.message}`);
      autostart = {ok:0,failed:1,errors:[{error:error.message}]};
    }
    try {
      restore = await restorePreviousForwards();
    } catch (error) {
      console.error(`restore forwards failed: ${error.message}`);
      restore = {ok:0,failed:1,errors:[{error:error.message}]};
    }
    const failures = Number(autostart.failed || 0) + Number(restore.failed || 0);
    writeStartupStatus({state:failures ? "warning" : "ready", completed_at:Date.now(), autostart, restore, failures, log_path:path.join(LOG_DIR, `system-${new Date().toISOString().slice(0,10)}.log`)});
    appendSystemLog(`启动任务完成：自动转发成功${autostart.ok || 0}、失败${autostart.failed || 0}；恢复转发成功${restore.ok || 0}、失败${restore.failed || 0}`);
    startForwardHealthMonitor();
  }, 1000);
  startupTaskTimer.unref?.();
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    clearTimeout(updateCheckTimer);
    updateCheckTimer = null;
    clearTimeout(startupTaskTimer);
    startupTaskTimer = null;
    try {
      appendSystemLog("TunnelDesk 正在关闭");
      await stopForwardHealthMonitor();
      closeAllTerminals();
      stopAllForwards({ preserveRestoreState: true });
      closeDatabase();
    } catch (error) {
      console.error(`stop forwards failed: ${error.message}`);
    }
    try {
      if (fs.existsSync(args.pidFile) && fs.readFileSync(args.pidFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(args.pidFile);
      if (fs.existsSync(WEB_URL_FILE)) fs.unlinkSync(WEB_URL_FILE);
      if (fs.existsSync(WEB_INFO_FILE)) fs.unlinkSync(WEB_INFO_FILE);
    } catch {}
    await closeListeners(activeServers);
    activeServers = [];
    if (exitOnShutdown) process.exit(0);
    if (onShutdown) await Promise.resolve(onShutdown()).catch((error) => console.error(`shutdown callback failed: ${error.message}`));
  })();
  return shutdownPromise;
}

function startServer(customArgs: any = parseArgs(), options: any = {}) {
  args = normalizeStartArgs(customArgs);
  exitOnShutdown = options.exitOnShutdown !== false;
  onShutdown = typeof options.onShutdown === "function" ? options.onShutdown : null;
  desktopIntegration = options.desktopIntegration || null;
  startupEffectsStarted = false;
  shutdownPromise = null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (process.env.TUNNELDESK_RESET_WEB_ACCESS === "1") {
    resetWebAccessSecurity();
    appendSystemLog("已根据 TUNNELDESK_RESET_WEB_ACCESS 重置 Web 访问密码和 Token");
  }
  const ready = bindWithFallback(args.listen_hosts, args.listen_port).then(async (binding) => {
    activeServers = binding.listeners;
    try {
      completeStartup(binding);
    } catch (error) {
      await closeListeners(activeServers);
      activeServers = [];
      throw error;
    }
    return {
      servers: activeServers,
      server: activeServers[0],
      args,
      port: binding.port,
      hosts: args.listen_hosts,
      fallback_count: binding.fallback_count
    };
  }).catch((error) => {
    writeStartupStatus({ state: "error", error: error.message || String(error), code: error.code || "", failed_at: Date.now() });
    appendSystemLog(`TunnelDesk 启动失败：${error.message || error}`);
    throw error;
  });
  // Desktop callers may intentionally ignore the promise; keep a rejection handler attached.
  ready.catch(() => {});
  return {
    get server() { return activeServers[0] || null; },
    get servers() { return activeServers; },
    args,
    ready,
    shutdown
  };
}

if (require.main === module) {
  const started = startServer(parseArgs());
  started.ready.catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  process.on("SIGINT", () => { shutdown(); });
  process.on("SIGTERM", () => { shutdown(); });
  process.on("SIGHUP", () => { shutdown(); });
}

module.exports = { startServer, shutdown, parseArgs, runtimeSettingsView, checkRuntimeSettings };
