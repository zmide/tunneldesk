const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const iconv = require("iconv-lite");
const { SSH_BIN } = require("./config");
const { getConnection } = require("./db");
const { buildTerminalCommand } = require("./ssh");
const { appendSystemLog, appendTerminalLog, createTerminalLog } = require("./logs");
const { isPasswordConnection, openSshShell } = require("./ssh2-client");
const { loadNodePty } = require("./pty-runtime");
const { WebSocketFrameParser, closeWebSocket, sendWebSocketFrame, validateWebSocketUpgrade, websocketAccept } = require("./websocket");

let pty = null;
let ptyLoadError = "";
try {
  pty = loadNodePty();
} catch (error) {
  ptyLoadError = error.message || String(error);
}

const sessions = new Set();
const TERMINAL_ENCODINGS = new Set(["utf8", "gb18030", "gbk", "big5", "shift_jis", "euc-kr", "latin1"]);

function setSessionEncoding(session, value) {
  const encoding = String(value || "utf8").toLowerCase();
  if (!TERMINAL_ENCODINGS.has(encoding)) throw new Error("不支持的终端编码");
  try { session.outputDecoder?.end(); } catch {}
  session.terminalEncoding = encoding;
  session.outputDecoder = encoding === "utf8" ? null : iconv.getDecoder(encoding);
}

function resolveTerminalBin() {
  if (path.isAbsolute(SSH_BIN)) return SSH_BIN;
  const command = process.platform === "win32" ? "where" : "which";
  const args = [SSH_BIN];
  const result = spawnSync(command, args, { encoding: "utf8" });
  const found = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return found || SSH_BIN;
}

function resolveTerminalCwd() {
  const candidates = [
    process.env.HOME,
    process.env.USERPROFILE,
    process.cwd()
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {}
  }
  return undefined;
}

function handleTerminalUpgrade(req, socket) {
  let upgraded = false;
  try {
    const key = validateWebSocketUpgrade(req);
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const id = Number(url.searchParams.get("id"));
    if (!id) throw new Error("缺少连接 ID");
    const connection = getConnection(id);
    const accept = websocketAccept(key);
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n"));
    upgraded = true;

    const cols = Number(url.searchParams.get("cols") || 80);
    const rows = Number(url.searchParams.get("rows") || 24);
    const title = url.searchParams.get("title") || "";
    const session: any = startTerminalProcess(connection, socket, cols, rows, title);
    sessions.add(session);
    sendWebSocketFrame(socket, `连接到 ${connection.ssh_user}@${connection.ssh_host}:${connection.ssh_port}${session.ptyProcess || session.remotePty ? "（PTY）" : ""}\r\n`);

    const parser = new WebSocketFrameParser({ maxFrameSize: 1024 * 1024, maxMessageSize: 2 * 1024 * 1024 });
    socket.on("data", (chunk) => {
      try {
        parser.push(chunk, (opcode, payload) => {
          if (opcode === 8) return closeTerminalSession(session);
          if (opcode === 9) return sendWebSocketFrame(socket, payload, 10);
          if (opcode === 1 || opcode === 2) writeTerminalInput(session, payload);
        });
      } catch (error) {
        sendWebSocketFrame(socket, `\r\nWebSocket 错误：${error.message}\r\n`);
        closeTerminalSession(session);
      }
    });
    socket.on("close", () => closeTerminalSession(session));
    socket.on("error", () => closeTerminalSession(session));
  } catch (error) {
    appendSystemLog(`终端 WebSocket 启动失败：${error.message}`);
    try {
      if (upgraded) {
        sendWebSocketFrame(socket, `\r\n终端启动失败：${error.message}\r\n`);
        closeWebSocket(socket, 1011, "终端启动失败");
      } else {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.end(error.message);
      }
    } catch {}
  }
}

function terminalEnv() {
  const env: any = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "xterm-256color";
  return env;
}

function sendTerminalOutput(session, data) {
  appendTerminalLog(session.logFile, data);
  if (Buffer.isBuffer(data) && session.outputDecoder) {
    const decoded = session.outputDecoder.write(data);
    if (decoded) sendWebSocketFrame(session.socket, decoded, 1);
    return;
  }
  sendWebSocketFrame(session.socket, data, Buffer.isBuffer(data) ? 2 : 1);
}

function startPlainTerminal(session, connection, args, cwd, log) {
  const child = spawn(SSH_BIN, args, { stdio: ["pipe", "pipe", "pipe"], cwd });
  session.child = child;
  child.stdout.on("data", (chunk) => sendTerminalOutput(session, chunk));
  child.stderr.on("data", (chunk) => sendTerminalOutput(session, chunk));
  child.on("error", (error) => {
    appendSystemLog(`普通终端启动失败：${error.message}`);
    sendTerminalOutput(session, `\r\n终端启动失败：${error.message}\r\n`);
  });
  child.on("exit", (code, signal) => {
    sendTerminalOutput(session, `\r\nSSH 会话已结束${signal ? `，信号 ${signal}` : `，退出码 ${code ?? ""}`}\r\n`);
    sessions.delete(session);
    closeWebSocket(session.socket);
  });
  appendSystemLog(`终端已启动（普通）：${log.label}`);
  return session;
}

function startRemotePty(connection, socket, cols, rows, log, fallback = null) {
  const encoding = String(connection.terminal_encoding || "utf8");
  const session: any = {
    socket,
    remotePty: true,
    ssh2Client: null,
    ssh2Stream: null,
    pendingInput: [],
    logFile: log.fullPath,
    terminalEncoding: encoding,
    outputDecoder: encoding === "utf8" ? null : iconv.getDecoder(encoding)
  };
  openSshShell(connection, { term: "xterm-256color", cols, rows }).then(({ client, stream }: any) => {
    if (!sessions.has(session)) {
      try { stream.close(); } catch {}
      try { client.end(); } catch {}
      return;
    }
    session.ssh2Client = client;
    session.ssh2Stream = stream;
    client.on("error", (error) => sendTerminalOutput(session, `\r\nSSH 连接错误：${error.message}\r\n`));
    stream.on("data", (chunk) => sendTerminalOutput(session, chunk));
    stream.stderr?.on("data", (chunk) => sendTerminalOutput(session, chunk));
    stream.on("error", (error) => sendTerminalOutput(session, `\r\n终端错误：${error.message}\r\n`));
    stream.on("close", (code, signal) => {
      sendTerminalOutput(session, `\r\nSSH 会话已结束${signal ? `，信号 ${signal}` : `，退出码 ${code ?? ""}`}\r\n`);
      sessions.delete(session);
      try { client.end(); } catch {}
      closeWebSocket(socket);
    });
    for (const pending of session.pendingInput.splice(0)) stream.write(pending);
    appendSystemLog(`终端已启动（内置 SSH PTY）：${log.label}`);
  }).catch((error) => {
    session.remotePty = false;
    appendSystemLog(`内置 SSH PTY 启动失败：${error.message}`);
    if (fallback && sessions.has(session)) {
      sendTerminalOutput(session, `\r\n内置 SSH PTY 启动失败，已切换普通终端：${error.message}\r\n`);
      for (const pending of session.pendingInput.splice(0)) fallback.input.push(pending);
      startPlainTerminal(session, connection, fallback.args, fallback.cwd, log);
      for (const pending of fallback.input) session.child?.stdin.write(pending);
      return;
    }
    sendTerminalOutput(session, `\r\n终端启动失败：${error.message}\r\n`);
    sessions.delete(session);
    closeWebSocket(socket);
  });
  return session;
}

function startTerminalProcess(connection, socket, cols, rows, title = "") {
  const log = createTerminalLog(connection, title);
  if (isPasswordConnection(connection)) {
    return startRemotePty(connection, socket, cols, rows, log);
  }

  const args = buildTerminalCommand(connection);
  const cwd = resolveTerminalCwd();
  if (pty) {
    try {
      const ptyOptions: any = {
        name: "xterm-256color",
        cols: Math.max(2, cols || 80),
        rows: Math.max(1, rows || 24),
        env: terminalEnv(),
        encoding: null
      };
      if (cwd) ptyOptions.cwd = cwd;
      const ptyProcess = pty.spawn(resolveTerminalBin(), args, ptyOptions);
      const session: any = { socket, ptyProcess, logFile: log.fullPath };
      setSessionEncoding(session, connection.terminal_encoding);
      ptyProcess.onData((data) => sendTerminalOutput(session, data));
      ptyProcess.onExit(({ exitCode, signal }) => {
        sendTerminalOutput(session, `\r\nSSH 会话已结束${signal ? `，信号 ${signal}` : `，退出码 ${exitCode ?? ""}`}\r\n`);
        sessions.delete(session);
        closeWebSocket(socket);
      });
      appendSystemLog(`终端已启动（PTY）：${log.label}`);
      return session;
    } catch (error) {
      appendSystemLog(`PTY 启动失败，已退回普通终端：${error.message}`);
      if (process.platform === "darwin") {
        sendWebSocketFrame(socket, `PTY 启动失败，正在尝试内置 SSH PTY：${error.message}\r\n`);
        return startRemotePty(connection, socket, cols, rows, log, { args, cwd, input: [] });
      }
      sendWebSocketFrame(socket, `PTY 启动失败，已自动切换普通终端：${error.message}\r\n`);
    }
  } else if (process.platform === "darwin") {
    sendWebSocketFrame(socket, `PTY 组件不可用，正在尝试内置 SSH PTY：${ptyLoadError || "node-pty 未安装"}\r\n`);
    return startRemotePty(connection, socket, cols, rows, log, { args, cwd, input: [] });
  }

  const session: any = { socket, child: null, logFile: log.fullPath };
  setSessionEncoding(session, connection.terminal_encoding);
  return startPlainTerminal(session, connection, args, cwd, log);
}

function writeTerminalInput(session, payload) {
  const text = payload.toString("utf8");
  if (text.startsWith("{")) {
    try {
      const message = JSON.parse(text);
      if (message?.type === "resize") {
        if (session.ptyProcess) session.ptyProcess.resize(Math.max(2, Number(message.cols) || 80), Math.max(1, Number(message.rows) || 24));
        else if (session.ssh2Stream?.setWindow) session.ssh2Stream.setWindow(Math.max(1, Number(message.rows) || 24), Math.max(2, Number(message.cols) || 80), 0, 0);
        return;
      }
      if (message?.type === "terminal-encoding") {
        setSessionEncoding(session, message.encoding);
        return;
      }
    } catch {}
  }
  const outgoing = session.terminalEncoding && session.terminalEncoding !== "utf8"
    ? iconv.encode(text, session.terminalEncoding)
    : payload;
  if (session.ptyProcess) session.ptyProcess.write(outgoing);
  else if (session.ssh2Stream) session.ssh2Stream.write(outgoing);
  else if (session.remotePty) session.pendingInput.push(Buffer.from(outgoing));
  else session.child?.stdin.write(outgoing);
}

function closeTerminalSession(session) {
  if (!sessions.has(session)) return;
  sessions.delete(session);
  try { session.ptyProcess?.kill(); } catch {}
  try { session.child?.kill(); } catch {}
  try { session.ssh2Stream?.close(); } catch {}
  try { session.ssh2Client?.end(); } catch {}
  try { session.socket.destroy(); } catch {}
}

function closeAllTerminals() {
  for (const session of [...sessions]) closeTerminalSession(session);
}

module.exports = { handleTerminalUpgrade, closeAllTerminals };
