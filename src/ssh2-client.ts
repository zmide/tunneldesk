const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const { PassThrough } = require("node:stream");
const { Client } = require("ssh2");
const socks = require("socksv5");

function isPasswordConnection(connection) {
  return String(connection?.auth_type || "key") === "password";
}

function passwordConnectOptions(connection) {
  const password = String(connection?.ssh_password || "");
  if (!password) throw new Error("该连接没有保存 SSH 密码，请编辑连接后重新输入");
  return {
    host: String(connection.ssh_host || "").trim(),
    port: Number(connection.ssh_port || 22),
    username: String(connection.ssh_user || "").trim(),
    password,
    readyTimeout: 15000,
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
    authHandler: ["password", "keyboard-interactive"],
    tryKeyboard: true
  };
}

function keyConnectOptions(connection) {
  const identityFile = String(connection?.identity_file || "").trim();
  const options: any = {
    host: String(connection.ssh_host || "").trim(),
    port: Number(connection.ssh_port || 22),
    username: String(connection.ssh_user || "").trim(),
    readyTimeout: 15000,
    keepaliveInterval: 30000,
    keepaliveCountMax: 3
  };
  if (identityFile) options.privateKey = fs.readFileSync(identityFile);
  else if (process.env.SSH_AUTH_SOCK) options.agent = process.env.SSH_AUTH_SOCK;
  else throw new Error("密钥连接未指定私钥，且当前没有可用的 SSH Agent");
  return options;
}

function connectionOptions(connection) {
  return isPasswordConnection(connection) ? passwordConnectOptions(connection) : keyConnectOptions(connection);
}

function connectSsh(connection) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      client.removeListener("ready", onReady);
      if (error) {
        try { client.end(); } catch {}
        reject(error);
      } else resolve(client);
    };
    const onReady = () => finish();
    const onError = (error) => {
      if (!settled) finish(error);
    };
    client.once("ready", onReady);
    client.on("error", onError);
    if (isPasswordConnection(connection)) {
      client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, complete) => {
        const password = String(connection.ssh_password || "");
        complete((prompts || []).map(() => password));
      });
    }
    try {
      client.connect(connectionOptions(connection));
    } catch (error) {
      finish(error);
    }
  });
}

function connectPassword(connection) {
  return connectSsh(connection);
}

function spawnPasswordCommand(connection, command) {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = null;
  child.killed = false;
  child.client = null;
  child.channel = null;
  let closed = false;
  let firstError = null;
  child.on("error", () => {});

  const close = (code = null, signal = null) => {
    if (closed) return;
    closed = true;
    try { child.stdin.unpipe(); } catch {}
    try { child.stdout.end(); } catch {}
    try { child.stderr.end(); } catch {}
    try { child.client?.end(); } catch {}
    child.emit("close", code, signal);
  };

  const reportError = (error) => {
    if (!firstError) {
      firstError = error;
      child.emit("error", error);
    }
    try { child.channel?.close(); } catch {}
    try { child.client?.end(); } catch {}
    close(null);
  };

  child.kill = (signal = "SIGTERM") => {
    child.killed = true;
    try { child.channel?.close(); } catch {}
    try { child.client?.end(); } catch {}
    close(null, signal);
    return true;
  };

  queueMicrotask(async () => {
    try {
      const client: any = await connectPassword(connection);
      child.client = client;
      client.on("error", reportError);
      client.once("close", () => close(child.killed ? null : 255, child.killed ? "SIGTERM" : null));
      client.exec(String(command || ""), (error, channel) => {
        if (error) {
          reportError(error);
          return;
        }
        child.channel = channel;
        child.stdin.pipe(channel);
        channel.pipe(child.stdout);
        channel.stderr?.pipe(child.stderr);
        channel.on("error", reportError);
        channel.once("close", (code, signal) => close(code, signal));
      });
    } catch (error) {
      reportError(error);
    }
  });
  return child;
}

function runPasswordCommand(connection, command, input = null, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child: any = spawnPasswordCommand(connection, command);
    const stdout: any[] = [];
    const stderr: any[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      finish(null, new Error("SSH 命令执行超时"));
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    const finish = (status, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), error });
    };
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function openPasswordShell(connection, options: any = {}) {
  const client: any = await connectSsh(connection);
  return new Promise((resolve, reject) => {
    client.shell({
      term: options.term || "xterm-256color",
      cols: Math.max(2, Number(options.cols || 80)),
      rows: Math.max(1, Number(options.rows || 24))
    }, (error, stream) => {
      if (error) {
        try { client.end(); } catch {}
        reject(error);
        return;
      }
      resolve({ client, stream });
    });
  });
}

function openSshShell(connection, options: any = {}) {
  return openPasswordShell(connection, options);
}

function pipeForwardSocket(client, source, host, port, onError: any = () => {}) {
  client.forwardOut(
    source.remoteAddress || "127.0.0.1",
    Number(source.remotePort || 0),
    String(host || "127.0.0.1"),
    Number(port),
    (error, channel) => {
      if (error) {
        onError(error);
        try { source.destroy(error); } catch {}
        return;
      }
      source.pipe(channel).pipe(source);
      channel.on("error", () => source.destroy());
      source.on("error", () => channel.close());
    }
  );
}

async function startLocalForward(client, forward, onError) {
  const server = net.createServer((socket) => {
    pipeForwardSocket(client, socket, forward.target_host, forward.target_port, onError);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(forward.bind_port), String(forward.bind_host || "127.0.0.1"), () => {
      server.removeListener("error", reject);
      server.on("error", onError);
      resolve(null);
    });
  });
  return server;
}

async function startSocksForward(client, forward, onError) {
  const server = socks.createServer((info, accept, deny) => {
    client.forwardOut(info.srcAddr, info.srcPort, info.dstAddr, info.dstPort, (error, channel) => {
      if (error) {
        onError(error);
        deny();
        return;
      }
      const socket = accept(true);
      if (!socket) {
        channel.close();
        return;
      }
      socket.pipe(channel).pipe(socket);
      channel.on("error", () => socket.destroy());
      socket.on("error", () => channel.close());
    });
  });
  server.useAuth(socks.auth.None());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(forward.bind_port), String(forward.bind_host || "127.0.0.1"), () => {
      server.removeListener("error", reject);
      server.on("error", onError);
      resolve(null);
    });
  });
  return server;
}

async function startRemoteForward(client, forward, onError) {
  const bindHost = String(forward.bind_host || "127.0.0.1");
  const bindPort = Number(forward.bind_port);
  client.on("tcp connection", (_info, accept, reject) => {
    const channel = accept();
    const socket = net.connect(Number(forward.target_port), String(forward.target_host || "127.0.0.1"));
    socket.once("connect", () => socket.pipe(channel).pipe(socket));
    socket.once("error", (error) => {
      onError(error);
      try { channel.close(); } catch {}
      try { reject(); } catch {}
    });
    channel.on("error", () => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    client.forwardIn(bindHost, bindPort, (error) => error ? reject(error) : resolve(null));
  });
  return {
    close: () => new Promise((resolve) => {
      client.unforwardIn(bindHost, bindPort, () => resolve(null));
    })
  };
}

async function startPasswordForward(connection, forward, callbacks: any = {}) {
  const client: any = await connectPassword(connection);
  let closing = false;
  const onError = (error) => callbacks.onError?.(error);
  client.on("error", onError);
  client.on("close", () => {
    if (!closing) callbacks.onClose?.();
  });
  let listener;
  try {
    if (forward.mode === "local") listener = await startLocalForward(client, forward, onError);
    else if (forward.mode === "remote") listener = await startRemoteForward(client, forward, onError);
    else listener = await startSocksForward(client, forward, onError);
  } catch (error) {
    try { client.end(); } catch {}
    throw error;
  }
  return {
    client,
    listener,
    async close() {
      closing = true;
      try {
        const result = listener?.close?.();
        if (result && typeof result.then === "function") await result.catch(() => {});
      } catch {}
      try { client.end(); } catch {}
    }
  };
}

module.exports = {
  connectSsh,
  connectPassword,
  isPasswordConnection,
  openSshShell,
  openPasswordShell,
  runPasswordCommand,
  spawnPasswordCommand,
  startPasswordForward
};
