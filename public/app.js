const $ = id => document.getElementById(id);
let connections = [], selectedId = null, activeView = "welcome", primaryView = "connections";
let importState = {tunnels: [], missing_keys: []};
const groupOpen = loadGroupState();
const runningOpen = loadRunningState();
const logOpen = loadLogState();
const logPage = new Map();
let logsData = {system: [], connections: []};
let pendingGroup = "";
let tabs = [];
let activeTabKey = "";
const terminalSessions = new Map();
const terminalCounts = new Map();
let TerminalClass = null;
let FitAddonClass = null;
let addingGroup = false;
let pendingGroupSelectValue = "";
let terminalFontSize = Number(localStorage.getItem("terminalFontSize") || 13);
let refreshInFlight = false;
let connectionSearch = localStorage.getItem("connectionSearch") || "";
let connectionBulkMode = false;
const selectedConnectionIds = new Set();
let logSearch = "";
let logViewerState = null;
let logSearchTimer = null;
const healthResults = new Map();
if (!localStorage.getItem("terminalKeysDefaultCollapsedV2")) {
  localStorage.setItem("terminalKeysVisible", "0");
  localStorage.setItem("terminalKeysDefaultCollapsedV2", "1");
}
let terminalKeysVisible = localStorage.getItem("terminalKeysVisible") === "1";
let terminalCtrlArmed = false;
let terminalCtrlLocked = false;
const connectionVirtual = { rowHeight: 118, buffer: 8, scrollTop: 0 };
let commandTemplates = [];
let editingTemplateId = "";
let batchCommandSocket = null;
let batchCommandExport = null;
let editingForwardId = 0;
let editingForwardTemplateId = "";
let forwardTemplates = [];
let runningGroupMode = localStorage.getItem("runningGroupMode") || "server";
let sftpClipboard = null;
let sftpState = { path: ".", entries: [], query: "", sort: "name", dir: "asc", connectionId: 0, selected: null, page: 1, pageSize: 50, total: 0, totalPages: 1, unfilteredTotal: 0, loading: false, requestSeq: 0 };
let sftpSearchTimer = null;
let sftpRequestController = null;
let sftpFavorites = JSON.parse(localStorage.getItem("sftpFavorites") || "[]");
let runningFilter = localStorage.getItem("runningFilter") || "";
let securitySettings = null;
let sftpJobsTimer = null;
let lastNotificationId = Number(localStorage.getItem("lastNotificationId") || 0);
let notificationCursorInitialized = false;
let notificationCursorPromise = null;
let recentTerminalCommands = loadRecentTerminalCommands();
async function loadAll(options={}){
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const editingSettings = activeView === "settings" && document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
    const [connectionRows, templateRows, security] = await Promise.all([
      api("/api/connections"),
      api("/api/forward-templates").catch(() => forwardTemplates),
      editingSettings ? Promise.resolve(securitySettings) : api("/api/security").catch(() => securitySettings)
    ]);
    connections = connectionRows;
    forwardTemplates = templateRows || [];
    if (!editingSettings) securitySettings = security;
    for (const c of connections) if (selectedId === c.id) groupOpen.add(c.group_name);
    saveGroupState();
    if (primaryView === "connections") renderConnections();
    else if (primaryView === "running") renderRunningForwards();
    if (activeView === "forwards") renderForwards();
  } catch (error) {
    if (!options.silent) throw error;
  } finally {
    refreshInFlight = false;
  }
}
function startAutoRefresh() {
  [800, 1800, 3200, 5200, 8000].forEach(delay => {
    setTimeout(() => {
      if (!document.hidden) loadAll({silent:true});
    }, delay);
  });
  setInterval(() => {
    if (!document.hidden) loadAll({silent:true});
  }, 4000);
  setInterval(() => {
    if (!document.hidden) pollNotifications();
  }, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      loadAll({silent:true});
      pollNotifications();
    }
  });
}
applyTheme(preferredTheme());
renderExplorerTools();
loadCachedUpdateStatus();
syncViewportHeight();
window.visualViewport?.addEventListener("resize", syncViewportHeight);
window.visualViewport?.addEventListener("scroll", syncViewportHeight);
window.addEventListener("resize", () => { syncViewportHeight(); syncResponsivePane(); });
window.addEventListener("orientationchange", () => setTimeout(syncViewportHeight, 250));
window.addEventListener("focusout", () => setTimeout(syncViewportHeight, 120));
window.restoringTabs = true;
renderWelcome();
window.restoringTabs = false;
$("connectionGroups")?.addEventListener("scroll", onConnectionScroll, {passive:true});
document.addEventListener("contextmenu", showCommandContextMenu);
document.addEventListener("click", () => {
  hideActionMenu();
  hideCommandContextMenu();
  hideSftpContextMenu();
  hideTabContextMenu();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    hideActionMenu();
    hideCommandContextMenu();
    hideSftpContextMenu();
    hideTabContextMenu();
  }
});
refreshIcons();
document.addEventListener("scroll", () => {
  if (!isMobileLayout()) hideActionMenu();
}, true);
loadAll().then(() => {
  if (!restoreTabsState()) renderWelcome();
  syncResponsivePane();
}).catch(e=>notify(e.message,"error"));
startAutoRefresh();
pollNotifications();
