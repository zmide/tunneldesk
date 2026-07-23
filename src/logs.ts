const fs = require("node:fs");
const path = require("node:path");
const { LOG_DIR } = require("./config");
const { listConnections } = require("./db");

const TERMINAL_DIR = path.join(LOG_DIR, "terminals");
const BATCH_DIR = path.join(LOG_DIR, "batch");
const logWriteQueues = new Map();

function queueLogWrite(file, data) {
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  let state = logWriteQueues.get(file);
  if (!state) {
    state = { chunks: [], bytes: 0, timer: null, writing: null };
    logWriteQueues.set(file, state);
  }
  state.chunks.push(chunk);
  state.bytes += chunk.length;
  if (state.bytes >= 64 * 1024) flushLogFile(file);
  else if (!state.timer) state.timer = setTimeout(() => flushLogFile(file), 50);
}

function flushLogFile(file) {
  const state = logWriteQueues.get(file);
  if (!state) return Promise.resolve();
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (state.writing) return state.writing;
  if (!state.chunks.length) {
    logWriteQueues.delete(file);
    return Promise.resolve();
  }
  const body = Buffer.concat(state.chunks, state.bytes);
  state.chunks = [];
  state.bytes = 0;
  state.writing = fs.promises.appendFile(file, body).catch(() => {}).finally(() => {
    state.writing = null;
    if (state.chunks.length) flushLogFile(file);
    else logWriteQueues.delete(file);
  });
  return state.writing;
}

async function flushLogWrites() {
  await Promise.all([...logWriteQueues.keys()].map((file) => flushLogFile(file)));
}

process.once("beforeExit", flushLogWrites);

function pad(value) {
  return String(value).padStart(2, "0");
}

function dateParts(date = new Date()) {
  const parts: any = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((out, part) => {
    if (part.type !== "literal") out[part.type] = Number(part.value);
    return out;
  }, {});
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function dayName(date = new Date()) {
  const d = dateParts(date);
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

function zhDateTime(date = new Date()) {
  const d = dateParts(date);
  return `${d.year}年${d.month}月${d.day}日 ${pad(d.hour)}:${pad(d.minute)}:${pad(d.second)}`;
}

function safeName(value) {
  return String(value || "log").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, "_").slice(0, 80) || "log";
}

function ensureLogDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(TERMINAL_DIR, { recursive: true });
  fs.mkdirSync(BATCH_DIR, { recursive: true });
}

function appendSystemLog(message) {
  ensureLogDirs();
  const line = `[${zhDateTime()}] ${message}\n`;
  queueLogWrite(path.join(LOG_DIR, `system-${dayName()}.log`), line);
}

function createTerminalLog(connection, title) {
  ensureLogDirs();
  const startedAt = new Date();
  const label = title || `${connection.name} · 终端`;
  const filename = `${safeName(label)}-${dayName(startedAt)}-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}.log`;
  const fullPath = path.join(TERMINAL_DIR, filename);
  fs.appendFileSync(fullPath, `# ${label}\n# ${connection.ssh_user}@${connection.ssh_host}:${connection.ssh_port}\n# 开始时间：${zhDateTime(startedAt)}\n\n`, "utf8");
  return { fullPath, label, startedAt };
}

function appendTerminalLog(logFile, data) {
  if (!logFile) return;
  ensureLogDirs();
  queueLogWrite(logFile, data);
}

function createBatchCommandLog(command, count) {
  ensureLogDirs();
  const startedAt = new Date();
  const filename = `batch-${dayName(startedAt)}-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}.log`;
  const fullPath = path.join(BATCH_DIR, filename);
  const label = `批量执行-${Number(dateParts(startedAt).month)}月${Number(dateParts(startedAt).day)}日 ${pad(startedAt.getHours())}:${pad(startedAt.getMinutes())}:${pad(startedAt.getSeconds())}`;
  fs.appendFileSync(fullPath, `# ${label}\n# 目标数量：${count}\n# 开始时间：${zhDateTime(startedAt)}\n# 命令：${command}\n\n`, "utf8");
  return { fullPath, label, startedAt };
}

function appendBatchCommandLog(logFile, data) {
  if (!logFile) return;
  ensureLogDirs();
  queueLogWrite(logFile, data);
}

function relativeLogPath(fullPath) {
  return path.relative(LOG_DIR, fullPath).replace(/\\/g, "/");
}

function parseTerminalFilename(name) {
  const stem = name.replace(/\.log$/i, "");
  const match = stem.match(/^(.*)-(\d{4})-(\d{2})-(\d{2})-(\d{6})$/);
  if (!match) return { label: stem, time: 0 };
  const title = match[1].replace(/_/g, " ");
  const time = new Date(`${match[2]}-${match[3]}-${match[4]}T${match[5].slice(0, 2)}:${match[5].slice(2, 4)}:${match[5].slice(4, 6)}`).getTime();
  return { label: `${title}-${Number(match[2])}年${Number(match[3])}月${Number(match[4])}日 ${match[5].slice(0, 2)}:${match[5].slice(2, 4)}:${match[5].slice(4, 6)}`, time };
}

function parseBatchFilename(name) {
  const stem = name.replace(/\.log$/i, "");
  const match = stem.match(/^batch-(\d{4})-(\d{2})-(\d{2})-(\d{6})$/);
  if (!match) return { label: stem, time: 0 };
  const time = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4].slice(0, 2)}:${match[4].slice(2, 4)}:${match[4].slice(4, 6)}`).getTime();
  return {
    label: `批量执行-${Number(match[2])}月${Number(match[3])}日 ${match[4].slice(0, 2)}:${match[4].slice(2, 4)}:${match[4].slice(4, 6)}`,
    time
  };
}

function listLogs() {
  ensureLogDirs();
  const system = fs.readdirSync(LOG_DIR)
    .filter((name) => /^system-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .map((name) => {
      const match = name.match(/^system-(\d{4})-(\d{2})-(\d{2})\.log$/);
      return {
        label: `system-${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`,
        path: name,
        time: new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00`).getTime()
      };
    })
    .sort((a, b) => b.time - a.time);

  const terminalFiles = fs.existsSync(TERMINAL_DIR) ? fs.readdirSync(TERMINAL_DIR).filter((name) => name.endsWith(".log")) : [];
  const batch = (fs.existsSync(BATCH_DIR) ? fs.readdirSync(BATCH_DIR).filter((name) => name.endsWith(".log")) : [])
    .map((name) => {
      const parsed = parseBatchFilename(name);
      return { label: parsed.label, path: relativeLogPath(path.join(BATCH_DIR, name)), time: parsed.time };
    })
    .sort((a, b) => b.time - a.time);
  const byServer: Map<string, any> = new Map(listConnections().map((connection) => [connection.name, { id: connection.id, name: connection.name, logs: [] }]));
  for (const name of terminalFiles) {
    const parsed = parseTerminalFilename(name);
    const serverName = parsed.label.split(" · ")[0].replace(/-\d{4}年.*$/, "");
    if (!byServer.has(serverName)) byServer.set(serverName, { id: null, name: serverName, logs: [] });
    byServer.get(serverName).logs.push({ label: parsed.label, path: relativeLogPath(path.join(TERMINAL_DIR, name)), time: parsed.time });
  }
  const connections = [...byServer.values()]
    .map((item) => ({ ...item, logs: item.logs.sort((a, b) => b.time - a.time) }))
    .filter((item) => item.logs.length)
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return { system, batch, connections };
}

function readLog(relPath) {
  return stripAnsi(readRawLog(relPath));
}

function readRawLog(relPath) {
  const resolved = path.resolve(LOG_DIR, String(relPath || ""));
  if (!resolved.startsWith(path.resolve(LOG_DIR))) throw new Error("日志路径无效");
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) throw new Error("日志不存在");
  return fs.readFileSync(resolved, "utf8");
}

function resolveLogPath(relPath) {
  const resolved = path.resolve(LOG_DIR, String(relPath || ""));
  if (!resolved.startsWith(path.resolve(LOG_DIR))) throw new Error("日志路径无效");
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) throw new Error("日志不存在");
  return resolved;
}

function deleteLogs(paths) {
  ensureLogDirs();
  const deleted = [];
  const errors = [];
  for (const item of paths || []) {
    try {
      const resolved = resolveLogPath(item);
      const queued = logWriteQueues.get(resolved);
      if (queued?.timer) clearTimeout(queued.timer);
      logWriteQueues.delete(resolved);
      fs.unlinkSync(resolved);
      deleted.push(String(item));
    } catch (error) {
      errors.push({ path: String(item), error: error.message });
    }
  }
  return { deleted, errors };
}

function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[PX^_][\s\S]*?\x1B\\)/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

module.exports = {
  appendSystemLog,
  createTerminalLog,
  appendTerminalLog,
  createBatchCommandLog,
  appendBatchCommandLog,
  listLogs,
  readLog,
  readRawLog,
  deleteLogs
};
