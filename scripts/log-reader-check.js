const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  enforceLogRetention,
  normalizeLogSettings,
  readLogSettings,
  readLogWindow,
  resolveLogFile,
  rotateLogFile,
  writeLogSettings
} = require("../dist/log-reader");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tunneldesk-log-check-"));
  try {
    const settingsFile = path.join(root, "log-settings.json");
    const settings = writeLogSettings(settingsFile, {
      retention_days: 30,
      max_file_size_mb: 1,
      max_total_size_mb: 10,
      rotation_files: 2
    });
    assert.equal(readLogSettings(settingsFile).retention_days, 30);
    assert.equal(normalizeLogSettings({ retention_days: -1 }).retention_days, 0);
    assert.equal(settings.rotation_files, 2);
    assert.throws(() => resolveLogFile(root, "../outside.log"), /路径无效/);

    const log = path.join(root, "large.log");
    const rows = Array.from({ length: 1200 }, (_, index) =>
      `${String(index + 1).padStart(4, "0")} ${index === 517 ? "\u001b[31mneedle\u001b[0m" : "ordinary"} ${"x".repeat(32)}`
    );
    fs.writeFileSync(log, `${rows.join("\n")}\n`, "utf8");
    const tail = await readLogWindow(root, "large.log", { limitBytes: 4096, query: "needle", contextLines: 1 });
    assert.equal(tail.has_older, true);
    assert.ok(tail.text.includes("1200 ordinary"));
    assert.equal(tail.matches.length, 1);
    assert.match(tail.matches[0].text, /needle/);
    assert.doesNotMatch(tail.matches[0].text, /\u001b/);
    const older = await readLogWindow(root, "large.log", { beforeOffset: tail.offset, limitBytes: 4096 });
    assert.ok(older.end_offset <= tail.offset);

    fs.writeFileSync(log, Buffer.alloc(1024 * 1024, 1));
    assert.equal(rotateLogFile(log, 1, settings), true);
    assert.equal(fs.existsSync(`${log}.1`), true);

    const oldLog = path.join(root, "expired.log");
    fs.writeFileSync(oldLog, "expired");
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldLog, oldTime, oldTime);
    const cleaned = enforceLogRetention(root, settings);
    assert.equal(cleaned.deleted >= 1, true);
    assert.equal(fs.existsSync(oldLog), false);

    for (let index = 0; index < 11; index += 1) {
      const file = path.join(root, `capacity-${index}.log`);
      fs.writeFileSync(file, Buffer.alloc(1024 * 1024, index));
      const time = new Date(Date.now() - (20 - index) * 1000);
      fs.utimesSync(file, time, time);
    }
    const capacity = enforceLogRetention(root, settings);
    const total = fs.readdirSync(root)
      .filter(name => /\.log(?:\.\d+)?$/.test(name))
      .reduce((sum, name) => sum + fs.statSync(path.join(root, name)).size, 0);
    assert.equal(capacity.deleted >= 1, true);
    assert.equal(total <= 10 * 1024 * 1024, true);
    console.log("日志服务检查通过：分段读取、流式搜索、轮转、保留期和容量清理");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
