const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10 * 1000;
const CACHE_FILENAME = "update-check.json";

function parseVersion(value) {
  const text = String(value || "").trim().replace(/^v(?=\d)/i, "");
  const match = text.match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    normalized: `${match[1]}${match[2] ? `-${match[2]}` : ""}`,
    core: match[1].split(".").map(part => Number(part)),
    prerelease: match[2] ? match[2].split(".") : []
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) return Number(left[index]) > Number(right[index]) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) throw new Error(`无法比较版本号：${leftValue || "空"} 与 ${rightValue || "空"}`);
  const length = Math.max(left.core.length, right.core.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.core[index] || 0;
    const rightPart = right.core[index] || 0;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function parseGitHubRepository(repository) {
  const raw = typeof repository === "string" ? repository : repository?.url;
  let value = String(raw || "").trim().replace(/^git\+/, "").replace(/\.git$/, "");
  const sshMatch = value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  if (/^[^/:]+\/[^/]+$/.test(value)) {
    const [owner, repo] = value.split("/");
    return { owner, repo };
  }
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") throw new Error("not github");
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (owner && repo) return { owner, repo };
  } catch {}
  throw new Error("package.json 中没有可用的 GitHub 仓库地址");
}

function readJson(file, fallback = null) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function releaseResult(packageInfo, release, checkedAt, fromCache) {
  const current = parseVersion(packageInfo.version);
  const latest = parseVersion(release?.tag_name);
  if (!current) throw new Error(`当前版本号无效：${packageInfo.version || "空"}`);
  if (!latest || !release?.html_url || release.draft || release.prerelease) {
    throw new Error("GitHub Releases 返回的正式版本数据无效");
  }
  return {
    current_version: current.normalized,
    latest_version: latest.normalized,
    update_available: compareVersions(latest.normalized, current.normalized) > 0,
    release_url: String(release.html_url),
    name: String(release.name || release.tag_name || latest.normalized),
    published_at: release.published_at || "",
    notes: String(release.body || ""),
    assets: Array.isArray(release.assets) ? release.assets.map(asset => ({
      name: String(asset?.name || ""),
      url: String(asset?.browser_download_url || ""),
      size: Number(asset?.size || 0),
      content_type: String(asset?.content_type || "")
    })).filter(asset => asset.name && asset.url) : [],
    checked_at: new Date(checkedAt).toISOString(),
    from_cache: Boolean(fromCache),
    source: "github"
  };
}

function cachedResult(cache, packageInfo) {
  if (!cache?.result) return null;
  const current = parseVersion(packageInfo?.version);
  const latest = parseVersion(cache.result.latest_version);
  if (!current) throw new Error(`当前版本号无效：${packageInfo?.version || "空"}`);
  if (!latest) return null;
  return {
    ...cache.result,
    current_version: current.normalized,
    latest_version: latest.normalized,
    update_available: compareVersions(latest.normalized, current.normalized) > 0,
    from_cache: true,
    source: "github"
  };
}

function createUpdateChecker(options: any = {}) {
  const dataDir = options.dataDir;
  if (!dataDir) throw new Error("更新检查器缺少数据目录");
  const packagePath = options.packagePath || path.resolve(__dirname, "..", "package.json");
  const packageInfo = options.packageInfo || readJson(packagePath);
  if (!packageInfo?.version) throw new Error("无法读取 package.json 中的当前版本");
  const repository = parseGitHubRepository(packageInfo.repository || packageInfo.homepage);
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前运行环境不支持网络更新检查");
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const cacheTtlMs = Number(options.cacheTtlMs || DEFAULT_CACHE_TTL_MS);
  const cachePath = options.cachePath || path.join(dataDir, CACHE_FILENAME);
  const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : null;
  let inFlight = null;

  function readCache() {
    return readJson(cachePath, {}) || {};
  }

  function saveCache(cache) {
    writeJson(cachePath, { schema_version: 1, ...cache });
  }

  async function notifyOnce(result) {
    if (!result.update_available || !onUpdate) return;
    const cache = readCache();
    if (cache.notified_latest_version === result.latest_version) return;
    saveCache({ ...cache, notified_latest_version: result.latest_version });
    await onUpdate(result);
  }

  async function requestLatest(cache) {
    const controller = new AbortController();
    let timedOut = false;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("检查更新超时，请稍后重试"));
      }, timeoutMs);
    });
    const headers: any = {
      "User-Agent": `TunnelDesk/${packageInfo.version}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (cache.etag) headers["If-None-Match"] = cache.etag;
    try {
      const request = Promise.resolve(fetchImpl(
        `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/releases/latest`,
        { method: "GET", headers, signal: controller.signal }
      ));
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (timedOut || error?.name === "AbortError") throw new Error("检查更新超时，请稍后重试");
      if (String(error?.message || "").startsWith("检查更新超时")) throw error;
      throw new Error(`无法连接 GitHub 检查更新：${error?.message || String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function performCheck(force) {
    const checkedAt = Number(now());
    let cache = readCache();
    const age = checkedAt - Number(cache.checked_at_ms || 0);
    const cached = cachedResult(cache, packageInfo);
    if (!force && cached && age >= 0 && age < cacheTtlMs) {
      const result = cached;
      await notifyOnce(result);
      return result;
    }

    const response: any = await requestLatest(cache);
    if (response?.status === 304) {
      const result = cachedResult(cache, packageInfo);
      if (!result) throw new Error("GitHub 返回未修改，但本地没有可用的更新缓存");
      result.checked_at = new Date(checkedAt).toISOString();
      cache = { ...cache, checked_at_ms: checkedAt, result };
      saveCache(cache);
      await notifyOnce(result);
      return result;
    }
    if (!response?.ok) {
      if (response?.status === 404) throw new Error("GitHub 仓库尚未发布正式版本");
      throw new Error(`GitHub 更新检查失败（HTTP ${response?.status || "未知"}）`);
    }
    let release;
    try {
      release = await response.json();
    } catch {
      throw new Error("GitHub Releases 返回的数据无法解析");
    }
    const result = releaseResult(packageInfo, release, checkedAt, false);
    const etag = response.headers?.get?.("etag") || response.headers?.get?.("ETag") || "";
    cache = { ...cache, checked_at_ms: checkedAt, etag, result };
    saveCache(cache);
    await notifyOnce(result);
    return result;
  }

  function check(optionsOrForce: any = {}) {
    const force = typeof optionsOrForce === "boolean" ? optionsOrForce : Boolean(optionsOrForce.force);
    if (inFlight) return inFlight;
    inFlight = performCheck(force).finally(() => { inFlight = null; });
    return inFlight;
  }

  function status() {
    return cachedResult(readCache(), packageInfo);
  }

  return { check, status, cachePath, packageInfo, repository };
}

module.exports = {
  CACHE_FILENAME,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  compareVersions,
  createUpdateChecker,
  parseGitHubRepository,
  parseVersion,
  releaseResult
};
