const { spawnSync } = require("node:child_process");
const path = require("node:path");

const files = [
  "public/app-api.js",
  "public/app-utils.js",
  "public/app-workspace.js",
  "public/app-settings.js",
  "public/app-running.js",
  "public/app-batch.js",
  "public/app-logs.js",
  "public/app-connections.js",
  "public/app-terminal.js",
  "public/app-forwards.js",
  "public/app-import.js",
  "public/app-sftp.js",
  "public/app.js"
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", path.resolve(file)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`前端语法检查通过：${files.length} 个脚本`);
