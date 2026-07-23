const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { DATA_DIR } = require("./config");
const { LoginRateLimiter, SessionStore } = require("./auth-protection");

const SECURITY_FILE = path.join(DATA_DIR, "security.json");
const DEFAULT_SESSION_TTL_MINUTES = 12 * 60;
const DEFAULT_SESSION_MAX_SESSIONS = 1000;
const DEFAULT_SESSION_CLEANUP_MINUTES = 10;
const SESSION_LIMITS = {
  ttl_minutes: { min:5, max:30 * 24 * 60 },
  max_sessions: { min:1, max:10000 },
  cleanup_minutes: { min:1, max:24 * 60 }
};
const sessions = new SessionStore({
  ttlMs: DEFAULT_SESSION_TTL_MINUTES * 60 * 1000,
  maxSessions: DEFAULT_SESSION_MAX_SESSIONS
});
const loginLimiter = new LoginRateLimiter();
let securityCleanupTimer: ReturnType<typeof setInterval> | null = null;
let securityCleanupIntervalMs = 0;

class AuthenticationError extends Error {
  statusCode: number;
  retryAfterSeconds: number;

  constructor(message, statusCode = 401, retryAfterSeconds = 0) {
    super(message);
    this.name = "AuthenticationError";
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

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
    secure_cookie_mode: "auto",
    trusted_proxy_enabled: false,
    trusted_proxy_addresses: [],
    session_ttl_minutes: DEFAULT_SESSION_TTL_MINUTES,
    session_max_sessions: DEFAULT_SESSION_MAX_SESSIONS,
    session_cleanup_minutes: DEFAULT_SESSION_CLEANUP_MINUTES,
    updated_at: Date.now()
  };
}

function normalizeBoundedInteger(value, fallback, limits) {
  const number = Number(value);
  return Number.isInteger(number) && number >= limits.min && number <= limits.max ? number : fallback;
}

function requireBoundedInteger(value, label, limits) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < limits.min || number > limits.max) {
    throw new Error(`${label}必须是 ${limits.min}-${limits.max} 之间的整数`);
  }
  return number;
}

function normalizeTrustedProxyAddresses(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/);
  return [...new Set(items.map(normalizeSocketAddress).filter(item => net.isIP(item)))].slice(0, 32);
}

function readSecuritySettings() {
  try {
    const stored = JSON.parse(fs.readFileSync(SECURITY_FILE, "utf8"));
    return {
      ...defaultSettings(),
      ...stored,
      secure_cookie_mode: ["auto", "always", "never"].includes(String(stored?.secure_cookie_mode)) ? String(stored.secure_cookie_mode) : "auto",
      trusted_proxy_addresses: normalizeTrustedProxyAddresses(stored?.trusted_proxy_addresses),
      session_ttl_minutes: normalizeBoundedInteger(stored?.session_ttl_minutes, DEFAULT_SESSION_TTL_MINUTES, SESSION_LIMITS.ttl_minutes),
      session_max_sessions: normalizeBoundedInteger(stored?.session_max_sessions, DEFAULT_SESSION_MAX_SESSIONS, SESSION_LIMITS.max_sessions),
      session_cleanup_minutes: normalizeBoundedInteger(stored?.session_cleanup_minutes, DEFAULT_SESSION_CLEANUP_MINUTES, SESSION_LIMITS.cleanup_minutes)
    };
  } catch {
    return defaultSettings();
  }
}

function publicSecuritySettings(req = null) {
  const settings = readSecuritySettings();
  sessions.cleanup();
  return {
    auth_mode: settings.auth_mode,
    lan_auth_enabled: Boolean(settings.lan_auth_enabled),
    allow_disable_lan_auth: Boolean(settings.allow_disable_lan_auth),
    password_set: Boolean(settings.password_hash),
    token_set: Boolean(settings.token_hash),
    encryption_enabled: Boolean(settings.encryption_enabled),
    notification_mode: ["on", "muted", "off"].includes(String(settings.notification_mode)) ? settings.notification_mode : "on",
    secure_cookie_mode: settings.secure_cookie_mode,
    trusted_proxy_enabled: Boolean(settings.trusted_proxy_enabled),
    trusted_proxy_addresses: settings.trusted_proxy_addresses,
    login_protection: {
      max_failures: loginLimiter.options.maxFailures,
      window_seconds: Math.floor(loginLimiter.options.windowMs / 1000),
      lock_seconds: Math.floor(loginLimiter.options.lockMs / 1000)
    },
    session_management: {
      ttl_minutes: settings.session_ttl_minutes,
      max_sessions: settings.session_max_sessions,
      cleanup_minutes: settings.session_cleanup_minutes,
      limits: SESSION_LIMITS
    },
    active_sessions: sessions.size(),
    auth_required: req ? authRequired(req) : null,
    request_secure: req ? isRequestSecure(req) : null
  };
}

function writeSecuritySettings(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const merged = { ...readSecuritySettings(), ...next, updated_at: Date.now() };
  fs.writeFileSync(SECURITY_FILE, JSON.stringify(merged, null, 2));
  applySessionManagementSettings(merged);
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
  sessions.clear();
  loginLimiter.clear();
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
  if (["auto", "always", "never"].includes(String(data.secure_cookie_mode || ""))) next.secure_cookie_mode = String(data.secure_cookie_mode);
  if (typeof data.trusted_proxy_enabled !== "undefined") next.trusted_proxy_enabled = Boolean(data.trusted_proxy_enabled);
  if (typeof data.trusted_proxy_addresses !== "undefined") next.trusted_proxy_addresses = normalizeTrustedProxyAddresses(data.trusted_proxy_addresses);
  if (typeof data.session_ttl_minutes !== "undefined") {
    next.session_ttl_minutes = requireBoundedInteger(data.session_ttl_minutes, "会话有效期", SESSION_LIMITS.ttl_minutes);
  }
  if (typeof data.session_max_sessions !== "undefined") {
    next.session_max_sessions = requireBoundedInteger(data.session_max_sessions, "最大会话数", SESSION_LIMITS.max_sessions);
  }
  if (typeof data.session_cleanup_minutes !== "undefined") {
    next.session_cleanup_minutes = requireBoundedInteger(data.session_cleanup_minutes, "清理间隔", SESSION_LIMITS.cleanup_minutes);
  }
  const merged = { ...readSecuritySettings(), ...next };
  if (merged.trusted_proxy_enabled && !merged.trusted_proxy_addresses.length) {
    throw new Error("启用可信反向代理前至少填写一个代理 IP 地址");
  }
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
    token_salt: "",
    secure_cookie_mode: "auto",
    trusted_proxy_enabled: false,
    trusted_proxy_addresses: [],
    session_ttl_minutes: DEFAULT_SESSION_TTL_MINUTES,
    session_max_sessions: DEFAULT_SESSION_MAX_SESSIONS,
    session_cleanup_minutes: DEFAULT_SESSION_CLEANUP_MINUTES
  });
  sessions.clear();
  loginLimiter.clear();
}

function normalizeSocketAddress(value) {
  const address = String(value || "").trim().toLowerCase().split("%")[0];
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

function isTrustedProxyRequest(req, settings = readSecuritySettings()) {
  if (!settings.trusted_proxy_enabled) return false;
  const remote = normalizeSocketAddress(req.socket.remoteAddress);
  return settings.trusted_proxy_addresses.includes(remote);
}

function requestSourceAddress(req) {
  const settings = readSecuritySettings();
  if (isTrustedProxyRequest(req, settings)) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map(item => normalizeSocketAddress(item)).find(item => net.isIP(item));
    if (forwarded) return forwarded;
  }
  return normalizeSocketAddress(req.socket.remoteAddress) || "unknown";
}

function isRequestSecure(req) {
  const settings = readSecuritySettings();
  if (settings.secure_cookie_mode === "always") return true;
  if (settings.secure_cookie_mode === "never") return false;
  if (req.socket?.encrypted) return true;
  if (!isTrustedProxyRequest(req, settings)) return false;
  return String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase() === "https";
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
    try {
      out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {}
  }
  return out;
}

function sessionFromRequest(req) {
  const token = parseCookies(req.headers.cookie || "").td_session;
  if (!token) return null;
  return sessions.get(token);
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

function login(password, req) {
  const source = requestSourceAddress(req);
  const check = loginLimiter.check(source);
  if (!check.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil(check.retryAfterMs / 1000));
    throw new AuthenticationError(`登录尝试过多，请在 ${retryAfterSeconds} 秒后重试`, 429, retryAfterSeconds);
  }
  const settings = readSecuritySettings();
  if (!settings.password_hash) throw new AuthenticationError("尚未设置 Web 密码", 400);
  if (!verifySecret(password, settings.password_hash, settings.password_salt)) {
    const result = loginLimiter.recordFailure(source);
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      throw new AuthenticationError(`密码不正确，登录已暂时锁定 ${retryAfterSeconds} 秒`, 429, retryAfterSeconds);
    }
    throw new AuthenticationError("密码不正确", 401);
  }
  loginLimiter.recordSuccess(source);
  return sessions.create();
}

function createSession() {
  return sessions.create();
}

function logout(req) {
  const token = parseCookies(req.headers.cookie || "").td_session;
  if (token) sessions.delete(token);
}

function sessionCookie(req, token, maxAge = null) {
  const secure = isRequestSecure(req) ? "; Secure" : "";
  const effectiveMaxAge = maxAge === null || typeof maxAge === "undefined"
    ? Math.floor(sessions.options.ttlMs / 1000)
    : Math.max(0, Number(maxAge) || 0);
  return `td_session=${encodeURIComponent(token || "")}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${effectiveMaxAge}${secure}`;
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

function securityDiagnostics() {
  return {
    sessions: sessions.size(),
    login_sources: loginLimiter.size()
  };
}

function applySessionManagementSettings(settings) {
  sessions.configure({
    ttlMs: normalizeBoundedInteger(settings?.session_ttl_minutes, DEFAULT_SESSION_TTL_MINUTES, SESSION_LIMITS.ttl_minutes) * 60 * 1000,
    maxSessions: normalizeBoundedInteger(settings?.session_max_sessions, DEFAULT_SESSION_MAX_SESSIONS, SESSION_LIMITS.max_sessions)
  });
  const intervalMs = normalizeBoundedInteger(
    settings?.session_cleanup_minutes,
    DEFAULT_SESSION_CLEANUP_MINUTES,
    SESSION_LIMITS.cleanup_minutes
  ) * 60 * 1000;
  if (securityCleanupTimer && intervalMs === securityCleanupIntervalMs) return;
  if (securityCleanupTimer) clearInterval(securityCleanupTimer);
  securityCleanupIntervalMs = intervalMs;
  securityCleanupTimer = setInterval(() => {
    sessions.cleanup();
    loginLimiter.cleanup();
  }, intervalMs);
  securityCleanupTimer.unref?.();
}

applySessionManagementSettings(readSecuritySettings());

module.exports = {
  AuthenticationError,
  authRequired,
  createSession,
  isAuthenticated,
  isLocalRequest,
  isRequestSecure,
  login,
  logout,
  publicSecuritySettings,
  readSecuritySettings,
  requestSourceAddress,
  resetWebAccessSecurity,
  sameOrigin,
  secureHeaders,
  securityDiagnostics,
  sessionCookie,
  setPassword,
  setToken,
  updateSecurityOptions,
  verifySecret,
  writeSecuritySettings
};
