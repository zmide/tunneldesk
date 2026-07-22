const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const desktopMainPath = path.join(root, "desktop", "main.js");
const desktopMainSource = fs.readFileSync(desktopMainPath, "utf8");
const readyMarker = "app.whenReady().then";
const readyIndex = desktopMainSource.indexOf(readyMarker);

assert.notEqual(readyIndex, -1, "desktop/main.js must contain the app.whenReady startup block");

const testableSource = `${desktopMainSource.slice(0, readyIndex)}
globalThis.__desktopStartupTestApi = {
  START_IN_TRAY_ARG,
  applyLoginSetting,
  shouldStartInTray,
  relaunchInForeground,
  createWindow,
  buildAppMenu,
  initializeDesktopSettingsFile,
  isWindowsPortable,
  userRuntimeRoot,
  legacyPackagedRoot,
  resolveRuntimePaths,
  prepareRuntimeSettings,
  desktopSettingsView,
  normalizeDesktopSettings,
  getPendingStorageMigrationNotice: () => pendingStorageMigrationNotice
};`;

const temporaryRoots = [];
process.on("exit", () => {
  for (const directory of temporaryRoots) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});

function createHarness({
  platform = "win32",
  argv = null,
  settings = { startMinimizedToTray: true },
  isPackaged = true,
  wasOpenedAtLogin = false,
  env = {},
  persistSettings = true
} = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunneldesk-desktop-check-"));
  temporaryRoots.push(temporaryRoot);
  const userData = path.join(temporaryRoot, "user-data");
  const defaultExecPath = platform === "darwin"
    ? path.join(temporaryRoot, "Applications", "TunnelDesk.app", "Contents", "MacOS", "TunnelDesk")
    : path.join(temporaryRoot, "installed", platform === "win32" ? "TunnelDesk.exe" : "tunneldesk");
  const processArgv = argv || [defaultExecPath];
  fs.mkdirSync(path.dirname(processArgv[0]), { recursive: true });
  const state = {
    loginSettings: [],
    relaunchOptions: [],
    windows: [],
    temporaryRoot,
    userData,
    execPath: processArgv[0],
    settingsFile: path.join(userData, "desktop-settings.json")
  };

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.visible = false;
      this.showCount = 0;
      this.hideCount = 0;
      this.onceHandlers = new Map();
      this.handlers = new Map();
      this.webContents = {
        setWindowOpenHandler: handler => {
          this.windowOpenHandler = handler;
        }
      };
      state.windows.push(this);
    }

    setAppDetails(details) {
      this.appDetails = details;
    }

    loadURL(url) {
      this.loadedUrl = url;
    }

    once(event, handler) {
      this.onceHandlers.set(event, handler);
    }

    on(event, handler) {
      this.handlers.set(event, handler);
    }

    emitOnce(event) {
      const handler = this.onceHandlers.get(event);
      assert.ok(handler, `missing ${event} handler`);
      this.onceHandlers.delete(event);
      handler();
    }

    show() {
      this.visible = true;
      this.showCount += 1;
    }

    hide() {
      this.visible = false;
      this.hideCount += 1;
    }

    isDestroyed() {
      return false;
    }
  }

  const app = {
    isPackaged,
    setName() {},
    setAppUserModelId() {},
    setToastActivatorCLSID() {},
    requestSingleInstanceLock: () => true,
    on() {},
    exit() {},
    getPath: name => name === "userData" ? userData : path.join(temporaryRoot, name),
    getLoginItemSettings: () => ({ wasOpenedAtLogin }),
    setLoginItemSettings: value => state.loginSettings.push(value),
    relaunch: value => state.relaunchOptions.push(value)
  };

  const electron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    Menu: { buildFromTemplate: template => template, setApplicationMenu() {} },
    Notification: {},
    Tray: class {},
    dialog: {},
    ipcMain: { handle() {} },
    nativeImage: {},
    shell: { openExternal() {} }
  };

  const context = vm.createContext({
    Buffer,
    URL,
    console,
    clearInterval,
    clearTimeout,
    setInterval,
    setTimeout,
    __dirname: path.dirname(desktopMainPath),
    process: {
      argv: [...processArgv],
      env: { ...env },
      execPath: processArgv[0],
      platform,
      pid: process.pid
    },
    require(id) {
      if (id === "electron") return electron;
      if (id === "node:fs") return fs;
      if (id === "node:path") return path;
      throw new Error(`unexpected require in desktop startup check: ${id}`);
    }
  });

  vm.runInContext(testableSource, context, { filename: desktopMainPath });
  context.__desktopStartupTestApi.initializeDesktopSettingsFile();
  if (persistSettings) {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(state.settingsFile, JSON.stringify(settings, null, 2), "utf8");
  }
  return { api: context.__desktopStartupTestApi, state };
}

function check(name, callback) {
  callback();
  console.log(`PASS ${name}`);
}

check("Windows login startup receives the tray-only argument", () => {
  const { api, state } = createHarness();
  api.applyLoginSetting({ openAtLogin: true, startMinimizedToTray: true });
  assert.equal(state.loginSettings.length, 1);
  assert.equal(state.loginSettings[0].openAtLogin, true);
  assert.equal(state.loginSettings[0].path, state.execPath);
  assert.deepEqual(Array.from(state.loginSettings[0].args), [api.START_IN_TRAY_ARG]);
});

check("Windows foreground login startup omits the tray-only argument", () => {
  const { api, state } = createHarness();
  api.applyLoginSetting({ openAtLogin: true, startMinimizedToTray: false });
  assert.deepEqual(Array.from(state.loginSettings[0].args), []);
});

check("Existing Windows login settings are migrated during normal startup setup", () => {
  const { api, state } = createHarness({ settings: { openAtLogin: true, startMinimizedToTray: true } });
  api.buildAppMenu();
  assert.equal(state.loginSettings.length, 1);
  assert.equal(state.loginSettings[0].openAtLogin, true);
  assert.deepEqual(Array.from(state.loginSettings[0].args), [api.START_IN_TRAY_ARG]);
});

check("Manual Windows launch remains visible even when login startup is configured for the tray", () => {
  const { api, state } = createHarness({
    argv: ["TunnelDesk.exe"],
    settings: { startMinimizedToTray: true }
  });
  assert.equal(api.shouldStartInTray({ startMinimizedToTray: true }), false);
  api.createWindow();
  const window = state.windows[0];
  window.emitOnce("ready-to-show");
  assert.equal(window.visible, true);
  assert.equal(window.showCount, 1);
  assert.equal(window.hideCount, 0);
});

check("Explicit Windows login launch starts in the tray", () => {
  const argv = ["TunnelDesk.exe", "--start-in-tray"];
  const { api, state } = createHarness({ argv });
  assert.equal(api.shouldStartInTray({ startMinimizedToTray: true }), true);
  api.createWindow();
  const window = state.windows[0];
  window.emitOnce("ready-to-show");
  assert.equal(window.visible, false);
  assert.equal(window.showCount, 0);
  assert.equal(window.hideCount, 1);
});

check("macOS only starts in the tray for an actual login launch", () => {
  const loginLaunch = createHarness({ platform: "darwin", wasOpenedAtLogin: true });
  const manualLaunch = createHarness({ platform: "darwin", wasOpenedAtLogin: false });
  assert.equal(loginLaunch.api.shouldStartInTray({ startMinimizedToTray: true }), true);
  assert.equal(manualLaunch.api.shouldStartInTray({ startMinimizedToTray: true }), false);
});

check("Relaunch removes every tray-only argument and preserves other arguments", () => {
  const { api, state } = createHarness({
    argv: ["TunnelDesk.exe", "app.asar", "--start-in-tray", "--inspect=9229", "--start-in-tray"]
  });
  api.relaunchInForeground();
  assert.equal(state.relaunchOptions.length, 1);
  assert.deepEqual(Array.from(state.relaunchOptions[0].args), ["app.asar", "--inspect=9229"]);
});

check("Unpackaged desktop keeps the repository runtime directories", () => {
  const { api } = createHarness({ isPackaged: false, persistSettings: false });
  const paths = api.resolveRuntimePaths({ dataMode: "project", customDataDir: "" });
  assert.equal(paths.dataDir, path.join(root, "data"));
  assert.equal(paths.sshDir, path.join(root, ".ssh"));
});

check("Packaged desktop defaults to the user runtime directory", () => {
  const { api, state } = createHarness({ platform: "linux", persistSettings: false });
  const settings = api.prepareRuntimeSettings();
  const paths = api.resolveRuntimePaths(settings);
  assert.equal(settings.dataMode, "user");
  assert.equal(paths.dataDir, path.join(state.userData, "runtime", "data"));
  assert.equal(paths.sshDir, path.join(state.userData, "runtime", ".ssh"));
  assert.equal(api.desktopSettingsView().project_mode_available, false);
});

check("Packaged desktop preserves an explicitly configured custom runtime directory", () => {
  const customRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunneldesk-custom-runtime-check-"));
  temporaryRoots.push(customRoot);
  const { api } = createHarness({
    platform: "linux",
    settings: { dataMode: "custom", customDataDir: customRoot }
  });
  const settings = api.prepareRuntimeSettings();
  const paths = api.resolveRuntimePaths(settings);
  assert.equal(settings.dataMode, "custom");
  assert.equal(settings.customDataDir, customRoot);
  assert.equal(paths.dataDir, path.join(customRoot, "data"));
  assert.equal(paths.sshDir, path.join(customRoot, ".ssh"));
});

check("Windows portable uses PORTABLE_EXECUTABLE_DIR instead of its temporary executable", () => {
  const portableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tunneldesk-portable-check-"));
  temporaryRoots.push(portableRoot);
  const { api, state } = createHarness({
    platform: "win32",
    env: { PORTABLE_EXECUTABLE_DIR: portableRoot },
    settings: { dataMode: "project" }
  });
  const settings = api.prepareRuntimeSettings();
  const paths = api.resolveRuntimePaths(settings);
  assert.equal(api.isWindowsPortable(), true);
  assert.equal(paths.dataDir, path.join(portableRoot, "data"));
  assert.equal(paths.sshDir, path.join(portableRoot, ".ssh"));
  assert.notEqual(path.dirname(state.execPath), portableRoot);
  assert.equal(api.desktopSettingsView().project_mode_available, true);
});

check("macOS migrates legacy app data before selecting the user runtime", () => {
  const { api, state } = createHarness({ platform: "darwin", settings: { dataMode: "project" } });
  const legacyRoot = api.legacyPackagedRoot();
  const legacyData = path.join(legacyRoot, "data");
  const legacySsh = path.join(legacyRoot, ".ssh");
  fs.mkdirSync(legacyData, { recursive: true });
  fs.mkdirSync(legacySsh, { recursive: true });
  fs.writeFileSync(path.join(legacyData, "tunnels.db"), "legacy database", "utf8");
  fs.writeFileSync(path.join(legacyData, "security.json"), "legacy security", "utf8");
  fs.writeFileSync(path.join(legacyData, "web.pid"), "123", "utf8");
  fs.writeFileSync(path.join(legacyData, "web.url"), "http://old", "utf8");
  fs.writeFileSync(path.join(legacyData, "web.json"), "{}", "utf8");
  fs.writeFileSync(path.join(legacySsh, "id_ed25519"), "legacy key", "utf8");

  const settings = api.prepareRuntimeSettings();
  const targetRoot = path.join(state.userData, "runtime");
  assert.equal(settings.dataMode, "user");
  assert.equal(settings.storageMigrationVersion, 1);
  assert.equal(settings.lastStorageMigration.status, "migrated");
  assert.equal(fs.readFileSync(path.join(targetRoot, "data", "tunnels.db"), "utf8"), "legacy database");
  assert.equal(fs.readFileSync(path.join(targetRoot, "data", "security.json"), "utf8"), "legacy security");
  assert.equal(fs.readFileSync(path.join(targetRoot, ".ssh", "id_ed25519"), "utf8"), "legacy key");
  assert.equal(fs.existsSync(path.join(targetRoot, "data", "web.pid")), false);
  assert.equal(fs.existsSync(path.join(targetRoot, "data", "web.url")), false);
  assert.equal(fs.existsSync(path.join(targetRoot, "data", "web.json")), false);
  assert.equal(fs.existsSync(path.join(legacyData, "tunnels.db")), true);
  assert.equal(JSON.parse(fs.readFileSync(state.settingsFile, "utf8")).dataMode, "user");
  assert.match(api.getPendingStorageMigrationNotice(), /已从旧程序目录迁移/);
});

check("Migration conflict keeps user data and backs up the complete legacy runtime", () => {
  const { api, state } = createHarness({ platform: "darwin", settings: { dataMode: "project" } });
  const legacyRoot = api.legacyPackagedRoot();
  const targetRoot = path.join(state.userData, "runtime");
  fs.mkdirSync(path.join(legacyRoot, "data", "logs"), { recursive: true });
  fs.mkdirSync(path.join(legacyRoot, ".ssh"), { recursive: true });
  fs.mkdirSync(path.join(targetRoot, "data"), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, "data", "tunnels.db"), "legacy database", "utf8");
  fs.writeFileSync(path.join(legacyRoot, "data", "logs", "legacy.log"), "legacy log", "utf8");
  fs.writeFileSync(path.join(legacyRoot, "data", "web.pid"), "456", "utf8");
  fs.writeFileSync(path.join(legacyRoot, ".ssh", "id_rsa"), "legacy key", "utf8");
  fs.writeFileSync(path.join(targetRoot, "data", "tunnels.db"), "current user database", "utf8");

  const settings = api.prepareRuntimeSettings();
  const backupRoot = settings.lastStorageMigration.backupRoot;
  assert.equal(settings.dataMode, "user");
  assert.equal(settings.lastStorageMigration.status, "conflict-backed-up");
  assert.equal(fs.readFileSync(path.join(targetRoot, "data", "tunnels.db"), "utf8"), "current user database");
  assert.equal(fs.readFileSync(path.join(backupRoot, "data", "tunnels.db"), "utf8"), "legacy database");
  assert.equal(fs.readFileSync(path.join(backupRoot, "data", "logs", "legacy.log"), "utf8"), "legacy log");
  assert.equal(fs.readFileSync(path.join(backupRoot, ".ssh", "id_rsa"), "utf8"), "legacy key");
  assert.equal(fs.existsSync(path.join(backupRoot, "data", "web.pid")), false);
  assert.equal(fs.existsSync(path.join(legacyRoot, "data", "tunnels.db")), true);
  assert.match(path.basename(backupRoot), /^migration-conflict-backup-/);
  assert.match(api.getPendingStorageMigrationNotice(), /继续使用用户目录/);
});

console.log("Desktop startup semantics passed.");
