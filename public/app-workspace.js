function renderTabs() {
  $("tabs").innerHTML = tabs.map(tab => `<button class="tab ${tab.key === activeTabKey ? "active" : ""}" onclick="activateTab('${tab.key}')" oncontextmenu="showTabContextMenu(event,'${escAttr(tab.key)}')"><span class="tab-title">${esc(tab.title)}</span>${tab.closable ? `<span class="tab-close" onclick="closeTab(event,'${escAttr(tab.key)}')">x</span>` : ""}</button>`).join("");
  if (!window.restoringTabs) saveTabsState();
}

function addTab(key, title, subtitle, viewName, closable=true, meta={}) {
  if (key !== "welcome") tabs = tabs.filter(tab => tab.key !== "welcome");
  if (key === "welcome" && tabs.some(tab => tab.key !== "welcome")) return;
  const found = tabs.find(tab => tab.key === key);
  if (found) Object.assign(found, {title, subtitle, viewName, closable, ...meta});
  else tabs.push({key, title, subtitle, viewName, closable, ...meta});
  activeTabKey = key;
  renderTabs();
}

function renderTabContent(tab) {
  if (tab.kind === "terminal") return openTerminal(tab.id, false, tab.key, tab.title);
  if (tab.kind === "forwards") return openForwards(tab.id, false);
  if (tab.kind === "edit") return editConnection(tab.id, false);
  if (tab.kind === "import") return showImport(false);
  if (tab.kind === "log") return openLog(tab.path, tab.title, false);
  if (tab.kind === "command") return openBatchCommand(false);
  if (tab.kind === "sftp") return openSftp(tab.id, tab.path || ".", false);
  if (tab.kind === "dashboard") return openServerDashboard(tab.id, false);
  if (tab.kind === "settings") return openSettings(false);
  return setWorkspace(tab.title, tab.subtitle, tab.viewName, tab.key, false, tab.closable);
}

function activateTab(key) {
  const tab = tabs.find(item => item.key === key);
  if (!tab) return;
  activeTabKey = key;
  renderTabs();
  renderTabContent(tab);
}

function closeTab(event, key) {
  event.stopPropagation();
  closeTabsByKey([key], key);
}

function closeTabsByKey(keys, anchorKey="") {
  const targets = new Set(keys);
  const previousTabs = [...tabs];
  const anchorIndex = Math.max(0, previousTabs.findIndex(tab => tab.key === anchorKey));
  for (const key of targets) {
    closeTerminalSession(key);
    if (key === "command") stopBatchCommand();
  }
  tabs = tabs.filter(tab => !targets.has(tab.key));
  if (!targets.has(activeTabKey)) return renderTabs();
  const previousKeys = previousTabs.map(tab => tab.key);
  const fallbackKey = [previousKeys[anchorIndex], ...previousKeys.slice(0, anchorIndex).reverse(), ...previousKeys.slice(anchorIndex + 1)]
    .find(key => !targets.has(key) && tabs.some(tab => tab.key === key));
  if (fallbackKey) activateTab(fallbackKey);
  else renderWelcome();
}

function closeTabsByMode(mode, key) {
  const index = tabs.findIndex(tab => tab.key === key);
  if (index < 0) return;
  const closable = tabs.filter(tab => tab.closable);
  let targets = [];
  if (mode === "current") targets = closable.filter(tab => tab.key === key);
  if (mode === "others") targets = closable.filter(tab => tab.key !== key);
  if (mode === "right") targets = tabs.slice(index + 1).filter(tab => tab.closable);
  if (mode === "all") targets = closable;
  hideTabContextMenu();
  if (targets.length) closeTabsByKey(targets.map(tab => tab.key), key);
}

function hideTabContextMenu() {
  $("tabContextMenu")?.remove();
}

function showTabContextMenu(event, key) {
  event.preventDefault();
  event.stopPropagation();
  hideTabContextMenu();
  const tab = tabs.find(item => item.key === key);
  const index = tabs.findIndex(item => item.key === key);
  if (!tab || index < 0) return;
  const options = [
    ["关闭当前标签", "current", Boolean(tab.closable)],
    ["关闭其他标签", "others", tabs.some(item => item.closable && item.key !== key)],
    ["关闭右侧标签", "right", tabs.slice(index + 1).some(item => item.closable)],
    ["关闭所有标签", "all", tabs.some(item => item.closable)]
  ];
  const menu = document.createElement("div");
  menu.id = "tabContextMenu";
  menu.className = "context-menu tab-context-menu";
  for (const [label, mode, enabled] of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = !enabled;
    button.onclick = () => closeTabsByMode(mode, key);
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - rect.height - 8)}px`;
}

function persistableTabs() {
  return tabs.filter(tab => tab.kind && tab.kind !== "terminal").map(({key,title,subtitle,viewName,closable,kind,id,path}) => ({key,title,subtitle,viewName,closable,kind,id,path}));
}

function saveTabsState() {
  try {
    localStorage.setItem("workspaceTabs", JSON.stringify({activeTabKey, tabs:persistableTabs()}));
  } catch {}
}

function restoreTabsState() {
  try {
    const saved = JSON.parse(localStorage.getItem("workspaceTabs") || "{}");
    const restored = (saved.tabs || []).filter(tab => tab.kind && tab.kind !== "terminal");
    if (!restored.length) return false;
    window.restoringTabs = true;
    tabs = restored;
    activeTabKey = restored.some(tab => tab.key === saved.activeTabKey) ? saved.activeTabKey : restored[0].key;
    renderTabs();
    renderTabContent(tabs.find(tab => tab.key === activeTabKey) || tabs[0]);
    window.restoringTabs = false;
    saveTabsState();
    return true;
  } catch {
    window.restoringTabs = false;
    return false;
  }
}

function closeTerminalSession(key) {
  const session = terminalSessions.get(key);
  if (!session) return;
  try { session.socket?.close(); } catch {}
  try { session.resizeDisposable?.dispose(); } catch {}
  try { session.term?.dispose(); } catch {}
  terminalSessions.delete(key);
}

function setWorkspace(title, subtitle, viewName, key=viewName, updateTab=true, closable=true, meta={}) {
  if (updateTab) addTab(key, title, subtitle, viewName, closable, meta);
  $("workspaceTitle").textContent = "工作区";
  $("workspaceSubtitle").textContent = subtitle || "";
  document.querySelectorAll(".view").forEach(v => v.hidden = true);
  $(`view-${viewName}`).hidden = false;
  document.querySelector(".workspace")?.classList.toggle("terminal-workspace", viewName === "terminal");
  $("content")?.classList.toggle("terminal-content", viewName === "terminal");
  document.body.classList.toggle("mobile-terminal-active", isMobileLayout() && viewName === "terminal");
  activeView = viewName;
  if (isMobileLayout() && viewName !== "welcome") showMobileWorkspace();
}

function showPrimary(name) {
  primaryView = name;
  $("navConnections").classList.toggle("active", name === "connections");
  $("navImport").classList.toggle("active", name === "import");
  $("navRunning").classList.toggle("active", name === "running");
  $("navCommand").classList.toggle("active", name === "command");
  $("navLogs").classList.toggle("active", name === "logs");
  $("navSettings")?.classList.toggle("active", name === "settings");
  $("sideConnections").classList.toggle("active", name === "connections");
  $("sideImport").classList.toggle("active", name === "import");
  $("mobileConnections").classList.toggle("active", name === "connections");
  $("mobileImport").classList.toggle("active", name === "import");
  $("mobileRunning").classList.toggle("active", name === "running");
  $("mobileCommand").classList.toggle("active", name === "command");
  $("mobileLogs").classList.toggle("active", name === "logs");
  $("mobileSettings")?.classList.toggle("active", name === "settings");
  renderExplorerTools();
  if (name === "import") {
    if (isMobileLayout()) showMobileExplorer();
    else if (activeView !== "import") showImport();
    else showImportSection(activeImportSection, {moveToWorkspace:false});
  } else if (name === "running") {
    if (isMobileLayout()) showMobileExplorer();
    renderRunningForwards();
  } else if (name === "command") {
    renderCommandTemplates().catch(e=>notify(e.message,"error"));
    if (isMobileLayout()) showMobileExplorer();
    else openBatchCommand();
  } else if (name === "logs") {
    if (isMobileLayout()) showMobileExplorer();
    renderLogs().catch(e=>notify(e.message,"error"));
  } else if (name === "settings") {
    if (isMobileLayout()) showMobileExplorer();
    else if (activeView !== "settings") openSettings();
    else showSettingsSection(activeSettingsSection, {moveToWorkspace:false});
  } else {
    if (isMobileLayout()) showMobileExplorer();
    else document.querySelector(".left-pane").classList.remove("mobile-hide");
    renderConnections();
  }
}

function setExplorerSectionActive(sectionId) {
  document.querySelectorAll("#explorerTools [data-explorer-section]").forEach(button => {
    button.classList.toggle("active", button.dataset.explorerSection === sectionId);
  });
}

function renderExplorerTools() {
  const tools = $("explorerTools");
  const tree = $("connectionGroups");
  tools.classList.remove("log-mode", "section-mode");
  if (tree) tree.hidden = ["settings", "import"].includes(primaryView);
  if (primaryView === "logs") {
    tools.classList.add("log-mode");
    tools.innerHTML = `
      <div class="search-field">${icon("search")}<input id="logSearch" placeholder="搜索日志" value="${esc(logSearch)}" oninput="setLogSearch(this.value)"></div>
      <div class="tool-row"><button onclick="openTodaySystemLog()">${icon("calendar-days")}<span>今天日志</span></button><button onclick="showLogSettings()">${icon("settings-2")}<span>日志设置</span></button></div>
      <button onclick="showLogCleanupMenu(event)">${icon("list-filter")}<span>清理日志</span></button>`;
    return;
  }
  if (primaryView === "running") {
    tools.classList.add("log-mode");
    tools.innerHTML = `<button onclick="loadAll().then(renderRunningForwards)">${icon("refresh-cw")}<span>刷新</span></button><button onclick="restoreForwards()">${icon("history")}<span>恢复上次转发</span></button>`;
    return;
  }
  if (primaryView === "command") {
    tools.classList.add("log-mode");
    tools.innerHTML = `<button class="primary" onclick="openBatchCommand()">${icon("play")}<span>批量执行</span></button><button onclick="newCommandTemplate()">${icon("plus")}<span>新增模板</span></button><button onclick="renderCommandTemplates()">${icon("refresh-cw")}<span>刷新模板</span></button>`;
    return;
  }
  if (primaryView === "import") {
    const activeSection = typeof activeImportSection === "string" ? activeImportSection : "import-source";
    const sections = [["import-source", "file-input", "SSH config 导入导出"], ["import-export", "database-backup", "数据库导入导出"], ["configSnapshots", "history", "配置快照"]];
    tools.classList.add("section-mode");
    tools.innerHTML = sections.map(([id, iconName, label]) => `<button class="${id === activeSection ? "active" : ""}" data-explorer-section="${id}" onclick="openImportSection('${id}')">${icon(iconName)}<span>${label}</span></button>`).join("");
    return;
  }
  if (primaryView === "settings") {
    const activeSection = typeof activeSettingsSection === "string" ? normalizeSettingsSection(activeSettingsSection) : "settings-general";
    const sections = [["settings-general", "settings-2", "通用设置"], ["settings-basic", "shield-check", "安全设置"], ["settings-notifications", "bell", "通知设置"], ["settings-runtime", "activity", "启动与运行"], ["settings-about", "info", "关于"]];
    const updateDotHidden = typeof shouldShowUpdateNotice === "function" && shouldShowUpdateNotice() ? "" : "hidden";
    tools.classList.add("section-mode");
    tools.innerHTML = sections.map(([id, iconName, label]) => `<button class="${id === activeSection ? "active" : ""}" data-explorer-section="${id}" onclick="openSettingsSection('${id}')">${icon(iconName)}<span>${label}</span>${id === "settings-about" ? `<i id="settingsExplorerUpdateDot" class="section-update-dot" ${updateDotHidden} aria-label="发现新版本"></i>` : ""}</button>`).join("");
    return;
  }
  tools.innerHTML = `
    <div class="search-field">${icon("search")}<input id="connectionSearch" placeholder="搜索连接、主机、用户、分组" value="${esc(connectionSearch)}" oninput="setConnectionSearch(this.value)"></div>
    <button onclick="addGroup()">${icon("folder-plus")}<span>添加分组</span></button>
    <button class="primary" onclick="newConnection()">${icon("server-cog")}<span>添加 SSH</span></button>
    <button class="${connectionBulkMode ? "active" : ""}" onclick="toggleConnectionBulkMode()">${icon(connectionBulkMode ? "check-check" : "list-checks")}<span>${connectionBulkMode ? "完成管理" : "批量管理"}</span></button>
    <button onclick="startAllForwards(this)">${icon("play")}<span>启动全部</span></button>
    <button onclick="stopAllForwardsUi(this)">${icon("square")}<span>停止全部</span></button>
    <button onclick="checkAllHealth(this)">${icon("activity")}<span>健康检查</span></button>`;
}

function backToExplorer() {
  showMobileExplorer();
}

function showMobileExplorer() {
  document.querySelector(".left-pane").classList.remove("mobile-hide");
  $("content").classList.remove("mobile-show");
  document.body.classList.remove("mobile-terminal-active");
}

function showMobileWorkspace() {
  document.querySelector(".left-pane").classList.add("mobile-hide");
  $("content").classList.add("mobile-show");
  document.body.classList.toggle("mobile-terminal-active", activeView === "terminal");
}

function syncResponsivePane() {
  if (!isMobileLayout()) {
    document.querySelector(".left-pane")?.classList.remove("mobile-hide");
    return;
  }
  if (["import", "settings"].includes(primaryView) || activeView === "terminal") showMobileWorkspace();
  else showMobileExplorer();
}

function renderWelcome() {
  $("view-welcome").innerHTML = `<div id="startupSummary"></div>${stateView("empty", "开始使用", "从左侧选择 SSH 资源、日志或导入导出；打开的内容会保留为工作区标签。", `<button class="primary" onclick="showPrimary('connections')">查看连接</button>`)}`;
  setWorkspace("开始使用", "选择左侧项目后开始操作", "welcome", "welcome", true, false);
  loadStartupSummary();
}

async function loadStartupSummary() {
  const box = $("startupSummary");
  if (!box) return;
  try {
    const s = await api("/api/startup-status");
    const success = Number(s.autostart?.ok || 0) + Number(s.restore?.ok || 0);
    const failed = Number(s.autostart?.failed || 0) + Number(s.restore?.failed || 0);
    const urls = [s.local_url, ...(s.lan_urls || [])].filter(Boolean);
    box.innerHTML = `<div class="startup-summary ${failed ? "warning" : "ready"}"><div><strong>${s.state === "starting" ? "启动任务正在执行" : failed ? "启动完成，部分转发失败" : "TunnelDesk 已就绪"}</strong><span>${urls.map(esc).join(" · ")}</span></div><div class="startup-counts"><span>转发成功 ${success}</span><span class="${failed ? "bad" : ""}">失败 ${failed}</span><button onclick="openTodaySystemLog()">系统日志</button></div></div>`;
    if (s.state === "starting") setTimeout(loadStartupSummary, 1200);
  } catch { box.innerHTML = ""; }
}
