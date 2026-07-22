const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { DATA_DIR } = require("./config");

const SECURITY_FILE = path.join(DATA_DIR, "security.json");
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

function defaultSettings() {
  return {
    auth_mode: "lan",
    lan_auth_enabled: true,
    allow_disable_lan_auth: false,
    password_hash: "",
    password_salt: "",
    token_hash: "",
    token_salt: "",
    encryption_enabled: false,
    encryption_salt: "",
    encryption_check: "",
    notification_mode: "on",
    updated_at: Date.now()
  };
}

function readSecuritySettings() {
  try {
    return { ...defaultSettings(), ...JSON.parse(fs.readFileSync(SECURITY_FILE, "utf8")) };
  } catch {
    return defaultSettings();
  }
}

function publicSecuritySettings(req = null) {
  const settings = readSecuritySettings();
  return {
    auth_mode: settings.auth_mode,
    lan_auth_enabled: Boolean(settings.lan_auth_enabled),
    allow_disable_lan_auth: Boolean(settings.allow_disable_lan_auth),
    password_set: Boolean(settings.password_hash),
    token_set: Boolean(settings.token_hash),
    encryption_enabled: Boolean(settings.encryption_enabled),
    notification_mode: ["on", "muted", "off"].includes(String(settings.notification_mode)) ? settings.notification_mode : "on",
    auth_required: req ? authRequired(req) : null
  };
}

function writeSecuritySettings(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SECURITY_FILE, JSON.stringify({ ...readSecuritySettings(), ...next, updated_at: Date.now() }, null, 2));
}

function hashSecret(secret, salt = crypto.randomBytes(16).toString("hex")) {
  if (!String(secret || "")) throw new Error("密码不能为空");
  const hash = crypto.scryptSync(String(secret), salt, 32).toString("hex");
  return { salt, hash };
}

function verifySecret(secret, hash, salt) {
  if (!secret || !hash || !salt) return false;
  const actual = crypto.scryptSync(String(secret), salt, 32);
  const expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function setPassword(password) {
  if (String(password || "").length < 8) throw new Error("密码至少 8 位");
  const item = hashSecret(password);
  writeSecuritySettings({ password_hash: item.hash, password_salt: item.salt });
}

function setToken(token = crypto.randomBytes(32).toString("base64url")) {
  const item = hashSecret(token);
  writeSecuritySettings({ token_hash: item.hash, token_salt: item.salt });
  return token;
}

function updateSecurityOptions(data) {
  const next: any = {};
  if (["lan", "always", "off"].includes(String(data.auth_mode || ""))) next.auth_mode = String(data.auth_mode);
  if (typeof data.lan_auth_enabled !== "undefined") next.lan_auth_enabled = Boolean(data.lan_auth_enabled);
  if (typeof data.allow_disable_lan_auth !== "undefined") next.allow_disable_lan_auth = Boolean(data.allow_disable_lan_auth);
  if (["on", "muted", "off"].includes(String(data.notification_mode || ""))) next.notification_mode = String(data.notification_mode);
  if (next.auth_mode === "off" || next.lan_auth_enabled === false) {
    if (!data.confirm_unsafe) throw new Error("关闭局域网密码需要确认风险");
  }
  writeSecuritySettings(next);
  return publicSecuritySettings();
}

function resetWebAccessSecurity() {
  writeSecuritySettings({
    auth_mode: "lan",
    lan_auth_enabled: true,
    allow_disable_lan_auth: false,
    password_hash: "",
    password_salt: "",
    token_hash: "",
    token_salt: ""
  });
}

function normalizeSocketAddress(value) {
  const address = String(value || "").toLowerCase().split("%")[0];
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function isLoopbackAddress(value) {
  const address = normalizeSocketAddress(value);
  if (address === "::1") return true;
  if (net.isIP(address) !== 4) return false;
  return Number(address.split(".")[0]) === 127;
}

function isLocalRequest(req) {
  return isLoopbackAddress(req.socket.remoteAddress);
}

function isLanListening(req) {
  const address = normalizeSocketAddress(req.socket.localAddress);
  return Boolean(address) && !isLoopbackAddress(address);
}

function authRequired(req) {
  const settings = readSecuritySettings();
  if (settings.auth_mode === "off") return false;
  if (settings.auth_mode === "always") return true;
  return Boolean(settings.lan_auth_enabled) && (isLanListening(req) || !isLocalRequest(req));
}

function parseCookies(header) {
  const out: any = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function sessionFromRequest(req) {
  const token = parseCookies(req.headers.cookie || "").td_session;
  if (!token) return null;
  const item = sessions.get(token);
  if (!item || item.expires_at < Date.now()) {
    sessions.delete(token);
    return null;
  }
  item.expires_at = Date.now() + SESSION_TTL_MS;
  return item;
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function isAuthenticated(req) {
  if (!authRequired(req)) return true;
  const settings = readSecuritySettings();
  if (sessionFromRequest(req)) return true;
  const envToken = process.env.TUNNELDESK_AUTH_TOKEN || "";
  const provided = bearerToken(req) || String(req.headers["x-tunneldesk-token"] || "");
  if (envToken && provided) {
    const a = Buffer.from(provided);
    const b = Buffer.from(envToken);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  if (provided && verifySecret(provided, settings.token_hash, settings.token_salt)) return true;
  return false;
}

function login(password) {
  const settings = readSecuritySettings();
  if (!settings.password_hash) throw new Error("尚未设置 Web 密码");
  if (!verifySecret(password, settings.password_hash, settings.password_salt)) throw new Error("密码不正确");
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, { created_at: Date.now(), expires_at: Date.now() + SESSION_TTL_MS });
  return token;
}

function logout(req) {
  const token = parseCookies(req.headers.cookie || "").td_session;
  if (token) sessions.delete(token);
}

function sameOrigin(req) {
  const method = String(req.method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  try {
    return new URL(String(origin)).host === host;
  } catch {
    return false;
  }
}

function secureHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    ...extra
  };
}

module.exports = {
  authRequired,
  isAuthenticated,
  isLocalRequest,
  login,
  logout,
  publicSecuritySettings,
  readSecuritySettings,
  resetWebAccessSecurity,
  sameOrigin,
  secureHeaders,
  setPassword,
  setToken,
  updateSecurityOptions,
  verifySecret,
  writeSecuritySettings
};
