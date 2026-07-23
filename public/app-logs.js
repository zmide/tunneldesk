function setLogSearch(value) {
  logSearch = value || "";
  renderLogs().catch(e=>notify(e.message,"error"));
  clearTimeout(logSearchTimer);
  if (logViewerState?.path && activeView === "log") {
    logSearchTimer = setTimeout(() => openLog(logViewerState.path, logViewerState.title, false).catch(e=>notify(e.message,"error")), 250);
  }
}

function showLogCleanupMenu(event) {
  showActionMenu(event, [
    {label:"清理 7 天前", icon:"calendar-minus", run:()=>clearLogsOlderThan(7)},
    {label:"清理 30 天前", icon:"calendar-minus", run:()=>clearLogsOlderThan(30)},
    {label:"清理 90 天前", icon:"calendar-minus", run:()=>clearLogsOlderThan(90)},
    {separator:true},
    {label:"清空全部日志", icon:"trash-2", danger:true, run:()=>clearAllLogs()}
  ]);
}

async function renderLogs(){
  const uiState = captureUiState($("connectionGroups") || document);
  logsData = await api("/api/logs");
  const systemOpen = logOpen.has("system");
  const systemLogs = filterLogs(logsData.system || []);
  const systemItems = systemOpen ? renderLogItems("system", systemLogs) : "";
  const batchOpen = logOpen.has("batch");
  const batchLogs = filterLogs(logsData.batch || []);
  const batchItems = batchOpen ? renderLogItems("batch", batchLogs) : "";
  const serverItems = (logsData.connections || []).map(server => {
    const key = `server:${server.name}`;
    const open = logOpen.has(key);
    const logs = filterLogs(server.logs || []);
    return `<div class="group log-group">
      <div class="group-head-row"><button class="group-head" onclick="toggleLogOpen('${escAttr(key)}')"><span class="chev">${open ? "▾" : "▸"}</span>${icon("server")}<span>${esc(server.name)}</span><span class="count">${logs.length}</span></button><button class="log-group-delete danger icon-button" title="删除该服务器日志" onclick="deleteLogGroup('${escAttr(key)}')">${icon("trash-2")}</button></div>
      ${open ? renderLogItems(key, logs) : ""}
    </div>`;
  }).join("");
  $("connectionGroups").innerHTML = `<div class="group log-group">
    <div class="group-head-row"><button class="group-head" onclick="toggleLogOpen('system')"><span class="chev">${systemOpen ? "▾" : "▸"}</span>${icon("monitor-cog")}<span>系统日志</span><span class="count">${systemLogs.length}</span></button><button class="log-group-delete danger icon-button" title="删除系统日志" onclick="deleteLogGroup('system')">${icon("trash-2")}</button></div>
    ${systemItems}
  </div><div class="group log-group">
    <div class="group-head-row"><button class="group-head" onclick="toggleLogOpen('batch')"><span class="chev">${batchOpen ? "▾" : "▸"}</span>${icon("square-terminal")}<span>批量执行日志</span><span class="count">${batchLogs.length}</span></button><button class="log-group-delete danger icon-button" title="删除批量日志" onclick="deleteLogGroup('batch')">${icon("trash-2")}</button></div>
    ${batchItems}
  </div>${serverItems || stateView("empty", "暂无终端日志", "打开终端或执行批量命令后，日志会按服务器保存在这里。")}`;
  restoreUiState(uiState);
}

function filterLogs(logs) {
  const q = logSearch.trim().toLowerCase();
  if (!q) return logs;
  return logs.filter(log => String(log.label || "").toLowerCase().includes(q));
}

function renderLogItems(key, logs) {
  const page = logPage.get(key) || 0;
  const start = page * 10;
  const visible = logs.slice(start, start + 10);
  return visible.map(log => renderLogButton(log)).join("") + renderPager(key, logs.length, page);
}

function renderLogButton(log) {
  return `<div class="log-row">
    <button class="log-item" onclick="openLog('${escAttr(log.path)}','${escAttr(log.label)}')">${esc(log.label)}</button>
    <button class="log-delete danger icon-button" title="删除日志" onclick="deleteLog('${escAttr(log.path)}')">${icon("trash-2")}</button>
  </div>`;
}

function renderPager(key, total, page) {
  if (total <= 10) return "";
  const maxPage = Math.ceil(total / 10) - 1;
  return `<div class="pager"><button ${page<=0?"disabled":""} onclick="changeLogPage('${escAttr(key)}',-1)">上一页</button><span class="pager-count">${page+1}/${maxPage+1}</span><button ${page>=maxPage?"disabled":""} onclick="changeLogPage('${escAttr(key)}',1)">下一页</button></div>`;
}

function toggleLogOpen(key) {
  if (logOpen.has(key)) logOpen.delete(key);
  else logOpen.add(key);
  saveLogState();
  renderLogs().catch(e=>notify(e.message,"error"));
}

function changeLogPage(key, delta) {
  const next = Math.max(0, (logPage.get(key) || 0) + delta);
  logPage.set(key, next);
  renderLogs().catch(e=>notify(e.message,"error"));
}

async function openLog(path, title, updateTab=true) {
  const result = await loadLogWindow(path);
  logViewerState = {path, title, offset:result.offset, text:result.text || "", matches:result.matches || [], matches_truncated:Boolean(result.matches_truncated), has_older:Boolean(result.has_older)};
  renderLogViewer();
  setWorkspace(title, "日志查看", "log", `log-${path}`, updateTab, true, {kind:"log", path});
}

async function loadLogWindow(path, before) {
  const params = new URLSearchParams({path, limit:String(256 * 1024)});
  if (before !== undefined) params.set("before", String(before));
  if (logSearch.trim()) params.set("query", logSearch.trim());
  return api(`/api/logs/read?${params.toString()}`);
}

function renderLogViewer() {
  if (!logViewerState) return;
  const matches = logViewerState.matches || [];
  let contexts = "";
  if (logSearch.trim()) {
    const blocks = matches.slice(0, 50).map(match => `<pre>${highlightLogText(match.text)}</pre>`).join("");
    const summary = matches.length
      ? `共显示 ${matches.length} 处命中${logViewerState.matches_truncated ? "，更多结果已省略" : ""}`
      : "正文中没有对应内容";
    contexts = `<div class="panel compact-log-context"><strong>搜索上下文</strong><span>${summary}</span>${blocks}</div>`;
  }
  const older = logViewerState.has_older
    ? `<div class="actions log-load-actions"><button onclick="loadOlderLog()">${icon("chevrons-up")}加载更早内容</button><span class="muted">按 256 KB 分段读取，不会一次载入整个大日志。</span></div>`
    : "";
  $("view-log").innerHTML = `${older}${contexts}<pre class="log-view">${highlightLogText(logViewerState.text || "日志为空")}</pre>`;
  refreshIcons();
}

async function loadOlderLog() {
  if (!logViewerState?.has_older) return;
  const result = await loadLogWindow(logViewerState.path, logViewerState.offset);
  logViewerState.offset = result.offset;
  logViewerState.text = `${result.text || ""}${logViewerState.text || ""}`;
  logViewerState.has_older = Boolean(result.has_older);
  renderLogViewer();
}

async function showLogSettings() {
  const settings = await api("/api/logs/settings");
  $("modal").innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="logSettingsTitle">
    <h2 id="logSettingsTitle">日志设置</h2>
    <div class="grid">
      <div><label>保留天数（0 为不限）</label><input id="logSettingDays" type="number" min="0" max="3650" value="${Number(settings.retention_days || 0)}"></div>
      <div><label>单文件上限（MB）</label><input id="logSettingFileMb" type="number" min="1" max="2048" value="${Number(settings.max_file_size_mb || 50)}"></div>
      <div><label>全部日志上限（MB）</label><input id="logSettingTotalMb" type="number" min="10" max="102400" value="${Number(settings.max_total_size_mb || 1024)}"></div>
      <div><label>每个日志保留轮转数</label><input id="logSettingRotations" type="number" min="1" max="10" value="${Number(settings.rotation_files || 3)}"></div>
    </div>
    <p class="muted">写入超过单文件上限时自动轮转；后台每 6 小时按天数和总容量清理一次。</p>
    <div class="actions"><button onclick="closeModal()">取消</button><button onclick="runConfiguredLogCleanup()">立即清理</button><button class="primary" onclick="saveLogSettings()">保存</button></div>
  </div>`;
  $("modal").hidden = false;
}

async function saveLogSettings() {
  const result = await api("/api/logs/settings", {method:"PUT", body:JSON.stringify({
    retention_days:Number($("logSettingDays").value),
    max_file_size_mb:Number($("logSettingFileMb").value),
    max_total_size_mb:Number($("logSettingTotalMb").value),
    rotation_files:Number($("logSettingRotations").value)
  })});
  closeModal();
  await renderLogs();
  notify(`日志设置已保存，清理 ${Number(result.cleanup?.deleted || 0)} 个文件`, "success");
}

async function runConfiguredLogCleanup() {
  const result = await api("/api/logs/cleanup", {method:"POST", body:"{}"});
  closeModal();
  await renderLogs();
  notify(`日志清理完成：删除 ${Number(result.deleted || 0)} 个文件`, "success");
}

function highlightLogText(text) {
  const escaped = esc(text);
  const q = logSearch.trim();
  if (!q) return escaped;
  const parts = q.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (!parts.length) return escaped;
  return escaped.replace(new RegExp(`(${parts.join("|")})`, "gi"), `<mark>$1</mark>`);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function openTodaySystemLog() {
  if (!logsData.system?.length) logsData = await api("/api/logs");
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const today = `${yyyy}-${mm}-${dd}`;
  const log = (logsData.system || []).find(item => String(item.path || item.label || "").includes(today));
  if (!log) return notify("今天暂无系统日志", "info");
  openLog(log.path, log.label || `system-${today}`);
}

function logPathsForKey(key) {
  if (key === "system") {
    return (logsData.system || []).map(log => log.path);
  }
  if (key === "batch") {
    return (logsData.batch || []).map(log => log.path);
  }
  const name = key.replace(/^server:/, "");
  const server = (logsData.connections || []).find(item => item.name === name);
  return (server?.logs || []).map(log => log.path);
}

async function deleteLog(path) {
  if (!await confirmModal("删除这条日志？", "删除日志", "删除", "取消", true)) return;
  await deleteLogPaths([path]);
}

async function deleteLogGroup(key) {
  const paths = logPathsForKey(key);
  if (!paths.length) return notify("请选择日志", "error");
  if (!await confirmModal(`删除该分组下的 ${paths.length} 条日志？`, "删除分组日志", "删除", "取消", true)) return;
  await deleteLogPaths(paths);
}

async function clearAllLogs() {
  const paths = [...(logsData.system || []).map(log => log.path), ...(logsData.batch || []).map(log => log.path), ...(logsData.connections || []).flatMap(server => (server.logs || []).map(log => log.path))];
  if (!paths.length) return notify("暂无日志可清空", "info");
  if (!await confirmModal(`清空全部 ${paths.length} 条日志？`, "清空日志", "清空", "取消", true)) return;
  await deleteLogPaths(paths);
}

async function clearLogsOlderThan(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const paths = [...(logsData.system || []), ...(logsData.batch || []), ...(logsData.connections || []).flatMap(server => server.logs || [])]
    .filter(log => Number(log.time || 0) && Number(log.time) < cutoff)
    .map(log => log.path);
  if (!paths.length) return notify(`没有 ${days} 天前的日志`, "info");
  if (!await confirmModal(`删除 ${days} 天前的 ${paths.length} 条日志？`, "清理历史日志", "删除", "取消", true)) return;
  await deleteLogPaths(paths);
}

async function clearCustomLogRetention() {
  const days = Math.max(1, Number($("logRetentionDays")?.value || 0));
  if (!Number.isFinite(days)) return notify("请输入有效保留天数", "error");
  await clearLogsOlderThan(days);
}

async function deleteLogPaths(paths) {
  const result = await api("/api/logs/delete", {method:"POST", body:JSON.stringify({paths})});
  const deleted = new Set(result.deleted || []);
  const activeLogPath = tabs.find(tab => tab.key === activeTabKey)?.path;
  tabs = tabs.filter(tab => !(tab.kind === "log" && deleted.has(tab.path)));
  if (activeView === "log" && deleted.has(activeLogPath)) renderWelcome();
  renderTabs();
  await renderLogs();
  notify(`已删除 ${result.deleted.length} 条日志${result.errors.length ? `，失败 ${result.errors.length} 条` : ""}`, result.errors.length ? "error" : "success");
}
