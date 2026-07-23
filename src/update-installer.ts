import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
  digest?: string;
  content_type?: string;
}

export interface UpdateRelease {
  latest_version: string;
  update_available: boolean;
  assets: UpdateAsset[];
}

export interface UpdateDownloadState {
  schema_version: number;
  state: "idle" | "downloading" | "downloaded" | "failed";
  version?: string;
  asset_name?: string;
  selected_asset_name?: string;
  selected_asset_size?: number;
  file?: string;
  size?: number;
  bytes_downloaded?: number;
  progress_percent?: number;
  digest?: string;
  downloaded_at?: string;
  error?: string;
  platform?: string;
  arch?: string;
  package_type?: string;
}

interface UpdateInstallerOptions {
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  windowsPackageType?: "installer" | "portable";
}

function safeAssetName(value: string): string {
  const name = path.basename(String(value || "")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  if (!name || name === "." || name === "..") throw new Error("更新产物名称无效");
  return name;
}

function platformAssetScore(
  asset: UpdateAsset,
  platform: NodeJS.Platform,
  arch: string,
  windowsPackageType: "installer" | "portable"
): number {
  const name = asset.name.toLowerCase();
  const normalizedArch = arch === "x64" ? ["x64", "x86_64", "amd64"] : arch === "arm64" ? ["arm64", "aarch64"] : [arch];
  const hasArch = normalizedArch.some(value => name.includes(value));
  if (!hasArch) return -1;
  if (platform === "win32") {
    if (!name.endsWith(".exe") || !name.includes("windows")) return -1;
    const isInstaller = name.includes("installer") || name.includes("setup");
    const isPortable = name.includes("portable");
    if (windowsPackageType === "portable") return isPortable ? 100 : isInstaller ? -1 : 1;
    return isInstaller ? 100 : isPortable ? -1 : 1;
  }
  if (platform === "darwin") {
    if (!name.includes("macos")) return -1;
    return name.endsWith(".dmg") ? 100 : name.endsWith(".zip") ? 50 : -1;
  }
  if (platform === "linux") {
    if (!name.includes("linux")) return -1;
    if (name.endsWith(".appimage")) return 100;
    if (name.endsWith(".deb")) return 80;
    if (name.endsWith(".rpm")) return 60;
  }
  return -1;
}

export function selectUpdateAsset(
  assets: UpdateAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  windowsPackageType: "installer" | "portable" = "installer"
): UpdateAsset {
  const selected = [...(Array.isArray(assets) ? assets : [])]
    .map(asset => ({ asset, score: platformAssetScore(asset, platform, arch, windowsPackageType) }))
    .filter(item => item.score >= 0)
    .sort((left, right) => right.score - left.score)[0]?.asset;
  if (!selected) throw new Error(`当前 Release 没有适用于 ${platform}/${arch} 的安装产物`);
  return selected;
}

function packageTypeForAsset(asset: UpdateAsset, platform: NodeJS.Platform): string {
  const name = asset.name.toLowerCase();
  if (platform === "win32") return name.includes("portable") ? "portable" : "installer";
  if (name.endsWith(".dmg")) return "dmg";
  if (name.endsWith(".zip")) return "zip";
  if (name.endsWith(".appimage")) return "appimage";
  if (name.endsWith(".deb")) return "deb";
  if (name.endsWith(".rpm")) return "rpm";
  return path.extname(name).replace(/^\./, "") || "unknown";
}

function parseSha256(value: string): string {
  const match = String(value || "").trim().match(/^sha256:([a-f0-9]{64})$/i);
  if (!match) throw new Error("GitHub Release 未提供可验证的 SHA-256 摘要，已拒绝下载");
  return match[1].toLowerCase();
}

function readState(file: string): UpdateDownloadState {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as UpdateDownloadState;
    return value && typeof value === "object" ? value : { schema_version: 1, state: "idle" };
  } catch {
    return { schema_version: 1, state: "idle" };
  }
}

function writeState(file: string, value: UpdateDownloadState): UpdateDownloadState {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
  return value;
}

export class UpdateInstaller {
  private readonly directory: string;
  private readonly stateFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly windowsPackageType: "installer" | "portable";
  private inFlight: Promise<UpdateDownloadState> | null = null;
  private liveState: UpdateDownloadState | null = null;

  constructor(dataDirectory: string, options: UpdateInstallerOptions = {}) {
    this.directory = path.join(dataDirectory, "updates");
    this.stateFile = path.join(this.directory, "state.json");
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.windowsPackageType = options.windowsPackageType
      || (this.platform === "win32" && String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim() ? "portable" : "installer");
    if (typeof this.fetchImpl !== "function") throw new Error("当前运行环境不支持更新下载");
  }

  status(release?: UpdateRelease): UpdateDownloadState {
    let state = this.liveState ? { ...this.liveState } : readState(this.stateFile);
    let selected: UpdateAsset | null = null;
    let selectedPackageType = "";
    if (release?.update_available) {
      try {
        selected = selectUpdateAsset(release.assets, this.platform, this.arch, this.windowsPackageType);
        selectedPackageType = packageTypeForAsset(selected, this.platform);
      } catch {}
    }
    if (state.state !== "idle" && selected) {
      const stateAssetName = String(state.asset_name || state.selected_asset_name || "");
      const stateVersion = String(state.version || "").replace(/^v/i, "");
      const releaseVersion = String(release?.latest_version || "").replace(/^v/i, "");
      const matchesCurrentTarget = stateAssetName === selected.name
        && stateVersion === releaseVersion
        && state.platform === this.platform
        && state.arch === this.arch
        && state.package_type === selectedPackageType;
      if (!matchesCurrentTarget) {
        state = { schema_version: 1, state: "idle" };
      }
    }
    if (state.state === "downloading" && !this.inFlight && !this.liveState) {
      state = writeState(this.stateFile, {
        ...state,
        state: "failed",
        error: "上次更新下载被中断，请重新下载"
      });
    }
    if (state.state === "downloaded" && (!state.file || !fs.existsSync(state.file))) {
      state = writeState(this.stateFile, { schema_version: 1, state: "idle" });
      this.liveState = state;
    }
    const result: UpdateDownloadState = {
      ...state,
      platform: this.platform,
      arch: this.arch
    };
    if (release?.update_available) {
      try {
        selected ||= selectUpdateAsset(release.assets, this.platform, this.arch, this.windowsPackageType);
        result.selected_asset_name = selected.name;
        result.selected_asset_size = selected.size;
        result.package_type = selectedPackageType || packageTypeForAsset(selected, this.platform);
      } catch (error) {
        if (!result.error) result.error = error instanceof Error ? error.message : String(error);
      }
    }
    return result;
  }

  download(release: UpdateRelease): Promise<UpdateDownloadState> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.performDownload(release).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async verifyDownloaded(release?: UpdateRelease): Promise<UpdateDownloadState> {
    if (release && (!release.update_available || !release.latest_version)) {
      throw new Error("当前没有可打开的新版本安装包");
    }
    const state = this.status(release);
    if (state.state !== "downloaded" || !state.file || !state.digest) throw new Error("没有已下载并校验的更新安装包");
    const root = path.resolve(this.directory);
    const resolved = path.resolve(state.file);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("更新安装包路径无效");
    const expected = parseSha256(state.digest);
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(resolved)) hash.update(chunk);
    const actual = hash.digest("hex");
    if (actual !== expected) throw new Error("更新安装包校验失败，文件可能已被修改");
    return state;
  }

  private async performDownload(release: UpdateRelease): Promise<UpdateDownloadState> {
    if (!release?.update_available || !release.latest_version) throw new Error("当前没有可下载的新版本");
    const asset = selectUpdateAsset(release.assets, this.platform, this.arch, this.windowsPackageType);
    const expectedDigest = parseSha256(String(asset.digest || ""));
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 4 * 1024 * 1024 * 1024) {
      throw new Error("更新产物大小无效");
    }
    const source = new URL(asset.url);
    if (source.protocol !== "https:" || !["github.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"].includes(source.hostname)) {
      throw new Error("更新下载地址不是受信任的 GitHub HTTPS 地址");
    }
    fs.mkdirSync(this.directory, { recursive: true });
    const filename = safeAssetName(asset.name);
    const target = path.join(this.directory, filename);
    const temporary = `${target}.part-${process.pid}`;
    const packageType = packageTypeForAsset(asset, this.platform);
    this.liveState = {
      schema_version: 1,
      state: "downloading",
      version: release.latest_version,
      asset_name: filename,
      selected_asset_name: filename,
      selected_asset_size: asset.size,
      size: asset.size,
      bytes_downloaded: 0,
      progress_percent: 0,
      digest: String(asset.digest),
      platform: this.platform,
      arch: this.arch,
      package_type: packageType
    };
    writeState(this.stateFile, this.liveState);
    try {
      const response = await this.fetchImpl(asset.url, {
        method: "GET",
        headers: { "User-Agent": `TunnelDesk/${release.latest_version}`, "Accept": "application/octet-stream" },
        redirect: "follow"
      });
      if (!response.ok || !response.body) throw new Error(`更新下载失败（HTTP ${response.status || "未知"}）`);
      const output = fs.createWriteStream(temporary, { flags: "w" });
      const hash = crypto.createHash("sha256");
      let bytes = 0;
      try {
        for await (const sourceChunk of response.body as any) {
          const chunk = Buffer.from(sourceChunk);
          bytes += chunk.length;
          if (bytes > asset.size) throw new Error("更新下载大小超过 Release 声明值");
          hash.update(chunk);
          if (!output.write(chunk)) await new Promise<void>(resolve => output.once("drain", resolve));
          if (this.liveState) {
            this.liveState.bytes_downloaded = bytes;
            this.liveState.progress_percent = Math.min(99, Math.floor(bytes / asset.size * 100));
          }
        }
        await new Promise<void>((resolve, reject) => {
          output.once("error", reject);
          output.end(resolve);
        });
      } catch (error) {
        output.destroy();
        throw error;
      }
      if (bytes !== asset.size) throw new Error(`更新下载不完整：应为 ${asset.size} 字节，实际 ${bytes} 字节`);
      if (hash.digest("hex") !== expectedDigest) throw new Error("更新安装包 SHA-256 校验失败");
      fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
      if (this.platform === "linux" && /\.appimage$/i.test(target)) {
        try { fs.chmodSync(target, 0o755); } catch {}
      }
      const completed = writeState(this.stateFile, {
        schema_version: 1,
        state: "downloaded",
        version: release.latest_version,
        asset_name: filename,
        selected_asset_name: filename,
        selected_asset_size: asset.size,
        file: target,
        size: bytes,
        bytes_downloaded: bytes,
        progress_percent: 100,
        digest: String(asset.digest),
        downloaded_at: new Date().toISOString(),
        platform: this.platform,
        arch: this.arch,
        package_type: packageType
      });
      this.liveState = completed;
      return completed;
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      const message = error instanceof Error ? error.message : String(error);
      const failed = writeState(this.stateFile, {
        schema_version: 1,
        state: "failed",
        version: release.latest_version,
        asset_name: filename,
        selected_asset_name: filename,
        selected_asset_size: asset.size,
        size: asset.size,
        bytes_downloaded: this.liveState?.bytes_downloaded || 0,
        progress_percent: this.liveState?.progress_percent || 0,
        platform: this.platform,
        arch: this.arch,
        package_type: packageType,
        error: message
      });
      this.liveState = failed;
      throw error;
    }
  }
}
