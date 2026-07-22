const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { SSH_BIN, SSH_DIR, USER_SSH_DIR, LOG_DIR, DATA_DIR, DEFAULT_EXTRA_ARGS } = require("./config");
const { all, getConnection, getForward, run, now, pidRunning } = require("./db");
const { notifyIssue, notifyRecovery } = require("./notifications");
const { isPasswordConnection, runPasswordCommand, startPasswordForward } = require("./ssh2-client");

const RESTORE_STATE_FILE = path.join(DATA_DIR, "forward-state.json");
let healthMonitorTimer: any = null;
let healthMonitorBusy = false;
let healthMonitorTask: Promise<any> | null = null;
const securedKeyCache = new Set();
const passwordForwards = new Map();

function splitArgs(text) {
  if (!text) return [];
  const args = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;
  while ((match = re.exec(text))) args.push((match[1] ?? match[2] ?? match[3]).replace(/\\(["'])/g, "$1"));
  return args;
}

function effectiveExtraArgs(text) {
  const args = splitArgs(text);
  const joined = args.join(" ").toLowerCase();
  const defaults = splitArgs(DEFAULT_EXTRA_ARGS);
  for (let i = 0; i < defaults.length; i += 1) {
    if (defaults[i] === "-o" && defaults[i + 1]) {
      const name = defaults[i + 1].split("=")[0].toLowerCase();
      if (!joined.includes(name)) args.push("-o", defaults[i + 1]);
    }
  }
  return args;
}

function looksLikePrivateKey(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return false;
    const name = path.basename(file);
    if (name.endsWith(".pub") || ["authorized_keys", "known_hosts", "config"].includes(name)) return false;
    const head = fs.readFileSync(file, "utf8").slice(0, 300);
    return head.includes("PRIVATE KEY") || name.startsWith("id_") || name.startsWith("identity");
  } catch {
    return false;
  }
}

function ensureSshDirs() {
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
}

function windowsAclPrincipals(output, file) {
  const target = path.resolve(String(file || ""));
  return String(output || "").split(/\r?\n/).map((line) => {
    let acl = line.trim();
    if (!acl) return "";
    if (acl.toLowerCase().startsWith(target.toLowerCase())) acl = acl.slice(target.length).trim();
    const match = acl.match(/^(.+?):(?:\([^)]+\))+/);
    return match ? match[1].trim() : "";
  }).filter(Boolean);
}

function riskyWindowsAclPrincipals(principals) {
  const risky = new Set([
    "everyone",
    "nt authority\\authenticated users",
    "builtin\\users",
    "s-1-1-0",
    "s-1-5-11",
    "s-1-5-32-545",
    "*s-1-1-0",
    "*s-1-5-11",
    "*s-1-5-32-545"
  ]);
  return principals.filter((principal) => risky.has(principal.toLowerCase()));
}

function securePrivateKeyPermissions(file) {
  const cacheKey = String(file || "");
  if (cacheKey && securedKeyCache.has(cacheKey)) return;
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  if (process.platform !== "win32") {
    if (cacheKey) securedKeyCache.add(cacheKey);
    return;
  }
  const username = process.env.USERNAME;
  const domain = process.env.USERDOMAIN;
  const account = username ? (domain ? `${domain}\\${username}` : username) : null;
  try {
    spawnSync("icacls", [file, "/inheritance:r"], { encoding: "utf8" });
    const listing = spawnSync("icacls", [file], { encoding: "utf8" }).stdout || "";
    const allowed = new Set([
      account?.toLowerCase(),
      username?.toLowerCase(),
      "nt authority\\system",
      "builtin\\administrators"
    ].filter(Boolean));
    for (const principal of windowsAclPrincipals(listing, file)) {
      if (principal && !allowed.has(principal.toLowerCase())) {
        spawnSync("icacls", [file, "/remove:g", principal], { encoding: "utf8" });
      }
    }
    if (account) spawnSync("icacls", [file, "/grant:r", `${account}:R`], { encoding: "utf8" });
    spawnSync("icacls", [file, "/remove:g", "*S-1-5-11", "*S-1-5-32-545", "*S-1-1-0"], { encoding: "utf8" });
  } catch {}
  if (cacheKey) securedKeyCache.add(cacheKey);
}

function diagnoseSshError(message) {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();
  const suggestions = [];
  let reason = "SSH 操作失败";
  if (/unprotected private key|bad permissions|permissions.*too open/.test(lower)) {
    reason = "私钥权限过宽";
    suggestions.push("在密钥管理中执行一键修复权限。");
    suggestions.push("Windows 下确保私钥只允许当前用户、SYSTEM 或 Administrators 读取。");
  } else if (/permission denied/.test(lower)) {
    reason = "SSH 认证失败";
    suggestions.push("检查用户名、私钥是否正确。");
    suggestions.push("确认服务器允许该用户使用公钥登录。");
  } else if (/connection timed out|operation timed out|connecttimeout/.test(lower)) {
    reason = "连接超时";
    suggestions.push("检查主机地址、端口、防火墙和网络连通性。");
  } else if (/connection refused/.test(lower)) {
    reason = "连接被拒绝";
    suggestions.push("检查 SSH 服务是否运行，以及端口是否正确。");
  } else if (/could not resolve hostname|name or service not known|getaddrinfo/.test(lower)) {
    reason = "主机名解析失败";
    suggestions.push("检查 SSH 主机名或 DNS 配置。");
  } else if (/address already in use|bind.*failed|端口已被占用|listen.*eaddrinuse/.test(lower)) {
    reason = "监听端口被占用";
    suggestions.push("更换本地监听端口，或停止占用该端口的程序。");
  } else if (/remote port forwarding failed|administratively prohibited/.test(lower)) {
    reason = "远程转发被服务器拒绝";
    suggestions.push("检查服务器 sshd_config 是否允许 AllowTcpForwarding。");
    suggestions.push("远程转发还可能需要 GatewayPorts 配置。");
  } else if (/no such file|identity file.*not accessible/.test(lower)) {
    reason = "私钥文件不存在或不可访问";
    suggestions.push("重新上传私钥，或在连接配置中选择正确的私钥。");
  } else if (/host key verification failed/.test(lower)) {
    reason = "主机指纹校验失败";
    suggestions.push("确认服务器指纹变化是否可信。");
    suggestions.push("必要时清理 known_hosts 中旧记录。");
  }
  return {
    reason,
    message: text,
    suggestions,
    display: [reason, text, ...suggestions.map((item) => `建议：${item}`)].filter(Boolean).join("\n")
  };
}

function identityPermissionStatus(file) {
  const item: any = {
    path: file,
    label: path.basename(String(file || "")),
    exists: false,
    ok: false,
    platform: process.platform,
    details: "",
    issues: []
  };
  try {
    if (!file || !fs.existsSync(file)) {
      item.details = "私钥文件不存在";
      item.issues.push("missing");
      return item;
    }
    item.exists = true;
    if (process.platform !== "win32") {
      const mode = fs.statSync(file).mode & 0o777;
      item.mode = `0${mode.toString(8)}`;
      item.ok = (mode & 0o077) === 0;
      item.details = item.ok ? `权限正常（${item.mode}）` : `权限过宽（${item.mode}），建议修复为 0600`;
      if (!item.ok) item.issues.push("mode");
      return item;
    }
    const result = spawnSync("icacls", [file], { encoding: "utf8" });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (result.error || result.status !== 0 || !output) {
      item.details = `无法读取 Windows ACL${result.status != null ? `（退出码 ${result.status}）` : ""}`;
      item.issues.push("acl-read");
      return item;
    }
    const principals = windowsAclPrincipals(output, file);
    const risky = riskyWindowsAclPrincipals(principals);
    item.ok = principals.length > 0 && risky.length === 0;
    item.details = item.ok
      ? "权限正常：仅当前用户、SYSTEM 或 Administrators 等受限账户可访问"
      : risky.length
        ? `权限过宽：${risky.join("、")}`
        : "无法识别 Windows ACL 权限主体";
    if (!item.ok) item.issues.push("acl");
    return item;
  } catch (error) {
    item.details = error.message;
    item.issues.push("error");
    return item;
  }
}

function repairIdentityFile(file) {
  if (!file || !fs.existsSync(file)) throw new Error("私钥文件不存在");
  securePrivateKeyPermissions(file);
  return identityPermissionStatus(file);
}

function listIdentityFiles() {
  ensureSshDirs();
  const result = [];
  const seen = new Set();
  const roots = [
    { path: SSH_DIR, source: "project", source_label: "当前密钥目录" },
    { path: USER_SSH_DIR, source: "user", source_label: "用户 ~/.ssh" }
  ];
  for (const rootInfo of roots) {
    const root = rootInfo.path;
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).sort()) {
      const file = path.join(root, name);
      if (!looksLikePrivateKey(file)) continue;
      if (rootInfo.source === "project") securePrivateKeyPermissions(file);
      const resolved = fs.realpathSync(file);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const status = identityPermissionStatus(resolved);
      result.push({
        label: `${name} - ${rootInfo.source_label}`,
        name,
        path: resolved,
        source: rootInfo.source,
        source_label: rootInfo.source_label,
        permission_ok: status.ok,
        permission_details: status.details
      });
    }
  }
  return result;
}

function identityFileMap() {
  const map = new Map();
  for (const item of listIdentityFiles()) {
    const name = path.basename(item.path);
    if (!map.has(name)) map.set(name, item.path);
    if ([".pem", ".key", ".txt"].includes(path.extname(name).toLowerCase())) {
      const stem = path.basename(name, path.extname(name));
      if (!map.has(stem)) map.set(stem, item.path);
    }
  }
  return map;
}

function saveUploadedKey(filename, data) {
  ensureSshDirs();
  if (!data.length) throw new Error("上传文件为空");
  if (data.length > 1024 * 1024) throw new Error("私钥文件不能超过 1MB");
  if (!data.subarray(0, 500).toString("utf8").includes("PRIVATE KEY")) throw new Error("文件看起来不是 SSH 私钥");
  const safe = path.basename(filename || "uploaded_key").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+|[._]+$/g, "") || "uploaded_key";
  if (safe.endsWith(".pub")) throw new Error("请选择私钥文件，不要上传 .pub 公钥");
  let target = path.join(SSH_DIR, safe);
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext);
  for (let i = 1; fs.existsSync(target); i += 1) target = path.join(SSH_DIR, `${stem}-${i}${ext}`);
  fs.writeFileSync(target, data, { mode: 0o600, flag: "wx" });
  securePrivateKeyPermissions(target);
  return { label: path.basename(target), path: target, directory: SSH_DIR };
}

function readRestoreState() {
  try {
    const data = JSON.parse(fs.readFileSync(RESTORE_STATE_FILE, "utf8"));
    return new Set((data.connection_ids || []).map((id) => Number(id)).filter(Boolean));
  } catch {
    return new Set();
  }
}

function writeRestoreState(ids) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RESTORE_STATE_FILE, JSON.stringify({ connection_ids: [...ids].sort((a, b) => a - b), updated_at: Date.now() }, null, 2));
}

function setRestoreConnection(connectionId, enabled) {
  const ids = readRestoreState();
  if (enabled) ids.add(Number(connectionId));
  else ids.delete(Number(connectionId));
  writeRestoreState(ids);
}

function restoreStateSummary() {
  const ids = readRestoreState();
  return { connection_ids: [...ids] };
}

function buildForwardCommand(connection, forward) {
  const args = ["-N", "-T", "-o", "ExitOnForwardFailure=yes", "-p", String(connection.ssh_port)];
  if (connection.identity_file) {
    securePrivateKeyPermissions(connection.identity_file);
    args.push("-i", connection.identity_file);
  }
  args.push(...effectiveExtraArgs(connection.extra_args));
  if (forward.mode === "local") args.push("-L", `${forward.bind_host}:${forward.bind_port}:${forward.target_host}:${forward.target_port}`);
  else if (forward.mode === "remote") args.push("-R", `${forward.bind_host}:${forward.bind_port}:${forward.target_host}:${forward.target_port}`);
  else args.push("-D", `${forward.bind_host}:${forward.bind_port}`);
  args.push(`${connection.ssh_user}@${connection.ssh_host}`);
  return args;
}

function appendForwardArgs(args, forward) {
  if (forward.mode === "local") args.push("-L", `${forward.bind_host}:${forward.bind_port}:${forward.target_host}:${forward.target_port}`);
  else if (forward.mode === "remote") args.push("-R", `${forward.bind_host}:${forward.bind_port}:${forward.target_host}:${forward.target_port}`);
  else args.push("-D", `${forward.bind_host}:${forward.bind_port}`);
}

function buildConnectionCommand(connection, forwards) {
  const args = ["-N", "-T", "-o", "ExitOnForwardFailure=yes", "-p", String(connection.ssh_port)];
  if (connection.identity_file) {
    securePrivateKeyPermissions(connection.identity_file);
    args.push("-i", connection.identity_file);
  }
  args.push(...effectiveExtraArgs(connection.extra_args));
  for (const forward of forwards) appendForwardArgs(args, forward);
  args.push(`${connection.ssh_user}@${connection.ssh_host}`);
  return args;
}

function forwardNotifyLabel(connection, forward) {
  const rule = forward.mode === "socks"
    ? `${forward.bind_host}:${forward.bind_port}`
    : `${forward.bind_host}:${forward.bind_port} -> ${forward.target_host}:${forward.target_port}`;
  return `${connection.name} / ${forward.service_name || rule}`;
}

function buildTerminalCommand(connection) {
  const args = ["-tt", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", String(connection.ssh_port)];
  if (connection.identity_file) {
    securePrivateKeyPermissions(connection.identity_file);
    args.push("-i", connection.identity_file);
  }
  args.push(...effectiveExtraArgs(connection.extra_args));
  args.push(`${connection.ssh_user}@${connection.ssh_host}`);
  return args;
}

function portAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(Number(port), host);
  });
}

function normalizeListenHost(host) {
  return ["0.0.0.0", "::", ""].includes(String(host || "")) ? "127.0.0.1" : String(host || "127.0.0.1");
}

function parseJsonOutput(text, fallback) {
  try {
    if (!String(text || "").trim()) return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function runProcess(command, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (status, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(null, new Error("命令执行超时"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk.toString()}`.slice(-12000); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-12000); });
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

function processInfo(pid) {
  const id = Number(pid);
  if (!id) return null;
  if (process.platform === "win32") {
    const script = `Get-Process -Id ${id} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress`;
    const out = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
    const item = parseJsonOutput(out.stdout, null);
    if (item) return { pid: Number(item.Id || id), name: item.ProcessName || `PID ${id}`, path: item.Path || "" };
  } else {
    const out = spawnSync("ps", ["-p", String(id), "-o", "pid=,comm=,args="], { encoding: "utf8" });
    const line = String(out.stdout || "").trim();
    if (line) {
      const match = line.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/);
      if (match) return { pid: Number(match[1]), name: match[2], path: match[3] || "" };
    }
  }
  return { pid: id, name: `PID ${id}`, path: "" };
}

async function processInfoAsync(pid) {
  const id = Number(pid);
  if (!id) return null;
  if (process.platform === "win32") {
    const script = `Get-Process -Id ${id} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress`;
    const out: any = await runProcess("powershell.exe", ["-NoProfile", "-Command", script], 4000);
    const item = parseJsonOutput(out.stdout, null);
    if (item) return { pid: Number(item.Id || id), name: item.ProcessName || `PID ${id}`, path: item.Path || "" };
  } else {
    const out: any = await runProcess("ps", ["-p", String(id), "-o", "pid=,comm=,args="], 4000);
    const line = String(out.stdout || "").trim();
    if (line) {
      const match = line.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/);
      if (match) return { pid: Number(match[1]), name: match[2], path: match[3] || "" };
    }
  }
  return { pid: id, name: `PID ${id}`, path: "" };
}

function uniqueProcesses(items) {
  const map = new Map();
  for (const item of items || []) {
    const pid = Number(item?.pid);
    if (!pid || map.has(pid)) continue;
    map.set(pid, { pid, name: item.name || `PID ${pid}`, path: item.path || "" });
  }
  return [...map.values()];
}

async function inspectPortOwner(port) {
  const targetPort = Number(port);
  if (!targetPort) return [];
  if (process.platform === "win32") {
    const script = [
      `$items = Get-NetTCPConnection -LocalPort ${targetPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
      `$items | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path } | ConvertTo-Json -Compress`
    ].join("; ");
    const out: any = await runProcess("powershell.exe", ["-NoProfile", "-Command", script], 5000);
    const data = parseJsonOutput(out.stdout, []);
    return uniqueProcesses((Array.isArray(data) ? data : [data]).map((item) => ({
      pid: item.Id,
      name: item.ProcessName,
      path: item.Path
    })));
  }
  const lsof: any = await runProcess("lsof", ["-nP", `-iTCP:${targetPort}`, "-sTCP:LISTEN"], 4000);
  if (lsof.status === 0 && lsof.stdout) {
    const rows = lsof.stdout.trim().split(/\r?\n/).slice(1);
    return uniqueProcesses(rows.map((line) => {
      const parts = line.trim().split(/\s+/);
      return { name: parts[0], pid: Number(parts[1]), path: parts.slice(8).join(" ") };
    }));
  }
  const ss: any = await runProcess("ss", ["-ltnp", `sport = :${targetPort}`], 4000);
  if (ss.status === 0 && ss.stdout) {
    const matches = [...ss.stdout.matchAll(/pid=(\d+),/g)];
    return uniqueProcesses((await Promise.all(matches.map((match) => processInfoAsync(Number(match[1]))))).filter(Boolean));
  }
  const netstat: any = await runProcess("netstat", ["-ltnp"], 4000);
  if (netstat.status === 0 && netstat.stdout) {
    const rows = netstat.stdout.split(/\r?\n/).filter((line) => line.includes(`:${targetPort} `));
    return uniqueProcesses(rows.map((line) => {
      const match = line.match(/\s(\d+)\/([^\s]+)\s*$/);
      return match ? { pid: Number(match[1]), name: match[2], path: "" } : null;
    }).filter(Boolean));
  }
  return [];
}

async function diagnosePortUsage(host, port) {
  const occupied = !(await portAvailable(host, port));
  const processes = occupied ? await inspectPortOwner(port) : [];
  const label = `${host}:${port}`;
  return {
    host,
    port: Number(port),
    occupied,
    processes,
    message: occupied
      ? `监听端口 ${label} 已被占用${processes.length ? `：${processes.map((item) => `${item.name}(${item.pid})`).join("、")}` : ""}`
      : `监听端口 ${label} 可用`
  };
}

async function recommendPort(host, port, excludeId = 0) {
  const start = Math.max(1, Math.min(Number(port) || 1, 65535));
  const configured = new Set(all("SELECT bind_port FROM connection_forwards WHERE mode IN ('local','socks') AND id<>?", [Number(excludeId || 0)]).map((row) => Number(row.bind_port)));
  for (let current = start; current <= 65535; current += 1) {
    if (configured.has(current)) continue;
    if (await portAvailable(host, current)) return { host, requested_port: Number(port), recommended_port: current };
  }
  throw new Error("没有找到可用端口");
}

function configuredPortOwner(port, excludeId = 0) {
  const row = all(
    `SELECT f.id, f.bind_host, f.bind_port, c.name AS connection_name
     FROM connection_forwards f
     JOIN connections c ON c.id=f.connection_id
     WHERE f.mode IN ('local','socks') AND f.bind_port=? AND f.id<>?
     LIMIT 1`,
    [Number(port), Number(excludeId || 0)]
  )[0];
  return row || null;
}

function killPortOwner(pid) {
  const id = Number(pid);
  if (!id) throw new Error("缺少 PID");
  if (id === process.pid) throw new Error("不能关闭当前 TunnelDesk 进程");
  const info = processInfo(id);
  if (!pidRunning(id)) return { ok: true, already_stopped: true, process: info };
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(id), "/T", "/F"], { encoding: "utf8" });
    if (result.status !== 0 && pidRunning(id)) throw new Error((result.stderr || result.stdout || "关闭进程失败").trim());
  } else {
    try {
      process.kill(id, "SIGTERM");
    } catch (error) {
      throw new Error(error.message);
    }
  }
  return { ok: true, process: info };
}

async function startForward(id) {
  return startForwardInternal(id, {});
}

async function startForwardInternal(id, options: any = {}) {
  const forward = getForward(id);
  const connection = getConnection(forward.connection_id);
  stopForward(id, { preserveRestoreState: true });
  if (["local", "socks"].includes(forward.mode)) {
    let usage = await diagnosePortUsage(forward.bind_host, forward.bind_port);
    if (usage.occupied && options.cleanupSshPortOwner) {
      const sshOwners = (usage.processes || []).filter((item) => /(^|[\\/])ssh(?:\.exe)?$/i.test(item.path || "") || /^ssh(?:\.exe)?$/i.test(item.name || ""));
      if (sshOwners.length && sshOwners.length === (usage.processes || []).length) {
        for (const owner of sshOwners) {
          try {
            stopPid(Number(owner.pid));
            fs.mkdirSync(LOG_DIR, { recursive: true });
            fs.appendFileSync(path.join(LOG_DIR, `forward-${id}.log`), `cleanup old ssh port owner: ${owner.name} PID ${owner.pid}\n`);
          } catch {}
        }
        await new Promise((resolve) => setTimeout(resolve, 600));
        usage = await diagnosePortUsage(forward.bind_host, forward.bind_port);
      }
    }
    if (usage.occupied) {
      const details = usage.processes.length
        ? usage.processes.map((item) => `${item.name} PID ${item.pid}${item.path ? `\n${item.path}` : ""}`).join("\n")
        : "未能识别占用进程";
      const display = diagnoseSshError(`${usage.message}\n${details}`).display;
      notifyIssue(`forward:${Number(id)}:down`, {
        type: "forward",
        level: "error",
        title: "转发启动失败",
        message: `${forwardNotifyLabel(connection, forward)}\n${display}`,
        action: { view: "forwards", connection_id: connection.id, forward_id: Number(id) }
      });
      throw new Error(display);
    }
  }
  if (isPasswordConnection(connection)) {
    let managed;
    try {
      managed = await startPasswordForward(connection, forward, {
        onError: (error) => {
          if (passwordForwards.get(Number(id)) !== managed) return;
          const message = diagnoseSshError(error.message || "密码 SSH 转发连接已断开").display;
          run("UPDATE connection_forwards SET status='failed', pid=NULL, last_error=?, updated_at=? WHERE id=?", [message, now(), Number(id)]);
          notifyIssue(`forward:${Number(id)}:down`, {
            type: "forward",
            level: "error",
            title: "转发连接异常",
            message: `${forwardNotifyLabel(connection, forward)}\n${message}`,
            action: { view: "forwards", connection_id: connection.id, forward_id: Number(id) }
          });
        },
        onClose: () => {
          if (passwordForwards.get(Number(id)) !== managed) return;
          passwordForwards.delete(Number(id));
          run("UPDATE connection_forwards SET status='failed', pid=NULL, last_error=?, updated_at=? WHERE id=?", ["密码 SSH 连接已关闭", now(), Number(id)]);
        }
      });
      passwordForwards.set(Number(id), managed);
      run("UPDATE connection_forwards SET pid=NULL, status='running', restore=1, started_at=?, reconnect_count=0, last_error=NULL, updated_at=? WHERE id=?", [now(), now(), Number(id)]);
      setRestoreConnection(forward.connection_id, true);
      notifyRecovery(`forward:${Number(id)}:down`, {
        type: "forward",
        title: "转发已启动",
        message: forwardNotifyLabel(connection, forward),
        action: { view: "forwards", connection_id: connection.id, forward_id: Number(id) }
      });
      return;
    } catch (error) {
      try { await managed?.close(); } catch {}
      const display = diagnoseSshError(error.message || "密码 SSH 转发启动失败").display;
      run("UPDATE connection_forwards SET status='failed', pid=NULL, last_error=?, updated_at=? WHERE id=?", [display, now(), Number(id)]);
      notifyIssue(`forward:${Number(id)}:down`, {
        type: "forward",
        level: "error",
        title: "转发启动失败",
        message: `${forwardNotifyLabel(connection, forward)}\n${display}`,
        action: { view: "forwards", connection_id: connection.id, forward_id: Number(id) }
      });
      throw new Error(display);
    }
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `forward-${id}.log`);
  const log = fs.openSync(logPath, "a");
  fs.writeSync(log, `\n--- start ${new Date().toISOString()} ---\n`);
  const child = spawn(SSH_BIN, buildForwardCommand(connection, forward), { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 900));
  const running = pidRunning(child.pid);
  run(
    "UPDATE connection_forwards SET pid=?, status=?, restore=?, started_at=?, reconnect_count=?, last_error=NULL, updated_at=? WHERE id=?",
    [running ? child.pid : null, running ? "running" : "failed", running ? 1 : Number(forward.restore || 0), running ? now() : null, running ? 0 : Number(forward.reconnect_count || 0), now(), Number(id)]
  );
  if (running) setRestoreConnection(forward.connection_id, true);
  if (running) {
    notifyRecovery(`forward:${Number(id)}:down`, {
      type: "forward",
      title: "转发已恢复",
      message: forwardNotifyLabel(connection, forward),
      action: { view: "forwards", connection_id: connection.id, forward_id: Number(id) }
    });
  }
  if (!running) {
    let logText = "";
    try { logText = fs.readFileSync(logPath, "utf8").slice(-4000); } catch {}
    const display = diagnoseSshError(logText || "转发启动失败，请查看日志").display;
    run("UPDATE connection_forwards SET last_error=?, updated_at=? WHERE id=?", [display, now(), Number(id)]);
    notifyIssue(`forward:${Number(id)}:down`, {
      type: "forward",
      level: "error",
      title: "转发启动失败",
      message: `${forwardNotifyLabel(connection, forward)}\n${display}`,
      action: { view: "forwards", connection_id: connection.id, forward_id: Number(id) }
    });
    throw new Error(display);
  }
}

function stopPid(pid) {
  if (pid && pidRunning(pid)) {
    try {
      if (process.platform === "win32") process.kill(pid);
      else process.kill(-pid, "SIGTERM");
    } catch {}
  }
}

function connectionForwards(connectionId) {
  return all("SELECT * FROM connection_forwards WHERE connection_id=? ORDER BY id", [Number(connectionId)]);
}

async function startConnectionForwards(connectionId, options: any = {}) {
  const forwards = connectionForwards(connectionId);
  if (!forwards.length) throw new Error("该连接没有转发配置");
  stopConnectionForwards(connectionId, { preserveRestoreState: true });
  const errors = [];
  for (const forward of forwards) {
    try {
      await startForwardInternal(forward.id, options);
    } catch (error) {
      errors.push(`${forward.mode} ${forward.bind_host}:${forward.bind_port}：${error.message}`);
    }
  }
  const running = connectionForwards(connectionId).filter((forward) => passwordForwards.has(Number(forward.id)) || (forward.pid && pidRunning(forward.pid)));
  if (running.length && options.recordState !== false) setRestoreConnection(connectionId, true);
  if (errors.length) {
    if (!running.length) setRestoreConnection(connectionId, false);
    throw new Error(errors.join("\n\n"));
  }
}

function stopForward(id, options: any = {}) {
  const forward = getForward(id);
  const managed = passwordForwards.get(Number(id));
  if (managed) {
    passwordForwards.delete(Number(id));
    managed.close().catch(() => {});
  }
  const pid = Number(forward.pid || 0);
  if (pid) stopPid(pid);
  const restore = options.preserveRestoreState ? Number(forward.restore || 0) : 0;
  run("UPDATE connection_forwards SET pid=NULL, status='stopped', restore=?, reconnect_count=0, started_at=NULL, updated_at=? WHERE id=?", [restore, now(), Number(id)]);
  if (pid) run("UPDATE connection_forwards SET pid=NULL, status='stopped', restore=0, reconnect_count=0, started_at=NULL, updated_at=? WHERE pid=? AND id<>?", [now(), pid, Number(id)]);
  if (!options.preserveRestoreState && !connectionRunning(forward.connection_id)) setRestoreConnection(forward.connection_id, false);
}

function stopConnectionForwards(connectionId, options: any = {}) {
  const forwards = connectionForwards(connectionId);
  for (const forward of forwards) {
    const managed = passwordForwards.get(Number(forward.id));
    if (managed) {
      passwordForwards.delete(Number(forward.id));
      managed.close().catch(() => {});
    }
  }
  const pids = [...new Set(forwards.map((forward) => forward.pid).filter(Boolean))];
  for (const pid of pids) stopPid(Number(pid));
  const restore = options.preserveRestoreState ? 1 : 0;
  run("UPDATE connection_forwards SET pid=NULL, status='stopped', restore=?, reconnect_count=0, started_at=NULL, updated_at=? WHERE connection_id=?", [restore, now(), Number(connectionId)]);
  if (!options.preserveRestoreState) setRestoreConnection(connectionId, false);
}

function stopAllForwards(options: any = {}) {
  const rows = all("SELECT DISTINCT connection_id FROM connection_forwards WHERE pid IS NOT NULL OR status = 'running'");
  for (const row of rows) stopConnectionForwards(row.connection_id, options);
}

async function autostartConnections() {
  const rows = all("SELECT id, name FROM connections WHERE autostart_forwards=1 ORDER BY id");
  const result = { ok:0, failed:0, errors:[] };
  for (const row of rows) {
    try {
      await startConnectionForwards(row.id, { cleanupSshPortOwner: true });
      result.ok++;
    } catch (error) {
      result.failed++;
      result.errors.push({id:row.id,name:row.name,error:error.message});
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(path.join(LOG_DIR, `connection-${row.id}.log`), `autostart failed: ${error.message}\n`);
    }
  }
  return result;
}

async function restorePreviousForwards() {
  const ids = readRestoreState();
  const result = { ok: 0, failed: 0, errors: [] };
  const forwardRows = all("SELECT id FROM connection_forwards WHERE restore=1 ORDER BY connection_id, id");
  if (forwardRows.length) {
    for (const row of forwardRows) {
      try {
        await startForwardInternal(row.id, { cleanupSshPortOwner: true });
        result.ok++;
      } catch (error) {
        result.failed++;
        result.errors.push({ id: row.id, error: error.message });
      }
    }
    return result;
  }
  for (const id of ids) {
    try {
      await startConnectionForwards(id, { recordState: true, cleanupSshPortOwner: true });
      result.ok++;
    } catch (error) {
      result.failed++;
      result.errors.push({ id, error: error.message });
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(path.join(LOG_DIR, `connection-${id}.log`), `restore failed: ${error.message}\n`);
    }
  }
  return result;
}

function connectionRunning(connectionId) {
  return connectionForwards(connectionId).some((forward) => passwordForwards.has(Number(forward.id)) || (forward.pid && pidRunning(forward.pid)));
}

function checkLocalPort(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port), timeout: 1200 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

const connectionHealthCache = new Map();
const CONNECTION_HEALTH_TTL_MS = 30000;

function clearConnectionHealthCache(connectionId = null) {
  if (connectionId === null) connectionHealthCache.clear();
  else connectionHealthCache.delete(Number(connectionId));
}

async function connectionHealth(connectionId, options: any = {}) {
  const id = Number(connectionId);
  const cached = connectionHealthCache.get(id);
  if (!options.force && cached && Date.now() - cached.checked_at < CONNECTION_HEALTH_TTL_MS) return {...cached, cached:true, cache_age_ms:Date.now() - cached.checked_at};
  const connection = getConnection(connectionId);
  const forwards = connectionForwards(connectionId);
  const ssh = await testSsh(connection);
  const forwardChecks = [];
  for (const forward of forwards) {
    const running = Boolean(passwordForwards.has(Number(forward.id)) || (forward.pid && pidRunning(forward.pid)));
    let reachable: any = null;
    let port_usage: any = null;
    if (running && ["local", "socks"].includes(forward.mode)) {
      const host = normalizeListenHost(forward.bind_host);
      reachable = await checkLocalPort(host, forward.bind_port);
    } else if (!running && ["local", "socks"].includes(forward.mode)) {
      port_usage = await diagnosePortUsage(forward.bind_host, forward.bind_port);
    }
    forwardChecks.push({ id: forward.id, mode: forward.mode, running, reachable, status: running ? "running" : (forward.status || "stopped"), port_usage, last_error: forward.last_error || "" });
  }
  const ok = ssh.ok && forwardChecks.every((item) => item.reachable !== false);
  const result = {
    id: Number(connectionId),
    name: connection.name,
    ok,
    status: ok ? "正常" : "异常",
    ssh,
    forwards: forwardChecks,
    checked_at: Date.now(),
    cached: false,
    cache_ttl_ms: CONNECTION_HEALTH_TTL_MS
  };
  connectionHealthCache.set(id, result);
  return result;
}

async function allConnectionsHealth(options: any = {}) {
  const rows = all("SELECT id FROM connections ORDER BY group_name, name, id");
  return mapLimit(rows, 4, (row) => connectionHealth(row.id, options));
}

async function mapLimit(items, limit, mapper) {
  const result = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      result[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

function startForwardHealthMonitor() {
  if (healthMonitorTimer) return;
  healthMonitorTimer = setInterval(() => {
    if (healthMonitorBusy) return;
    healthMonitorBusy = true;
    healthMonitorTask = (async () => {
      try {
        const forwardRows = all("SELECT id, pid, restore FROM connection_forwards WHERE restore=1 OR status='running'");
        for (const row of forwardRows) {
          try {
            const running = passwordForwards.has(Number(row.id)) || (row.pid && pidRunning(row.pid));
            if (row.restore && !running) {
              run("UPDATE connection_forwards SET status='reconnecting', reconnect_count=reconnect_count+1, updated_at=? WHERE id=?", [now(), row.id]);
              await startForwardInternal(row.id, { cleanupSshPortOwner: true });
            }
          } catch (error) {
            run("UPDATE connection_forwards SET status='failed', pid=NULL, last_error=?, updated_at=? WHERE id=?", [error.message, now(), row.id]);
            fs.mkdirSync(LOG_DIR, { recursive: true });
            fs.appendFileSync(path.join(LOG_DIR, `forward-${row.id}.log`), `auto reconnect failed: ${error.message}\n`);
            try {
              const forward = getForward(row.id);
              const connection = getConnection(forward.connection_id);
              notifyIssue(`forward:${Number(row.id)}:down`, {
                type: "forward",
                level: "error",
                title: "转发自动重连失败",
                message: `${forwardNotifyLabel(connection, forward)}\n${error.message}`,
                action: { view: "forwards", connection_id: connection.id, forward_id: Number(row.id) }
              });
            } catch {}
          }
        }
        const ids = readRestoreState();
        for (const id of ids) {
          try {
            if (!connectionRunning(id)) await startConnectionForwards(id, { recordState: true });
          } catch (error) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
            fs.appendFileSync(path.join(LOG_DIR, `connection-${id}.log`), `auto reconnect failed: ${error.message}\n`);
          }
        }
      } finally {
        healthMonitorBusy = false;
        healthMonitorTask = null;
      }
    })();
  }, 30000);
  healthMonitorTimer.unref?.();
}

async function stopForwardHealthMonitor() {
  if (healthMonitorTimer) clearInterval(healthMonitorTimer);
  healthMonitorTimer = null;
  const task = healthMonitorTask;
  if (task) await task.catch(() => {});
}

function runSshTest(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(SSH_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current, chunk) => (current + chunk.toString()).slice(-12000);
    const finish = (status, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(null, new Error("SSH 测试超时"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
    try {
      child.stdin?.end();
    } catch {}
  });
}

async function testSsh(data) {
  const host = String(data.ssh_host || "").trim();
  const user = String(data.ssh_user || "").trim();
  if (!host || !user) throw new Error("缺少 SSH 主机或用户");
  if (isPasswordConnection(data)) {
    const start = Date.now();
    const result: any = await runPasswordCommand({ ...data, ssh_password: String(data.ssh_password || "") }, "true", null, 15000);
    const rawOutput = (result.stdout || result.stderr || (result.error ? result.error.message : "") || (result.status === 0 ? "SSH 连接成功（退出码 0）" : `SSH 退出码 ${result.status}`)).trim();
    const diagnosis = diagnoseSshError(rawOutput);
    return { ok: result.status === 0, elapsed_ms: Date.now() - start, output: result.status === 0 ? rawOutput : diagnosis.display, raw_output: rawOutput, diagnosis };
  }
  const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", String(data.ssh_port || 22)];
  if (data.identity_file) {
    securePrivateKeyPermissions(data.identity_file);
    args.push("-i", data.identity_file);
  }
  args.push(...effectiveExtraArgs(data.extra_args));
  args.push(`${user}@${host}`, "true");
  const start = Date.now();
  const result: any = await runSshTest(args, 15000);
  const ok = result.status === 0;
  const rawOutput = (result.stdout || result.stderr || (result.error ? result.error.message : "") || (ok ? "SSH 连接成功（退出码 0）" : `SSH 退出码 ${result.status}`)).trim();
  const diagnosis = diagnoseSshError(rawOutput);
  return {
    ok,
    elapsed_ms: Date.now() - start,
    output: ok ? rawOutput : diagnosis.display,
    raw_output: rawOutput,
    diagnosis
  };
}

function runSshCommandForConnection(connection, command, timeoutMs = 60000) {
  if (isPasswordConnection(connection)) return runPasswordCommand(connection, command, null, timeoutMs);
  const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", String(connection.ssh_port || 22)];
  if (connection.identity_file) {
    securePrivateKeyPermissions(connection.identity_file);
    args.push("-i", connection.identity_file);
  }
  args.push(...effectiveExtraArgs(connection.extra_args));
  args.push(`${connection.ssh_user}@${connection.ssh_host}`, String(command || ""));
  return new Promise((resolve) => {
    const child = spawn(SSH_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current, chunk) => (current + chunk.toString()).slice(-60000);
    const finish = (status, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(null, new Error("命令执行超时"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

async function batchRunCommands(ids, command, options: any = {}) {
  const cleanIds = [...new Set((ids || []).map(Number).filter(Boolean))];
  const text = String(command || "").trim();
  if (!cleanIds.length) throw new Error("请选择 SSH 连接");
  if (!text) throw new Error("请输入要执行的命令");
  const timeoutMs = Math.max(5000, Math.min(Number(options.timeout_ms || 60000), 10 * 60 * 1000));
  const rows = cleanIds.map((id) => getConnection(id));
  const results = await mapLimit(rows, 4, async (connection) => {
    const started = Date.now();
    const result: any = await runSshCommandForConnection(connection, text, timeoutMs);
    const ok = result.status === 0;
    const output = `${result.stdout || ""}${result.stderr || ""}${result.error ? result.error.message : ""}`.trim();
    return {
      id: connection.id,
      name: connection.name,
      ok,
      exit_code: result.status,
      elapsed_ms: Date.now() - started,
      output: output || (ok ? "命令执行完成，无输出" : `命令退出码 ${result.status}`)
    };
  });
  return {
    total: results.length,
    ok: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results
  };
}

module.exports = {
  splitArgs,
  effectiveExtraArgs,
  listIdentityFiles,
  securePrivateKeyPermissions,
  identityPermissionStatus,
  repairIdentityFile,
  identityFileMap,
  saveUploadedKey,
  diagnoseSshError,
  buildForwardCommand,
  buildConnectionCommand,
  buildTerminalCommand,
  startForward,
  stopForward,
  startConnectionForwards,
  stopConnectionForwards,
  stopAllForwards,
  autostartConnections,
  restorePreviousForwards,
  restoreStateSummary,
  diagnosePortUsage,
  recommendPort,
  configuredPortOwner,
  killPortOwner,
  connectionHealth,
  allConnectionsHealth,
  clearConnectionHealthCache,
  startForwardHealthMonitor,
  stopForwardHealthMonitor,
  testSsh,
  batchRunCommands,
  runSshCommandForConnection
};
