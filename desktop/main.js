const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, shell } = require("electron");

let startServer = null;
let shutdown = null;
let parseServerArgs = null;
let DATA_DIR = "";
let LOG_DIR = "";
let PROJECT_SSH_DIR = "";
let PID_FILE = "";
let WEB_URL_FILE = "";
let DEFAULT_HOST = "127.0.0.1";
let DEFAULT_PORT = 8088;
let SETTINGS_FILE = "";
let BOOT_SETTINGS_FILE = "";
let dataPath = "";
let sshPath = "";

let mainWindow = null;
let tray = null;
let webUrl = "";
let quitting = false;
let trayStateTimer = null;
let trayState = { runningConnections: 0, runningForwards: 0, failedForwards: 0, totalForwards: 0, online: false };
let pendingStorageMigrationNotice = "";

const APP_USER_MODEL_ID = "com.zmide.tunneldesk";
const TOAST_ACTIVATOR_CLSID = "{4BCB7691-AE54-4E32-B6D3-B22E3F4E3444}";
const START_IN_TRAY_ARG = "--start-in-tray";
const STORAGE_MIGRATION_VERSION = 1;
const TRANSIENT_DATA_FILES = new Set(["web.pid", "web.url", "web.json"]);

app.setName("TunnelDesk");
configureWindowsAppIdentity();

const singleInstanceLocked = app.requestSingleInstanceLock();
if (!singleInstanceLocked) {
  app.exit(0);
}

app.on("second-instance", () => {
  showWindow();
  notify("TunnelDesk 已在运行，已切换到现有窗口");
});

function configureWindowsAppIdentity() {
  if (process.platform !== "win32") return;
  app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : process.execPath);
  if (typeof app.setToastActivatorCLSID === "function") app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID);
}

function removeLegacyElectronShortcut() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  const shortcutPaths = [
    path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Electron.lnk"),
    path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs", "Electron.lnk")
  ];
  for (const shortcutPath of shortcutPaths) {
    try {
      const bytes = fs.existsSync(shortcutPath) ? fs.readFileSync(shortcutPath) : null;
      if (!bytes) continue;
      const text = bytes.toString("utf16le") + bytes.toString("utf8");
      if (/tunneldesk/i.test(text) && /electron\.exe/i.test(text)) fs.unlinkSync(shortcutPath);
    } catch (error) {
      console.warn(`failed to remove legacy shortcut ${shortcutPath}: ${error.message}`);
    }
  }
}

function iconPath(filename = process.platform === "win32" ? "icon.ico" : "icon.png") {
  return path.join(__dirname, "assets", filename);
}

function loadBackend() {
  const settings = prepareRuntimeSettings();
  const paths = resolveRuntimePaths(settings);
  dataPath = paths.dataDir;
  sshPath = paths.sshDir;
  process.env.TUNNELDESK_DATA_DIR = dataPath;
  process.env.TUNNELDESK_SSH_DIR = sshPath;
  ({ startServer, shutdown, parseArgs:parseServerArgs } = require("../dist/server"));
  ({ DATA_DIR, LOG_DIR, PROJECT_SSH_DIR, PID_FILE, WEB_URL_FILE, DEFAULT_HOST, DEFAULT_PORT } = require("../dist/config"));
}

function defaultDesktopSettings() {
  return {
    dataMode: app.isPackaged && !isWindowsPortable() ? "user" : "project",
    customDataDir: "",
    openAtLogin: false,
    minimizeToTray: true,
    startMinimizedToTray: false,
    showStartupNotification: true
  };
}

function readSettings() {
  try {
    return {
      ...defaultDesktopSettings(),
      ...JSON.parse(fs.readFileSync(SETTINGS_FILE || BOOT_SETTINGS_FILE, "utf8"))
    };
  } catch {
    return defaultDesktopSettings();
  }
}

function settingsExists() {
  try {
    return fs.existsSync(SETTINGS_FILE || BOOT_SETTINGS_FILE);
  } catch {
    return false;
  }
}

function writeSettings(settings) {
  const settingsFile = SETTINGS_FILE || BOOT_SETTINGS_FILE;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const temporaryFile = `${settingsFile}.tmp-${process.pid || "desktop"}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(settings, null, 2), "utf8");
    fs.renameSync(temporaryFile, settingsFile);
  } finally {
    try { fs.rmSync(temporaryFile, { force: true }); } catch {}
  }
}

function initializeDesktopSettingsFile() {
  BOOT_SETTINGS_FILE = path.join(app.getPath("userData"), "desktop-settings.json");
  SETTINGS_FILE = BOOT_SETTINGS_FILE;
  return SETTINGS_FILE;
}

function isWindowsPortable() {
  return app.isPackaged
    && process.platform === "win32"
    && Boolean(String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim());
}

function sourceProjectRoot() {
  return path.resolve(__dirname, "..");
}

function userRuntimeRoot() {
  return path.join(app.getPath("userData"), "runtime");
}

function legacyPackagedRoot() {
  return path.dirname(process.execPath);
}

function projectRuntimeRoot() {
  if (isWindowsPortable()) return path.resolve(process.env.PORTABLE_EXECUTABLE_DIR);
  if (!app.isPackaged) return sourceProjectRoot();
  return userRuntimeRoot();
}

function resolveRuntimePaths(settings) {
  const root = settings.dataMode === "custom" && settings.customDataDir
    ? path.resolve(settings.customDataDir)
    : settings.dataMode === "project" && (!app.isPackaged || isWindowsPortable())
      ? projectRuntimeRoot()
      : userRuntimeRoot();
  return {
    dataDir: path.join(root, "data"),
    sshDir: path.join(root, ".ssh")
  };
}

function directoryHasPersistentFiles(directory, ignoredNames = null) {
  if (!fs.existsSync(directory)) return false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredNames?.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (directoryHasPersistentFiles(fullPath)) return true;
    } else {
      return true;
    }
  }
  return false;
}

function runtimeHasPersistentData(root) {
  return directoryHasPersistentFiles(path.join(root, "data"), TRANSIENT_DATA_FILES)
    || directoryHasPersistentFiles(path.join(root, ".ssh"));
}

function copyRuntimeDirectory(sourceRoot, destinationRoot) {
  const sourceData = path.join(sourceRoot, "data");
  const sourceSsh = path.join(sourceRoot, ".ssh");
  fs.mkdirSync(destinationRoot, { recursive: true });
  if (fs.existsSync(sourceData)) {
    fs.cpSync(sourceData, path.join(destinationRoot, "data"), {
      recursive: true,
      filter: source => {
        const relative = path.relative(sourceData, source);
        if (!relative) return true;
        return !TRANSIENT_DATA_FILES.has(relative.split(path.sep)[0]);
      }
    });
  }
  if (fs.existsSync(sourceSsh)) fs.cpSync(sourceSsh, path.join(destinationRoot, ".ssh"), { recursive: true });
}

function uniqueMigrationPath(parent, prefix) {
  const base = path.join(parent, `${prefix}-${timestampName()}`);
  let candidate = base;
  let suffix = 2;
  while (fs.existsSync(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function migrateLegacyPackagedRuntime(settings) {
  if (!app.isPackaged || isWindowsPortable() || settings.dataMode !== "project") return settings;

  const sourceRoot = legacyPackagedRoot();
  const targetRoot = userRuntimeRoot();
  const sourceHasData = runtimeHasPersistentData(sourceRoot);
  const targetHasData = runtimeHasPersistentData(targetRoot);
  const migratedAt = new Date().toISOString();
  let status = "switched-to-user-runtime";
  let backupRoot = "";

  if (sourceHasData && targetHasData) {
    backupRoot = uniqueMigrationPath(app.getPath("userData"), "migration-conflict-backup");
    try {
      copyRuntimeDirectory(sourceRoot, backupRoot);
    } catch (error) {
      try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch {}
      throw error;
    }
    status = "conflict-backed-up";
    pendingStorageMigrationNotice = `检测到旧程序目录和用户目录中都有 TunnelDesk 数据。现继续使用用户目录，旧程序数据已完整备份到：${backupRoot}`;
  } else if (sourceHasData) {
    const stagingRoot = uniqueMigrationPath(app.getPath("userData"), "runtime-migration-staging");
    try {
      copyRuntimeDirectory(sourceRoot, stagingRoot);
      if (fs.existsSync(targetRoot)) fs.rmSync(targetRoot, { recursive: true, force: true });
      fs.renameSync(stagingRoot, targetRoot);
    } catch (error) {
      try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch {}
      throw error;
    }
    status = "migrated";
    pendingStorageMigrationNotice = `TunnelDesk 数据已从旧程序目录迁移到用户目录：${targetRoot}。旧目录仍保留，可用于回滚。`;
  }

  const migratedSettings = {
    ...settings,
    dataMode: "user",
    storageMigrationVersion: STORAGE_MIGRATION_VERSION,
    lastStorageMigration: {
      status,
      migratedAt,
      sourceRoot,
      targetRoot,
      backupRoot
    }
  };
  writeSettings(migratedSettings);
  return migratedSettings;
}

function prepareRuntimeSettings() {
  return migrateLegacyPackagedRuntime(readSettings());
}

function applyLoginSetting(settings) {
  if (!app.isPackaged && process.platform !== "darwin") return;
  const loginSettings = {
    openAtLogin: Boolean(settings.openAtLogin),
    path: process.execPath
  };
  if (process.platform === "win32") {
    loginSettings.args = settings.startMinimizedToTray ? [START_IN_TRAY_ARG] : [];
  }
  app.setLoginItemSettings(loginSettings);
}

function shouldStartInTray(settings) {
  if (!settings.startMinimizedToTray) return false;
  if (process.argv.includes(START_IN_TRAY_ARG)) return true;
  if (process.platform !== "darwin") return false;
  try {
    return Boolean(app.getLoginItemSettings().wasOpenedAtLogin);
  } catch {
    return false;
  }
}

function relaunchInForeground() {
  app.relaunch({ args: process.argv.slice(1).filter(arg => arg !== START_IN_TRAY_ARG) });
}

function readWebUrl() {
  try {
    return fs.readFileSync(WEB_URL_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

async function waitForWebUrl(timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const url = readWebUrl();
    if (url) return url;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Web 服务已经启动，但 ${WEB_URL_FILE} 未在 ${Math.round(timeoutMs / 1000)} 秒内生成`);
}

function createWindow(options = {}) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    title: "TunnelDesk",
    icon: iconPath(),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (process.platform === "win32") {
    mainWindow.setAppDetails({
      appId: "com.zmide.tunneldesk",
      appIconPath: iconPath("icon.ico"),
      appIconIndex: 0,
      relaunchDisplayName: "TunnelDesk"
    });
  }
  if (options.openDesktopSettings) {
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow.webContents.executeJavaScript('openSettingsSection("settings-runtime")').catch(() => {});
    });
  }
  mainWindow.loadURL(webUrl);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.once("ready-to-show", () => {
    const settings = readSettings();
    if (shouldStartInTray(settings)) mainWindow.hide();
    else mainWindow.show();
  });
  mainWindow.on("close", event => {
    if (quitting || !readSettings().minimizeToTray) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function trayIcon() {
  const source = nativeImage.createFromPath(iconPath("icon.png"));
  const image = process.platform === "darwin"
    ? source.resize({ width: 18, height: 18, quality: "best" })
    : source;
  image.setTemplateImage(false);
  return image;
}

async function fetchJson(pathname, options = {}) {
  const res = await fetch(`${webUrl}${pathname}`, options);
  if (!res.ok) throw new Error(await res.text() || res.statusText);
  return res.json();
}

async function updateTrayState() {
  if (!webUrl) return;
  const connections = await fetchJson("/api/connections");
  const forwards = connections.flatMap(connection => connection.forwards || []);
  trayState = {
    runningConnections: connections.filter(connection => (connection.forwards || []).some(forward => forward.status === "running")).length,
    runningForwards: forwards.filter(forward => forward.status === "running").length,
    failedForwards: forwards.filter(forward => forward.status === "failed").length,
    totalForwards: forwards.length,
    online: true
  };
  if (tray) {
    const failed = trayState.failedForwards ? `，异常 ${trayState.failedForwards} 条` : "";
    tray.setToolTip(`TunnelDesk：正在转发 ${trayState.runningForwards}/${trayState.totalForwards} 条${failed}`);
    refreshTrayMenu();
  }
}

async function startAllForwards() {
  const connections = await fetchJson("/api/connections");
  for (const connection of connections.filter(item => (item.forwards || []).length)) {
    await fetchJson(`/api/connections/${connection.id}/start-forwards`, { method: "POST" });
  }
  await updateTrayState().catch(() => {});
  notify("已启动全部连接转发");
}

async function stopAllConnectionForwards() {
  const connections = await fetchJson("/api/connections");
  for (const connection of connections.filter(item => (item.forwards || []).some(forward => forward.status === "running"))) {
    await fetchJson(`/api/connections/${connection.id}/stop-forwards`, { method: "POST" });
  }
  await updateTrayState().catch(() => {});
  notify("已停止全部连接转发");
}

function notify(body) {
  if (process.platform === "win32" && tray && typeof tray.displayBalloon === "function") {
    tray.displayBalloon({
      title: "TunnelDesk",
      content: body,
      icon: nativeImage.createFromPath(iconPath("icon.ico")),
      largeIcon: true
    });
    return;
  }
  if (Notification.isSupported()) new Notification({ title: "TunnelDesk", body, icon: iconPath("icon.png") }).show();
}

function buildAppMenu() {
  const settings = readSettings();
  const template = [
    {
      label: "开始",
      submenu: [
        { label: "在浏览器打开", click: () => shell.openExternal(webUrl) },
        { type: "separator" },
        { label: "打开 .ssh 目录", click: () => shell.openPath(PROJECT_SSH_DIR) },
        { label: "打开日志目录", click: () => shell.openPath(LOG_DIR) },
        { label: "导出日志", click: exportLogs },
        { type: "separator" },
        { label: "退出 TunnelDesk", click: quitApp }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  applyLoginSetting(settings);
}

function createTray() {
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip("TunnelDesk");
    tray.on("double-click", showWindow);
    refreshTrayMenu();
  } catch (error) {
    console.warn(`tray unavailable: ${error.message}`);
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  const statusLabel = trayState.online
    ? `正在转发：${trayState.runningForwards}/${trayState.totalForwards} 条，连接 ${trayState.runningConnections} 个${trayState.failedForwards ? `，异常 ${trayState.failedForwards} 条` : ""}`
    : "正在转发：状态读取中";
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 TunnelDesk", click: showWindow },
    { label: "在浏览器打开", click: () => shell.openExternal(webUrl) },
    { label: statusLabel, enabled: false },
    { type: "separator" },
    { label: "启动全部转发", click: () => startAllForwards().catch(showError) },
    { label: "停止全部转发", click: () => stopAllConnectionForwards().catch(showError) },
    { type: "separator" },
    { label: "打开 .ssh 目录", click: () => shell.openPath(PROJECT_SSH_DIR) },
    { label: "打开日志目录", click: () => shell.openPath(LOG_DIR) },
    { label: "导出日志", click: exportLogs },
    { type: "separator" },
    { label: "退出 TunnelDesk", click: quitApp }
  ]));
}

function showError(error) {
  dialog.showErrorBox("TunnelDesk", error.message || String(error));
}

async function exportLogs() {
  try {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: "选择日志导出目录",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return;
    const target = path.join(result.filePaths[0], `tunneldesk-logs-${timestampName()}`);
    fs.mkdirSync(target, { recursive: true });
    if (fs.existsSync(LOG_DIR)) fs.cpSync(LOG_DIR, target, { recursive: true });
    notify("日志已导出");
    shell.openPath(target);
  } catch (error) {
    showError(error);
  }
}

function timestampName() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function desktopSettingsView() {
  const settings = readSettings();
  const paths = resolveRuntimePaths(settings);
  return {
    settings,
    paths,
    project_mode_available: !app.isPackaged || isWindowsPortable(),
    project_mode_label: isWindowsPortable() ? "便携程序所在文件夹" : "项目所在文件夹"
  };
}

function normalizeDesktopSettings(value) {
  const current = readSettings();
  const projectModeAvailable = !app.isPackaged || isWindowsPortable();
  const requestedMode = String(value?.dataMode || current.dataMode);
  const allowedModes = new Set(projectModeAvailable ? ["project", "user", "custom"] : ["user", "custom"]);
  if (!allowedModes.has(requestedMode)) throw new Error("数据路径模式无效");
  const customDataDir = String(value?.customDataDir || "").trim();
  if (requestedMode === "custom" && !customDataDir) throw new Error("请选择自定义数据根目录");
  if (customDataDir.includes("\0")) throw new Error("自定义数据目录无效");
  return {
    ...current,
    dataMode: requestedMode,
    customDataDir: customDataDir ? path.resolve(customDataDir) : "",
    openAtLogin: Boolean(value?.openAtLogin),
    minimizeToTray: Boolean(value?.minimizeToTray),
    startMinimizedToTray: Boolean(value?.startMinimizedToTray),
    showStartupNotification: Boolean(value?.showStartupNotification)
  };
}

function saveDesktopSettings(value) {
  const settings = normalizeDesktopSettings(value);
  writeSettings(settings);
  applyLoginSetting(settings);
  setTimeout(async () => {
    quitting = true;
    try { await Promise.resolve(shutdown()); } catch (error) { console.error(error); }
    relaunchInForeground();
    app.exit(0);
  }, 500);
  return { ok:true, restart_required:true };
}

async function chooseDesktopDataDir() {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: "选择 TunnelDesk 数据根目录",
    properties: ["openDirectory", "createDirectory"]
  });
  return result.canceled ? "" : result.filePaths[0];
}

function validatedUpdatePackagePath(file) {
  const target = path.resolve(String(file || ""));
  const updateRoot = path.resolve(path.join(DATA_DIR, "updates"));
  const relative = path.relative(updateRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(target)) {
    throw new Error("更新安装包路径无效");
  }
  const supported = process.platform === "win32"
    ? /\.exe$/i
    : process.platform === "darwin"
      ? /\.(?:dmg|zip)$/i
      : /\.(?:appimage|deb|rpm)$/i;
  if (!supported.test(target)) throw new Error("更新安装包类型与当前系统不匹配");
  return target;
}

async function openUpdatePackage(file) {
  const target = validatedUpdatePackagePath(file);
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return { ok:true };
}

async function openUpdateDirectory(file) {
  const target = validatedUpdatePackagePath(file);
  shell.showItemInFolder(target);
  return { ok:true };
}

function quitApp() {
  quitting = true;
  if (trayStateTimer) clearInterval(trayStateTimer);
  try {
    shutdown();
  } catch (error) {
    console.error(error);
  }
  setTimeout(() => app.quit(), 300);
}

app.whenReady().then(async () => {
  configureWindowsAppIdentity();
  removeLegacyElectronShortcut();
  initializeDesktopSettingsFile();
  const firstRun = !settingsExists();
  loadBackend();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PROJECT_SSH_DIR, { recursive: true });
  try {
    const desktopServerArgs = { ...parseServerArgs(), pidFile:PID_FILE };
    const backend = startServer(desktopServerArgs, {
      exitOnShutdown: false,
      onShutdown: () => {
        quitting = true;
        if (trayStateTimer) clearInterval(trayStateTimer);
        trayStateTimer = null;
        setTimeout(() => app.quit(), 0);
      },
      desktopIntegration: {
        getSettings: desktopSettingsView,
        saveSettings: saveDesktopSettings,
        chooseDataDir: chooseDesktopDataDir,
        openUpdatePackage,
        openUpdateDirectory
      }
    });
    if (backend?.ready && typeof backend.ready.then === "function") await backend.ready;
    webUrl = await waitForWebUrl();
  } catch (error) {
    const message = error?.code === "TUNNELDESK_ALREADY_RUNNING"
      ? `${error.message}\n\n请使用已经打开的 TunnelDesk 窗口，或先停止已有无界面服务。`
      : (error?.message || String(error));
    dialog.showErrorBox("TunnelDesk 启动失败", message);
    quitting = true;
    app.exit(1);
    return;
  }
  buildAppMenu();
  createTray();
  createWindow({ openDesktopSettings:firstRun });
  if (pendingStorageMigrationNotice) setTimeout(() => notify(pendingStorageMigrationNotice), 1200);
  updateTrayState().catch(() => {});
  trayStateTimer = setInterval(() => updateTrayState().catch(() => {}), 10000);
  const settings = readSettings();
  if (settings.showStartupNotification) {
    setTimeout(async () => {
      try {
        const status = await fetchJson("/api/startup-status");
        const success = Number(status.autostart?.ok || 0) + Number(status.restore?.ok || 0);
        const failed = Number(status.autostart?.failed || 0) + Number(status.restore?.failed || 0);
        notify(`管理界面：${webUrl}\n转发启动：成功 ${success}，失败 ${failed}${failed ? "；详情请查看系统日志" : ""}`);
      } catch {
        notify(`管理界面已启动：${webUrl}`);
      }
    }, 2200);
  }
});

app.on("activate", showWindow);

app.on("before-quit", () => {
  quitting = true;
});
