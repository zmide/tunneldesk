"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunneldesk-credential-backup-"));
process.env.TUNNELDESK_DATA_DIR = path.join(temporaryRoot, "data");
process.env.TUNNELDESK_SSH_DIR = path.join(temporaryRoot, ".ssh");

const database = require("../dist/db");

function passwordFrom(buffer, name) {
  const file = path.join(temporaryRoot, `${name}.db`);
  fs.writeFileSync(file, buffer);
  const backup = new DatabaseSync(file, {readOnly:true});
  try {
    return backup.prepare("SELECT ssh_password FROM connections WHERE name=?").get("password-check")?.ssh_password ?? null;
  } finally {
    backup.close();
  }
}

try {
  database.insertConnection({
    name:"password-check",
    group_name:"测试",
    ssh_host:"example.invalid",
    ssh_port:22,
    ssh_user:"root",
    auth_type:"password",
    ssh_password:"fixture-secret"
  }, "");
  assert.equal(passwordFrom(database.exportDatabaseBuffer(false), "without-password"), null);
  assert.equal(passwordFrom(database.exportDatabaseBuffer(true), "with-password"), "fixture-secret");
  assert.equal(database.getConnection(1).ssh_password, "fixture-secret");
  console.log("Database credential backup choices passed.");
} finally {
  try { database.closeDatabase(); } catch {}
  fs.rmSync(temporaryRoot, {recursive:true, force:true});
}
