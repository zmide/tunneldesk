"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const mode = process.argv[2];

function openLog(name) {
  fs.mkdirSync(dataDir, { recursive: true });
  return fs.openSync(path.join(dataDir, name), "a");
}

function startDetached(command, args, stdoutName, stderrName = stdoutName) {
  const stdout = openLog(stdoutName);
  const stderr = stderrName === stdoutName ? stdout : openLog(stderrName);
  try {
    const child = spawn(command, args, {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
      env: process.env
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(stdout);
    if (stderr !== stdout) fs.closeSync(stderr);
  }
}

if (mode === "desktop") {
  const electron = require("electron");
  if (typeof electron !== "string" || !fs.existsSync(electron)) throw new Error("Electron binary not found");
  startDetached(electron, [root, ...process.argv.slice(3)], "web.log", "desktop-error.log");
} else if (mode === "web") {
  startDetached(process.execPath, [path.join(root, "dist", "server.js"), ...process.argv.slice(3)], "web.log");
} else {
  throw new Error(`Unknown detached start mode: ${mode || "missing"}`);
}
