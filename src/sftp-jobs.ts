const crypto = require("node:crypto");
const fs = require("node:fs");
const iconv = require("iconv-lite");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DATA_DIR, SSH_BIN } = require("./config");
const { getConnection } = require("./db");
const { effectiveExtraArgs, securePrivateKeyPermissions } = require("./ssh");
const { notifyEvent } = require("./notifications");
const { isPasswordConnection, spawnPasswordCommand } = require("./ssh2-client");

const jobs = new Map();
const JOBS_FILE = path.join(DATA_DIR, "sftp-jobs.json");
const DOWNLOADS_DIR = path.join(DATA_DIR, "downloads");
const MAX_HISTORY = 120;
const ACTIVE_STATUSES = new Set(["running", "pending", "paused"]);
let historyCache: any[] | null = null;
let persistTimer: any = null;

function resetTransferSpeed(job) {
  job.speed_bps = 0;
  job.speed_sample_at = Date.now();
  job.speed_sample_bytes = Number(job.transferred || 0);
}

function recordTransferred(job, bytes) {
  job.transferred = Number(job.transferred || 0) + Number(bytes || 0);
  job.progress = job.size ? Math.min(99, Math.floor(job.transferred / job.size * 100)) : 0;
  const now = Date.now();
  const elapsed = now - Number(job.speed_sample_at || now);
  if (elapsed >= 500) {
    const delta = Math.max(0, job.transferred - Number(job.speed_sample_bytes || 0));
    const current = delta * 1000 / elapsed;
    job.speed_bps = job.speed_bps ? Math.round(job.speed_bps * 0.35 + current * 0.65) : Math.round(current);
    job.speed_sample_at = now;
    job.speed_sample_bytes = job.transferred;
  }
}

function finishTransferMetrics(job) {
  const elapsed = Math.max(1, Number(job.finished_at || Date.now()) - Number(job.started_at || Date.now()));
  job.average_bps = Math.round(Number(job.transferred || 0) * 1000 / elapsed);
  job.speed_bps = 0;
}

function readHistory(): any[] {
  if (historyCache) return historyCache;
  try {
    const data = JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
    historyCache = Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    historyCache = [];
  }
  return historyCache;
}

function persistJobs(immediate = false) {
  if (!immediate) {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => persistJobs(true), 400);
    return;
  }
  clearTimeout(persistTimer);
  persistTimer = null;
  const active: any[] = [...jobs.values()].map(({ child, stream, out, responder, pauseNow, ...job }: any) => job);
  const byId = new Map(readHistory().map((job: any) => [job.id, job]));
  for (const job of active) byId.set(job.id, job);
  const next = [...byId.values()].sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0)).slice(0, MAX_HISTORY);
  writeJsonJobs(next);
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

const FILENAME_ENCODINGS = new Set(["utf8", "gb18030", "gbk", "big5", "shift_jis", "euc-kr", "latin1"]);

function filenameEncoding(connection) {
  const encoding = String(connection?.sftp_filename_encoding || "utf8").toLowerCase();
  return FILENAME_ENCODINGS.has(encoding) ? encoding : "utf8";
}

function remotePathOperand(connection, value) {
  const text = String(value || "");
  const encoding = filenameEncoding(connection);
  if (encoding === "utf8") return shellQuote(text);
  const bytes = iconv.encode(text, encoding);
  if (iconv.decode(bytes, encoding) !== text) throw new Error(`文件名包含 ${encoding} 无法表示的字符`);
  const octal = [...bytes].map((byte) => `\\0${byte.toString(8).padStart(3, "0")}`).join("");
  return `"$(printf '%b' ${shellQuote(octal)})"`;
}

function sshArgs(connection, command) {
  const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", String(connection.ssh_port || 22)];
  if (connection.identity_file) {
    securePrivateKeyPermissions(connection.identity_file);
    args.push("-i", connection.identity_file);
  }
  args.push(...effectiveExtraArgs(connection.extra_args));
  args.push(`${connection.ssh_user}@${connection.ssh_host}`, command);
  return args;
}

function spawnRemote(connection, command) {
  const portableCommand = `sh -c ${shellQuote(command)}`;
  return isPasswordConnection(connection)
    ? spawnPasswordCommand(connection, portableCommand)
    : spawn(SSH_BIN, sshArgs(connection, portableCommand), { stdio: ["pipe", "pipe", "pipe"] });
}

function listSftpJobs() {
  const active: any[] = [...jobs.values()].map(({ child, stream, out, responder, pauseNow, ...job }: any) => ({
    ...job,
    can_resume: ["upload", "download"].includes(job.type) && ["paused", "failed"].includes(job.status)
  }));
  const activeIds = new Set(active.map((job) => job.id));
  return [...active, ...readHistory().filter((job) => !activeIds.has(job.id))]
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
    .slice(0, MAX_HISTORY);
}

function clearFinishedSftpJobs() {
  const keepStatuses = new Set(["running", "pending", "paused", "failed"]);
  const before = listSftpJobs();
  for (const [id, job] of jobs) {
    if (!keepStatuses.has(job.status)) jobs.delete(id);
  }
  const active = [...jobs.values()].map(({ child, stream, out, responder, pauseNow, ...job }: any) => job);
  const activeIds = new Set(active.map((job: any) => job.id));
  const history = readHistory().filter((job: any) => keepStatuses.has(job.status) && !activeIds.has(job.id));
  writeJsonJobs([...active, ...history]);
  const removed = Math.max(0, before.length - active.length - history.length);
  return { ok: true, removed };
}

function writeJsonJobs(items) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  historyCache = items.slice(0, MAX_HISTORY);
  const temporary = `${JOBS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ jobs: historyCache }, null, 2), "utf8");
  fs.renameSync(temporary, JOBS_FILE);
}

process.once("beforeExit", () => {
  if (persistTimer) persistJobs(true);
});

function startSftpJob(connectionId, type, command, label) {
  const connection = getConnection(connectionId);
  const id = crypto.randomUUID();
  const job: any = {
    id,
    connection_id: Number(connectionId),
    connection_name: connection.name,
    type,
    label,
    status: "running",
    stdout: "",
    stderr: "",
    error: "",
    created_at: Date.now(),
    started_at: Date.now(),
    finished_at: null
  };
  resetTransferSpeed(job);
  const child = spawnRemote(connection, command);
  job.child = child;
  jobs.set(id, job);
  persistJobs();
  child.stdout.on("data", (chunk) => { job.stdout = `${job.stdout}${chunk.toString()}`.slice(-12000); persistJobs(); });
  child.stderr.on("data", (chunk) => { job.stderr = `${job.stderr}${chunk.toString()}`.slice(-12000); persistJobs(); });
  let finished = false;
  const finish = (status, error = "") => {
    if (finished || job.status === "cancelled") return;
    finished = true;
    job.status = status;
    job.error = error;
    job.finished_at = Date.now();
    persistJobs(true);
    notifyEvent({
      type: "sftp",
      level: status === "done" ? "success" : "error",
      title: status === "done" ? "SFTP 任务已完成" : "SFTP 任务失败",
      message: `${job.connection_name} · ${job.label}${job.error ? `\n${job.error}` : ""}`,
      action: { view: "sftp", connection_id: job.connection_id }
    }, { cooldown_ms: 0 });
  };
  child.on("error", (error) => finish("failed", error.message));
  child.on("close", (code, signal) => {
    finish(code === 0 ? "done" : "failed", code === 0 ? "" : (job.stderr || `退出码 ${code ?? ""}${signal ? `，信号 ${signal}` : ""}`));
  });
  return { id, status: job.status };
}

function startUploadJob(connectionId, localPath, remotePath, size = 0) {
  const connection = getConnection(connectionId);
  const id = crypto.randomUUID();
  const label = `上传 ${path.basename(remotePath || localPath || "文件")}`;
  const job: any = {
    id,
    connection_id: Number(connectionId),
    connection_name: connection.name,
    type: "upload",
    label,
    status: "running",
    stdout: "",
    stderr: "",
    error: "",
    size: Number(size || 0),
    transferred: 0,
    progress: 0,
    remote_path: remotePath,
    local_path: localPath,
    created_at: Date.now(),
    started_at: Date.now(),
    finished_at: null
  };
  resetTransferSpeed(job);
  const child = spawnRemote(connection, `cat > ${remotePathOperand(connection, remotePath)}`);
  const stream = fs.createReadStream(localPath);
  job.child = child;
  job.stream = stream;
  jobs.set(id, job);
  persistJobs();

  const finish = (status, error = "") => {
    if (job.finished_at && status !== "paused") return;
    job.status = status;
    job.error = error || "";
    if (status !== "paused") job.finished_at = Date.now();
    if (status === "done") {
      job.transferred = job.size || job.transferred;
      job.progress = 100;
      try { fs.unlinkSync(localPath); } catch {}
    }
    if (status !== "paused") finishTransferMetrics(job);
    persistJobs(status !== "paused");
    if (status !== "paused") {
      notifyEvent({
        type: "sftp",
        level: status === "done" ? "success" : "error",
        title: status === "done" ? "SFTP 上传已完成" : "SFTP 上传失败",
        message: `${job.connection_name} · ${job.label}${job.error ? `\n${job.error}` : ""}`,
        action: { view: "sftp", connection_id: job.connection_id }
      }, { cooldown_ms: 0 });
    }
  };

  stream.on("data", (chunk) => {
    recordTransferred(job, chunk.length);
    persistJobs();
  });
  stream.on("error", (error) => {
    try { child.kill("SIGKILL"); } catch {}
    finish("failed", error.message);
  });
  child.stdout.on("data", (chunk) => { job.stdout = `${job.stdout}${chunk.toString()}`.slice(-12000); persistJobs(); });
  child.stderr.on("data", (chunk) => { job.stderr = `${job.stderr}${chunk.toString()}`.slice(-12000); persistJobs(); });
  child.on("error", (error) => finish("failed", error.message));
  child.on("close", (code, signal) => {
    if (job.status === "cancelled" || job.status === "paused") return;
    finish(code === 0 ? "done" : "failed", code === 0 ? "" : (job.stderr || `退出码 ${code ?? ""}${signal ? `，信号 ${signal}` : ""}`));
  });
  stream.pipe(child.stdin);
  return { id, status: job.status };
}

function cancelSftpJob(id) {
  const job = jobs.get(id);
  if (!job) throw new Error("任务不存在");
  if (!ACTIVE_STATUSES.has(job.status)) return { ok: true, status: job.status };
  try { job.child?.kill("SIGTERM"); } catch {}
  try { job.stream?.destroy(); } catch {}
  try { job.responder?.kill?.("SIGTERM"); } catch {}
  try { job.responder?.destroy?.(); } catch {}
  job.status = "cancelled";
  job.finished_at = Date.now();
  job.error = "用户已取消";
  finishTransferMetrics(job);
  persistJobs(true);
  return { ok: true, status: job.status };
}

function cleanupJobArtifacts(job) {
  try { if (job.temp_path) fs.unlinkSync(job.temp_path); } catch {}
  if (job.type === "upload") {
    try { if (job.local_path) fs.unlinkSync(job.local_path); } catch {}
  }
}

function deleteSftpJob(id) {
  const job = jobs.get(id);
  if (!job) {
    const hist = readHistory().find((item) => item.id === id);
    if (hist) {
      const remaining = readHistory().filter((item) => item.id !== id);
      writeJsonJobs(remaining);
      if (hist.temp_path) try { fs.unlinkSync(hist.temp_path); } catch {}
      return { ok: true };
    }
    throw new Error("任务不存在");
  }
  if (ACTIVE_STATUSES.has(job.status)) throw new Error("请先暂停或取消运行中的任务");
  cleanupJobArtifacts(job);
  jobs.delete(id);
  writeJsonJobs(readHistory().filter((item) => item.id !== id));
  return { ok: true };
}

function getRemoteSize(connection, remotePath) {
  const child = spawnRemote(connection, `wc -c < ${remotePathOperand(connection, remotePath)} | tr -d ' '`);
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error("获取远程文件大小超时")); }, 15000);
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk) => { err += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `读取远程文件大小失败（退出码 ${code ?? "?"}）`));
      const size = Number((out || "").trim());
      resolve(Number.isFinite(size) ? size : 0);
    });
  });
}

function startDownloadJob(connectionId, remotePath) {
  const connection = getConnection(connectionId);
  const id = crypto.randomUUID();
  const basename = path.posix.basename(String(remotePath || "").replace(/\\/g, "/")) || "download";
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const tempPath = path.join(DOWNLOADS_DIR, `${id}-${basename}`);
  const job = {
    id,
    connection_id: Number(connectionId),
    connection_name: connection.name,
    type: "download",
    label: `下载 ${basename}`,
    remote_path: remotePath,
    temp_path: tempPath,
    status: "pending",
    stdout: "",
    stderr: "",
    error: "",
    size: 0,
    transferred: 0,
    progress: 0,
    created_at: Date.now(),
    started_at: Date.now(),
    finished_at: null
  };
  resetTransferSpeed(job);
  jobs.set(id, job);
  persistJobs();
  runDownloadJob(id, true);
  return { id, status: job.status };
}

function runDownloadJob(id, fetchSize) {
  const job = jobs.get(id);
  if (!job) return;
  const connection = getConnection(job.connection_id);
  (async () => {
    try {
      if (fetchSize || !job.size) {
        job.size = await getRemoteSize(connection, job.remote_path);
        persistJobs();
      }
      if (job.status === "cancelled") return;
      const offset = fs.existsSync(job.temp_path) ? fs.statSync(job.temp_path).size : 0;
      job.transferred = offset;
      job.progress = job.size ? Math.min(99, Math.floor(offset / job.size * 100)) : 0;
      if (job.size && offset >= job.size && job.size > 0) {
        finishDownloadJob(id, true);
        return;
      }
      const command = offset > 0 ? `tail -c +${offset + 1} ${remotePathOperand(connection, job.remote_path)}` : `cat -- ${remotePathOperand(connection, job.remote_path)}`;
      const child = spawnRemote(connection, command);
      const out = fs.createWriteStream(job.temp_path, offset > 0 ? { flags: "a" } : {});
      job.child = child;
      job.out = out;
      job.status = "running";
      job.started_at = job.started_at || Date.now();
      job.finished_at = null;
      job.error = "";
      resetTransferSpeed(job);
      persistJobs();
      let paused = false;
      const finish = (status, error = "") => {
        if (job.finished_at && status !== "paused") return;
        try { out.destroy(); } catch {}
        if (status !== "paused") try { child.kill("SIGTERM"); } catch {}
        if (status === "done") {
          job.transferred = job.size || fs.existsSync(job.temp_path) ? fs.statSync(job.temp_path).size : job.transferred;
          job.progress = 100;
        }
        job.status = status;
        if (error) job.error = error;
        if (status !== "paused") job.finished_at = Date.now();
        if (status !== "paused") finishTransferMetrics(job);
        persistJobs(status !== "paused");
        if (status === "done" || status === "failed") {
          notifyEvent({
            type: "sftp",
            level: status === "done" ? "success" : "error",
            title: status === "done" ? "SFTP 下载已完成" : "SFTP 下载失败",
            message: `${job.connection_name} · ${job.label}${job.error ? `\n${job.error}` : ""}`,
            action: { view: "sftp", connection_id: job.connection_id }
          }, { cooldown_ms: 0 });
        }
      };
      child.stdout.on("data", (chunk) => {
        if (paused) return;
        if (!out.write(chunk)) { child.stdout.pause(); out.once("drain", () => child.stdout.resume()); }
        recordTransferred(job, chunk.length);
        persistJobs();
      });
      child.stderr.on("data", (chunk) => { job.stderr = `${job.stderr}${chunk.toString()}`.slice(-12000); persistJobs(); });
      child.on("error", (error) => finish("failed", error.message));
      child.on("close", (code, signal) => {
        if (job.status === "paused" || job.status === "cancelled") return;
        out.end(() => {
          if (paused) return;
          if (code === 0) {
            finish("done");
          } else {
            const realSize = fs.existsSync(job.temp_path) ? fs.statSync(job.temp_path).size : job.transferred;
            if (job.size && realSize >= job.size) finish("done");
            else finish("failed", job.stderr || `退出码 ${code ?? ""}${signal ? `，信号 ${signal}` : ""}`);
          }
        });
      });
      job.pauseNow = () => {
        paused = true;
        try { child.stdout.pause(); } catch {}
        try { child.kill("SIGTERM"); } catch {}
        finish("paused");
      };
    } catch (error) {
      job.status = "failed";
      job.error = error.message || "下载启动失败";
      job.finished_at = Date.now();
      persistJobs(true);
      notifyEvent({ type: "sftp", level: "error", title: "SFTP 下载失败", message: `${job.connection_name} · ${job.label}\n${job.error}`, action: { view: "sftp", connection_id: job.connection_id } }, { cooldown_ms: 0 });
    }
  })();
}

function finishDownloadJob(id, complete) {
  const job = jobs.get(id);
  if (!job) return;
  try { job.out?.destroy(); } catch {}
  try { job.child?.kill("SIGTERM"); } catch {}
  if (complete) {
    job.transferred = fs.existsSync(job.temp_path) ? fs.statSync(job.temp_path).size : job.transferred;
    job.progress = 100;
    job.status = "done";
    job.finished_at = Date.now();
    finishTransferMetrics(job);
    persistJobs(true);
    notifyEvent({ type: "sftp", level: "success", title: "SFTP 下载已完成", message: `${job.connection_name} · ${job.label}`, action: { view: "sftp", connection_id: job.connection_id } }, { cooldown_ms: 0 });
  }
}

function pauseSftpJob(id) {
  const job = jobs.get(id);
  if (!job) throw new Error("任务不存在");
  if (!ACTIVE_STATUSES.has(job.status)) return { ok: true, status: job.status };
  if (job.status !== "running") {
    job.status = "paused";
    job.speed_bps = 0;
    persistJobs(true);
    return { ok: true, status: job.status };
  }
  if (job.type === "download" && typeof job.pauseNow === "function") {
    job.pauseNow();
  } else if (job.type === "upload") {
    try { job.child?.kill("SIGTERM"); } catch {}
    try { job.stream?.destroy(); } catch {}
    job.status = "paused";
    job.speed_bps = 0;
    persistJobs(true);
  } else {
    try { job.child?.kill("SIGTERM"); } catch {}
    job.status = "paused";
    job.speed_bps = 0;
    persistJobs(true);
  }
  return { ok: true, status: job.status };
}

function resumeSftpJob(id) {
  const job = jobs.get(id);
  if (!job) {
    const hist = readHistory().find((item) => item.id === id);
    if (!hist) throw new Error("任务不存在");
    return { ok: false, error: "历史任务无法恢复，请重新开始下载或上传" };
  }
  if (job.status === "running") return { ok: true, status: job.status };
  if (!["paused", "failed"].includes(job.status)) throw new Error(`当前状态（${job.status}）无法继续`);
  if (job.type === "download") {
    runDownloadJob(id, false);
    return { ok: true, status: job.status };
  }
  if (job.type === "upload") {
    resumeUploadJob(id);
    return { ok: true, status: job.status };
  }
  throw new Error("该任务类型暂不支持继续");
}

function resumeUploadJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  const connection = getConnection(job.connection_id);
  const offset = fs.existsSync(job.local_path) ? fs.statSync(job.local_path).size : 0;
  const transferred = Math.min(job.transferred || 0, offset);
  const command = transferred > 0 ? `cat >> ${remotePathOperand(connection, job.remote_path)}` : `cat > ${remotePathOperand(connection, job.remote_path)}`;
  const child = spawnRemote(connection, command);
  const stream = fs.createReadStream(job.local_path, transferred > 0 ? { start: transferred } : {});
  job.child = child;
  job.stream = stream;
  job.status = "running";
  job.error = "";
  job.transferred = transferred;
  job.progress = job.size ? Math.min(99, Math.floor(transferred / job.size * 100)) : 0;
  job.started_at = Date.now();
  job.finished_at = null;
  resetTransferSpeed(job);
  persistJobs();
  const finish = (status, error = "") => {
    if (job.finished_at && status !== "paused") return;
    if (status !== "paused") try { stream.destroy(); } catch {}
    if (status !== "paused") try { child.kill("SIGTERM"); } catch {}
    job.status = status;
    if (error) job.error = error;
    if (status !== "paused") {
      job.finished_at = Date.now();
      if (status === "done") { job.transferred = job.size || job.transferred; job.progress = 100; try { fs.unlinkSync(job.local_path); } catch {} }
      finishTransferMetrics(job);
    }
    persistJobs(status !== "paused");
    if (status === "done" || status === "failed") {
      notifyEvent({ type: "sftp", level: status === "done" ? "success" : "error", title: status === "done" ? "SFTP 上传已完成" : "SFTP 上传失败", message: `${job.connection_name} · ${job.label}${job.error ? `\n${job.error}` : ""}`, action: { view: "sftp", connection_id: job.connection_id } }, { cooldown_ms: 0 });
    }
  };
  stream.on("data", (chunk) => { recordTransferred(job, chunk.length); persistJobs(); });
  stream.on("error", (error) => { try { child.kill("SIGKILL"); } catch {} finish("failed", error.message); });
  child.stdout.on("data", (chunk) => { job.stdout = `${job.stdout}${chunk.toString()}`.slice(-12000); persistJobs(); });
  child.stderr.on("data", (chunk) => { job.stderr = `${job.stderr}${chunk.toString()}`.slice(-12000); persistJobs(); });
  child.on("error", (error) => finish("failed", error.message));
  child.on("close", (code, signal) => {
    if (job.status === "paused" || job.status === "cancelled") return;
    finish(code === 0 ? "done" : "failed", code === 0 ? "" : (job.stderr || `退出码 ${code ?? ""}${signal ? `，信号 ${signal}` : ""}`));
  });
  stream.pipe(child.stdin);
}

function getSftpJobFile(id) {
  const job = jobs.get(id) || readHistory().find((item) => item.id === id);
  if (!job) throw new Error("任务不存在");
  if (job.type !== "download") throw new Error("该任务没有可下载的文件");
  if (!fs.existsSync(job.temp_path)) throw new Error("临时文件不存在");
  return { path: job.temp_path, name: path.posix.basename(job.remote_path || "download") };
}

function crossCopyJob(sourceConnectionId, targetConnectionId, paths, targetDir = ".") {
  const sourceConnection = getConnection(sourceConnectionId);
  const targetConnection = getConnection(targetConnectionId);
  if (Number(sourceConnectionId) === Number(targetConnectionId)) throw new Error("跨主机复制必须选择不同的源连接和目标连接");
  if (filenameEncoding(sourceConnection) !== filenameEncoding(targetConnection)) {
    throw new Error("源主机和目标主机的 SFTP 文件名编码必须一致，避免复制后文件名乱码");
  }
  const normalized: string[] = [...new Set<string>((paths || []).map((item) => path.posix.normalize(String(item || "").replace(/\\/g, "/"))).filter(Boolean))];
  if (!normalized.length) throw new Error("请选择要跨主机复制的文件或目录");
  if (normalized.length > 200 || normalized.some((item) => item.includes("\0") || item === "." || item === ".." || item.startsWith("../") || item.length > 4096)) {
    throw new Error("跨主机复制路径无效或数量过多");
  }
  const parent = path.posix.dirname(normalized[0]) || ".";
  if (normalized.some((item) => (path.posix.dirname(item) || ".") !== parent)) throw new Error("跨主机复制的项目必须位于同一目录");
  const names = normalized.map((item) => path.posix.basename(item));
  const sourceNames = names.map((name) => remotePathOperand(sourceConnection, `./${name}`)).join(" ");
  const collisionChecks = names.map((name) => {
    const operand = remotePathOperand(targetConnection, `./${name}`);
    return `if [ -e ${operand} ] || [ -L ${operand} ]; then echo "目标目录已存在同名项目" >&2; exit 1; fi`;
  }).join("; ");
  const sourceCommand = `tar -cf - -C ${remotePathOperand(sourceConnection, parent)} -- ${sourceNames}`;
  const targetCommand = `cd ${remotePathOperand(targetConnection, targetDir)} && ${collisionChecks} && tar -xf -`;
  const source = spawnRemote(sourceConnection, sourceCommand);
  const target = spawnRemote(targetConnection, targetCommand);
  const id = crypto.randomUUID();
  const job: any = {
    id,
    connection_id: Number(targetConnectionId),
    connection_name: targetConnection.name,
    source_connection_id: Number(sourceConnectionId),
    source_connection_name: sourceConnection.name,
    target_connection_id: Number(targetConnectionId),
    type: "cross-copy",
    label: `从 ${sourceConnection.name} 复制 ${normalized.length} 项`,
    status: "running",
    stdout: "",
    stderr: "",
    error: "",
    transferred: 0,
    progress: 0,
    created_at: Date.now(),
    started_at: Date.now(),
    finished_at: null,
    child: source,
    responder: target
  };
  resetTransferSpeed(job);
  jobs.set(id, job);
  persistJobs();
  let sourceCode = null;
  let targetCode = null;
  let finished = false;
  const finish = (status, error = "") => {
    if (finished || job.status === "cancelled") return;
    finished = true;
    if (status !== "done") {
      try { source.kill("SIGTERM"); } catch {}
      try { target.kill("SIGTERM"); } catch {}
    }
    job.status = status;
    job.error = error;
    job.finished_at = Date.now();
    if (status === "done") job.progress = 100;
    finishTransferMetrics(job);
    persistJobs(true);
    notifyEvent({
      type: "sftp",
      level: status === "done" ? "success" : "error",
      title: status === "done" ? "跨主机复制已完成" : "跨主机复制失败",
      message: `${sourceConnection.name} → ${targetConnection.name} · ${normalized.length} 项${error ? `\n${error}` : ""}`,
      action: { view: "sftp", connection_id: Number(targetConnectionId) }
    }, { cooldown_ms: 0 });
  };
  const maybeFinish = () => {
    if (sourceCode === null || targetCode === null) return;
    if (sourceCode === 0 && targetCode === 0) finish("done");
    else finish("failed", job.stderr || `源主机退出码 ${sourceCode}，目标主机退出码 ${targetCode}`);
  };
  source.stdout.on("data", (chunk) => { recordTransferred(job, chunk.length); persistJobs(); });
  source.stderr.on("data", (chunk) => { job.stderr = `${job.stderr}${sourceConnection.name}: ${chunk.toString()}`.slice(-12000); persistJobs(); });
  target.stdout.on("data", (chunk) => { job.stdout = `${job.stdout}${chunk.toString()}`.slice(-12000); persistJobs(); });
  target.stderr.on("data", (chunk) => { job.stderr = `${job.stderr}${targetConnection.name}: ${chunk.toString()}`.slice(-12000); persistJobs(); });
  source.on("error", (error) => finish("failed", `${sourceConnection.name}: ${error.message}`));
  target.on("error", (error) => finish("failed", `${targetConnection.name}: ${error.message}`));
  target.stdin.on("error", (error) => finish("failed", `${targetConnection.name}: ${error.message}`));
  source.on("close", (code) => { sourceCode = code; maybeFinish(); });
  target.on("close", (code) => { targetCode = code; maybeFinish(); });
  source.stdout.pipe(target.stdin);
  return { id, status: job.status, type: job.type, connection_id: Number(targetConnectionId) };
}

function copyJob(connectionId, paths, targetDir) {
  const connection = getConnection(connectionId);
  const quoted = (paths || []).map((item) => remotePathOperand(connection, item)).join(" ");
  if (!quoted) throw new Error("请选择要复制的文件");
  return startSftpJob(connectionId, "copy", `cp -a -- ${quoted} ${remotePathOperand(connection, targetDir)}`, `复制 ${paths.length} 项`);
}

function moveJob(connectionId, paths, targetDir) {
  const connection = getConnection(connectionId);
  const quoted = (paths || []).map((item) => remotePathOperand(connection, item)).join(" ");
  if (!quoted) throw new Error("请选择要移动的文件");
  return startSftpJob(connectionId, "move", `mv -- ${quoted} ${remotePathOperand(connection, targetDir)}`, `移动 ${paths.length} 项`);
}

function extractJob(connectionId, remotePath, targetDir) {
  const connection = getConnection(connectionId);
  const lower = String(remotePath || "").toLowerCase();
  let command;
  if (lower.endsWith(".zip")) command = `cd ${remotePathOperand(connection, targetDir)} && unzip -o ${remotePathOperand(connection, remotePath)}`;
  else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) command = `cd ${remotePathOperand(connection, targetDir)} && tar -xzf ${remotePathOperand(connection, remotePath)}`;
  else if (lower.endsWith(".tar")) command = `cd ${remotePathOperand(connection, targetDir)} && tar -xf ${remotePathOperand(connection, remotePath)}`;
  else throw new Error("暂只支持 zip、tar.gz、tgz、tar 解压");
  return startSftpJob(connectionId, "extract", command, `解压 ${remotePath}`);
}

function normalizeCompressionRequest(paths, targetDir = ".", archiveName = "", connection = null) {
  const source = Array.isArray(paths) ? paths : [paths];
  const normalizedPaths = [...new Set(source.map((item) => path.posix.normalize(String(item || "").replace(/\\/g, "/"))).filter(Boolean))];
  if (!normalizedPaths.length) throw new Error("请选择要压缩的文件或目录");
  if (normalizedPaths.length > 200) throw new Error("一次最多压缩 200 个文件或目录");
  if (normalizedPaths.some((item) => item === "." || item === ".." || item.startsWith("../") || item.includes("\0") || item.length > 4096)) throw new Error("压缩路径无效");
  const parent = path.posix.dirname(normalizedPaths[0]) || ".";
  if (normalizedPaths.some((item) => (path.posix.dirname(item) || ".") !== parent)) throw new Error("多选压缩必须选择同一目录下的项目");
  const target = path.posix.normalize(String(targetDir || parent).replace(/\\/g, "/")) || ".";
  if (target !== parent) throw new Error("压缩目标必须是所选项目所在目录");
  const requestedName = String(archiveName || "").trim().replace(/\\/g, "/");
  if (requestedName.includes("/") || requestedName.includes("\0")) throw new Error("压缩包名称不能包含路径");
  let name = path.posix.basename(requestedName);
  if (!name || name === "." || name === "..") name = normalizedPaths.length === 1 ? `${path.posix.basename(normalizedPaths[0])}.tar.gz` : "archive.tar.gz";
  if (!/\.(?:tar\.gz|tgz)$/i.test(name)) name = `${name}.tar.gz`;
  if (Buffer.byteLength(name, "utf8") > 255) throw new Error("压缩包名称过长");
  const output = path.posix.join(target, name);
  if (normalizedPaths.includes(output)) throw new Error("压缩包不能覆盖被选中的源文件");
  const temporaryOutput = path.posix.join(target, `.tunneldesk-${crypto.randomUUID()}.tar.gz.part`);
  const names = normalizedPaths.map((item) => `./${path.posix.basename(item)}`);
  const command = `if [ -e ${remotePathOperand(connection, output)} ]; then echo "目标压缩包已存在" >&2; exit 1; fi; tar -czf ${remotePathOperand(connection, temporaryOutput)} -C ${remotePathOperand(connection, parent)} -- ${names.map((item) => remotePathOperand(connection, item)).join(" ")} && mv -- ${remotePathOperand(connection, temporaryOutput)} ${remotePathOperand(connection, output)} || { status=$?; rm -f -- ${remotePathOperand(connection, temporaryOutput)}; exit $status; }`;
  return { paths: normalizedPaths, target, parent, name, output, temporary_output: temporaryOutput, command };
}

function compressJob(connectionId, paths, targetDir = ".", archiveName = "") {
  const connection = getConnection(connectionId);
  const request = normalizeCompressionRequest(paths, targetDir, archiveName, connection);
  return { ...startSftpJob(connectionId, "compress", request.command, `压缩 ${request.paths.length} 项为 ${request.name}`), output:request.output };
}

module.exports = { cancelSftpJob, clearFinishedSftpJobs, compressJob, copyJob, crossCopyJob, deleteSftpJob, extractJob, getSftpJobFile, listSftpJobs, moveJob, normalizeCompressionRequest, pauseSftpJob, resumeSftpJob, startDownloadJob, startUploadJob, __buildCompressCommand: normalizeCompressionRequest };
