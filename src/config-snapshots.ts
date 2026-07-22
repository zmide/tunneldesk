const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR } = require("./config");
const { exportConfigSnapshot, restoreConfigSnapshot } = require("./db");

const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const MAX_SNAPSHOTS = 20;

function safeId(value) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("快照 ID 无效");
  return id;
}

function readSnapshotFile(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return data;
}

function scanConfigSnapshots() {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive:true });
  return fs.readdirSync(SNAPSHOT_DIR).filter(name => name.endsWith(".json")).map(name => {
    try {
      const data = readSnapshotFile(path.join(SNAPSHOT_DIR, name));
      return { id:data.id, reason:data.reason, created_at:data.created_at, counts:data.counts };
    } catch { return null; }
  }).filter(Boolean).sort((a,b) => b.created_at - a.created_at);
}

function listConfigSnapshots() {
  return scanConfigSnapshots().slice(0, MAX_SNAPSHOTS);
}

function createConfigSnapshot(reason="手动快照") {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive:true });
  const snapshot = exportConfigSnapshot();
  const id = crypto.randomUUID();
  const payload = { id, reason:String(reason || "手动快照").slice(0,120), created_at:Date.now(), counts:{connections:snapshot.connections.length,forwards:snapshot.forwards.length,templates:snapshot.forward_templates.length}, snapshot };
  fs.writeFileSync(path.join(SNAPSHOT_DIR, `${id}.json`), JSON.stringify(payload, null, 2), "utf8");
  for (const old of scanConfigSnapshots().slice(MAX_SNAPSHOTS)) try { fs.unlinkSync(path.join(SNAPSHOT_DIR, `${old.id}.json`)); } catch {}
  return { id:payload.id, reason:payload.reason, created_at:payload.created_at, counts:payload.counts };
}

function restoreConfigSnapshotById(id) {
  const payload = readSnapshotFile(path.join(SNAPSHOT_DIR, `${safeId(id)}.json`));
  return restoreConfigSnapshot(payload.snapshot);
}

function deleteConfigSnapshot(id) {
  const file = path.join(SNAPSHOT_DIR, `${safeId(id)}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return {ok:true};
}

module.exports = { createConfigSnapshot, deleteConfigSnapshot, listConfigSnapshots, restoreConfigSnapshotById };
