"use strict";

const fs = require("node:fs");
const path = require("node:path");

function resourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources"
    );
  }
  return path.join(context.appOutDir, "resources");
}

function verifyMacIcon(context) {
  const appDir = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const plistPath = path.join(appDir, "Contents", "Info.plist");
  const iconPath = path.join(appDir, "Contents", "Resources", "icon.icns");
  const plist = fs.readFileSync(plistPath, "utf8");
  if (!/<key>CFBundleIconFile<\/key>\s*<string>icon\.icns<\/string>/.test(plist)) {
    throw new Error(`macOS bundle does not declare icon.icns: ${plistPath}`);
  }
  if (!fs.existsSync(iconPath) || fs.readFileSync(iconPath).subarray(0, 4).toString("ascii") !== "icns") {
    throw new Error(`macOS bundle icon is missing or invalid: ${iconPath}`);
  }
  console.log(`Verified macOS bundle icon: ${iconPath}`);
}

function walk(directory, files = []) {
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, files);
    else files.push(fullPath);
  }
  return files;
}

exports.default = async function afterPack(context) {
  if (!["darwin", "linux"].includes(context.electronPlatformName)) return;
  if (context.electronPlatformName === "darwin") verifyMacIcon(context);

  const nodePtyDir = path.join(resourcesDir(context), "app.asar.unpacked", "node_modules", "node-pty");
  const helpers = walk(nodePtyDir).filter(file => path.basename(file) === "spawn-helper");
  if (!helpers.length) {
    const message = `node-pty spawn-helper not found under ${nodePtyDir}`;
    if (context.electronPlatformName === "darwin") throw new Error(message);
    console.warn(`${message}; PTY fallback remains available.`);
    return;
  }

  for (const helper of helpers) {
    try {
      fs.chmodSync(helper, 0o755);
      console.log(`Prepared executable node-pty helper: ${helper}`);
    } catch (error) {
      if (context.electronPlatformName === "darwin") throw error;
      console.warn(`Could not mark node-pty helper executable: ${helper}: ${error.message}`);
    }
  }
};
