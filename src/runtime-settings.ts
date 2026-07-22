const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_LISTEN_HOSTS = ["127.0.0.1"];
const DEFAULT_LISTEN_PORT = 8088;
const MAX_PORT_FALLBACKS = 20;

function splitListenHosts(value) {
  const source = Array.isArray(value) ? value : [value];
  return source.flatMap(item => String(item ?? "").split(/[\s,]+/)).map(item => item.trim()).filter(Boolean);
}

function normalizeListenHosts(value, fallback: any = DEFAULT_LISTEN_HOSTS) {
  const hosts = [...new Set(splitListenHosts(value))];
  if (!hosts.length) {
    if (fallback === null) throw new Error("请至少选择一个监听地址");
    return normalizeListenHosts(fallback, null);
  }
  for (const host of hosts) {
    if (net.isIP(host) !== 4) throw new Error(`监听地址必须是 IPv4 地址：${host}`);
  }
  return hosts.includes("0.0.0.0") ? ["0.0.0.0"] : hosts;
}

function normalizeListenPort(value, fallback: any = DEFAULT_LISTEN_PORT) {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (fallback === null) throw new Error("监听端口不能为空");
    return normalizeListenPort(fallback, null);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("监听端口必须是 1-65535 的整数");
  return port;
}

function normalizeRuntimeSettings(value: any = {}, fallback: any = {}) {
  const hostsValue = value.listen_hosts !== undefined ? value.listen_hosts
    : (value.hosts !== undefined ? value.hosts : value.host);
  const portValue = value.listen_port !== undefined ? value.listen_port : value.port;
  return {
    schema_version: 2,
    listen_hosts: normalizeListenHosts(hostsValue, hostsValue === undefined ? (fallback.listen_hosts ?? DEFAULT_LISTEN_HOSTS) : null),
    listen_port: normalizeListenPort(portValue, portValue === undefined ? (fallback.listen_port ?? DEFAULT_LISTEN_PORT) : null),
    sftp_recycle_bin_enabled: value.sftp_recycle_bin_enabled === undefined
      ? fallback.sftp_recycle_bin_enabled === true
      : value.sftp_recycle_bin_enabled === true
  };
}

function readRuntimeSettings(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeRuntimeSettings(parsed);
  } catch {
    return normalizeRuntimeSettings();
  }
}

function writeRuntimeSettings(filePath, value) {
  const normalized = normalizeRuntimeSettings(value);
  const result = { ...normalized, updated_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(result, null, 2), "utf8");
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
  return result;
}

function resolveRuntimeSettings(filePath, env: any = process.env) {
  const persisted = readRuntimeSettings(filePath);
  let listenHosts = persisted.listen_hosts;
  let listenPort = persisted.listen_port;
  let hostsSource = fs.existsSync(filePath) ? "file" : "default";
  let portSource = hostsSource;
  const envHosts = String(env.TUNNEL_WEB_HOSTS || env.TUNNEL_WEB_HOST || "").trim();
  const envPort = String(env.TUNNEL_WEB_PORT || "").trim();
  if (envHosts) {
    listenHosts = normalizeListenHosts(envHosts, null);
    hostsSource = "env";
  }
  if (envPort) {
    listenPort = normalizeListenPort(envPort, null);
    portSource = "env";
  }
  return {
    listen_hosts: listenHosts,
    listen_port: listenPort,
    sources: { listen_hosts: hostsSource, listen_port: portSource }
  };
}

function isLoopbackHost(host) {
  const parts = String(host || "").split(".").map(Number);
  return parts.length === 4 && parts[0] === 127 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255);
}

function availableListenHosts(interfaces: any = os.networkInterfaces()) {
  const out: any[] = [
    { address: "127.0.0.1", interface: "loopback", label: "仅本机", internal: true },
    { address: "0.0.0.0", interface: "all", label: "所有 IPv4 网卡", wildcard: true, internal: false }
  ];
  const seen = new Set(out.map(item => item.address));
  for (const [name, items] of Object.entries(interfaces || {}) as any) {
    for (const item of items || []) {
      if (item.family !== "IPv4" || item.internal || seen.has(item.address)) continue;
      seen.add(item.address);
      out.push({ address: item.address, interface: name, label: `${name} · ${item.address}`, internal: false });
    }
  }
  return out;
}

module.exports = {
  DEFAULT_LISTEN_HOSTS,
  DEFAULT_LISTEN_PORT,
  MAX_PORT_FALLBACKS,
  availableListenHosts,
  isLoopbackHost,
  normalizeListenHosts,
  normalizeListenPort,
  normalizeRuntimeSettings,
  readRuntimeSettings,
  resolveRuntimeSettings,
  splitListenHosts,
  writeRuntimeSettings
};
