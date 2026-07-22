"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function expectedArtifacts(platform, version = packageJson.version) {
  const product = packageJson.build?.productName || "TunnelDesk";
  const releaseVersion = String(version || packageJson.version);
  if (platform === "windows") {
    return [
      `${product}-${releaseVersion}-windows-x64-installer.exe`,
      `${product}-${releaseVersion}-windows-x64-portable.exe`
    ];
  }
  if (platform === "linux") {
    return [
      `${product}-${releaseVersion}-linux-x86_64.AppImage`,
      `${product}-${releaseVersion}-linux-amd64.deb`,
      `${product}-${releaseVersion}-linux-x86_64.rpm`
    ];
  }
  if (platform === "macos") {
    return [
      `${product}-${releaseVersion}-macos-x64.dmg`,
      `${product}-${releaseVersion}-macos-x64.zip`,
      `${product}-${releaseVersion}-macos-arm64.dmg`,
      `${product}-${releaseVersion}-macos-arm64.zip`
    ];
  }
  if (platform === "linux-source") {
    return [`${product}-${releaseVersion}-linux-source-noarch.tar.gz`];
  }
  throw new Error(`未知发布平台：${platform}`);
}

function relevantArtifacts(platform, names) {
  const patterns = {
    windows: /\.(?:exe|blockmap)$/i,
    linux: /\.(?:AppImage|deb|rpm|blockmap)$/i,
    macos: /\.(?:dmg|zip|blockmap)$/i,
    "linux-source": /\.tar\.gz$/i
  };
  const pattern = patterns[platform];
  if (!pattern) throw new Error(`未知发布平台：${platform}`);
  return names.filter((name) => pattern.test(name));
}

function verifyReleaseVersion(refName = process.env.GITHUB_REF_NAME, refType = process.env.GITHUB_REF_TYPE) {
  if (refType !== "tag") return { checked:false, version:packageJson.version };
  const expected = `v${packageJson.version}`;
  if (refName !== expected) {
    throw new Error(`发布标签 ${refName || "（空）"} 与 package.json 版本不一致，应为 ${expected}`);
  }
  console.log(`发布标签与程序版本一致：${expected}`);
  return { checked:true, version:packageJson.version, tag:expected };
}

function verifyArtifacts(platform, directory, version = packageJson.version) {
  const expected = expectedArtifacts(platform, version);
  const names = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const relevant = relevantArtifacts(platform, names);
  const allowed = new Set(expected.flatMap((name) => [name, `${name}.blockmap`]));
  const missing = expected.filter((name) => !relevant.includes(name));
  const unexpected = relevant.filter((name) => !allowed.has(name));
  if (missing.length || unexpected.length) {
    const details = [
      missing.length ? `缺少：${missing.join(", ")}` : "",
      unexpected.length ? `名称不规范：${unexpected.join(", ")}` : ""
    ].filter(Boolean).join("；");
    throw new Error(`${platform} 发布产物校验失败：${details}`);
  }
  console.log(`${platform} 发布产物名称已验证：\n${relevant.map((name) => `  ${name}`).join("\n")}`);
  return relevant;
}

if (require.main === module) {
  const platform = String(process.argv[2] || "").toLowerCase();
  verifyReleaseVersion();
  const directory = path.resolve(root, process.argv[3] || (platform === "linux-source" ? "release-source" : "release"));
  const version = process.argv[4] || packageJson.version;
  verifyArtifacts(platform, directory, version);
}

module.exports = { expectedArtifacts, relevantArtifacts, verifyArtifacts, verifyReleaseVersion };
