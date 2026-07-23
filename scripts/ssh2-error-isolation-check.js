const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const net = require("node:net");
const { Server } = require("ssh2");
const { runPasswordCommand } = require("../dist/ssh2-client");

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
  return new Promise((resolve) => server.close(resolve));
}

function connection(port) {
  return {
    auth_type: "password",
    ssh_host: "127.0.0.1",
    ssh_port: port,
    ssh_user: "test",
    ssh_password: "test-password"
  };
}

async function main() {
  let uncaught = null;
  let unhandled = null;
  const onUncaught = (error) => { uncaught = error; };
  const onUnhandled = (error) => { unhandled = error; };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);

  const rejectingServer = net.createServer((socket) => socket.destroy());
  const rejectingPort = await listen(rejectingServer);
  const failed = await runPasswordCommand(connection(rejectingPort), "true", null, 3000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await close(rejectingServer);
  assert.equal(failed.status, null);
  assert.ok(failed.error, "握手失败应返回普通错误结果");
  assert.equal(uncaught, null, `握手失败不应触发未捕获异常：${uncaught?.message || ""}`);
  assert.equal(unhandled, null, `握手失败不应触发未处理拒绝：${unhandled?.message || ""}`);

  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sshServer = new Server({
    hostKeys: [privateKey.export({type:"pkcs1", format:"pem"})]
  }, (client) => {
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "test" && context.password === "test-password") context.accept();
      else context.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec) => {
          const stream = acceptExec();
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  const sshPort = await listen(sshServer);
  const succeeded = await runPasswordCommand(connection(sshPort), "true", null, 3000);
  await close(sshServer);

  process.removeListener("uncaughtException", onUncaught);
  process.removeListener("unhandledRejection", onUnhandled);
  assert.equal(succeeded.status, 0, succeeded.error?.message || succeeded.stderr || "后续 SSH 测试应成功");
  assert.equal(uncaught, null);
  assert.equal(unhandled, null);
  console.log("SSH2 错误隔离检查通过：握手失败后可继续建立新连接");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
