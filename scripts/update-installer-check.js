const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { selectUpdateAsset, UpdateInstaller } = require("../dist/update-installer");

function digest(body) {
  return `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
}

function release(asset) {
  return { latest_version: "1.2.0", update_available: true, assets: [asset] };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tunneldesk-update-installer-"));
  try {
    const windowsAssets = [
      { name:"TunnelDesk-1.2.0-windows-x64-portable.exe" },
      { name:"TunnelDesk-1.2.0-windows-x64-installer.exe" }
    ];
    assert.equal(selectUpdateAsset(windowsAssets, "win32", "x64", "installer").name.endsWith("-installer.exe"), true);
    assert.equal(selectUpdateAsset(windowsAssets, "win32", "x64", "portable").name.endsWith("-portable.exe"), true);
    assert.throws(
      () => selectUpdateAsset([windowsAssets[1]], "win32", "x64", "portable"),
      /没有适用于/
    );
    assert.equal(selectUpdateAsset([{ name:"TunnelDesk-1.2.0-windows-x64-setup.exe" }], "win32", "x64").name.endsWith("-setup.exe"), true);
    assert.equal(selectUpdateAsset([{ name:"TunnelDesk-1.2.0-macos-arm64.dmg" }], "darwin", "arm64").name.endsWith(".dmg"), true);
    assert.equal(selectUpdateAsset([{ name:"TunnelDesk-1.2.0-linux-x86_64.AppImage" }], "linux", "x64").name.endsWith(".AppImage"), true);

    const portablePreview = new UpdateInstaller(path.join(root, "portable-preview"), {
      platform:"win32",
      arch:"x64",
      windowsPackageType:"portable"
    }).status({ latest_version:"1.2.0", update_available:true, assets:windowsAssets });
    assert.equal(portablePreview.selected_asset_name.endsWith("-portable.exe"), true);
    assert.equal(portablePreview.package_type, "portable");
    const previousPortableDirectory = process.env.PORTABLE_EXECUTABLE_DIR;
    process.env.PORTABLE_EXECUTABLE_DIR = root;
    try {
      const autoPortablePreview = new UpdateInstaller(path.join(root, "auto-portable-preview"), {
        platform:"win32",
        arch:"x64"
      }).status({ latest_version:"1.2.0", update_available:true, assets:windowsAssets });
      assert.equal(autoPortablePreview.package_type, "portable");
    } finally {
      if (previousPortableDirectory === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR;
      else process.env.PORTABLE_EXECUTABLE_DIR = previousPortableDirectory;
    }

    const body = Buffer.from("signed-update-fixture");
    const asset = {
      name: "TunnelDesk-1.2.0-windows-x64-installer.exe",
      url: "https://github.com/zmide/tunneldesk/releases/download/v1.2.0/TunnelDesk.exe",
      size: body.length,
      digest: digest(body)
    };
    const installer = new UpdateInstaller(root, {
      platform: "win32",
      arch: "x64",
      fetch: async () => ({ ok:true, status:200, body:Readable.from(body) })
    });
    const downloaded = await installer.download(release(asset));
    assert.equal(downloaded.state, "downloaded");
    assert.equal(downloaded.progress_percent, 100);
    assert.equal(downloaded.package_type, "installer");
    assert.equal(fs.readFileSync(downloaded.file, "utf8"), body.toString());
    assert.equal((await installer.verifyDownloaded()).state, "downloaded");
    const portableAsset = {
      ...asset,
      name: "TunnelDesk-1.2.0-windows-x64-portable.exe"
    };
    const currentRelease = {
      latest_version: "1.2.0",
      update_available: true,
      assets: [asset, portableAsset]
    };
    const portableUsingSameData = new UpdateInstaller(root, {
      platform: "win32",
      arch: "x64",
      windowsPackageType: "portable"
    });
    const portableStatus = portableUsingSameData.status(currentRelease);
    assert.equal(portableStatus.state, "idle");
    assert.equal(portableStatus.selected_asset_name, portableAsset.name);
    assert.equal(portableStatus.package_type, "portable");
    await assert.rejects(() => portableUsingSameData.verifyDownloaded(currentRelease), /没有已下载/);
    assert.equal(installer.status(currentRelease).state, "downloaded");
    assert.equal((await installer.verifyDownloaded(currentRelease)).package_type, "installer");
    fs.appendFileSync(downloaded.file, "tampered");
    await assert.rejects(() => installer.verifyDownloaded(), /校验失败/);

    const missingDigest = new UpdateInstaller(path.join(root, "missing"), {
      platform: "win32",
      arch: "x64",
      fetch: async () => ({ ok:true, status:200, body:Readable.from(body) })
    });
    await assert.rejects(() => missingDigest.download(release({...asset, digest:""})), /未提供.*SHA-256/);

    const mismatch = new UpdateInstaller(path.join(root, "mismatch"), {
      platform: "win32",
      arch: "x64",
      fetch: async () => ({ ok:true, status:200, body:Readable.from(Buffer.from("wrong")) })
    });
    await assert.rejects(() => mismatch.download(release(asset)), /不完整|校验失败/);

    const untrusted = new UpdateInstaller(path.join(root, "untrusted"), { platform:"win32", arch:"x64" });
    await assert.rejects(() => untrusted.download(release({...asset, url:"https://example.invalid/update.exe"})), /不是受信任/);
    console.log("更新安装包检查通过：平台/架构/便携类型选包、跨运行形态状态隔离、进度状态、GitHub HTTPS、大小与 SHA-256 校验、篡改拒绝");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
