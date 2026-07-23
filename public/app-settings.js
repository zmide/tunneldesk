let aboutSettings = null;
let updateSettings = null;
let runtimeSettings = null;
let desktopSettings = null;
let runtimeSettingsMessage = null;
let runtimeSettingsCheck = null;
let licenseModalKeyHandler = null;
let updateDownloadPollingTimer = null;
const SETTINGS_SECTION_META = {
  "settings-general": "通用设置",
  "settings-basic": "安全设置",
  "settings-notifications": "通知设置",
  "settings-runtime": "启动与运行",
  "settings-about": "关于"
};
let activeSettingsSection = "settings-general";
const UPDATE_NOTICE_SESSION_KEY = "tunneldeskUpdateReadVersion";
let updateNoticeReadVersion = "";
try { updateNoticeReadVersion = sessionStorage.getItem(UPDATE_NOTICE_SESSION_KEY) || ""; } catch {}

function normalizeSettingsSection(id) {
  if (id === "settings-advanced") return "settings-basic";
  return Object.prototype.hasOwnProperty.call(SETTINGS_SECTION_META, id) ? id : "settings-general";
}

function currentUpdateNoticeVersion() {
  return String(updateSettings?.latest_version || "").trim().replace(/^v/i, "");
}

function shouldShowUpdateNotice() {
  const latestVersion = currentUpdateNoticeVersion();
  return Boolean(updateSettings?.update_available && !updateSettings?.update_ignored && latestVersion && latestVersion !== updateNoticeReadVersion);
}

function syncUpdateNoticeDots() {
  const visible = shouldShowUpdateNotice();
  for (const id of ["navSettingsUpdateDot", "mobileSettingsUpdateDot", "settingsExplorerUpdateDot"]) {
    const dot = $(id);
    if (dot) dot.hidden = !visible;
  }
}

function markUpdateNoticeRead() {
  const latestVersion = currentUpdateNoticeVersion();
  if (!latestVersion || !updateSettings?.update_available) return;
  updateNoticeReadVersion = latestVersion;
  try { sessionStorage.setItem(UPDATE_NOTICE_SESSION_KEY, latestVersion); } catch {}
  syncUpdateNoticeDots();
}

function syncUpdateNoticeForCurrentSection() {
  if (activeView === "settings" && activeSettingsSection === "settings-about" && updateSettings?.update_available) {
    markUpdateNoticeRead();
  } else {
    syncUpdateNoticeDots();
  }
}

async function loadCachedUpdateStatus() {
  try {
    const [status, download] = await Promise.all([
      api("/api/updates/status"),
      api("/api/updates/download/status").catch(()=>null)
    ]);
    if (status && typeof status === "object") updateSettings = status;
    if (updateSettings && download) updateSettings.download_status = download;
    const area = $("updateCheckArea");
    if (area) area.innerHTML = updateStatusHtml();
    if (download?.state === "downloading") startUpdateDownloadPolling();
    syncUpdateNoticeForCurrentSection();
  } catch {}
}

async function loadSecuritySettings() {
  securitySettings = await api("/api/security");
  return securitySettings;
}

async function loadAboutSettings() {
  aboutSettings = await api("/api/about");
  return aboutSettings;
}

async function loadDesktopSettings() {
  try {
    desktopSettings = await api("/api/desktop-settings");
  } catch {
    desktopSettings = {available:false};
  }
  return desktopSettings;
}

function storageSettingsPanelHtml() {
  const settings = desktopSettings?.settings || {};
  const paths = desktopSettings?.paths || {};
  const storage = desktopSettings?.storage || {};
  const configurable = Boolean(desktopSettings?.available);
  if (desktopSettings?.storage_management_available === false) return `<section class="desktop-settings-section storage-settings-section">
    <h3>数据存储</h3>
    <div class="warning">远程管理数据路径需要启用 Web 密码并登录。关闭局域网密码时，只能在运行 TunnelDesk 的本机修改。</div>
  </section>`;
  return `<section class="desktop-settings-section storage-settings-section">
    <h3>数据存储</h3>
    <div class="desktop-settings-grid">
      <div>${configurable ? `
        <label for="desktopDataMode">数据路径模式</label>
        <select id="desktopDataMode" onchange="syncDesktopCustomDataMode()">
          ${desktopSettings.project_mode_available ? `<option value="project" ${settings.dataMode === "project" ? "selected" : ""}>${esc(desktopSettings.project_mode_label || "项目所在文件夹")}</option>` : ""}
          <option value="user" ${settings.dataMode === "user" ? "selected" : ""}>用户数据路径（推荐）</option>
          <option value="custom" ${settings.dataMode === "custom" ? "selected" : ""}>自定义路径</option>
        </select>
        <div id="desktopCustomDataBox" class="desktop-custom-path">
          <label for="desktopCustomDataDir">自定义数据根目录</label>
          <div class="upload-line"><input id="desktopCustomDataDir" value="${escAttr(settings.customDataDir || "")}" placeholder="选择或输入绝对路径"><button type="button" onclick="chooseDesktopDataDirectory()">${icon("folder-open")}<span>选择</span></button></div>
        </div>
        <div class="muted">保存数据路径后桌面端会重启，当前 SSH 转发会按已有恢复策略重新连接。</div>` : `
        <label for="webStorageRoot">运行根目录</label>
        <div class="upload-line"><input id="webStorageRoot" value="${escAttr(storage.root || desktopSettings?.base_dir || "")}" placeholder="选择或输入绝对路径"><button type="button" onclick="openStorageDirectoryBrowser()">${icon("folder-open")}<span>浏览</span></button></div>
        <label class="check-row"><input id="webStorageMigrate" type="checkbox" checked> 复制当前数据库、设置和密钥到新目录</label>
        <div class="muted">保存后 TunnelDesk 会自动重启。目标已有数据库时不会覆盖；也可在启动前使用 TUNNELDESK_DATA_DIR 和 TUNNELDESK_SSH_DIR 分别覆盖目录。</div>`}
        <div class="desktop-current-paths"><code>数据：${esc(paths.dataDir || "")}</code><code>密钥：${esc(paths.sshDir || "")}</code></div>
      </div>
      <div class="actions"><button class="primary" type="button" onclick="${configurable ? "saveDesktopSettings(this)" : "saveWebStorageSettings(this)"}">${icon("save")}<span>保存数据路径并重启</span></button></div>
    </div>
  </section>`;
}

async function openStorageDirectoryBrowser(startPath="") {
  const input = $("webStorageRoot");
  const requested = startPath || input?.value.trim() || desktopSettings?.storage?.root || desktopSettings?.base_dir || "";
  try {
    const listing = await api(`/api/storage/directories?path=${encodeURIComponent(requested)}`);
    const modal = $("modal");
    modal.hidden = false;
    modal.innerHTML = `<div class="modal-card wide storage-directory-modal">
      <h2>选择运行根目录</h2>
      <div class="storage-directory-path"><code>${esc(listing.current)}</code></div>
      <div class="storage-directory-roots" aria-label="文件系统根目录">${(listing.roots || []).map((item, index) => `<button type="button" data-storage-root="${index}" class="${item.path === listing.current ? "active" : ""}">${icon("hard-drive")}<span>${esc(item.name)}</span></button>`).join("")}</div>
      <div class="storage-directory-actions"><button id="storageDirectoryUp" type="button" ${listing.parent ? "" : "disabled"}>${icon("corner-left-up")}<span>上一级</span></button><button id="storageDirectorySelect" class="primary" type="button">${icon("folder-check")}<span>选择当前目录</span></button></div>
      <div class="storage-directory-list">${listing.directories.length ? listing.directories.map((item, index) => `<button type="button" data-storage-directory="${index}">${icon("folder")}<span>${esc(item.name)}</span></button>`).join("") : stateView("empty", "当前目录没有子目录")}</div>
      <div class="actions"><button type="button" onclick="closeModal()">取消</button></div>
    </div>`;
    modal.querySelectorAll("[data-storage-directory]").forEach(button => {
      button.onclick = () => openStorageDirectoryBrowser(listing.directories[Number(button.dataset.storageDirectory)].path);
    });
    modal.querySelectorAll("[data-storage-root]").forEach(button => {
      button.onclick = () => openStorageDirectoryBrowser(listing.roots[Number(button.dataset.storageRoot)].path);
    });
    $("storageDirectoryUp").onclick = () => listing.parent && openStorageDirectoryBrowser(listing.parent);
    $("storageDirectorySelect").onclick = () => {
      if (input) input.value = listing.current;
      closeModal();
    };
    refreshIcons();
  } catch (error) {
    notify(error.message || "目录读取失败", "error");
  }
}

async function saveWebStorageSettings(button) {
  const root = $("webStorageRoot")?.value.trim() || "";
  if (!root) return notify("请选择运行根目录", "error");
  if (!await confirmModal("保存后会停止当前转发、迁移数据并重启 TunnelDesk。继续？", "更改数据路径", "保存并重启", "取消", true)) return;
  try {
    setButtonBusy(button, true, "正在保存");
    const result = await api("/api/desktop-settings", {method:"PUT", body:JSON.stringify({root, migrate:Boolean($("webStorageMigrate")?.checked)})});
    notify("数据路径已保存，正在重启 TunnelDesk", "success");
    await waitForStorageRestart(result.data_dir);
  } catch (error) {
    setButtonBusy(button, false);
    notify(error.message || "数据路径保存失败", "error");
  }
}

async function waitForStorageRestart(expectedDataDir) {
  await new Promise(resolve => setTimeout(resolve, 900));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`/api/desktop-settings?restart=${Date.now()}`, {cache:"no-store"});
      if (response.ok) {
        const value = await response.json();
        const dataDir = value.storage?.data_dir || value.paths?.dataDir || "";
        if (!expectedDataDir || dataDir === expectedDataDir) {
          location.reload();
          return;
        }
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("重启等待超时，请手动刷新页面查看状态");
}

function desktopBehaviorPanelHtml() {
  if (!desktopSettings?.available) return "";
  const settings = desktopSettings.settings || {};
  return `<section class="desktop-settings-section">
    <h3>桌面端行为</h3>
    <div class="muted">这些选项只在本机桌面版显示。</div>
    <div class="desktop-settings-grid">
      <div class="desktop-toggle-list">
        <label class="check-row"><input id="desktopOpenAtLogin" type="checkbox" ${settings.openAtLogin ? "checked" : ""}> 开机后自动启动桌面端</label>
        <label class="check-row"><input id="desktopMinimizeToTray" type="checkbox" ${settings.minimizeToTray ? "checked" : ""}> 关闭窗口时最小化到托盘</label>
        <label class="check-row"><input id="desktopStartMinimized" type="checkbox" ${settings.startMinimizedToTray ? "checked" : ""}> 开机自动启动时静默到托盘</label>
        <label class="check-row"><input id="desktopStartupNotification" type="checkbox" ${settings.showStartupNotification ? "checked" : ""}> 启动完成后显示系统通知</label>
      </div>
    </div>
    <div class="actions"><button id="desktopSettingsSaveBtn" class="primary" type="button" onclick="saveDesktopSettings(this)">${icon("save")}<span>保存桌面行为</span></button></div>
  </section>`;
}

function syncDesktopCustomDataMode() {
  const box = $("desktopCustomDataBox");
  if (box) box.hidden = $("desktopDataMode")?.value !== "custom";
}

async function chooseDesktopDataDirectory() {
  try {
    const result = await api("/api/desktop-settings/choose-data-dir", {method:"POST", body:"{}"});
    if (result.path && $("desktopCustomDataDir")) $("desktopCustomDataDir").value = result.path;
  } catch (error) { notify(error.message || "目录选择失败", "error"); }
}

async function saveDesktopSettings(button=$("desktopSettingsSaveBtn")) {
  try {
    setButtonBusy(button, true, "正在保存");
    await api("/api/desktop-settings", {method:"PUT", body:JSON.stringify({
      dataMode:$("desktopDataMode").value,
      customDataDir:$("desktopCustomDataDir").value.trim(),
      openAtLogin:$("desktopOpenAtLogin").checked,
      minimizeToTray:$("desktopMinimizeToTray").checked,
      startMinimizedToTray:$("desktopStartMinimized").checked,
      showStartupNotification:$("desktopStartupNotification").checked
    })});
    notify("桌面设置已保存，TunnelDesk 正在重启", "success");
  } catch (error) {
    setButtonBusy(button, false);
    notify(error.message || "桌面设置保存失败", "error");
  }
}

function runtimeHostValues(value) {
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source.flatMap(item => String(item ?? "").split(/[\s,]+/)).map(item => item.trim()).filter(Boolean))];
}

function runtimePortValue(value, fallback=8088) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function normalizeRuntimeSettingsResponse(value={}) {
  const source = value && typeof value === "object" ? value : {};
  const savedSource = source.saved && typeof source.saved === "object" ? source.saved : source;
  const effectiveSource = source.effective && typeof source.effective === "object"
    ? source.effective
    : {
        ...savedSource,
        listen_hosts:source.actual_hosts || source.effective_hosts || source.requested_hosts || savedSource.listen_hosts,
        listen_port:source.actual_port || source.effective_port || source.requested_port || savedSource.listen_port
      };
  const savedHosts = runtimeHostValues(savedSource.listen_hosts || savedSource.hosts || savedSource.host || "127.0.0.1");
  const effectiveHosts = runtimeHostValues(effectiveSource.listen_hosts || effectiveSource.hosts || effectiveSource.host || savedHosts);
  const available = [
    {address:"127.0.0.1", label:"仅本机", interface:"loopback", internal:true},
    {address:"0.0.0.0", label:"所有 IPv4 网卡", interface:"all", wildcard:true}
  ];
  const known = new Set(available.map(item => item.address));
  const candidates = Array.isArray(source.available_hosts) ? source.available_hosts : [];
  for (const item of candidates) {
    const entry = typeof item === "string" ? {address:item, label:item} : (item || {});
    const address = String(entry.address || "").trim();
    if (!address || known.has(address)) continue;
    known.add(address);
    available.push({...entry, address, label:String(entry.label || `${entry.interface ? `${entry.interface} · ` : ""}${address}`)});
  }
  for (const address of [...savedHosts, ...effectiveHosts]) {
    if (!address || known.has(address)) continue;
    known.add(address);
    available.push({address, label:`当前配置 · ${address}`, interface:"saved"});
  }
  const effectivePort = runtimePortValue(effectiveSource.listen_port ?? effectiveSource.port, runtimePortValue(savedSource.listen_port ?? savedSource.port));
  const fallbackLocalHost = effectiveHosts.find(address => address.startsWith("127.")) || (effectiveHosts.includes("0.0.0.0") ? "127.0.0.1" : effectiveHosts[0]);
  const computedLocalUrl = fallbackLocalHost ? `http://${fallbackLocalHost}:${effectivePort}` : "";
  const computedLanHosts = effectiveHosts.includes("0.0.0.0")
    ? available.filter(entry => !entry.internal && !entry.wildcard && entry.address !== "0.0.0.0").map(entry => entry.address)
    : effectiveHosts.filter(address => address !== "0.0.0.0" && !address.startsWith("127."));
  const reportedLanUrls = Array.isArray(source.lan_urls)
    ? source.lan_urls
    : Array.isArray(effectiveSource.lan_urls)
      ? effectiveSource.lan_urls
      : computedLanHosts.map(address => `http://${address}:${effectivePort}`);
  const hasRuntimeData = Boolean(source.local_url || source.actual_hosts || source.effective || source.listen_hosts || source.saved);
  return {
    ...source,
    sftp_recycle_bin_enabled: savedSource.sftp_recycle_bin_enabled === true,
    saved: {
      ...savedSource,
      listen_hosts: savedHosts.length ? savedHosts : ["127.0.0.1"],
      listen_port: runtimePortValue(savedSource.listen_port ?? savedSource.port),
      sftp_recycle_bin_enabled: savedSource.sftp_recycle_bin_enabled === true
    },
    effective: {
      ...effectiveSource,
      listen_hosts: effectiveHosts.length ? effectiveHosts : ["127.0.0.1"],
      listen_port: effectivePort
    },
    available_hosts: available,
    local_url: String(source.local_url || effectiveSource.local_url || (hasRuntimeData ? computedLocalUrl : "")),
    lan_urls: hasRuntimeData ? reportedLanUrls.map(String).filter(Boolean) : [],
    restart_required: source.restart_required === true,
    error: String(source.error || "")
  };
}

async function loadRuntimeSettings(refreshUi=false) {
  runtimeSettingsMessage = null;
  runtimeSettingsCheck = null;
  try {
    runtimeSettings = normalizeRuntimeSettingsResponse(await api("/api/runtime-settings"));
  } catch (error) {
    runtimeSettings = normalizeRuntimeSettingsResponse({error:error.message || "监听配置加载失败"});
  }
  if (refreshUi) renderRuntimeSettingsPanel();
  return runtimeSettings;
}

function safeRuntimeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function runtimeUrlListHtml(data=runtimeSettings) {
  const localUrl = safeRuntimeUrl(data?.local_url);
  const lanUrls = [...new Set((data?.lan_urls || []).map(safeRuntimeUrl).filter(Boolean))];
  const rows = [];
  if (localUrl) rows.push({label:"本机访问", url:localUrl, icon:"monitor"});
  lanUrls.forEach((url, index) => rows.push({label:lanUrls.length > 1 ? `局域网 ${index + 1}` : "局域网访问", url, icon:"network"}));
  if (!rows.length) return `<div class="runtime-empty muted">当前进程尚未报告可用访问地址，请刷新运行诊断。</div>`;
  return `<div class="runtime-url-list">${rows.map(row => `<a class="runtime-url-row" href="${escAttr(row.url)}" target="_blank" rel="noopener"><span class="runtime-url-icon">${icon(row.icon)}</span><span><strong>${esc(row.label)}</strong><small>${esc(row.url)}</small></span>${icon("external-link")}</a>`).join("")}</div>`;
}

function runtimeHostOptionsHtml(data=runtimeSettings) {
  const selected = new Set(data?.saved?.listen_hosts || ["127.0.0.1"]);
  return (data?.available_hosts || []).map(entry => {
    const address = String(entry.address || "");
    const wildcard = address === "0.0.0.0";
    const detail = wildcard
      ? "包含当前及以后出现的所有 IPv4 网卡"
      : address === "127.0.0.1"
        ? "仅本机可访问（只能从运行 TunnelDesk 的本机访问）"
        : `${entry.interface && entry.interface !== "saved" ? `${entry.interface} · ` : ""}仅绑定此网卡地址`;
    return `<label class="runtime-host-option ${wildcard ? "wildcard" : ""}" data-runtime-host-option="${escAttr(address)}">
      <input type="checkbox" name="runtimeListenHost" value="${escAttr(address)}" ${selected.has(address) ? "checked" : ""} onchange="syncRuntimeHostOptions(this)">
      <span><strong>${esc(entry.label || address)}</strong><small>${esc(detail)}</small></span>
      <code>${esc(address)}</code>
    </label>`;
  }).join("");
}

function runtimeFeedbackHtml() {
  if (runtimeSettingsMessage) {
    const type = runtimeSettingsMessage.type || "info";
    const symbol = type === "success" ? "check-circle-2" : type === "error" ? "circle-alert" : "info";
    return `<div class="runtime-feedback ${escAttr(type)}">${icon(symbol)}<span>${esc(runtimeSettingsMessage.text)}</span></div>`;
  }
  const result = runtimeSettingsCheck;
  if (!result) return "";
  const requestedPort = result.requested_port || result.listen_port || $("runtimeListenPort")?.value || "";
  if (result.error && result.available !== false) return `<div class="runtime-feedback error">${icon("circle-alert")}<span>${esc(result.error)}</span></div>`;
  if (result.available && (result.occupied_by_current || result.current)) {
    return `<div class="runtime-feedback info">${icon("info")}<span>端口 ${esc(requestedPort)} 正由当前 TunnelDesk 使用；保存后仍需重启才能应用新的监听地址。</span></div>`;
  }
  if (result.available) return `<div class="runtime-feedback success">${icon("check-circle-2")}<span>端口 ${esc(requestedPort)} 可用，可以保存此监听配置。</span></div>`;
  const suggestion = runtimePortValue(result.suggested_port, 0);
  const reason = result.code === "EADDRINUSE" || /address already in use|eaddrinuse/i.test(result.error || "")
    ? "该端口已被其他程序占用。"
    : result.code === "EACCES" || /permission denied|eacces/i.test(result.error || "")
      ? "当前账号无权绑定该端口。"
      : result.error ? `检查失败：${result.error}` : "该端口无法绑定。";
  return `<div class="runtime-feedback error">${icon("circle-alert")}<span>端口 ${esc(requestedPort)} 不可用。${esc(reason)}${suggestion ? ` 可尝试端口 ${suggestion}。` : " 请换一个端口后重试。"}</span>${suggestion ? `<button type="button" onclick="useRuntimeSuggestedPort(${suggestion})">使用 ${suggestion}</button>` : ""}</div>`;
}

function runtimeSettingsPanelHtml(data=runtimeSettings) {
  const saved = data?.saved || {listen_hosts:["127.0.0.1"], listen_port:8088};
  const effective = data?.effective || saved;
  const savedText = `${(saved.listen_hosts || []).join("、")}:${saved.listen_port}`;
  const effectiveText = `${(effective.listen_hosts || []).join("、")}:${effective.listen_port}`;
  const overridden = data?.sources?.listen_hosts === "env" || data?.sources?.listen_port === "env" || effective.sources?.listen_hosts === "env" || effective.sources?.listen_port === "env";
  return `<div class="runtime-settings-panel">
    ${data?.error ? `<div class="runtime-feedback error">${icon("circle-alert")}<span>监听配置加载失败：${esc(data.error)}。其他设置不受影响，可以稍后重新加载。</span><button type="button" onclick="loadRuntimeSettings(true)">重新加载</button></div>` : ""}
    <div class="runtime-config-summary">
      <div><span>当前实际监听</span><strong>${esc(effectiveText)}</strong></div>
      <div><span>已保存配置</span><strong>${esc(savedText)}</strong></div>
      ${data?.restart_required ? `<span class="status-pill reconnecting">等待重启</span>` : `<span class="status-pill running">已生效</span>`}
    </div>
    ${overridden ? `<div class="warning">当前进程使用环境变量或启动参数覆盖监听配置。保存仍会写入配置文件，但重启时若继续传入覆盖项，将优先使用覆盖值。</div>` : ""}
    <fieldset class="runtime-host-fieldset">
      <legend>监听地址（可多选）</legend>
      <div class="runtime-host-options">${runtimeHostOptionsHtml(data)}</div>
      <div id="runtimeWildcardHint" class="muted" hidden>已选择所有 IPv4 网卡；其他地址已折叠，取消勾选后可按网卡选择。</div>
    </fieldset>
    <div class="runtime-port-field">
      <label for="runtimeListenPort">监听端口</label>
      <input id="runtimeListenPort" type="number" inputmode="numeric" min="1" max="65535" step="1" value="${escAttr(saved.listen_port)}" oninput="clearRuntimeSettingsFeedback()">
      <span>允许填写 1-65535。保存不会中断当前连接，重启 TunnelDesk 后生效。</span>
    </div>
    <div class="runtime-security-note">${icon("shield-alert")}<div><strong>局域网访问前先确认认证策略</strong><span>选择指定网卡 IP 或 0.0.0.0 后，同一网络中的设备可能访问 TunnelDesk。建议保留 Web 密码并使用“仅局域网访问时校验密码”或“始终校验密码”。0.0.0.0 表示所有 IPv4 网卡，不只代表某一个局域网地址。</span></div></div>
    <div class="actions runtime-config-actions"><button id="runtimeCheckBtn" type="button" onclick="checkRuntimeSettings()">${icon("scan-search")}<span>检查占用</span></button><button id="runtimeSaveBtn" class="primary" type="button" onclick="saveRuntimeSettings()">${icon("save")}<span>保存监听配置</span></button></div>
    <div id="runtimeSettingsFeedback">${runtimeFeedbackHtml()}</div>
  </div>`;
}

function renderRuntimeSettingsPanel() {
  const panel = $("runtimeSettingsPanel");
  if (panel) panel.innerHTML = runtimeSettingsPanelHtml();
  const urls = $("runtimeCurrentUrls");
  if (urls) urls.innerHTML = runtimeUrlListHtml();
  syncRuntimeHostOptions();
}

function renderRuntimeSettingsFeedback() {
  const area = $("runtimeSettingsFeedback");
  if (area) area.innerHTML = runtimeFeedbackHtml();
}

function clearRuntimeSettingsFeedback() {
  runtimeSettingsCheck = null;
  runtimeSettingsMessage = null;
  renderRuntimeSettingsFeedback();
}

function syncRuntimeHostOptions(source=null) {
  const options = [...document.querySelectorAll('[name="runtimeListenHost"]')];
  if (!options.length) return;
  const wildcard = options.find(input => input.value === "0.0.0.0");
  if (source?.value === "0.0.0.0" && source.checked) {
    options.filter(input => input !== wildcard).forEach(input => { input.checked = false; });
  } else if (source?.value !== "0.0.0.0" && source?.checked && wildcard) {
    wildcard.checked = false;
  }
  const collapseOthers = Boolean(wildcard?.checked);
  options.filter(input => input !== wildcard).forEach(input => {
    const row = input.closest(".runtime-host-option");
    if (row) row.hidden = collapseOthers;
  });
  const hint = $("runtimeWildcardHint");
  if (hint) hint.hidden = !collapseOthers;
  if (source) clearRuntimeSettingsFeedback();
}

function runtimeSettingsFormValue() {
  const listen_hosts = [...document.querySelectorAll('[name="runtimeListenHost"]:checked')].map(input => input.value);
  const listen_port = Number($("runtimeListenPort")?.value);
  if (!listen_hosts.length) throw new Error("请至少选择一个监听地址");
  if (!Number.isInteger(listen_port) || listen_port < 1 || listen_port > 65535) throw new Error("监听端口必须是 1-65535 的整数");
  return {listen_hosts, listen_port};
}

async function checkRuntimeSettings() {
  let payload;
  try {
    payload = runtimeSettingsFormValue();
  } catch (error) {
    runtimeSettingsCheck = {error:error.message};
    renderRuntimeSettingsFeedback();
    return;
  }
  const button = $("runtimeCheckBtn");
  setButtonBusy(button, true, "检查中");
  runtimeSettingsMessage = null;
  try {
    runtimeSettingsCheck = await api("/api/runtime-settings/check", {method:"POST", body:JSON.stringify(payload)});
  } catch (error) {
    runtimeSettingsCheck = {error:error.message || "端口占用检查失败"};
  } finally {
    setButtonBusy($("runtimeCheckBtn"), false);
    renderRuntimeSettingsFeedback();
  }
}

function useRuntimeSuggestedPort(port) {
  const input = $("runtimeListenPort");
  if (input) input.value = runtimePortValue(port);
  clearRuntimeSettingsFeedback();
  input?.focus();
}

async function saveRuntimeSettings() {
  let payload;
  try {
    payload = runtimeSettingsFormValue();
  } catch (error) {
    runtimeSettingsMessage = {type:"error", text:error.message};
    renderRuntimeSettingsFeedback();
    return;
  }
  const button = $("runtimeSaveBtn");
  setButtonBusy(button, true, "保存中");
  try {
    const result = await api("/api/runtime-settings", {method:"PUT", body:JSON.stringify(payload)});
    runtimeSettings = normalizeRuntimeSettingsResponse({
      ...runtimeSettings,
      ...result,
      available_hosts:result.available_hosts || runtimeSettings?.available_hosts,
      saved:result.saved || payload,
      effective:result.effective || runtimeSettings?.effective,
      restart_required:result.restart_required !== false
    });
    runtimeSettingsCheck = null;
    runtimeSettingsMessage = {type:"success", text:"监听配置已保存。当前服务不会立即断开，请重启 TunnelDesk 后应用新的地址和端口。"};
    renderRuntimeSettingsPanel();
    notify("监听配置已保存，重启 TunnelDesk 后生效", "success");
  } catch (error) {
    runtimeSettingsMessage = {type:"error", text:error.message || "监听配置保存失败"};
    renderRuntimeSettingsFeedback();
  } finally {
    setButtonBusy($("runtimeSaveBtn"), false);
  }
}

async function saveSftpRecycleBinSetting() {
  const input = $("sftpRecycleBinEnabled");
  const button = $("sftpRecycleBinSave");
  if (!input || !button) return;
  const enabled = input.checked;
  setButtonBusy(button, true, "保存中");
  try {
    const result = await api("/api/runtime-settings", {
      method:"PUT",
      body:JSON.stringify({sftp_recycle_bin_enabled:enabled})
    });
    runtimeSettings = normalizeRuntimeSettingsResponse({
      ...runtimeSettings,
      ...result,
      available_hosts:result.available_hosts || runtimeSettings?.available_hosts,
      saved:result.saved || {...runtimeSettings?.saved, sftp_recycle_bin_enabled:enabled},
      effective:result.effective || runtimeSettings?.effective
    });
    input.checked = runtimeSettings.saved.sftp_recycle_bin_enabled;
    notify(enabled ? "SFTP 回收站已开启" : "SFTP 回收站已关闭", "success");
  } catch (error) {
    input.checked = runtimeSettings?.saved?.sftp_recycle_bin_enabled === true;
    notify(error.message || "SFTP 回收站设置保存失败", "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function openSettings(updateTab=true) {
  setWorkspace("设置", "访问保护、通知、运行信息与开源许可", "settings", "settings", updateTab, true, {kind:"settings"});
  $("view-settings").innerHTML = stateView("loading", "正在加载设置", "正在读取访问保护、运行状态和程序信息。");
  try {
    await loadSecuritySettings();
    try {
      await loadAboutSettings();
    } catch (error) {
      aboutSettings = { product_name:"TunnelDesk", repository_url:"https://github.com/zmide/tunneldesk", load_error:error.message };
    }
    await loadRuntimeSettings();
    await loadDesktopSettings();
    renderSettings();
    refreshUpdateStatus(false);
  } catch (error) {
    $("view-settings").innerHTML = stateView("error", "设置加载失败", error.message, `<button onclick="openSettings(false)">重试</button>`);
  }
}

function renderSettings() {
  const s = securitySettings || {};
  const about = aboutSettings || {};
  const uiState = captureUiState($("view-settings") || document);
  $("view-settings").innerHTML = `<div class="panel settings-panel">
    <div class="workspace-head"><div><h2>设置</h2><div class="subtitle">访问保护、通知、运行信息与开源许可。</div></div></div>
    <div class="settings-layout"><div class="settings-groups">
      <div class="settings-group" id="settings-general">
        <div class="settings-group-head"><h3>通用设置</h3><span>管理桌面端行为和 SFTP 文件操作偏好。</span></div>
        <div class="settings-grid single">
          ${storageSettingsPanelHtml()}
          ${desktopBehaviorPanelHtml()}
          <section>
            <h3>SFTP 回收站</h3>
            <label class="check-row"><input id="sftpRecycleBinEnabled" type="checkbox" ${runtimeSettings?.saved?.sftp_recycle_bin_enabled ? "checked" : ""}> 删除远程文件时先移入回收站</label>
            <div class="muted">默认关闭。开启后，每台远端服务器会在当前 SSH 用户主目录创建 TunnelDesk 专用隐藏目录；关闭只影响之后的删除，不会自动清空已有内容。</div>
            <div class="warning">回收站仍占用远端磁盘空间。永久删除和清空回收站无法撤销。</div>
            <div class="actions"><button id="sftpRecycleBinSave" class="primary" type="button" onclick="saveSftpRecycleBinSetting()">${icon("save")}<span>保存回收站设置</span></button></div>
          </section>
        </div>
      </div>
      <div class="settings-group" id="settings-basic">
        <div class="settings-group-head"><h3>安全设置</h3><span>管理 Web 访问认证、密码、Token 和配置加密。</span></div>
        <div class="settings-grid">
      <section>
        <h3>Web 访问保护</h3>
        <label>认证策略</label>
        <select id="securityAuthMode">
          <option value="lan" ${s.auth_mode === "lan" ? "selected" : ""}>仅局域网访问时校验密码</option>
          <option value="always" ${s.auth_mode === "always" ? "selected" : ""}>始终校验密码</option>
          <option value="off" ${s.auth_mode === "off" ? "selected" : ""}>关闭 Web 密码</option>
        </select>
        <label class="check-row"><input id="securityLanAuth" type="checkbox" ${s.lan_auth_enabled !== false ? "checked" : ""}> 通过局域网或其他非本机地址访问时要求密码</label>
        <label>会话 Cookie 安全模式</label>
        <select id="securitySecureCookieMode">
          <option value="auto" ${(s.secure_cookie_mode || "auto") === "auto" ? "selected" : ""}>自动识别 HTTPS（推荐）</option>
          <option value="always" ${s.secure_cookie_mode === "always" ? "selected" : ""}>始终使用 Secure</option>
          <option value="never" ${s.secure_cookie_mode === "never" ? "selected" : ""}>从不使用 Secure</option>
        </select>
        <label class="check-row"><input id="securityTrustedProxyEnabled" type="checkbox" ${s.trusted_proxy_enabled ? "checked" : ""}> 信任指定的 HTTPS 反向代理</label>
        <label>可信代理 IP</label>
        <input id="securityTrustedProxyAddresses" value="${escAttr((s.trusted_proxy_addresses || []).join(", "))}" placeholder="例如 127.0.0.1, 192.168.1.2">
        <div class="muted">仅来自这些 IP 的请求可以使用 X-Forwarded-For 和 X-Forwarded-Proto。自动模式只在直连 HTTPS 或可信代理明确报告 HTTPS 时发送 Secure Cookie。</div>
        <div class="muted">登录密码在 5 分钟内连续错误 ${Number(s.login_protection?.max_failures || 5)} 次会锁定来源地址 ${Number(s.login_protection?.lock_seconds || 300)} 秒；过期会话会自动清理。</div>
        <div class="warning">关闭局域网密码后，局域网内设备可能直接操作 SSH、SFTP、密钥、转发和批量命令。</div>
        <div class="actions"><button class="primary" onclick="saveSecurityOptions()">保存认证策略</button><button onclick="logout()">退出登录</button></div>
      </section>
      <section>
        <h3>会话管理</h3>
        <label>登录会话有效期（分钟）</label>
        <input id="securitySessionTtlMinutes" type="number" min="${Number(s.session_management?.limits?.ttl_minutes?.min || 5)}" max="${Number(s.session_management?.limits?.ttl_minutes?.max || 43200)}" value="${Number(s.session_management?.ttl_minutes || 720)}">
        <label>最大活动会话数</label>
        <input id="securitySessionMaxSessions" type="number" min="${Number(s.session_management?.limits?.max_sessions?.min || 1)}" max="${Number(s.session_management?.limits?.max_sessions?.max || 10000)}" value="${Number(s.session_management?.max_sessions || 1000)}">
        <label>过期会话清理间隔（分钟）</label>
        <input id="securitySessionCleanupMinutes" type="number" min="${Number(s.session_management?.limits?.cleanup_minutes?.min || 1)}" max="${Number(s.session_management?.limits?.cleanup_minutes?.max || 1440)}" value="${Number(s.session_management?.cleanup_minutes || 10)}">
        <div class="cmd">当前活动会话：${Number(s.active_sessions || 0)}</div>
        <div class="muted">保存后对新会话立即生效。缩短有效期或降低数量上限时，已有会话会同步收紧；过期会话即使尚未到定时清理时间也不能继续使用。</div>
        <div class="actions"><button class="primary" onclick="saveSessionManagement()">${icon("save")}<span>保存会话设置</span></button></div>
      </section>
      <section>
        <h3>密码和 Token</h3>
        <label>设置 Web 密码 <span id="securityPasswordState">${s.password_set ? "（已设置）" : "（未设置）"}</span></label>
        <input id="securityPassword" type="password" placeholder="至少 8 位">
        <div class="muted">Web 密码用于浏览器登录，普通使用、手机访问和局域网访问一般只需要设置这个。</div>
        <div class="actions"><button onclick="saveWebPassword()">保存密码</button></div>
        <label>访问 Token <span id="securityTokenState">${s.token_set ? "（已设置）" : "（未设置）"}</span></label>
        <div class="muted">Token 只给脚本、curl 或第三方工具通过 Bearer Token 调用 API 使用；未设置 Token 时，这类外部 Token 调用不可用。Web 页面和本机访问仍按当前认证策略工作。Token 由系统随机生成，只显示一次。</div>
        <div class="actions"><button id="securityTokenBtn" onclick="generateAccessToken()">${s.token_set ? "重新生成 Token" : "生成 Token"}</button></div>
      </section>
      <section class="security-encryption-section">
        <h3>配置加密</h3>
        <details id="securityAdvancedDetails" class="advanced-settings" open>
          <summary>配置加密 ${s.encryption_enabled ? "（已启用）" : "（可选）"}</summary>
          <div class="muted">配置加密不是普通使用必需项。启用时会自动加密现有和以后保存的私钥路径、额外 SSH 参数；不会加密私钥文件本身。个人或局域网自用场景通常保持关闭即可。</div>
          <div class="warning">启用后，SSH 连接、SFTP、终端、转发和批量命令在使用加密字段前需要先解锁。重启 TunnelDesk 后如果没有解锁，依赖私钥或额外 SSH 参数的连接可能无法正常启动。关闭加密会要求主密码，并把已加密字段解密回普通数据库字段。</div>
          <label>主密码</label>
          <input id="securityMasterPassword" type="password" placeholder="至少 8 位">
          <div class="actions">
            ${s.encryption_enabled ? "" : `<button onclick="enableConfigEncryption()">启用加密</button>`}
            ${s.encryption_enabled ? `<button onclick="unlockConfigEncryption()">解锁</button><button class="danger" onclick="disableConfigEncryption()">解密并关闭</button>` : ""}
          </div>
        </details>
      </section>
        </div>
      </div>
      <div class="settings-group" id="settings-notifications">
        <div class="settings-group-head"><h3>通知设置</h3><span>选择异常和后台任务的提醒方式。</span></div>
        <div class="settings-grid single">
      <section>
        <h3>通知</h3>
        <div class="muted">转发异常、自动重连失败、恢复成功、批量命令完成和 SFTP 后台任务完成会先显示页面提示。授权桌面通知后，浏览器或桌面端也可以显示系统通知。</div>
        <div class="cmd">当前状态：${notificationPermissionText()}</div>
        <label>提醒方式</label>
        <select id="notificationMode">
          <option value="on" ${(s.notification_mode || "on") === "on" ? "selected" : ""}>正常提醒</option>
          <option value="muted" ${s.notification_mode === "muted" ? "selected" : ""}>静音，只记录已读</option>
          <option value="off" ${s.notification_mode === "off" ? "selected" : ""}>关闭提醒</option>
        </select>
        <div class="actions"><button class="primary" onclick="saveNotificationOptions()">保存通知设置</button><button onclick="requestDesktopNotifications()">开启桌面通知</button></div>
      </section>
        </div>
      </div>
      <div class="settings-group" id="settings-runtime">
        <div class="settings-group-head"><h3>启动与运行</h3><span>配置监听地址和端口，查看当前运行诊断。</span></div>
        <div class="settings-grid runtime-settings-grid">
          <section>
            <h3>监听配置</h3>
            <div id="runtimeSettingsPanel">${runtimeSettingsPanelHtml()}</div>
          </section>
          <section>
            <h3>当前访问地址</h3>
            <div class="muted">这些地址来自当前正在运行的 TunnelDesk；保存监听配置后，重启程序才会刷新实际地址。</div>
            <div id="runtimeCurrentUrls">${runtimeUrlListHtml()}</div>
            <h3 class="runtime-diagnostics-title">运行诊断</h3>
            <div class="muted">查看进程、数据目录、日志、Web 启动路径和 PTY 依赖状态。</div>
            <div id="runtimeDiagnostics" class="diagnostics-box muted">尚未加载</div>
            <div class="actions"><button type="button" onclick="loadRuntimeDiagnostics()">${icon("refresh-cw")}<span>刷新诊断</span></button></div>
          </section>
        </div>
      </div>
      <div class="settings-group" id="settings-about">
        <div class="settings-group-head"><h3>关于 TunnelDesk</h3><span>版本、更新、项目地址与开源许可信息。</span></div>
        <div class="settings-grid single">
          <section class="about-section">
            <div class="about-product"><div class="about-mark" aria-hidden="true">TD</div><div><h3>${esc(about.product_name || "TunnelDesk")}</h3><div class="muted">版本 ${esc(about.version || "未知")}</div></div></div>
            <dl class="about-meta">
              <div><dt>开源许可</dt><dd>${esc(about.license_name || "GNU General Public License v3.0 only")}（${esc(about.license || "GPL-3.0-only")}）</dd></div>
              <div><dt>项目作者</dt><dd>${esc(about.author || "zmide")}</dd></div>
              <div><dt>版权</dt><dd>Copyright (C) 2026 zmide</dd></div>
            </dl>
            ${about.load_error || about.license_error ? `<div class="warning">程序版本与许可信息加载失败：${esc(about.load_error || about.license_error)}</div>` : ""}
            <div id="updateCheckArea">${updateStatusHtml()}</div>
            <div class="muted">本软件按现状提供，不附带任何担保。使用、修改和再分发须遵守 GNU GPL v3.0 条款。</div>
            <div class="actions about-actions"><a class="button-link" href="${escAttr(about.repository_url || "https://github.com/zmide/tunneldesk")}" target="_blank" rel="noopener">${icon("github")}<span>GitHub 源码</span></a><button id="openLicenseBtn" onclick="showLicenseModal()">${icon("scroll-text")}<span>查看开源许可正文</span></button></div>
          </section>
        </div>
      </div>
    </div></div>
  </div>`;
  restoreUiState(uiState);
  showSettingsSection(activeSettingsSection, {moveToWorkspace:false});
  syncRuntimeHostOptions();
  syncDesktopCustomDataMode();
  syncUpdateNoticeForCurrentSection();
}

function updateStatusHtml() {
  const update = updateSettings;
  if (!update) {
    return `<div class="update-card"><div class="update-card-head"><strong>GitHub Release 更新</strong><span>正在读取版本信息</span></div><div class="update-status checking"><div><strong>正在检查更新</strong><span>正在读取 GitHub Releases。</span></div><span class="status-pill">检查中</span></div><div class="actions update-actions"><button id="checkUpdateBtn" onclick="refreshUpdateStatus(true)">${icon("refresh-cw")}<span>重新检查</span></button></div></div>`;
  }
  if (update.error) {
    return `<div class="update-card"><div class="update-card-head"><strong>GitHub Release 更新</strong><span>检查失败</span></div><div class="update-status failed"><div><strong>暂时无法检查更新</strong><span>${esc(update.error)}</span></div><span class="status-pill failed">失败</span></div><div class="actions update-actions"><button id="checkUpdateBtn" onclick="refreshUpdateStatus(true)">${icon("refresh-cw")}<span>重试</span></button></div></div>`;
  }
  const currentVersion = update.current_version ? `v${String(update.current_version).replace(/^v/i, "")}` : "当前版本未知";
  if (!update.latest_version) {
    return `<div class="update-card"><div class="update-card-head"><strong>GitHub Release 更新</strong><span>${esc(currentVersion)}</span></div><div class="update-status"><div><strong>尚未检查更新</strong><span>启动检查完成后会自动更新此处。</span></div><span class="status-pill">待检查</span></div><div class="actions update-actions"><button id="checkUpdateBtn" onclick="refreshUpdateStatus(true)">${icon("refresh-cw")}<span>立即检查</span></button></div></div>`;
  }
  const latestVersion = update.latest_version ? `v${String(update.latest_version).replace(/^v/i, "")}` : "尚无正式版本";
  const checkedAt = update.checked_at ? new Date(update.checked_at).toLocaleString("zh-CN", {hour12:false}) : "尚未检查";
  const publishedAt = update.published_at ? new Date(update.published_at).toLocaleDateString("zh-CN") : "";
  const download = update.download_status || {};
  const progress = Math.max(0, Math.min(100, Number(download.progress_percent || 0)));
  const statusLabel = download.state === "downloading"
    ? "下载中"
    : download.state === "downloaded"
      ? "已下载并校验"
      : download.state === "failed"
        ? "下载失败"
        : update.update_available ? "可更新" : "已是最新版";
  const resourceName = download.selected_asset_name || download.asset_name || "未找到当前平台资源";
  const platformLabels = {win32:"Windows", darwin:"macOS", linux:"Linux"};
  const packageLabels = {portable:"便携版", installer:"安装版", dmg:"DMG", zip:"ZIP", appimage:"AppImage", deb:"DEB", rpm:"RPM"};
  const target = [platformLabels[download.platform] || download.platform, download.arch, packageLabels[download.package_type] || download.package_type].filter(Boolean).join(" · ");
  const progressText = download.state === "downloading"
    ? `${Math.round(progress)}% · ${formatUpdateBytes(download.bytes_downloaded)} / ${formatUpdateBytes(download.size || download.selected_asset_size)}`
    : download.state === "downloaded"
      ? `100% · ${formatUpdateBytes(download.size)}`
      : `${Math.round(progress)}%`;
  const notes = updateReleaseNotesHtml(update);
  const releaseUrl = safeGitHubReleaseUrl(update.release_url);
  const releaseLink = releaseUrl ? `<a class="button-link" href="${escAttr(releaseUrl)}" target="_blank" rel="noopener">${icon("external-link")}<span>查看 Release</span></a>` : "";
  const downloadedCurrent = download.state === "downloaded"
    && String(download.version || "").replace(/^v/i, "") === String(update.latest_version || "").replace(/^v/i, "")
    && Boolean(download.asset_name)
    && download.asset_name === download.selected_asset_name;
  const openDirectoryAction = download.can_open_directory
    ? `<button onclick="openDownloadedUpdateDirectory()">${icon("folder-open")}<span>打开下载目录</span></button>`
    : "";
  const redownloadAction = downloadedCurrent
    ? `<button id="downloadUpdateBtn" onclick="downloadUpdatePackage(true)">${icon("download")}<span>重新下载</span></button>`
    : "";
  const downloadAction = update.update_available
    ? downloadedCurrent
      ? download.package_type === "portable"
        ? `${openDirectoryAction || `<span class="muted">便携版已下载并通过校验；请在运行设备的 updates 目录中找到文件，关闭旧版本后手动替换。</span>`}${redownloadAction}`
        : `${download.can_open ? `<button class="primary" onclick="openDownloadedUpdate()">${icon("package-open")}<span>打开已校验安装包</span></button>` : ""}${openDirectoryAction || (!download.can_open ? `<span class="muted">安装包已下载并通过校验；请在运行设备的 updates 目录中手动安装。</span>` : "")}${redownloadAction}`
      : download.state === "downloading"
        ? `<button id="downloadUpdateBtn" disabled>${icon("download")}<span>正在下载</span></button>`
        : `<button id="downloadUpdateBtn" class="primary" onclick="downloadUpdatePackage()">${icon("download")}<span>${download.state === "failed" ? "重新下载并校验" : "下载并校验"}</span></button>`
    : "";
  const downloadError = download.state === "failed" && download.error ? `<div class="warning">更新下载失败：${esc(download.error)}</div>` : "";
  const ignoreControl = update.update_available
    ? `<label class="check-row update-ignore-row"><input id="updateIgnoreCurrentVersion" type="checkbox" ${update.update_ignored ? "checked" : ""} onchange="setUpdateVersionIgnored(this)"> 忽略 ${esc(latestVersion)} 的更新提醒</label><div class="muted update-ignore-help">只隐藏该版本的提示弹窗和红点，关于页面仍可正常下载；出现更高版本时会自动恢复提醒。</div>`
    : "";
  return `<div class="update-card">
    <div class="update-card-head"><strong>GitHub Release 更新</strong><span>当前版本 ${esc(currentVersion)}</span></div>
    <dl class="update-details">
      <div><dt>状态</dt><dd><span class="status-pill ${download.state === "failed" ? "failed" : update.update_available ? "reconnecting" : "running"}">${esc(statusLabel)}</span><small>最近检查 ${esc(checkedAt)}</small></dd></div>
      <div><dt>最新版本</dt><dd><strong>${esc(latestVersion)}</strong>${publishedAt ? `<small>发布于 ${esc(publishedAt)}</small>` : ""}</dd></div>
      <div><dt>资源</dt><dd><strong title="${escAttr(resourceName)}">${esc(resourceName)}</strong>${target ? `<small>${esc(target)}</small>` : ""}</dd></div>
      <div><dt>进度</dt><dd><strong>${esc(progressText)}</strong><div class="update-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}"><i style="width:${progress}%"></i></div></dd></div>
    </dl>
    ${notes}${downloadError}
    <div class="actions update-actions"><button id="checkUpdateBtn" onclick="refreshUpdateStatus(true)">${icon("refresh-cw")}<span>检查更新</span></button>${downloadAction}${releaseLink}</div>
    ${ignoreControl}
    <div class="muted">自动匹配运行 TunnelDesk 主机的平台、架构和 Windows 安装类型；只接受 GitHub HTTPS 资源及匹配的 SHA-256，不会静默安装或自动回滚。</div>
  </div>`;
}

function updateReleaseNotesHtml(update) {
  const history = Array.isArray(update?.release_notes) && update.release_notes.length
    ? update.release_notes.slice(0, 2)
    : update?.notes
      ? [{version:update.latest_version, published_at:update.published_at, notes:update.notes}]
      : [];
  if (!history.length) return "";
  return `<div class="update-notes"><strong>最近版本更新内容</strong><div class="update-release-list">${history.map((item, index) => {
    const version = String(item?.version || "").replace(/^v/i, "");
    const published = item?.published_at ? new Date(item.published_at).toLocaleDateString("zh-CN") : "";
    return `<section class="update-release-entry"><div class="update-release-head"><b>${version ? `v${esc(version)}` : index === 0 ? "最新版本" : "上一版本"}</b>${index === 0 ? `<span class="status-pill running">最新</span>` : ""}${published ? `<small>${esc(published)}</small>` : ""}</div><pre>${esc(String(item?.notes || "暂无更新说明").slice(0, 6000))}</pre></section>`;
  }).join("")}</div></div>`;
}

function formatUpdateBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function safeGitHubReleaseUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.includes("/releases/") ? url.href : "";
  } catch {
    return "";
  }
}

async function refreshUpdateStatus(force=false) {
  const button = $("checkUpdateBtn");
  setButtonBusy(button, true, "检查中");
  try {
    const status = await api(`/api/updates/check${force ? "?force=1" : ""}`);
    const download = await api("/api/updates/download/status").catch(()=>null);
    updateSettings = status;
    if (download) updateSettings.download_status = download;
    const area = $("updateCheckArea");
    if (area) area.innerHTML = updateStatusHtml();
    syncUpdateNoticeForCurrentSection();
    if (force && !updateSettings.update_ignored) notify(updateSettings.update_available ? `发现新版本 v${String(updateSettings.latest_version || "").replace(/^v/i, "")}` : "当前已经是最新版本", updateSettings.update_available ? "info" : "success");
  } catch (error) {
    updateSettings = { error:error.message || "连接 GitHub 失败" };
    const area = $("updateCheckArea");
    if (area) area.innerHTML = updateStatusHtml();
    syncUpdateNoticeForCurrentSection();
    if (force) notify(updateSettings.error, "error");
  } finally {
    setButtonBusy($("checkUpdateBtn"), false);
  }
}

async function setUpdateVersionIgnored(input) {
  const enabled = Boolean(input?.checked);
  if (input) input.disabled = true;
  try {
    const status = await api(`/api/updates/ignore?enabled=${enabled ? "1" : "0"}`, {method:"POST", body:"{}"});
    const downloadStatus = updateSettings?.download_status;
    updateSettings = status;
    if (downloadStatus) updateSettings.download_status = downloadStatus;
    if (!enabled && updateNoticeReadVersion === currentUpdateNoticeVersion()) {
      updateNoticeReadVersion = "";
      try { sessionStorage.removeItem(UPDATE_NOTICE_SESSION_KEY); } catch {}
    }
    const area = $("updateCheckArea");
    if (area) {
      area.innerHTML = updateStatusHtml();
      refreshIcons();
    }
    syncUpdateNoticeDots();
    notify(enabled ? `已忽略 v${currentUpdateNoticeVersion()} 的更新提示` : `已恢复 v${currentUpdateNoticeVersion()} 的更新提示`, "success");
  } catch (error) {
    if (input) input.checked = !enabled;
    notify(error.message || "更新提醒设置保存失败", "error");
  } finally {
    const current = $("updateIgnoreCurrentVersion");
    if (current) current.disabled = false;
  }
}

function stopUpdateDownloadPolling() {
  if (updateDownloadPollingTimer) clearInterval(updateDownloadPollingTimer);
  updateDownloadPollingTimer = null;
}

async function refreshUpdateDownloadProgress() {
  try {
    const download = await api("/api/updates/download/status");
    if (!updateSettings) return;
    updateSettings.download_status = download;
    const area = $("updateCheckArea");
    if (area) {
      area.innerHTML = updateStatusHtml();
      refreshIcons();
    }
    if (download.state !== "downloading") stopUpdateDownloadPolling();
  } catch {}
}

function startUpdateDownloadPolling() {
  if (updateDownloadPollingTimer) return;
  updateDownloadPollingTimer = setInterval(refreshUpdateDownloadProgress, 500);
}

async function downloadUpdatePackage(redownload=false) {
  if (!await confirmModal(
    `${redownload ? "将重新下载并覆盖当前已下载的更新文件。" : "将从 GitHub Release 下载当前系统的安装产物。"}下载完成后会严格校验 GitHub 提供的 SHA-256 摘要，不会自动安装，也不会关闭当前程序。继续？`,
    redownload ? "重新下载更新" : "下载并校验更新",
    redownload ? "重新下载" : "开始下载",
    "取消"
  )) return;
  const button = $("downloadUpdateBtn");
  setButtonBusy(button, true, "下载中");
  try {
    const request = api("/api/updates/download", {method:"POST", body:"{}"});
    startUpdateDownloadPolling();
    const result = await request;
    updateSettings.download_status = result;
    $("updateCheckArea").innerHTML = updateStatusHtml();
    refreshIcons();
    notify("更新安装包已下载并通过 SHA-256 校验", "success");
  } catch (error) {
    updateSettings.download_status = {state:"failed", error:error.message};
    $("updateCheckArea").innerHTML = updateStatusHtml();
    refreshIcons();
    notify(error.message, "error");
  } finally {
    stopUpdateDownloadPolling();
    setButtonBusy($("downloadUpdateBtn"), false);
  }
}

async function openDownloadedUpdate() {
  if (updateSettings?.download_status?.package_type === "portable") {
    return openDownloadedUpdateDirectory();
  }
  if (!await confirmModal(
    "将交给系统打开已校验的安装包。安装程序会处理正在运行的旧版本；如果需要手动操作，也可以取消后选择“打开下载目录”。继续？",
    "打开更新安装包",
    "打开安装包",
    "取消"
  )) return;
  await api("/api/updates/open", {method:"POST", body:"{}"});
  notify("已交给系统打开安装包", "success");
}

async function openDownloadedUpdateDirectory() {
  const portable = updateSettings?.download_status?.package_type === "portable";
  const message = portable
    ? "将打开便携版所在目录。请先关闭当前 TunnelDesk，再用新版本文件替换旧版本并重新启动；运行中的便携版不会自动覆盖自身。"
    : "将打开已校验安装包所在目录，方便手动运行、复制或留存安装包。";
  if (!await confirmModal(
    message,
    "打开更新下载目录",
    "打开目录",
    "取消"
  )) return;
  await api("/api/updates/open-directory", {method:"POST", body:"{}"});
  notify(portable ? "已打开下载目录，请关闭旧版本后手动替换" : "已打开更新下载目录", "success");
}

async function openSettingsSection(id) {
  activeSettingsSection = normalizeSettingsSection(id);
  if (activeView !== "settings") await openSettings();
  showSettingsSection(activeSettingsSection);
}

function showSettingsSection(id, options={}) {
  const next = normalizeSettingsSection(id);
  activeSettingsSection = next;
  $("view-settings")?.querySelectorAll(".settings-group").forEach(group => {
    group.hidden = group.id !== next;
  });
  setExplorerSectionActive(next);
  if (activeView === "settings" && $("workspaceSubtitle")) $("workspaceSubtitle").textContent = SETTINGS_SECTION_META[next];
  if (next === "settings-about") markUpdateNoticeRead();
  if (options.moveToWorkspace !== false) {
    document.querySelector(".workspace")?.scrollTo?.({top:0, behavior:"auto"});
    if (isMobileLayout()) showMobileWorkspace();
  }
}

function scrollToSetting(id) {
  showSettingsSection(id);
}

function closeLicenseModal() {
  const modal = $("modal");
  if (licenseModalKeyHandler) document.removeEventListener("keydown", licenseModalKeyHandler);
  licenseModalKeyHandler = null;
  modal.onclick = null;
  modal.hidden = true;
  modal.innerHTML = "";
  $("openLicenseBtn")?.focus();
}

async function showLicenseModal() {
  const trigger = $("openLicenseBtn");
  try {
    const about = aboutSettings?.license_text ? aboutSettings : await loadAboutSettings();
    if (!about.license_text) throw new Error(about.license_error || "未找到随程序提供的开源许可正文");
    const modal = $("modal");
    modal.innerHTML = `<div class="modal-card wide license-modal" role="dialog" aria-modal="true" aria-labelledby="licenseModalTitle">
      <div class="license-modal-head"><div><h2 id="licenseModalTitle">GNU General Public License v3.0</h2><span>${esc(about.product_name || "TunnelDesk")} · ${esc(about.license || "GPL-3.0-only")}</span></div><button id="licenseModalClose" class="icon-button" type="button" title="关闭许可正文" aria-label="关闭许可正文">${icon("x")}</button></div>
      <pre id="licenseText" class="license-text" tabindex="0"></pre>
      <div class="actions"><button type="button" onclick="closeLicenseModal()">关闭</button></div>
    </div>`;
    $("licenseText").textContent = about.license_text || "未找到开源许可正文。";
    modal.hidden = false;
    modal.onclick = event => {
      if (event.target === modal) closeLicenseModal();
    };
    $("licenseModalClose").onclick = closeLicenseModal;
    licenseModalKeyHandler = event => {
      if (event.key === "Escape") closeLicenseModal();
    };
    document.addEventListener("keydown", licenseModalKeyHandler);
    $("licenseModalClose").focus();
  } catch (error) {
    trigger?.focus();
    notify(`许可正文加载失败：${error.message}`, "error");
  }
}

async function loadRuntimeDiagnostics() {
  const box = $("runtimeDiagnostics");
  if (!box) return;
  box.textContent = "正在加载...";
  try {
    const data = await api("/api/diagnostics/runtime");
    let webInfo = null;
    try { webInfo = typeof data.web_info === "string" ? JSON.parse(data.web_info) : data.web_info; } catch {}
    const ptyHelper = data.platform === "win32"
      ? "Windows ConPTY"
      : data.platform !== "darwin"
        ? "当前平台不依赖 spawn-helper"
      : data.pty?.helper_exists
        ? `${data.pty.helper_executable ? "可执行" : "不可执行"} · ${data.pty.helper_path}`
        : "未找到";
    const localUrl = safeRuntimeUrl(data.web_url || webInfo?.local_url || runtimeSettings?.local_url);
    const lanUrls = [...new Set((data.lan_urls || webInfo?.lan_urls || runtimeSettings?.lan_urls || []).map(safeRuntimeUrl).filter(Boolean))];
    runtimeSettings = normalizeRuntimeSettingsResponse({...runtimeSettings, local_url:localUrl, lan_urls:lanUrls});
    const urls = $("runtimeCurrentUrls");
    if (urls) urls.innerHTML = runtimeUrlListHtml();
    const actualHosts = runtimeHostValues(webInfo?.hosts || webInfo?.host || runtimeSettings?.effective?.listen_hosts);
    const actualPort = runtimePortValue(webInfo?.port ?? runtimeSettings?.effective?.listen_port);
    const ptyStatus = data.pty?.operational
      ? "可用"
      : data.pty?.available
        ? "组件已加载，但运行条件不完整"
        : `不可用（${data.pty?.error || "optional 依赖未安装或加载失败"}）`;
    const rows = [
      ["进程", `PID ${data.pid} · ${data.platform}/${data.arch} · ${data.node}`],
      ["实际监听", `${actualHosts.join("、") || "未知"}:${actualPort}`],
      ["本机地址", localUrl || "未生成"],
      ["局域网地址", lanUrls.join("，") || "无"],
      ["数据目录", data.data_dir || "未知"],
      ["日志目录", data.log_dir || "未知"],
      ["Web 日志", data.web_log || "未知"],
      ["PTY", ptyStatus],
      ["PTY 辅助程序", ptyHelper]
    ];
    box.className = "diagnostics-box";
    box.innerHTML = `<dl class="runtime-diagnostic-grid">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>`;
  } catch (error) {
    box.className = "diagnostics-box error";
    box.textContent = error.message;
  }
}

function notificationPermissionText() {
  if (typeof Notification === "undefined") return "当前浏览器不支持系统通知，仍会显示页面提示";
  return { granted: "已授权系统通知", denied: "浏览器已拒绝系统通知，仍会显示页面提示", default: "未授权，仅显示页面提示" }[Notification.permission] || Notification.permission;
}

function updateSecurityBadges() {
  const s = securitySettings || {};
  if ($("securityPasswordState")) $("securityPasswordState").textContent = s.password_set ? "（已设置）" : "（未设置）";
  if ($("securityTokenState")) $("securityTokenState").textContent = s.token_set ? "（已设置）" : "（未设置）";
  if ($("securityTokenBtn")) $("securityTokenBtn").textContent = s.token_set ? "重新生成 Token" : "生成 Token";
}

async function saveSecurityOptions() {
  const auth_mode = $("securityAuthMode").value;
  const lan_auth_enabled = $("securityLanAuth").checked;
  const secure_cookie_mode = $("securitySecureCookieMode")?.value || "auto";
  const trusted_proxy_enabled = Boolean($("securityTrustedProxyEnabled")?.checked);
  const trusted_proxy_addresses = String($("securityTrustedProxyAddresses")?.value || "").split(/[\s,]+/).filter(Boolean);
  let confirm_unsafe = false;
  if (auth_mode === "off" || !lan_auth_enabled) {
    confirm_unsafe = await confirmModal("关闭局域网访问密码会让同一局域网内设备直接操作 TunnelDesk。确认关闭？", "高风险设置", "确认关闭", "取消", true);
    if (!confirm_unsafe) return;
  }
  securitySettings = await api("/api/security", {method:"PUT", body:JSON.stringify({auth_mode, lan_auth_enabled, secure_cookie_mode, trusted_proxy_enabled, trusted_proxy_addresses, confirm_unsafe})});
  notify("安全策略已保存", "success");
}

async function saveSessionManagement() {
  const session_ttl_minutes = Number($("securitySessionTtlMinutes").value);
  const session_max_sessions = Number($("securitySessionMaxSessions").value);
  const session_cleanup_minutes = Number($("securitySessionCleanupMinutes").value);
  securitySettings = await api("/api/security", {
    method:"PUT",
    body:JSON.stringify({session_ttl_minutes, session_max_sessions, session_cleanup_minutes})
  });
  renderSettings();
  refreshIcons();
  notify("会话设置已保存", "success");
}

async function saveNotificationOptions() {
  const notification_mode = $("notificationMode")?.value || "on";
  securitySettings = await api("/api/security", {method:"PUT", body:JSON.stringify({notification_mode})});
  notify(notification_mode === "on" ? "通知已开启" : notification_mode === "muted" ? "通知已静音" : "通知已关闭", "success");
}

async function saveWebPassword() {
  const password = $("securityPassword").value;
  securitySettings = await api("/api/security/password", {method:"POST", body:JSON.stringify({password})});
  $("securityPassword").value = "";
  updateSecurityBadges();
  notify("Web 密码已保存", "success");
}

async function generateAccessToken() {
  if (securitySettings?.token_set && !await confirmModal("重新生成 Token 后，旧 Token 会立即失效。继续？", "重新生成 Token", "继续", "取消", true)) return;
  const result = await api("/api/security/token", {method:"POST", body:JSON.stringify({})});
  securitySettings = result;
  updateSecurityBadges();
  await inputModal("访问 Token 只显示一次", "请保存这个 Token", result.token || "");
  notify("访问 Token 已生成", "success");
}

async function enableConfigEncryption() {
  const password = $("securityMasterPassword").value;
  const result = await api("/api/security/encryption/enable", {method:"POST", body:JSON.stringify({password})});
  await loadSecuritySettings();
  renderSettings();
  notify(`配置加密已启用，已处理 ${result.encrypted_rows || 0} 个连接`, "success");
}

async function unlockConfigEncryption() {
  const password = $("securityMasterPassword").value;
  await api("/api/security/encryption/unlock", {method:"POST", body:JSON.stringify({password})});
  notify("配置加密已解锁", "success");
}

async function disableConfigEncryption() {
  const password = $("securityMasterPassword").value;
  if (securitySettings?.encryption_enabled && !password) return notify("请输入主密码后再关闭配置加密", "error");
  if (!await confirmModal("关闭配置加密会先用主密码解密已加密字段，再关闭加密。关闭后可以使用普通数据库备份迁移。确认关闭？", "关闭配置加密", "解密并关闭", "取消", true)) return;
  const result = await api("/api/security/encryption/disable", {method:"POST", body:JSON.stringify({password})});
  await loadSecuritySettings();
  renderSettings();
  notify(`配置加密已关闭，已解密 ${result.decrypted_rows || 0} 个连接`, "success");
}

async function logout() {
  await api("/api/auth/logout", {method:"POST"});
  location.href = "/login";
}
