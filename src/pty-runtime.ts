const fs = require("node:fs");
const path = require("node:path");

function unpackedPath(file) {
  return String(file || "").replace(/app\.asar(?=[\\/])/, "app.asar.unpacked");
}

function nodePtyPackageDir() {
  try {
    return path.dirname(require.resolve("node-pty/package.json"));
  } catch {
    return "";
  }
}

function helperCandidates(packageDir) {
  if (!packageDir || process.platform === "win32") return [];
  return [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")
  ].map(unpackedPath);
}

function ptyRuntimeStatus(repair = false) {
  const packageDir = nodePtyPackageDir();
  const helperPath = helperCandidates(packageDir).find(file => fs.existsSync(file)) || "";
  let helperExecutable = process.platform === "win32";
  let helperError = "";

  if (helperPath) {
    try {
      helperExecutable = Boolean(fs.statSync(helperPath).mode & 0o111);
      if (repair && !helperExecutable) {
        fs.chmodSync(helperPath, 0o755);
        helperExecutable = Boolean(fs.statSync(helperPath).mode & 0o111);
      }
    } catch (error) {
      helperError = error.message || String(error);
    }
  }

  return {
    package_dir: packageDir,
    helper_path: helperPath,
    helper_exists: process.platform === "win32" || Boolean(helperPath),
    helper_executable: helperExecutable,
    helper_error: helperError
  };
}

function loadNodePty() {
  const status = ptyRuntimeStatus(true);
  if (process.platform === "darwin" && !status.helper_exists) {
    throw new Error("node-pty spawn-helper 不存在");
  }
  if (process.platform === "darwin" && !status.helper_executable) {
    throw new Error(`node-pty spawn-helper 不可执行${status.helper_error ? `：${status.helper_error}` : ""}`);
  }
  return require("node-pty");
}

module.exports = { loadNodePty, ptyRuntimeStatus };
