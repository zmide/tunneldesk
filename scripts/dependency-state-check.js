const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const helper = path.join(__dirname, "dependency-state.js");
const marker = path.join(__dirname, "..", "node_modules", ".tunneldesk-dependencies.sha256");
const run = (...args) => spawnSync(process.execPath, [helper, ...args], { stdio:"pipe" });

assert.strictEqual(run("--write").status, 0, "dependency fingerprint can be written");
assert.strictEqual(run().status, 0, "current dependency fingerprint is accepted");
fs.writeFileSync(marker, "outdated\n", "utf8");
assert.strictEqual(run().status, 1, "changed dependency fingerprint requests npm install");
assert.strictEqual(run("--write").status, 0, "dependency fingerprint is restored after install");
console.log("启动依赖检查通过：依赖完整且 package/package-lock 指纹一致");
