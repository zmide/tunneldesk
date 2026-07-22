const crypto = require("node:crypto");
const { readSecuritySettings, verifySecret, writeSecuritySettings } = require("./security");

let activeKey = null;

function deriveKey(password, salt) {
  return crypto.scryptSync(String(password || ""), salt, 32);
}

function unlockEncryption(password) {
  const settings = readSecuritySettings();
  if (!settings.encryption_enabled) return { ok: true, enabled: false };
  if (!verifySecret(password, settings.encryption_check, settings.encryption_salt)) throw new Error("主密码不正确");
  activeKey = deriveKey(password, settings.encryption_salt);
  return { ok: true, enabled: true };
}

function enableEncryption(password) {
  const settings = readSecuritySettings();
  if (settings.encryption_enabled) throw new Error("配置加密已启用，请使用解锁或关闭");
  if (String(password || "").length < 8) throw new Error("主密码至少 8 位");
  const salt = crypto.randomBytes(16).toString("hex");
  const key = deriveKey(password, salt);
  const check = crypto.scryptSync(String(password), salt, 32).toString("hex");
  activeKey = key;
  writeSecuritySettings({ encryption_enabled: true, encryption_salt: salt, encryption_check: check });
  return { ok: true };
}

function disableEncryption() {
  activeKey = null;
  writeSecuritySettings({ encryption_enabled: false, encryption_salt: "", encryption_check: "" });
  return { ok: true };
}

function encryptionReady() {
  const settings = readSecuritySettings();
  return !settings.encryption_enabled || Boolean(activeKey);
}

function encryptText(value) {
  if (value == null || value === "") return value;
  const settings = readSecuritySettings();
  if (!settings.encryption_enabled) return value;
  if (!activeKey) throw new Error("配置加密已启用，请先解锁");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", activeKey, iv);
  const data = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `tdenc:v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${data.toString("base64url")}`;
}

function decryptText(value) {
  const text = String(value || "");
  if (!text.startsWith("tdenc:v1:")) return value;
  if (!activeKey) return "";
  const [, , ivText, tagText, dataText] = text.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", activeKey, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]).toString("utf8");
}

module.exports = {
  decryptText,
  disableEncryption,
  enableEncryption,
  encryptionReady,
  encryptText,
  unlockEncryption
};
