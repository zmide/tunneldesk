const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { SSH_BIN } = require("./config");
const { getConnection } = require("./db");
const { effectiveExtraArgs, securePrivateKeyPermissions } = require("./ssh");
const { isPasswordConnection, spawnPasswordCommand } = require("./ssh2-client");
const MAX_TEXT_FILE_SIZE = 512 * 1024;
const DEFAULT_DIRECTORY_PAGE_SIZE = 50;
const MAX_DIRECTORY_PAGE_SIZE = 200;
const DIRECTORY_CACHE_TTL_MS = 15 * 1000;
const DIRECTORY_CACHE_MAX_SNAPSHOTS = 20;
const SFTP_RECYCLE_DIRECTORY = ".tunneldesk-recycle-bin";
const directorySnapshots = new Map();
const directoryAliases = new Map();
const directoryNameCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

function permissionPathOperand(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.startsWith("./")) return normalized;
  return `./${normalized}`;
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
  return isPasswordConnection(connection)
    ? spawnPasswordCommand(connection, command)
    : spawn(SSH_BIN, sshArgs(connection, command), { stdio: ["pipe", "pipe", "pipe"] });
}

function runRemote(connection, command, input = null, timeoutMs = 30000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawnRemote(connection, command);
    const chunks = [];
    const errors = [];
    let settled = false;
    const finish = (error = null, code = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks);
      const stderr = Buffer.concat(errors).toString("utf8");
      if (error) reject(error);
      else if (code !== 0) reject(new Error(stderr || `远程命令退出码 ${code}`));
      else resolve(stdout);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(new Error("远程文件操作超时"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(null, code));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label}必须是正整数`);
  return parsed;
}

function normalizeRemoteDirectoryListOptions(options: any = {}) {
  const sort = String(options.sort || "name").toLowerCase();
  const dir = String(options.dir || "asc").toLowerCase();
  if (!["name", "size", "mtime"].includes(sort)) throw new Error("目录排序字段无效");
  if (!["asc", "desc"].includes(dir)) throw new Error("目录排序方向无效");
  return {
    page: positiveInteger(options.page, 1, "页码"),
    page_size: Math.min(positiveInteger(options.page_size, DEFAULT_DIRECTORY_PAGE_SIZE, "每页数量"), MAX_DIRECTORY_PAGE_SIZE),
    query: String(options.query || "").trim().slice(0, 256),
    sort,
    dir,
    refresh: options.refresh === true || String(options.refresh || "") === "1"
  };
}

function paginateRemoteEntries(entries, options: any = {}) {
  const normalized = normalizeRemoteDirectoryListOptions(options);
  const source = Array.isArray(entries) ? entries : [];
  const query = normalized.query.toLowerCase();
  const direction = normalized.dir === "desc" ? -1 : 1;
  const filtered = source
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !query || String(entry?.name || "").toLowerCase().includes(query));

  filtered.sort((left, right) => {
    const leftDirectory = left.entry?.type === "dir";
    const rightDirectory = right.entry?.type === "dir";
    if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;

    let comparison = 0;
    if (normalized.sort === "size") comparison = (Number(left.entry?.size) || 0) - (Number(right.entry?.size) || 0);
    else if (normalized.sort === "mtime") comparison = (Number(left.entry?.mtime) || 0) - (Number(right.entry?.mtime) || 0);
    if (comparison === 0) comparison = directoryNameCollator.compare(String(left.entry?.name || ""), String(right.entry?.name || ""));
    if (comparison !== 0) return comparison * direction;
    return left.index - right.index;
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / normalized.page_size));
  const page = Math.min(normalized.page, totalPages);
  const offset = (page - 1) * normalized.page_size;
  return {
    entries: filtered.slice(offset, offset + normalized.page_size).map(({ entry }) => entry),
    page,
    page_size: normalized.page_size,
    total,
    total_pages: totalPages,
    unfiltered_total: source.length
  };
}

function normalizedRemotePath(value) {
  const remotePath = String(value || ".").replace(/\\/g, "/");
  if (remotePath === "/") return "/";
  return remotePath.replace(/\/+$/, "") || ".";
}

function directoryCacheKey(connectionId, remotePath) {
  return `${Number(connectionId)}\0${normalizedRemotePath(remotePath)}`;
}

function removeDirectorySnapshot(key) {
  directorySnapshots.delete(key);
  for (const [alias, target] of directoryAliases) {
    if (target === key) directoryAliases.delete(alias);
  }
}

function pruneDirectorySnapshots(now = Date.now()) {
  for (const [key, snapshot] of directorySnapshots) {
    if (snapshot.expires_at <= now) removeDirectorySnapshot(key);
  }
  while (directorySnapshots.size > DIRECTORY_CACHE_MAX_SNAPSHOTS) {
    const oldest = directorySnapshots.keys().next().value;
    if (oldest === undefined) break;
    removeDirectorySnapshot(oldest);
  }
}

function cachedDirectorySnapshot(connectionId, remotePath) {
  pruneDirectorySnapshots();
  const requestedKey = directoryCacheKey(connectionId, remotePath);
  const canonicalKey = directoryAliases.get(requestedKey) || requestedKey;
  const snapshot = directorySnapshots.get(canonicalKey);
  if (!snapshot) return null;
  directorySnapshots.delete(canonicalKey);
  directorySnapshots.set(canonicalKey, snapshot);
  return snapshot;
}

function cacheDirectorySnapshot(connectionId, remotePath, snapshot) {
  pruneDirectorySnapshots();
  const requestedKey = directoryCacheKey(connectionId, remotePath);
  const canonicalKey = directoryCacheKey(connectionId, snapshot.path);
  directorySnapshots.delete(canonicalKey);
  directorySnapshots.set(canonicalKey, snapshot);
  directoryAliases.set(requestedKey, canonicalKey);
  directoryAliases.set(canonicalKey, canonicalKey);
  pruneDirectorySnapshots();
}

function invalidateRemoteDirectoryCache(connectionId) {
  const prefix = `${Number(connectionId)}\0`;
  for (const key of [...directorySnapshots.keys()]) {
    if (key.startsWith(prefix)) removeDirectorySnapshot(key);
  }
  for (const key of [...directoryAliases.keys()]) {
    if (key.startsWith(prefix)) directoryAliases.delete(key);
  }
}

async function enumerateRemoteDir(connectionId, remotePath = ".") {
  const connection = getConnection(connectionId);
  const dir = remotePath || ".";
  const listEntries = [
    `if stat -c "%s" . >/dev/null 2>&1; then TD_STAT_STYLE=gnu`,
    `elif stat -f "%z" . >/dev/null 2>&1; then TD_STAT_STYLE=bsd`,
    `else echo "远程系统缺少兼容的 stat 命令" >&2; exit 1`,
    `fi`,
    `export TD_STAT_STYLE`,
    `find . ! -name . ! -name ${shellQuote(SFTP_RECYCLE_DIRECTORY)} -prune -exec sh -c 'for entry in "$@"; do if [ -d "$entry" ]; then type=d; else type=f; fi; if [ "$TD_STAT_STYLE" = gnu ]; then meta=$(stat -c "%s %Y %a %U %G" "$entry"); else meta=$(stat -f "%z %m %Lp %Su %Sg" "$entry"); fi || exit 1; name=\${entry#./}; printf "%s\\t%s\\t%s\\n" "$name" "$type" "$meta"; done' sh {} +`
  ].join("; ");
  const command = [
    `cd ${shellQuote(dir)}`,
    `pwd`,
    listEntries
  ].join(" && ");
  const output = (await runRemote(connection, command)).toString("utf8");
  const [cwdLine, ...rows] = output.split(/\r?\n/).filter(Boolean);
  return {
    path: cwdLine || dir,
    entries: rows.map((line) => {
      const [name, type, meta = ""] = line.split("\t");
      const [size, mtime, mode, owner, group] = meta.trim().split(/\s+/);
      return {
        name,
        type: type === "d" ? "dir" : "file",
        size: Number(size || 0),
        mtime: Number(mtime || 0),
        mode: String(mode || ""),
        owner: String(owner || ""),
        group: String(group || "")
      };
    })
  };
}

async function listRemoteDir(connectionId, remotePath = ".", options: any = {}) {
  const normalized = normalizeRemoteDirectoryListOptions(options);
  let snapshot = normalized.refresh ? null : cachedDirectorySnapshot(connectionId, remotePath);
  if (!snapshot) {
    const result = await enumerateRemoteDir(connectionId, remotePath);
    snapshot = { ...result, expires_at: Date.now() + DIRECTORY_CACHE_TTL_MS };
    cacheDirectorySnapshot(connectionId, remotePath, snapshot);
  }
  return {
    path: snapshot.path,
    ...paginateRemoteEntries(snapshot.entries, normalized)
  };
}

async function makeRemoteDir(connectionId, remotePath) {
  const connection = getConnection(connectionId);
  await runRemote(connection, `mkdir -p ${shellQuote(remotePath)}`);
  return { ok: true };
}

function normalizeRemoteCreateFilePath(remotePath) {
  const raw = String(remotePath || "").replace(/\\/g, "/").trim();
  if (!raw || raw.includes("\0") || raw.length > 4096) throw new Error("新建文件路径无效或过长");
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized === "/" || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("新建文件路径无效");
  }
  if (raw.endsWith("/")) throw new Error("文件名不能以斜杠结尾");
  return normalized;
}

function buildRemoteCreateFileCommand(remotePath) {
  const normalizedPath = normalizeRemoteCreateFilePath(remotePath);
  const quotedPath = shellQuote(normalizedPath);
  return {
    path: normalizedPath,
    command: `if [ -e ${quotedPath} ] || [ -L ${quotedPath} ]; then printf '%s\\n' '目标文件已存在' >&2; exit 1; fi; : > ${quotedPath}`
  };
}

async function createRemoteFile(connectionId, remotePath) {
  const connection = getConnection(connectionId);
  const { path: normalizedPath, command } = buildRemoteCreateFileCommand(remotePath);
  await runRemote(connection, command, null, 60000);
  return { ok: true, path: normalizedPath };
}

async function deleteRemotePath(connectionId, remotePath) {
  const connection = getConnection(connectionId);
  await runRemote(connection, `rm -rf -- ${shellQuote(remotePath)}`);
  return { ok: true };
}

function normalizeRemoteRecyclePath(remotePath) {
  const raw = String(remotePath || "").replace(/\\/g, "/");
  if (!raw || raw.includes("\0") || raw.length > 4096) throw new Error("远程路径无效或过长");
  const normalized = path.posix.normalize(raw);
  if (!normalized || ["/", ".", ".."].includes(normalized) || normalized.startsWith("../")) {
    throw new Error("不能将根目录或当前目录移入回收站");
  }
  if (normalized.split("/").includes(SFTP_RECYCLE_DIRECTORY)) throw new Error("不能操作 TunnelDesk 回收站目录");
  return normalized;
}

function normalizeRemoteRecycleItemId(value) {
  const id = String(value || "").trim();
  if (!/^[a-z0-9-]{8,80}$/.test(id)) throw new Error("回收站项目编号无效");
  return id;
}

function remoteRecycleRootAssignment() {
  return `if [ -z "$HOME" ]; then echo "远端用户主目录不可用" >&2; exit 1; fi; td_root="$HOME/${SFTP_RECYCLE_DIRECTORY}"`;
}

function buildRecycleRemotePathCommand(remotePath, itemId, deletedAt = Date.now()) {
  const source = normalizeRemoteRecyclePath(remotePath);
  const id = normalizeRemoteRecycleItemId(itemId);
  const encodedPath = Buffer.from(source, "utf8").toString("base64");
  const sourceOperand = permissionPathOperand(source);
  return [
    remoteRecycleRootAssignment(),
    `td_item="$td_root/items/${id}"`,
    `if [ ! -e ${shellQuote(sourceOperand)} ] && [ ! -L ${shellQuote(sourceOperand)} ]; then echo "远程项目不存在" >&2; exit 1; fi`,
    `mkdir -p "$td_root/items" && mkdir "$td_item"`,
    `printf '%s\\n' ${shellQuote(encodedPath)} > "$td_item/path.b64"`,
    `printf '%s\\n' ${shellQuote(String(Number(deletedAt) || Date.now()))} > "$td_item/deleted-at"`,
    `if mv ${shellQuote(sourceOperand)} "$td_item/payload"; then :; else rm -rf "$td_item"; exit 1; fi`
  ].join("; ");
}

function buildListRemoteRecycleCommand() {
  return [
    remoteRecycleRootAssignment(),
    `td_items="$td_root/items"`,
    `if [ -d "$td_items" ]; then for td_item in "$td_items"/*; do [ -d "$td_item" ] || continue; td_id=\${td_item##*/}; td_path=$(tr -d '\\r\\n' < "$td_item/path.b64" 2>/dev/null) || continue; td_deleted=$(tr -d '\\r\\n' < "$td_item/deleted-at" 2>/dev/null); if [ -d "$td_item/payload" ]; then td_type=dir; else td_type=file; fi; printf '%s\\t%s\\t%s\\t%s\\n' "$td_id" "$td_path" "$td_deleted" "$td_type"; done; fi`
  ].join("; ");
}

function decodeRemoteRecyclePath(value) {
  const encoded = String(value || "").trim();
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("回收站元数据已损坏");
  return normalizeRemoteRecyclePath(Buffer.from(encoded, "base64").toString("utf8"));
}

function parseRemoteRecycleItems(output) {
  return String(output || "").split(/\r?\n/).filter(Boolean).map((line) => {
    const [rawId, encodedPath, rawDeletedAt, rawType] = line.split("\t");
    const id = normalizeRemoteRecycleItemId(rawId);
    const originalPath = decodeRemoteRecyclePath(encodedPath);
    return {
      id,
      original_path: originalPath,
      name: path.posix.basename(originalPath),
      type: rawType === "dir" ? "dir" : "file",
      deleted_at: Number(rawDeletedAt) || 0
    };
  }).sort((left, right) => right.deleted_at - left.deleted_at);
}

function buildRestoreRemoteRecycleCommand(itemId, originalPath) {
  const id = normalizeRemoteRecycleItemId(itemId);
  const target = normalizeRemoteRecyclePath(originalPath);
  const targetOperand = permissionPathOperand(target);
  const parentOperand = permissionPathOperand(path.posix.dirname(target));
  return [
    remoteRecycleRootAssignment(),
    `td_item="$td_root/items/${id}"`,
    `if [ ! -e "$td_item/payload" ] && [ ! -L "$td_item/payload" ]; then echo "回收站项目不存在" >&2; exit 1; fi`,
    `if [ -e ${shellQuote(targetOperand)} ] || [ -L ${shellQuote(targetOperand)} ]; then echo "原路径已有同名项目，无法恢复" >&2; exit 1; fi`,
    `mkdir -p ${shellQuote(parentOperand)}`,
    `mv "$td_item/payload" ${shellQuote(targetOperand)}`,
    `rm -rf "$td_item"`
  ].join("; ");
}

function buildDeleteRemoteRecycleCommand(itemId) {
  const id = normalizeRemoteRecycleItemId(itemId);
  return `${remoteRecycleRootAssignment()}; td_item="$td_root/items/${id}"; if [ ! -d "$td_item" ]; then echo "回收站项目不存在" >&2; exit 1; fi; rm -rf "$td_item"`;
}

function buildClearRemoteRecycleCommand() {
  return `${remoteRecycleRootAssignment()}; rm -rf "$td_root/items"; mkdir -p "$td_root/items"`;
}

async function readRemoteRecycleItem(connection, itemId) {
  const id = normalizeRemoteRecycleItemId(itemId);
  const command = `${remoteRecycleRootAssignment()}; td_item="$td_root/items/${id}"; cat "$td_item/path.b64"`;
  return decodeRemoteRecyclePath((await runRemote(connection, command)).toString("utf8"));
}

async function recycleRemotePath(connectionId, remotePath) {
  const connection = getConnection(connectionId);
  const id = `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
  const deletedAt = Date.now();
  const originalPath = normalizeRemoteRecyclePath(remotePath);
  await runRemote(connection, buildRecycleRemotePathCommand(originalPath, id, deletedAt), null, 60000);
  return { ok: true, recycled: true, id, original_path: originalPath, deleted_at: deletedAt };
}

async function listRemoteRecycleItems(connectionId) {
  const connection = getConnection(connectionId);
  return parseRemoteRecycleItems((await runRemote(connection, buildListRemoteRecycleCommand())).toString("utf8"));
}

async function restoreRemoteRecycleItem(connectionId, itemId) {
  const connection = getConnection(connectionId);
  const originalPath = await readRemoteRecycleItem(connection, itemId);
  await runRemote(connection, buildRestoreRemoteRecycleCommand(itemId, originalPath), null, 60000);
  return { ok: true, original_path: originalPath };
}

async function deleteRemoteRecycleItem(connectionId, itemId) {
  const connection = getConnection(connectionId);
  await runRemote(connection, buildDeleteRemoteRecycleCommand(itemId), null, 60000);
  return { ok: true };
}

async function clearRemoteRecycleItems(connectionId) {
  const connection = getConnection(connectionId);
  await runRemote(connection, buildClearRemoteRecycleCommand(), null, 60000);
  return { ok: true };
}

async function renameRemotePath(connectionId, from, to) {
  const connection = getConnection(connectionId);
  await runRemote(connection, `mv -- ${shellQuote(from)} ${shellQuote(to)}`);
  return { ok: true };
}

function normalizeRemotePrincipal(value, label) {
  const principal = String(value || "").trim();
  if (!principal) return "";
  if (principal.length > 64 || !/^(?:[A-Za-z_][A-Za-z0-9_.-]*|[0-9]+)$/.test(principal)) throw new Error(`${label}格式无效`);
  return principal;
}

function normalizeRemotePermissionRequest(paths, mode, recursive = false, owner = "", group = "") {
  const source = Array.isArray(paths) ? paths : [paths];
  const normalizedPaths = [...new Set(source
    .map((item) => path.posix.normalize(String(item || "").replace(/\\/g, "/").trim()))
    .filter(Boolean))];
  if (!normalizedPaths.length) throw new Error("请选择要设置权限的文件或目录");
  if (normalizedPaths.length > 200) throw new Error("一次最多设置 200 个文件或目录的权限");
  if (normalizedPaths.some((item) => item.includes("\0") || item.length > 4096)) throw new Error("远程路径无效或过长");
  if (normalizedPaths.reduce((total, item) => total + item.length, 0) > 32768) throw new Error("所选远程路径总长度过长");
  const normalizedMode = String(mode ?? "").trim();
  if (!/^[0-7]{3}$/.test(normalizedMode)) throw new Error("权限值必须是三位八进制数字，例如 755");
  const applyRecursively = recursive === true;
  if (normalizedPaths.some((item) => item === ".." || item.startsWith("../"))) throw new Error("远程路径不能越出当前连接目录");
  if (applyRecursively && normalizedPaths.some((item) => ["/", ".", ".."].includes(item))) {
    throw new Error("不能对根目录或当前目录递归设置权限");
  }
  return {
    paths: normalizedPaths,
    mode: normalizedMode,
    recursive: applyRecursively,
    owner: normalizeRemotePrincipal(owner, "所有者"),
    group: normalizeRemotePrincipal(group, "用户组")
  };
}

function buildRemotePermissionCommand(request) {
  const normalized = normalizeRemotePermissionRequest(request?.paths, request?.mode, request?.recursive, request?.owner, request?.group);
  const permissionPaths = normalized.paths.map(permissionPathOperand);
  const quotedPaths = permissionPaths.map(shellQuote).join(" ");
  const commands = permissionPaths.map((item) => `if [ -L ${shellQuote(item)} ]; then echo "暂不支持修改符号链接权限" >&2; exit 1; fi`);
  const recursiveFlag = normalized.recursive ? "-R " : "";
  if (normalized.owner && normalized.group) {
    commands.push(`chown ${recursiveFlag}${shellQuote(`${normalized.owner}:${normalized.group}`)} ${quotedPaths}`);
  } else if (normalized.owner) {
    commands.push(`chown ${recursiveFlag}${shellQuote(normalized.owner)} ${quotedPaths}`);
  } else if (normalized.group) {
    commands.push(`chgrp ${recursiveFlag}${shellQuote(normalized.group)} ${quotedPaths}`);
  }
  commands.push(`chmod ${recursiveFlag}${normalized.mode} ${quotedPaths}`);
  return commands.join(" && ");
}

async function setRemotePermissions(connectionId, paths, mode, recursive = false, owner = "", group = "") {
  const connection = getConnection(connectionId);
  const request = normalizeRemotePermissionRequest(paths, mode, recursive, owner, group);
  await runRemote(connection, buildRemotePermissionCommand(request), null, 120000);
  invalidateRemoteDirectoryCache(connectionId);
  return { ok: true, ...request };
}

async function copyRemotePaths(connectionId, paths, targetDir) {
  const connection = getConnection(connectionId);
  const quoted = (paths || []).map(shellQuote).join(" ");
  if (!quoted) throw new Error("请选择要复制的文件");
  await runRemote(connection, `cp -a -- ${quoted} ${shellQuote(targetDir)}`, null, 120000);
  return { ok: true };
}

async function moveRemotePaths(connectionId, paths, targetDir) {
  const connection = getConnection(connectionId);
  const quoted = (paths || []).map(shellQuote).join(" ");
  if (!quoted) throw new Error("请选择要移动的文件");
  await runRemote(connection, `mv -- ${quoted} ${shellQuote(targetDir)}`, null, 120000);
  return { ok: true };
}

async function extractRemoteArchive(connectionId, remotePath, targetDir) {
  const connection = getConnection(connectionId);
  const lower = String(remotePath || "").toLowerCase();
  let command;
  if (lower.endsWith(".zip")) command = `cd ${shellQuote(targetDir)} && unzip -o ${shellQuote(remotePath)}`;
  else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) command = `cd ${shellQuote(targetDir)} && tar -xzf ${shellQuote(remotePath)}`;
  else if (lower.endsWith(".tar")) command = `cd ${shellQuote(targetDir)} && tar -xf ${shellQuote(remotePath)}`;
  else throw new Error("暂只支持 zip、tar.gz、tgz、tar 解压");
  await runRemote(connection, command, null, 120000);
  return { ok: true };
}

async function readRemoteTextFile(connectionId, remotePath) {
  const connection = getConnection(connectionId);
  const quotedPath = shellQuote(remotePath);
  const body = await runRemote(connection, `if [ ! -f ${quotedPath} ]; then echo "目标不是普通文件" >&2; exit 1; fi; head -c ${MAX_TEXT_FILE_SIZE + 1} -- ${quotedPath}`, null, 60000);
  if (body.length > MAX_TEXT_FILE_SIZE) throw new Error("文件超过 512 KB，暂不能在程序中以文本打开，请下载后处理");
  if (body.includes(0)) throw new Error("该文件包含二进制内容，无法安全地以文本编辑");
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new Error("该文件不是可安全编辑的 UTF-8 文本，请下载后处理");
  }
  return { content, size: body.length, limit: MAX_TEXT_FILE_SIZE };
}
function streamRemoteFile(connectionId, remotePath, res, req) {
  const connection = getConnection(connectionId);
  const basename = String(remotePath || "").split("/").pop() || "download";
  const child = spawnRemote(connection, `cat -- ${shellQuote(remotePath)}`);
  let headersSent = false;
  let stderr = [];
  let aborted = false;
  const sendError = (message) => {
    if (headersSent || res.writableEnded) { try { res.end(); } catch {} return; }
    try {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: message }));
    } catch {}
  };
  const onAbort = () => {
    aborted = true;
    try { child.kill("SIGKILL"); } catch {}
  };
  if (req) req.on("close", onAbort);
  child.stdout.on("data", (chunk) => {
    if (aborted) return;
    if (!headersSent) {
      headersSent = true;
      try {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(basename)}"`,
          "Cache-Control": "no-store"
        });
      } catch {}
    }
    if (!res.write(chunk)) {
      child.stdout.pause();
      res.once("drain", () => child.stdout.resume());
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", (error) => sendError(error.message || "远程文件读取失败"));
  child.on("close", (code) => {
    if (req) req.removeListener("close", onAbort);
    if (aborted) return;
    if (code !== 0 && !headersSent) {
      const message = Buffer.concat(stderr).toString("utf8").trim() || `远程文件读取失败（退出码 ${code ?? "?"}）`;
      sendError(message);
      return;
    }
    try { res.end(); } catch {}
  });
  child.stdin.end();
}

async function writeRemoteFile(connectionId, remotePath, data, options: { backup?: boolean } = {}) {
  const connection = getConnection(connectionId);
  const quotedPath = shellQuote(remotePath);
  let backupPath = null;
  let command = "";
  if (options.backup) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    backupPath = `${remotePath}.bak-${stamp}-${randomBytes(4).toString("hex")}`;
    command = `cp -p -- ${quotedPath} ${shellQuote(backupPath)} && `;
  }
  await runRemote(connection, `${command}cat > ${quotedPath}`, data, 60000);
  return { ok: true, backup_path: backupPath };
}

module.exports = {
  listRemoteDir,
  normalizeRemoteDirectoryListOptions,
  paginateRemoteEntries,
  invalidateRemoteDirectoryCache,
  __cacheDirectorySnapshot: cacheDirectorySnapshot,
  __cachedDirectorySnapshot: cachedDirectorySnapshot,
  makeRemoteDir,
  buildRemoteCreateFileCommand,
  createRemoteFile,
  deleteRemotePath,
  recycleRemotePath,
  listRemoteRecycleItems,
  restoreRemoteRecycleItem,
  deleteRemoteRecycleItem,
  clearRemoteRecycleItems,
  buildRecycleRemotePathCommand,
  buildListRemoteRecycleCommand,
  buildRestoreRemoteRecycleCommand,
  buildDeleteRemoteRecycleCommand,
  buildClearRemoteRecycleCommand,
  parseRemoteRecycleItems,
  copyRemotePaths,
  moveRemotePaths,
  normalizeRemotePermissionRequest,
  buildRemotePermissionCommand,
  setRemotePermissions,
  extractRemoteArchive,
  renameRemotePath,
  readRemoteTextFile,
  writeRemoteFile,
  streamRemoteFile
};
