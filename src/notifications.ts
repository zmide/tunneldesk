const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR } = require("./config");
const { appendSystemLog } = require("./logs");

const NOTIFICATION_FILE = path.join(DATA_DIR, "notifications.json");
const STATE_FILE = path.join(DATA_DIR, "notification-state.json");
const MAX_EVENTS = 300;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

let seq = 0;
const lastSent = new Map();
const activeIssues = new Set(readJson(STATE_FILE, { active: [] }).active || []);

function readJson(file, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function readEvents() {
  const data = readJson(NOTIFICATION_FILE, { events: [] });
  return Array.isArray(data.events) ? data.events : [];
}

function writeEvents(events) {
  writeJson(NOTIFICATION_FILE, { events: events.slice(-MAX_EVENTS) });
}

function saveState() {
  writeJson(STATE_FILE, { active: [...activeIssues] });
}

function nextId() {
  seq = (seq + 1) % 100000;
  return Date.now() * 100000 + seq;
}

function addNotification(event) {
  const item = {
    id: nextId(),
    time: Date.now(),
    type: event.type || "system",
    level: event.level || "info",
    title: String(event.title || "TunnelDesk"),
    message: String(event.message || ""),
    key: event.key || "",
    action: event.action || null
  };
  const events = readEvents();
  events.push(item);
  writeEvents(events);
  appendSystemLog(`通知：${item.title}${item.message ? `：${item.message}` : ""}`);
  return item;
}

function notifyEvent(event, options: any = {}) {
  const key = event.key || `${event.type || "system"}:${event.title || ""}`;
  const cooldownMs = Number(options.cooldown_ms ?? event.cooldown_ms ?? DEFAULT_COOLDOWN_MS);
  const now = Date.now();
  const last = Number(lastSent.get(key) || 0);
  if (cooldownMs > 0 && now - last < cooldownMs) return null;
  lastSent.set(key, now);
  return addNotification({ ...event, key });
}

function notifyIssue(key, event, options: any = {}) {
  activeIssues.add(key);
  saveState();
  return notifyEvent({ ...event, key }, options);
}

function notifyRecovery(key, event, options: any = {}) {
  if (!activeIssues.has(key)) return null;
  activeIssues.delete(key);
  saveState();
  return notifyEvent({ level: "success", ...event, key: `${key}:recovered` }, { cooldown_ms: options.cooldown_ms ?? 0 });
}

function listNotifications(since = 0) {
  const minId = Number(since || 0);
  return readEvents().filter((event) => Number(event.id) > minId);
}

module.exports = {
  listNotifications,
  notifyEvent,
  notifyIssue,
  notifyRecovery
};
