const assert = require("node:assert/strict");
const net = require("node:net");
const { startSocksForward } = require("../dist/ssh2-client");
let stage = "初始化";
let proxyServer = null;
const watchdog = setTimeout(() => {
  console.error(`SOCKS5 动态转发检查超时：${stage}`);
  process.exit(1);
}, 10000);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  try { server.closeAllConnections?.(); } catch {}
  try { server._srv?.closeAllConnections?.(); } catch {}
  try { server.server?.closeAllConnections?.(); } catch {}
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 2000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function readAtLeast(socket, size, label) {
  return new Promise((resolve, reject) => {
    let body = Buffer.alloc(0);
    const timer = setTimeout(() => onError(new Error(`${label} 等待 SOCKS5 数据超时，已收到 ${body.length}/${size} 字节`)), 3000);
    const onData = chunk => {
      body = Buffer.concat([body, chunk]);
      if (body.length < size) return;
      cleanup();
      resolve(body);
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function requestBytes(addressType, target, port) {
  let address;
  if (addressType === 1) {
    address = Buffer.from(target.split(".").map(Number));
  } else if (addressType === 3) {
    const body = Buffer.from(target, "utf8");
    address = Buffer.concat([Buffer.from([body.length]), body]);
  } else {
    address = Buffer.alloc(16);
    address[15] = 1;
  }
  return Buffer.concat([Buffer.from([5, 1, 0, addressType]), address, Buffer.from([port >> 8, port & 255])]);
}

async function proxyRoundTrip(proxyPort, addressType, target, targetPort, expectedAddress) {
  stage = `连接代理 ${addressType}`;
  const socket = net.connect(proxyPort, "127.0.0.1");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(Buffer.from([5, 1, 0]));
  stage = `等待认证响应 ${addressType}`;
  assert.deepEqual([...await readAtLeast(socket, 2, "认证响应")].slice(0, 2), [5, 0]);
  socket.write(requestBytes(addressType, target, targetPort));
  stage = `等待连接响应 ${addressType}`;
  const reply = await readAtLeast(socket, 10, "连接响应");
  assert.equal(reply[0], 5);
  assert.equal(reply[1], 0);
  const payload = Buffer.from(`tunneldesk-${addressType}`);
  socket.write(payload);
  stage = `等待回显 ${addressType}`;
  const echoed = await readAtLeast(socket, payload.length, "回显数据");
  assert.equal(echoed.subarray(0, payload.length).toString(), payload.toString());
  socket.destroy();
  stage = `完成往返 ${addressType}`;
  assert.equal(lastTarget.address, expectedAddress);
}

let lastTarget = {};
const echoServer = net.createServer(socket => socket.pipe(socket));

(async () => {
  stage = "启动回显服务";
  const echoPort = await listen(echoServer);
  const fakeSshClient = {
    forwardOut(sourceAddress, sourcePort, address, port, callback) {
      lastTarget = { sourceAddress, sourcePort, address, port };
      const channel = net.connect(echoPort, "127.0.0.1");
      channel.once("connect", () => callback(null, channel));
      channel.once("error", callback);
    }
  };
  stage = "启动 SOCKS5 服务";
  const proxy = await startSocksForward(fakeSshClient, { bind_host: "127.0.0.1", bind_port: 0 }, error => {
    throw error;
  });
  proxyServer = proxy;
  const proxyPort = proxy.address().port;
  await proxyRoundTrip(proxyPort, 1, "127.0.0.1", echoPort, "127.0.0.1");
  await proxyRoundTrip(proxyPort, 3, "localhost", echoPort, "localhost");
  await proxyRoundTrip(proxyPort, 4, "::1", echoPort, "0000:0000:0000:0000:0000:0000:0000:0001");
  stage = "关闭 SOCKS5 服务";
  await close(proxy);
  stage = "关闭回显服务";
  await close(echoServer);
  clearTimeout(watchdog);
  console.log("SOCKS5 动态转发检查通过：IPv4、域名、IPv6 和 SSH 通道双向传输");
})().catch(async error => {
  try { if (proxyServer) await close(proxyServer); } catch {}
  try { await close(echoServer); } catch {}
  clearTimeout(watchdog);
  console.error(error);
  process.exitCode = 1;
});
