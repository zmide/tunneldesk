const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DATA_DIR, SSH_BIN } = require("./config");
const { getConnection } = require("./db");
const { effectiveExtraArgs, securePrivateKeyPermissions } = require("./ssh");
const { appendBatchCommandLog, appendSystemLog, createBatchCommandLog } = require("./logs");
const { notifyEvent } = require("./notifications");
const { isPasswordConnection, spawnPasswordCommand } = require("./ssh2-client");

const TEMPLATE_FILE = path.join(DATA_DIR, "command-templates.json");

function sendFrame(socket, data, opcode = 1) {
  if (socket.destroyed || socket.writableEnded || socket.writableDestroyed || socket._tunneldeskClosing) return false;
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  const header = [];
  header.push(0x80 | opcode);
  if (payload.length < 126) header.push(payload.length);
  else if (payload.length < 65536) header.push(126, payload.length >> 8, payload.length & 0xff);
  else {
    header.push(127, 0, 0, 0, 0);
    header.push((payload.length / 2 ** 24) & 0xff, (payload.length / 2 ** 16) & 0xff, (payload.length / 2 ** 8) & 0xff, payload.length & 0xff);
  }
  try {
    socket.write(Buffer.concat([Buffer.from(header), payload]));
    return true;
  } catch {
    return false;
  }
}

function closeSocket(socket) {
  if (socket.destroyed || socket.writableEnded || socket.writableDestroyed || socket._tunneldeskClosing) return;
  socket._tunneldeskClosing = true;
  try {
    sendFrame(socket, "", 8);
  } catch {}
  try {
    if (!socket.destroyed && !socket.writableEnded) socket.end();
  } catch {}
}

function parseFrames(buffer, onFrame) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const high = buffer.readUInt32BE(offset + 2);
      const low = buffer.readUInt32BE(offset + 6);
      if (high !== 0) throw new Error("WebSocket frame too large");
      length = low;
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + headerLength + maskLength + length;
    if (frameEnd > buffer.length) break;
    let payload = buffer.subarray(offset + headerLength + maskLength, frameEnd);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }
    onFrame(opcode, payload);
    offset = frameEnd;
  }
  return buffer.subarray(offset);
}

function readTemplates() {
  try {
    const items = JSON.parse(fs.readFileSync(TEMPLATE_FILE, "utf8"));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function writeTemplates(items) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(items, null, 2), "utf8");
}

function listCommandTemplates() {
  return readTemplates().sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-Hans-CN"));
}

function normalizeTemplate(data) {
  const name = String(data.name || "").trim();
  const command = String(data.command || "").trim();
  if (!name) throw new Error("请输入模板名称");
  if (!command) throw new Error("请输入模板命令");
  return {
    name,
    command,
    description: String(data.description || "").trim(),
    updated_at: Date.now()
  };
}

function saveCommandTemplate(data) {
  const items = readTemplates();
  const item = { id: crypto.randomUUID(), created_at: Date.now(), ...normalizeTemplate(data) };
  items.push(item);
  writeTemplates(items);
  return item;
}

function updateCommandTemplate(id, data) {
  const items = readTemplates();
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("模板不存在");
  items[index] = { ...items[index], ...normalizeTemplate(data) };
  writeTemplates(items);
  return items[index];
}

function deleteCommandTemplate(id) {
  const items = readTemplates();
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) throw new Error("模板不存在");
  writeTemplates(next);
  return { ok: true };
}

function buildCommandArgs(connection) {
  const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", String(connection.ssh_port || 22)];
  if (connection.identity_file) {
    securePrivateKeyPermissions(connection.identity_file);
    args.push("-i", connection.identity_file);
  }
  args.push(...effectiveExtraArgs(connection.extra_args));
  args.push(`${connection.ssh_user}@${connection.ssh_host}`, "sh", "-s");
  return args;
}

function sendJson(socket, data) {
  sendFrame(socket, JSON.stringify(data));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildRemoteScript(command) {
  const lines = String(command || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const runs = lines.map((line) => `td_run ${shellQuote(line)}\ntd_status=$?`).join("\n");
  return [
    "td_status=0",
    "td_prompt() {",
    "  td_user=$(id -un 2>/dev/null || whoami 2>/dev/null || printf user)",
    "  td_host=$(hostname -s 2>/dev/null || hostname 2>/dev/null || printf host)",
    "  if [ -n \"$HOME\" ] && [ \"$PWD\" = \"$HOME\" ]; then",
    "    td_dir=\"~\"",
    "  elif [ -n \"$HOME\" ] && [ \"${PWD#\"$HOME\"/}\" != \"$PWD\" ]; then",
    "    td_dir=\"~/${PWD#\"$HOME\"/}\"",
    "  else",
    "    td_dir=\"$PWD\"",
    "  fi",
    "  if [ \"$(id -u 2>/dev/null)\" = \"0\" ]; then td_mark=\"#\"; else td_mark=\"$\"; fi",
    "  printf '%s@%s:%s%s ' \"$td_user\" \"$td_host\" \"$td_dir\" \"$td_mark\"",
    "}",
    "td_run() {",
    "  td_cmd=$1",
    "  td_prompt",
    "  printf '%s\\n' \"$td_cmd\"",
    "  eval \"$td_cmd\"",
    "}",
    runs,
    "td_prompt",
    "printf '\\n'",
    "exit \"$td_status\"",
    ""
  ].join("\n");
}

async function runBatchCommandStream(socket, payload, activeChildren) {
  const ids = [...new Set((payload.ids || []).map(Number).filter(Boolean))];
  const command = String(payload.command || "").trim();
  if (!ids.length) throw new Error("请选择 SSH 连接");
  if (!command) throw new Error("请输入要执行的命令");
  const timeoutMs = Math.max(5000, Math.min(Number(payload.timeout_ms || 60000), 10 * 60 * 1000));
  const rows = ids.map((id) => getConnection(id));
  const log = createBatchCommandLog(command, rows.length);
  sendJson(socket, { type: "meta", total: rows.length, log_path: path.relative(path.join(DATA_DIR, "logs"), log.fullPath).replace(/\\/g, "/"), log_label: log.label });
  appendSystemLog(`批量命令已启动：${log.label}`);
  let ok = 0;
  let failed = 0;
  let next = 0;

  async function worker() {
    while (next < rows.length && !socket.destroyed) {
      const connection = rows[next++];
      const started = Date.now();
      sendJson(socket, { type: "start", id: connection.id, name: connection.name, command });
      appendBatchCommandLog(log.fullPath, `\n## ${connection.name} (${connection.ssh_user}@${connection.ssh_host}:${connection.ssh_port})\n`);
      await new Promise((resolve) => {
        const child = isPasswordConnection(connection)
          ? spawnPasswordCommand(connection, "sh -s")
          : spawn(SSH_BIN, buildCommandArgs(connection), { stdio: ["pipe", "pipe", "pipe"] });
        activeChildren.add(child);
        let settled = false;
        const finish = (exitCode, error = null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          activeChildren.delete(child);
          const success = exitCode === 0;
          if (success) ok++;
          else failed++;
          const message = error ? error.message : `退出码 ${exitCode ?? ""}`;
          appendBatchCommandLog(log.fullPath, `\n[结束] ${connection.name} ${success ? "成功" : `失败：${message}`}，用时 ${Date.now() - started}ms\n`);
          sendJson(socket, { type: "exit", id: connection.id, name: connection.name, ok: success, exit_code: exitCode, error: error ? error.message : "", elapsed_ms: Date.now() - started });
          resolve(null);
        };
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          finish(null, new Error("命令执行超时"));
        }, timeoutMs);
        child.stdout?.on("data", (chunk) => {
          const text = chunk.toString();
          appendBatchCommandLog(log.fullPath, text);
          sendJson(socket, { type: "data", stream: "stdout", id: connection.id, name: connection.name, data: text });
        });
        child.stderr?.on("data", (chunk) => {
          const text = chunk.toString();
          appendBatchCommandLog(log.fullPath, text);
          sendJson(socket, { type: "data", stream: "stderr", id: connection.id, name: connection.name, data: text });
        });
        child.on("error", (error) => finish(null, error));
        child.on("close", (code) => finish(code));
        try {
          child.stdin.end(buildRemoteScript(command));
        } catch {}
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
  appendBatchCommandLog(log.fullPath, `\n# 批量执行完成：成功 ${ok} 个，失败 ${failed} 个\n`);
  sendJson(socket, { type: "done", ok, failed, total: rows.length, log_path: path.relative(path.join(DATA_DIR, "logs"), log.fullPath).replace(/\\/g, "/") });
  appendSystemLog(`批量命令已完成：${log.label}，成功 ${ok} 个，失败 ${failed} 个`);
  notifyEvent({
    type: "batch",
    level: failed ? "error" : "success",
    title: failed ? "批量命令部分失败" : "批量命令已完成",
    message: `${log.label}，成功 ${ok} 个，失败 ${failed} 个`,
    action: { view: "log", path: path.relative(path.join(DATA_DIR, "logs"), log.fullPath).replace(/\\/g, "/"), title: log.label }
  }, { cooldown_ms: 0 });
}

function handleBatchCommandUpgrade(req, socket) {
  let upgraded = false;
  const activeChildren: Set<any> = new Set();
  try {
    const key = req.headers["sec-websocket-key"];
    if (!key) return socket.destroy();
    const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n"));
    upgraded = true;
    sendJson(socket, { type: "ready" });

    let pending = Buffer.alloc(0);
    let started = false;
    socket.on("data", (chunk) => {
      try {
        pending = parseFrames(Buffer.concat([pending, chunk]), (opcode, data) => {
          if (opcode === 8) return closeSocket(socket);
          if (opcode === 9) return sendFrame(socket, data, 10);
          if ((opcode === 1 || opcode === 2) && !started) {
            started = true;
            runBatchCommandStream(socket, JSON.parse(data.toString("utf8")), activeChildren)
              .catch((error) => sendJson(socket, { type: "error", error: error.message }))
              .finally(() => closeSocket(socket));
          }
        });
      } catch (error) {
        sendJson(socket, { type: "error", error: error.message });
        closeSocket(socket);
      }
    });
  } catch (error) {
    appendSystemLog(`批量命令 WebSocket 启动失败：${error.message}`);
    try {
      if (upgraded) {
        sendJson(socket, { type: "error", error: error.message });
        closeSocket(socket);
      } else {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.end(error.message);
      }
    } catch {}
  }
  socket.on("close", () => {
    for (const child of activeChildren) {
      try { child.kill("SIGKILL"); } catch {}
    }
  });
}

module.exports = {
  listCommandTemplates,
  saveCommandTemplate,
  updateCommandTemplate,
  deleteCommandTemplate,
  handleBatchCommandUpgrade
};
