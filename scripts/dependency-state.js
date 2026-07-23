const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const nodeModules = path.join(root, "node_modules");
const marker = path.join(nodeModules, ".tunneldesk-dependencies.sha256");
const manifests = ["package.json", "package-lock.json"]
  .map((name) => path.join(root, name))
  .filter((file) => fs.existsSync(file));
const fingerprint = crypto.createHash("sha256")
  .update(manifests.map((file) => fs.readFileSync(file)).reduce((parts, body) => Buffer.concat([parts, body]), Buffer.alloc(0)))
  .digest("hex");
const required = [
  path.join(nodeModules, "@xterm", "xterm", "lib", "xterm.js"),
  path.join(nodeModules, "@xterm", "addon-fit", "lib", "addon-fit.js"),
  path.join(nodeModules, "iconv-lite", "lib", "index.js"),
  process.platform === "win32"
    ? path.join(nodeModules, ".bin", "tsc.cmd")
    : path.join(nodeModules, ".bin", "tsc")
];

if (process.argv.includes("--write")) {
  fs.mkdirSync(nodeModules, { recursive: true });
  fs.writeFileSync(marker, `${fingerprint}\n`, "utf8");
  process.exit(0);
}

let stored = "";
try {
  stored = fs.readFileSync(marker, "utf8").trim();
} catch {}
process.exit(stored === fingerprint && required.every((file) => fs.existsSync(file)) ? 0 : 1);
