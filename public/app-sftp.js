let sftpListResizeObserver = null;
let sftpListResizeFrame = 0;
const sftpKnownJobStatuses = new Map();
const sftpPendingDirectoryRefreshes = new Set();
const SFTP_MUTATING_JOB_TYPES = new Set(["upload", "copy", "cross-copy", "move", "extract", "compress"]);
const SFTP_DIRECTORY_VIEW_CACHE_TTL_MS = 10 * 60 * 1000;
const SFTP_DIRECTORY_VIEW_CACHE_MAX_DIRECTORIES = 60;
const SFTP_DIRECTORY_VIEW_CACHE_MAX_ENTRIES = 5000;
const SFTP_DIRECTORY_SIZE_CACHE_TTL_MS = 10 * 60 * 1000;
const SFTP_DIRECTORY_SIZE_CACHE_MAX_ENTRIES = 200;
const sftpFilenameEncodingOptions = [
  ["utf8", "UTF-8"],
  ["gb18030", "GB18030"],
  ["gbk", "GBK"],
  ["big5", "Big5"],
  ["shift_jis", "Shift_JIS"],
  ["euc-kr", "EUC-KR"],
  ["latin1", "ISO-8859-1"]
];
let sftpLatestJobs = [];
let sftpRecycleBinConnectionId = 0;

function joinRemotePath(base, name) {
  const rawBase = String(base || ".").replace(/\\/g, "/");
  const cleanBase = rawBase === "/" ? "/" : (rawBase.replace(/\/+$/,"") || ".");
  const cleanName = String(name || "").replace(/^\/+/, "");
  if (cleanBase === "/") return `/${cleanName}`;
  return cleanBase === "." ? cleanName : `${cleanBase}/${cleanName}`;
}

function parentRemotePath(path) {
  const raw = String(path || ".").replace(/\\/g, "/");
  if (raw === "/") return "/";
  const clean = raw.replace(/\/+$/,"");
  if (!clean || clean === ".") return ".";
  const index = clean.lastIndexOf("/");
  if (index === 0 && clean.startsWith("/")) return "/";
  return index < 0 ? "." : clean.slice(0, index);
}

function normalizeSftpDirectoryCachePath(value) {
  const path = String(value || ".").replace(/\\/g, "/");
  if (path === "/") return "/";
  return path.replace(/\/+$/, "") || ".";
}

function sftpDirectoryViewCacheKey(connectionId, remotePath) {
  return `${Number(connectionId)}\0${normalizeSftpDirectoryCachePath(remotePath)}`;
}

function resolvedSftpDirectoryViewCacheKey(connectionId, remotePath) {
  const requested = sftpDirectoryViewCacheKey(connectionId, remotePath);
  return sftpDirectoryViewAliases.get(requested) || requested;
}

function removeSftpDirectoryViewCacheEntry(key) {
  sftpDirectoryViewCache.delete(key);
  for (const [alias, target] of sftpDirectoryViewAliases) {
    if (alias === key || target === key) sftpDirectoryViewAliases.delete(alias);
  }
}

function pruneSftpDirectoryViewCache(now=Date.now()) {
  for (const [key, cached] of sftpDirectoryViewCache) {
    if (now - Number(cached.lastAccess || cached.cachedAt || 0) > SFTP_DIRECTORY_VIEW_CACHE_TTL_MS) {
      removeSftpDirectoryViewCacheEntry(key);
    }
  }
  let totalEntries = [...sftpDirectoryViewCache.values()]
    .reduce((sum, cached) => sum + Number(cached.state?.entries?.length || 0), 0);
  while (
    sftpDirectoryViewCache.size > SFTP_DIRECTORY_VIEW_CACHE_MAX_DIRECTORIES
    || totalEntries > SFTP_DIRECTORY_VIEW_CACHE_MAX_ENTRIES
  ) {
    const oldestKey = sftpDirectoryViewCache.keys().next().value;
    if (oldestKey === undefined) break;
    totalEntries -= Number(sftpDirectoryViewCache.get(oldestKey)?.state?.entries?.length || 0);
    removeSftpDirectoryViewCacheEntry(oldestKey);
  }
}

function cloneSftpDirectoryViewState(state) {
  return {
    ...state,
    entries:(state?.entries || []).map(entry => ({...entry})),
    selected:state?.selected ? {...state.selected} : null,
    loading:false
  };
}

function cloneSftpScrollState(state) {
  if (!state) return null;
  return {...state, selectedPaths:[...(state.selectedPaths || [])]};
}

function getCachedSftpDirectoryView(connectionId, remotePath) {
  pruneSftpDirectoryViewCache();
  const key = resolvedSftpDirectoryViewCacheKey(connectionId, remotePath);
  const cached = sftpDirectoryViewCache.get(key);
  if (!cached) return null;
  cached.lastAccess = Date.now();
  sftpDirectoryViewCache.delete(key);
  sftpDirectoryViewCache.set(key, cached);
  return cached;
}

function cacheSftpDirectoryView(tabKey=activeTabKey, requestedPath=sftpState.path, viewState=captureSftpViewState()) {
  if (!String(tabKey || "").startsWith("sftp-") || !Number(sftpState.connectionId)) return null;
  const now = Date.now();
  const state = cloneSftpDirectoryViewState(sftpState);
  const canonicalKey = sftpDirectoryViewCacheKey(state.connectionId, state.path);
  const requestedKey = sftpDirectoryViewCacheKey(state.connectionId, requestedPath);
  removeSftpDirectoryViewCacheEntry(canonicalKey);
  const cached = {
    needsReload:Boolean(sftpState.loading),
    state,
    viewState:cloneSftpScrollState(viewState),
    cachedAt:now,
    lastAccess:now
  };
  sftpDirectoryViewCache.set(canonicalKey, cached);
  sftpDirectoryViewAliases.set(canonicalKey, canonicalKey);
  sftpDirectoryViewAliases.set(requestedKey, canonicalKey);
  pruneSftpDirectoryViewCache(now);
  return cached;
}

function clearSftpDirectoryViewCache(tabKey) {
  const connectionId = Number(String(tabKey || "").replace(/^sftp-/, ""));
  if (!connectionId) return;
  const prefix = `${connectionId}\0`;
  for (const key of [...sftpDirectoryViewCache.keys()]) {
    if (key.startsWith(prefix)) removeSftpDirectoryViewCacheEntry(key);
  }
  for (const key of [...sftpDirectoryViewAliases.keys()]) {
    if (key.startsWith(prefix)) sftpDirectoryViewAliases.delete(key);
  }
  clearSftpDirectorySizeCache(connectionId);
}

function sftpDirectorySizeCacheKey(connectionId, remotePath) {
  return `${Number(connectionId)}\0${normalizeSftpDirectoryCachePath(remotePath)}`;
}

function pruneSftpDirectorySizeCache(now=Date.now()) {
  for (const [key, record] of sftpDirectorySizeCache) {
    if (record.status !== "loading" && now - Number(record.lastAccess || record.updatedAt || 0) > SFTP_DIRECTORY_SIZE_CACHE_TTL_MS) {
      sftpDirectorySizeCache.delete(key);
    }
  }
  while (sftpDirectorySizeCache.size > SFTP_DIRECTORY_SIZE_CACHE_MAX_ENTRIES) {
    const oldestKey = sftpDirectorySizeCache.keys().next().value;
    if (oldestKey === undefined) break;
    sftpDirectorySizeCache.delete(oldestKey);
  }
}

function getSftpDirectorySizeRecord(connectionId, remotePath) {
  pruneSftpDirectorySizeCache();
  const key = sftpDirectorySizeCacheKey(connectionId, remotePath);
  const record = sftpDirectorySizeCache.get(key);
  if (!record) return null;
  record.lastAccess = Date.now();
  sftpDirectorySizeCache.delete(key);
  sftpDirectorySizeCache.set(key, record);
  return record;
}

function setSftpDirectorySizeRecord(connectionId, remotePath, record) {
  const key = sftpDirectorySizeCacheKey(connectionId, remotePath);
  const now = Date.now();
  sftpDirectorySizeCache.delete(key);
  sftpDirectorySizeCache.set(key, {...record, updatedAt:now, lastAccess:now});
  pruneSftpDirectorySizeCache(now);
}

function clearSftpDirectorySizeCache(connectionId) {
  const prefix = `${Number(connectionId)}\0`;
  for (const key of [...sftpDirectorySizeCache.keys()]) {
    if (key.startsWith(prefix)) sftpDirectorySizeCache.delete(key);
  }
}

function sftpDirectorySizePresentation(record) {
  if (record?.status === "loading") return {
    className:"is-loading",
    label:"读取中",
    title:"正在递归读取目录实际大小",
    disabled:true,
    iconName:"loader-circle"
  };
  if (record?.status === "ready") {
    const exactBytes = String(record.sizeBytes || "0");
    return {
      className:"is-ready",
      label:formatBytes(Number(exactBytes)),
      title:`实际内容大小 ${exactBytes} 字节；点击重新读取`,
      disabled:false,
      iconName:"refresh-cw"
    };
  }
  if (record?.status === "error") return {
    className:"is-error",
    label:"重试",
    title:`读取失败：${record.error || "未知错误"}；点击重试`,
    disabled:false,
    iconName:"circle-alert"
  };
  return {
    className:"is-idle",
    label:"读取",
    title:"递归读取目录内普通文件的实际总字节数",
    disabled:false,
    iconName:"calculator"
  };
}

function sftpDirectorySizeButtonHtml(connectionId, remotePath) {
  const key = encodeURIComponent(sftpDirectorySizeCacheKey(connectionId, remotePath));
  const presentation = sftpDirectorySizePresentation(getSftpDirectorySizeRecord(connectionId, remotePath));
  return `<button class="sftp-directory-size-button ${presentation.className}" data-sftp-directory-size="${escAttr(key)}" type="button" title="${escAttr(presentation.title)}" aria-label="${escAttr(presentation.title)}" ${presentation.disabled ? "disabled" : ""} onclick="event.stopPropagation();readSftpDirectorySize(${Number(connectionId)},'${escAttr(remotePath)}')">${icon(presentation.iconName)}<span>${esc(presentation.label)}</span></button>`;
}

function syncSftpDirectorySizeButtons(connectionId, remotePath) {
  const key = encodeURIComponent(sftpDirectorySizeCacheKey(connectionId, remotePath));
  document.querySelectorAll(".sftp-directory-size-button").forEach(button => {
    if (button.dataset.sftpDirectorySize !== key) return;
    button.outerHTML = sftpDirectorySizeButtonHtml(connectionId, remotePath);
  });
}

async function readSftpDirectorySize(connectionId, remotePath) {
  const current = getSftpDirectorySizeRecord(connectionId, remotePath);
  if (current?.status === "loading") return;
  setSftpDirectorySizeRecord(connectionId, remotePath, {status:"loading"});
  syncSftpDirectorySizeButtons(connectionId, remotePath);
  try {
    const result = await api(`/api/connections/${connectionId}/sftp/directory-size`, {
      method:"POST",
      body:JSON.stringify({path:remotePath})
    });
    const sizeBytes = String(result?.size_bytes ?? result?.size ?? "");
    if (!/^\d+$/.test(sizeBytes)) throw new Error("目录大小返回格式无效");
    setSftpDirectorySizeRecord(connectionId, remotePath, {status:"ready", sizeBytes});
  } catch (error) {
    setSftpDirectorySizeRecord(connectionId, remotePath, {status:"error", error:error.message || "目录大小读取失败"});
    notify(error.message || "目录大小读取失败", "error");
  }
  syncSftpDirectorySizeButtons(connectionId, remotePath);
}

function sftpDirectoryContentSignature(state) {
  return JSON.stringify({
    path:normalizeSftpDirectoryCachePath(state?.path),
    query:String(state?.query || ""),
    sort:String(state?.sort || "name"),
    dir:String(state?.dir || "asc"),
    page:Number(state?.page || 1),
    pageSize:Number(state?.pageSize || state?.page_size || 50),
    total:Number(state?.total || 0),
    totalPages:Number(state?.totalPages || state?.total_pages || 1),
    unfilteredTotal:Number(state?.unfilteredTotal || state?.unfiltered_total || 0),
    entries:(state?.entries || []).map(entry => [
      entry.name, entry.type, Number(entry.size || 0), Number(entry.mtime || 0),
      entry.mode || "", entry.owner || "", entry.group || ""
    ])
  });
}

function sftpBreadcrumbHtml(id, remotePath) {
  const raw = String(remotePath || ".").replace(/\\/g, "/");
  const clean = raw === "/" ? "/" : (raw.replace(/\/+$/,"") || ".");
  if (clean === ".") return `<button class="crumb active" aria-current="page" onclick="openSftp(${id},'.')">当前目录</button>`;
  const absolute = clean.startsWith("/");
  const parts = clean.split("/").filter(Boolean);
  const crumbs = absolute ? [{label:"根目录", path:"/"}] : [{label:"当前目录", path:"."}];
  let current = absolute ? "" : ".";
  for (const part of parts) {
    current = current === "." ? part : `${current.replace(/\/$/,"")}/${part}`;
    crumbs.push({label:part, path:current});
  }
  return crumbs.map((item, index) => `<button class="crumb ${index === crumbs.length - 1 ? "active" : ""}" ${index === crumbs.length - 1 ? 'aria-current="page"' : ""} title="${esc(item.path)}" onclick="openSftp(${id},'${escAttr(item.path)}')">${esc(item.label)}</button>`).join(`<span class="crumb-sep" aria-hidden="true">${icon("chevron-right")}</span>`);
}

function renderSftpFavorites(id) {
  const items = sftpFavorites.filter(item => item.connectionId === id);
  return `<span class="sftp-favorites-label">常用目录</span>${items.length ? items.map(item => `<button onclick="openSftp(${id},'${escAttr(item.path)}')" title="${esc(item.path)}"><span aria-hidden="true">★</span>${esc(item.name || item.path)}</button>`).join("") : `<span class="muted">收藏当前目录后可快速跳转</span>`}`;
}

function isCurrentSftpFavorite(id, path) {
  return sftpFavorites.some(item => item.connectionId === id && item.path === path);
}

function saveSftpFavorites() {
  localStorage.setItem("sftpFavorites", JSON.stringify(sftpFavorites.slice(0, 80)));
}

function sftpClipboardMatchesConnection() {
  return Boolean(sftpClipboard?.paths?.length) && Number(sftpClipboard.connectionId) === Number(sftpState.connectionId);
}

function sftpFilenameEncodingLabel(connection) {
  return sftpFilenameEncodingOptions.find(([value]) => value === (connection?.sftp_filename_encoding || "utf8"))?.[1] || "UTF-8";
}

function renderSftpClipboardActions() {
  if (!sftpClipboard?.paths?.length) return "";
  const count = sftpClipboard.paths.length;
  const mode = sftpClipboard.mode === "move" ? "移动" : "复制";
  const matches = sftpClipboardMatchesConnection();
  const canPaste = matches || sftpClipboard.mode === "copy";
  const crossHost = canPaste && !matches;
  const source = sftpClipboard.connectionName ? `来源：${sftpClipboard.connectionName}` : "";
  return `<span class="sftp-clipboard-state" title="${escAttr(source || `${mode}队列 ${count} 项`)}">${icon(mode === "移动" ? "folder-input" : "copy")}<span>${mode}队列 ${count} 项</span></span><button class="primary" onclick="pasteSftpClipboard()" ${canPaste ? "" : "disabled"} title="${escAttr(matches ? "粘贴到当前目录" : crossHost ? "从来源主机复制到当前主机" : "跨主机仅支持复制，不能移动")}">${icon(crossHost ? "network" : "clipboard-paste")}<span>${crossHost ? "跨主机复制" : "粘贴"}</span></button><button class="icon-button" title="取消复制/移动队列" aria-label="取消复制或移动队列" onclick="cancelSftpClipboard()">${icon("x")}</button>`;
}

function showSftpFilenameEncodingMenu(event, connectionId) {
  const connection = connections.find(item => item.id === connectionId);
  if (!connection) return;
  const current = connection.sftp_filename_encoding || "utf8";
  showActionMenu(event, sftpFilenameEncodingOptions.map(([value, label]) => ({
    label,
    icon:value === current ? "check" : "languages",
    run:()=>applySftpFilenameEncoding(connectionId, value, label)
  })));
}

async function applySftpFilenameEncoding(connectionId, encoding, label) {
  const connection = connections.find(item => item.id === connectionId);
  if (!connection) return;
  const result = await api(`/api/connections/${connectionId}/sftp-filename-encoding`, {
    method:"POST",
    body:JSON.stringify({encoding})
  });
  Object.assign(connection, result);
  const labelNode = document.querySelector("#sftpFilenameEncodingButton span");
  if (labelNode) labelNode.textContent = label;
  notify(`SFTP 文件名编码已切换为 ${label}`, "success");
  await loadSftpPage({connectionId, path:sftpState.path || ".", page:1, refresh:true, keepContents:false});
}

function refreshSftpDirectoryActions() {
  const tab = tabs.find(item => item.key === activeTabKey) || {id:Number(sftpState.connectionId || 0)};
  if (!tab.id) return;
  const favoriteButton = $("sftpFavoriteToggle");
  if (favoriteButton) favoriteButton.innerHTML = `${icon("star")}<span>${isCurrentSftpFavorite(tab.id, sftpState.path || ".") ? "取消收藏" : "收藏"}</span>`;
  const favorites = $("sftpFavorites");
  if (favorites) {
    favorites.classList.toggle("is-empty", !sftpFavorites.some(item => item.connectionId === tab.id));
    favorites.innerHTML = renderSftpFavorites(tab.id);
  }
  const clipboard = $("sftpClipboardActions");
  if (clipboard) clipboard.innerHTML = renderSftpClipboardActions();
}

function cancelSftpClipboard() {
  if (!sftpClipboard) return;
  sftpClipboard = null;
  refreshSftpDirectoryActions();
  notify("已取消复制/移动队列", "info");
}

async function toggleSftpFavorite() {
  const tab = tabs.find(item => item.key === activeTabKey);
  const path = sftpState.path || ".";
  if (!tab?.id) return;
  const index = sftpFavorites.findIndex(item => item.connectionId === tab.id && item.path === path);
  if (index >= 0) {
    sftpFavorites.splice(index, 1);
    notify("已取消收藏路径", "success");
  } else {
    const name = await inputModal("收藏路径", "收藏名称", path.split("/").filter(Boolean).pop() || path);
    if (!name) return;
    sftpFavorites.unshift({connectionId:tab.id, path, name});
    notify("已收藏路径", "success");
  }
  saveSftpFavorites();
  refreshSftpDirectoryActions();
}

function rememberSftpViewState(tabKey=activeTabKey, requestedPath=sftpState.path) {
  if (!String(tabKey || "").startsWith("sftp-")) return;
  const view = $("view-sftp");
  if (!view?.querySelector(".sftp-shell") || view.dataset.sftpTabKey !== tabKey) return;
  const viewState = captureSftpViewState();
  cacheSftpDirectoryView(tabKey, requestedPath, viewState);
  sftpViewStates.set(tabKey, {
    needsReload:Boolean(sftpState.loading),
    state:{
      ...sftpState,
      entries:[...(sftpState.entries || [])],
      selected:sftpState.selected ? {...sftpState.selected} : null,
      loading:false
    },
    viewState
  });
}

function restoreCachedSftpState(cached) {
  if (!cached?.state) return false;
  const nextRequestSeq = Math.max(Number(sftpState.requestSeq || 0), Number(cached.state.requestSeq || 0)) + 1;
  sftpState = {
    ...cached.state,
    entries:[...(cached.state.entries || [])],
    selected:cached.state.selected ? {...cached.state.selected} : null,
    loading:false,
    requestSeq:nextRequestSeq
  };
  return true;
}

async function openSftp(id, remotePath=".", updateTab=true) {
  const tabKey = `sftp-${id}`;
  const view = $("view-sftp");
  const currentlyMounted = view.dataset.sftpTabKey === activeTabKey && Boolean(view.querySelector(".sftp-shell"));
  const leavingCurrentDirectory = activeView === "sftp"
    && currentlyMounted
    && (
      activeTabKey !== tabKey
      || resolvedSftpDirectoryViewCacheKey(sftpState.connectionId, sftpState.path)
        !== resolvedSftpDirectoryViewCacheKey(id, remotePath)
    );
  if (leavingCurrentDirectory) rememberSftpViewState(activeTabKey);
  const c = selectConnection(id);
  if (!c) return;
  clearTimeout(sftpSearchTimer);
  const directoryCached = getCachedSftpDirectoryView(id, remotePath);
  const tabCached = updateTab ? null : sftpViewStates.get(tabKey);
  const cached = directoryCached || tabCached;
  const mounted = view.dataset.sftpTabKey === tabKey
    && Boolean(view.querySelector(".sftp-shell"))
    && Number(sftpState.connectionId) === Number(id)
    && (
      normalizeSftpDirectoryCachePath(sftpState.path) === normalizeSftpDirectoryCachePath(remotePath)
      || normalizeSftpDirectoryCachePath(directoryCached?.state?.path) === normalizeSftpDirectoryCachePath(sftpState.path)
    );
  if (mounted) {
    setWorkspace(`${c.name} · SFTP`, `${c.ssh_user}@${c.ssh_host}`, "sftp", tabKey, updateTab, true, {kind:"sftp", id:c.id, path:sftpState.path});
    if (cached?.viewState) restoreSftpViewState(cached.viewState);
    refreshSftpDirectoryActions();
    refreshSftpJobs();
    startSftpJobsTimer();
    void loadSftpPage({
      path:sftpState.path,
      page:sftpState.page || 1,
      tabKey,
      refresh:true,
      keepContents:true,
      preserveView:true,
      silent:true,
      renderIfChangedOnly:true
    });
    return true;
  }

  const restored = Boolean(cached?.state && String(cached.state.path || ".") === String(remotePath || "."))
    && restoreCachedSftpState(cached);
  if (!restored) {
    sftpState = {...sftpState, connectionId:id, path:remotePath, entries:[], selected:null, page:1, total:0, totalPages:1, unfilteredTotal:0};
  }
  const displayPath = restored ? sftpState.path : remotePath;
  view.innerHTML = `<div class="sftp-shell">
    <div class="sftp-top">
      <div class="sftp-primary-row">
        <div class="sftp-path-block">
          <div class="sftp-title">${esc(c.name)}</div>
          <nav class="sftp-breadcrumb" id="sftpBreadcrumb" aria-label="远程目录路径">${sftpBreadcrumbHtml(id, displayPath)}</nav>
        </div>
        <div class="sftp-top-actions">
          <div class="sftp-search search-field">${icon("search")}<input id="sftpSearch" placeholder="搜索当前目录" value="${esc(sftpState.query)}" oninput="setSftpSearch(this.value)"></div>
          <button id="sftpFilenameEncodingButton" class="sftp-encoding-button" title="切换 SFTP 文件名编码" onclick="showSftpFilenameEncodingMenu(event,${id})">${icon("languages")}<span>${esc(sftpFilenameEncodingLabel(c))}</span>${icon("chevron-down")}</button>
          <button class="icon-button" title="打开此连接的终端" aria-label="打开此连接的终端" onclick="openTerminal(${id})">${icon("square-terminal")}</button>
          <button class="icon-button" title="上级目录" aria-label="上级目录" onclick="openSftp(${id}, parentRemotePath(sftpState.path))">${icon("corner-left-up")}</button>
          <button class="icon-button" title="刷新目录" aria-label="刷新目录" onclick="refreshSftp()">${icon("refresh-cw")}</button>
        </div>
      </div>
      <div class="sftp-directory-bar">
        <div class="sftp-directory-actions">
          <button id="sftpFavoriteToggle" onclick="toggleSftpFavorite()">${icon("star")}<span>${isCurrentSftpFavorite(id, displayPath) ? "取消收藏" : "收藏"}</span></button>
          <button onclick="mkdirSftp()">${icon("folder-plus")}<span>新建目录</span></button>
          <button onclick="createSftpFile()">${icon("file-plus-2")}<span>新建文件</span></button>
          <label class="upload-button">${icon("upload")}<span>上传</span><input id="sftpUpload" type="file" onchange="uploadSftpFile()" hidden></label>
          <button onclick="openSftpRecycleBin()">${icon("trash-2")}<span>回收站</span></button>
          <span id="sftpClipboardActions" class="sftp-clipboard-actions">${renderSftpClipboardActions()}</span>
        </div>
        <div id="sftpFavorites" class="sftp-favorites${sftpFavorites.some(item => item.connectionId === id) ? "" : " is-empty"}">${renderSftpFavorites(id)}</div>
      </div>
      <div class="sftp-selection-bar" id="sftpSelectionBar" hidden>
        <div class="sftp-selected" id="sftpSelectedInfo">已选择 0 项</div>
        <div class="sftp-selection-actions">
          <button onclick="copySftpSelection('copy')">${icon("copy")}<span>复制</span></button>
          <button onclick="copySftpSelection('move')">${icon("folder-input")}<span>移动</span></button>
          <button id="sftpSelectionCompress" onclick="compressSftpSelection()">${icon("archive")}<span>压缩</span></button>
          <button id="sftpSelectionPermissions" onclick="openSftpPermissionsForSelection()">${icon("key-round")}<span>权限</span></button>
          <button id="sftpSelectionExtract" onclick="extractSftpSelection()" hidden>${icon("archive-restore")}<span>解压</span></button>
          <button class="danger" onclick="deleteSftpSelection()">${icon("trash-2")}<span>删除</span></button>
          <button class="icon-button" title="取消选择" aria-label="取消选择" onclick="clearSftpSelection()">${icon("x")}</button>
        </div>
      </div>
    </div>
    <div id="sftpJobs" class="sftp-jobs"></div>
    <div id="sftpList" class="sftp-list">${restored ? "" : stateView("loading", "正在读取目录", displayPath)}</div>
  </div>`;
  view.dataset.sftpTabKey = tabKey;
  setWorkspace(`${c.name} · SFTP`, `${c.ssh_user}@${c.ssh_host}`, "sftp", tabKey, updateTab, true, {kind:"sftp", id:c.id, path:displayPath});
  refreshSftpJobs();
  startSftpJobsTimer();
  if (restored) {
    refreshSftpDirectoryActions();
    renderSftpEntries();
    restoreSftpViewState(cached.viewState);
    void loadSftpPage({
      path:displayPath,
      page:sftpState.page || 1,
      tabKey,
      refresh:true,
      keepContents:true,
      preserveView:true,
      silent:true,
      renderIfChangedOnly:true
    });
    return true;
  }
  return loadSftpPage({path:remotePath, page:1, tabKey});
}

async function loadSftpPage(options={}) {
  const id = Number(options.connectionId || sftpState.connectionId);
  if (!id) return false;
  const tabKey = options.tabKey || `sftp-${id}`;
  const remotePath = options.path || sftpState.path || ".";
  const requestedPage = Math.max(1, Number(options.page || sftpState.page || 1));
  const query = String(sftpState.query || "");
  const sort = ["name","size","mtime"].includes(sftpState.sort) ? sftpState.sort : "name";
  const dir = sftpState.dir === "desc" ? "desc" : "asc";
  const pageSize = [25,50,100,200].includes(Number(sftpState.pageSize)) ? Number(sftpState.pageSize) : 50;
  const list = $("sftpList");
  const sameDirectory = Number(sftpState.connectionId) === id && String(sftpState.path || ".") === String(remotePath || ".");
  const keepContents = Boolean(list?.querySelector(".sftp-head") && sameDirectory && options.keepContents !== false);
  const preserveView = Boolean(options.preserveView ?? options.refresh) && keepContents;
  const silent = Boolean(options.silent) && keepContents;

  if (sftpRequestController) sftpRequestController.abort();
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  sftpRequestController = controller;
  const requestSeq = Number(sftpState.requestSeq || 0) + 1;
  sftpState = {...sftpState, loading:true, requestSeq, selected:preserveView ? sftpState.selected : null};
  if (list) {
    if (!silent) {
      list.classList.toggle("is-refreshing", keepContents);
      list.setAttribute("aria-busy", "true");
      if (!keepContents) list.innerHTML = stateView("loading", "正在读取目录", remotePath);
    }
  }

  const params = new URLSearchParams({
    path: remotePath,
    page: String(requestedPage),
    page_size: String(pageSize),
    query,
    sort,
    dir
  });
  if (options.refresh) params.set("refresh", "1");
  try {
    const data = await api(`/api/connections/${id}/sftp?${params.toString()}`, controller ? {signal:controller.signal} : {});
    if (requestSeq !== sftpState.requestSeq || activeTabKey !== tabKey || activeView !== "sftp") return false;
    const viewState = preserveView ? captureSftpViewState() : null;
    const tab = tabs.find(item => item.key === tabKey);
    if (tab) tab.path = data.path;
    const nextState = {
      ...sftpState,
      connectionId:id,
      path:data.path,
      entries:data.entries || [],
      selected:preserveView ? sftpState.selected : null,
      page:Number(data.page || 1),
      pageSize:Number(data.page_size || pageSize),
      total:Number(data.total || 0),
      totalPages:Number(data.total_pages || 1),
      unfilteredTotal:Number(data.unfiltered_total || 0),
      loading:false,
      requestSeq
    };
    const contentChanged = !options.renderIfChangedOnly
      || sftpDirectoryContentSignature(sftpState) !== sftpDirectoryContentSignature(nextState);
    sftpState = nextState;
    if (contentChanged) {
      if ($("sftpBreadcrumb")) $("sftpBreadcrumb").innerHTML = sftpBreadcrumbHtml(id, data.path);
      refreshSftpDirectoryActions();
      renderSftpEntries();
      if (viewState) restoreSftpViewState(viewState);
    }
    rememberSftpViewState(tabKey, remotePath);
    saveTabsState();
    return true;
  } catch (error) {
    if (error?.name === "AbortError" || requestSeq !== sftpState.requestSeq) return false;
    if (activeTabKey === tabKey && activeView === "sftp" && $("sftpList")) {
      if (keepContents) {
        if (!silent) notify(error.message || "目录同步失败", "error");
      } else {
        $("sftpList").innerHTML = stateView("error", "目录加载失败", error.message, `<button onclick="refreshSftp()">重试</button>`);
      }
    }
    return false;
  } finally {
    if (requestSeq === sftpState.requestSeq) sftpState.loading = false;
    if (sftpRequestController === controller) sftpRequestController = null;
    if (list && requestSeq === sftpState.requestSeq && !silent) {
      list.classList.remove("is-refreshing");
      list.setAttribute("aria-busy", "false");
    }
    if (requestSeq === sftpState.requestSeq) queueMicrotask(flushPendingSftpDirectoryRefresh);
  }
}

function captureSftpViewState() {
  const workspace = document.querySelector(".workspace");
  return {
    scrollTop:Number(workspace?.scrollTop || 0),
    selectedPaths:[...document.querySelectorAll("#sftpList .sftp-check:checked")].map(input => input.value),
    activePath:sftpState.selected?.path || ""
  };
}

function restoreSftpViewState(state) {
  if (!state) return;
  const selectedPaths = new Set(state.selectedPaths || []);
  document.querySelectorAll("#sftpList .sftp-check").forEach(input => { input.checked = selectedPaths.has(input.value); });
  if (state.activePath && !(sftpState.entries || []).some(entry => joinRemotePath(sftpState.path, entry.name) === state.activePath)) {
    sftpState.selected = null;
    document.querySelectorAll("#sftpList .sftp-row.active").forEach(row => row.classList.remove("active"));
  }
  updateSftpSelection();
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  const restore = () => { workspace.scrollTop = Math.min(Number(state.scrollTop || 0), Math.max(0, workspace.scrollHeight - workspace.clientHeight)); };
  restore();
  requestAnimationFrame(restore);
}

function setSftpSearch(value) {
  sftpState.query = value || "";
  clearTimeout(sftpSearchTimer);
  sftpSearchTimer = setTimeout(() => {
    sftpState.page = 1;
    loadSftpPage({page:1});
  }, 280);
}

function setSftpSort(key) {
  clearTimeout(sftpSearchTimer);
  if (sftpState.sort === key) sftpState.dir = sftpState.dir === "asc" ? "desc" : "asc";
  else {
    sftpState.sort = key;
    sftpState.dir = "asc";
  }
  sftpState.page = 1;
  loadSftpPage({page:1});
}

function setSftpPage(page) {
  clearTimeout(sftpSearchTimer);
  const target = Math.max(1, Math.min(Number(page) || 1, Number(sftpState.totalPages || 1)));
  if (target === sftpState.page || sftpState.loading) return;
  loadSftpPage({page:target});
}

function setSftpPageSize(value) {
  clearTimeout(sftpSearchTimer);
  const pageSize = Number(value);
  if (![25,50,100,200].includes(pageSize) || pageSize === sftpState.pageSize) return;
  sftpState.pageSize = pageSize;
  sftpState.page = 1;
  loadSftpPage({page:1});
}

function sortMark(key) {
  return sftpState.sort === key ? (sftpState.dir === "asc" ? "↑" : "↓") : "";
}

function syncSftpListLayout(list=$("sftpList"), measuredWidth) {
  if (!list) return;
  const width = Number(measuredWidth) || list.getBoundingClientRect().width;
  list.classList.toggle("sftp-actions-medium", width > 0 && width <= 1200);
  list.classList.toggle("sftp-actions-compact", width > 0 && width <= 1000);
  list.classList.toggle("sftp-actions-minimal", width > 0 && width <= 620);
  list.classList.toggle("sftp-actions-more-only", width > 0 && width <= 460);
}

function watchSftpListLayout(list) {
  sftpListResizeObserver?.disconnect();
  if (sftpListResizeFrame) cancelAnimationFrame(sftpListResizeFrame);
  syncSftpListLayout(list);
  if (typeof ResizeObserver !== "function") return;
  sftpListResizeObserver = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect?.width;
    if (sftpListResizeFrame) cancelAnimationFrame(sftpListResizeFrame);
    sftpListResizeFrame = requestAnimationFrame(() => {
      sftpListResizeFrame = 0;
      if (list.isConnected) syncSftpListLayout(list, width);
    });
  });
  sftpListResizeObserver.observe(list);
}

function renderSftpEntries() {
  const list = $("sftpList");
  if (!list) return;
  const entries = sftpState.entries || [];
  const id = sftpState.connectionId;
  const head = `<div class="sftp-head"><label><input id="sftpSelectAll" type="checkbox" aria-label="选择当前页全部项目" onchange="toggleSftpAll(this.checked)"></label><button onclick="setSftpSort('name')">名称 ${sortMark("name")}</button><button class="sftp-size" onclick="setSftpSort('size')">大小 ${sortMark("size")}</button><button class="sftp-time" onclick="setSftpSort('mtime')">修改时间 ${sortMark("mtime")}</button><span class="sftp-access">权限 / 所有者</span><span class="sftp-head-actions">操作</span></div>`;
  const rows = entries.map(entry => {
    const fullPath = joinRemotePath(sftpState.path, entry.name);
    const isDir = entry.type === "dir";
    const active = sftpState.selected?.path === fullPath;
    return `<div class="sftp-row ${active ? "active" : ""}" onclick="selectSftpEntry(${id}, '${escAttr(fullPath)}', '${escAttr(entry.name)}', '${escAttr(entry.type)}')" ondblclick="activateSftpEntry(event, ${id}, '${escAttr(fullPath)}', '${escAttr(entry.name)}', '${escAttr(entry.type)}')" oncontextmenu="showSftpEntryMenu(event, ${id}, '${escAttr(fullPath)}', '${escAttr(entry.name)}', '${escAttr(entry.type)}')">
      <input class="sftp-check" type="checkbox" value="${esc(fullPath)}" data-name="${esc(entry.name)}" data-type="${esc(entry.type)}" data-mode="${esc(entry.mode || "")}" data-owner="${esc(entry.owner || "")}" data-group="${esc(entry.group || "")}" aria-label="选择 ${esc(entry.name)}" onclick="event.stopPropagation()" onchange="updateSftpSelection()">
      <button class="sftp-name" title="${esc(entry.name)}" onclick="event.stopPropagation(); selectSftpEntry(${id}, '${escAttr(fullPath)}', '${escAttr(entry.name)}', '${escAttr(entry.type)}')"><span class="sftp-icon ${entry.type} ${sftpFileKind(entry.name)}">${sftpIcon(entry.name, isDir)}</span><span class="sftp-name-copy"><span class="sftp-file-name">${esc(entry.name)}</span><span class="sftp-mobile-meta">${isDir ? "目录" : formatBytes(entry.size)} · ${entry.mtime ? formatSftpTime(entry.mtime) : "--"}</span></span></button>
      <span class="sftp-size">${isDir ? sftpDirectorySizeButtonHtml(id, fullPath) : formatBytes(entry.size)}</span>
      <span class="sftp-time">${entry.mtime ? formatSftpTime(entry.mtime) : "--"}</span>
      <span class="sftp-access" title="权限 ${esc(entry.mode || "未知")}；所有者 ${esc(entry.owner || "未知")}；用户组 ${esc(entry.group || "未知")}"><code>${esc(entry.mode || "---")}</code><span>${esc(entry.owner || "未知")}</span></span>
      <div class="sftp-row-actions">${sftpRowActionsHtml(id, fullPath, entry.name, entry.type)}</div>
    </div>`;
  }).join("");
  const page = Number(sftpState.page || 1);
  const totalPages = Number(sftpState.totalPages || 1);
  const total = Number(sftpState.total || 0);
  const first = total ? (page - 1) * Number(sftpState.pageSize || 50) + 1 : 0;
  const last = total ? Math.min(first + entries.length - 1, total) : 0;
  const pageSizes = [25,50,100,200].map(size => `<option value="${size}" ${size === Number(sftpState.pageSize) ? "selected" : ""}>${size} 项</option>`).join("");
  const filterSummary = sftpState.query && Number(sftpState.unfilteredTotal || 0) !== total ? ` · 目录共 ${Number(sftpState.unfilteredTotal || 0)} 项` : "";
  const pager = `<div class="pager sftp-pager"><button onclick="setSftpPage(${page - 1})" ${page <= 1 ? "disabled" : ""}>上一页</button><span class="pager-count">第 ${page}/${totalPages} 页 · ${first}-${last} / ${total}${filterSummary} · <select aria-label="每页数量" onchange="setSftpPageSize(this.value)">${pageSizes}</select></span><button onclick="setSftpPage(${page + 1})" ${page >= totalPages ? "disabled" : ""}>下一页</button></div>`;
  list.innerHTML = head + (rows || stateView("empty", sftpState.query ? "没有匹配的文件" : "当前目录为空", sftpState.query ? "换一个关键词试试。" : "可以上传文件或新建目录。")) + pager;
  watchSftpListLayout(list);
  updateSftpSelection();
}

function fileTypeLabel(name) {
  const ext = String(name || "").replace(/^\./, "").split(".").pop()?.toUpperCase() || "FILE";
  return ext.length > 5 ? "FILE" : ext;
}

function sftpFileKind(name) {
  const lower = String(name || "").toLowerCase();
  const ext = lower.replace(/^\./, "").split(".").pop() || "";
  if (["sh","bash","zsh","fish","bat","cmd","ps1"].includes(ext) || [".bashrc",".profile",".zshrc"].includes(lower)) return "script";
  if (["json","yaml","yml","toml","xml","ini","conf","cfg","env","properties"].includes(ext)) return "config";
  if (["js","jsx","ts","tsx","css","html","py","go","rs","java","c","cpp","h","sql","php","rb"].includes(ext)) return "code";
  if (["md","txt","rtf"].includes(ext)) return "text";
  if (["log","out"].includes(ext)) return "log";
  if (["zip","gz","tgz","tar","rar","7z","xz","bz2"].includes(ext)) return "archive";
  if (["png","jpg","jpeg","gif","webp","svg","ico"].includes(ext)) return "image";
  if (["mp4","mkv","avi","mov","mp3","wav","flac"].includes(ext)) return "media";
  if (["csv","tsv","db","sqlite","sqlite3"].includes(ext)) return "data";
  if (["pdf","doc","docx","xls","xlsx","ppt","pptx"].includes(ext)) return "document";
  return "file";
}

function sftpIcon(name, isDir=false) {
  if (isDir) return icon("folder");
  const ext = fileTypeLabel(name);
  const icons = {script:"terminal-square", config:"braces", code:"file-code-2", text:"file-text", log:"scroll-text", archive:"file-archive", image:"image", media:"file-play", data:"database", document:"file-text", file:"file"};
  return `${icon(icons[sftpFileKind(name)] || "file")}<small>${esc(ext)}</small>`;
}

function formatSftpTime(value) {
  return new Date(Number(value) * 1000).toLocaleString("zh-CN", {hour12:false});
}

function sftpDiffHtml(oldText, newText) {
  const oldLines = String(oldText || "").split("\n");
  const newLines = String(newText || "").split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  const rows = [];
  for (let i = 0; i < max; i++) {
    if (oldLines[i] === newLines[i]) continue;
    if (typeof oldLines[i] !== "undefined") rows.push(`<div class="diff-line removed"><b>-</b><code>${esc(oldLines[i]) || " "}</code></div>`);
    if (typeof newLines[i] !== "undefined") rows.push(`<div class="diff-line added"><b>+</b><code>${esc(newLines[i]) || " "}</code></div>`);
    if (rows.length > 180) {
      rows.push(`<div class="diff-line"><b>...</b><code>差异较多，仅显示前 180 行变化</code></div>`);
      break;
    }
  }
  return rows.length ? rows.join("") : `<div class="muted">没有内容变化。</div>`;
}

const sftpTextEncodingOptions = [
  ["utf8","UTF-8"], ["utf8bom","UTF-8 BOM"], ["gb18030","GB18030"], ["gbk","GBK"],
  ["big5","Big5"], ["shift_jis","Shift_JIS"], ["euc-kr","EUC-KR"], ["latin1","ISO-8859-1"]
];

function sftpTextEncodingLabel(value) {
  return sftpTextEncodingOptions.find(([encoding]) => encoding === value)?.[1] || String(value || "UTF-8");
}

function sftpTextModal(title, content, size=0, limit=512*1024, encoding="utf8", preferredEncoding="auto") {
  return new Promise((resolve) => {
    const modal = $("modal");
    modal.innerHTML = `<div class="modal-card wide sftp-editor-modal"><div class="sftp-editor-head"><div><h2>${esc(title)}</h2><span>${esc(formatBytes(size))} · 上限 ${esc(formatBytes(limit))}</span></div><div class="sftp-editor-encoding"><label>文本编码<select id="sftpTextEncoding">${sftpTextEncodingOptions.map(([value,label]) => `<option value="${value}" ${value === encoding ? "selected" : ""}>${label}</option>`).join("")}</select></label><span id="sftpEditorStats"></span></div></div><textarea id="sftpTextEditor" class="text-editor code-editor" spellcheck="false">${esc(content)}</textarea><div id="sftpDiffPreview" class="diff-preview" hidden></div><div class="sftp-editor-options"><label class="check-row"><input id="sftpBackupBeforeSave" type="checkbox" checked> 保存前备份远程文件</label><label class="check-row"><input id="sftpPersistEncoding" type="checkbox" ${preferredEncoding === encoding ? "checked" : ""}> 设为此连接默认文本编码</label></div><div class="actions"><button id="sftpTextDiff">预览差异</button><button class="primary" id="sftpTextSave">保存 <span class="shortcut-hint">Ctrl+S</span></button><button id="sftpTextClose">关闭</button></div></div>`;
    modal.hidden = false;
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      modal.hidden = true;
      resolve(value);
    };
    const editor = $("sftpTextEditor");
    const saveButton = $("sftpTextSave");
    const updateStats = () => {
      const value = editor.value;
      const bytes = new Blob([value]).size;
      const tooLarge = bytes > limit;
      const stats = $("sftpEditorStats");
      stats.textContent = `${value.split("\n").length} 行 · ${formatBytes(bytes)}${tooLarge ? " · 已超过上限" : ""}`;
      stats.classList.toggle("limit-exceeded", tooLarge);
      saveButton.disabled = tooLarge;
      return !tooLarge;
    };
    updateStats();
    editor.addEventListener("input", updateStats);
    editor.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!updateStats()) return notify(`在线编辑内容不能超过 ${formatBytes(limit)}`, "error");
        finish({action:"save", content:editor.value, backup:$("sftpBackupBeforeSave").checked, encoding:$("sftpTextEncoding").value, persist_default:$("sftpPersistEncoding").checked});
      } else if (event.key === "Tab") {
        event.preventDefault();
        const start = editor.selectionStart;
        editor.setRangeText("  ", start, editor.selectionEnd, "end");
        updateStats();
      }
    });
    $("sftpTextDiff").onclick = () => {
      const box = $("sftpDiffPreview");
      box.hidden = false;
      box.innerHTML = sftpDiffHtml(content, editor.value);
    };
    $("sftpTextEncoding").onchange = event => {
      const nextEncoding = event.target.value;
      if (editor.value !== content) {
        event.target.value = encoding;
        notify("请先保存或放弃当前修改，再切换文本编码", "info");
        return;
      }
      finish({action:"encoding", encoding:nextEncoding});
    };
    $("sftpTextSave").onclick = () => finish({action:"save", content:editor.value, backup:$("sftpBackupBeforeSave").checked, encoding:$("sftpTextEncoding").value, persist_default:$("sftpPersistEncoding").checked});
    $("sftpTextClose").onclick = async () => {
      if (editor.value !== content && !await confirmModal("当前修改尚未保存，确认关闭？", "放弃修改", "放弃修改", "继续编辑", true)) return;
      finish(null);
    };
    setTimeout(() => editor.focus(), 0);
  });
}

async function previewSftpText(id, path) {
  try {
    let requestedEncoding = "";
    while (true) {
      const suffix = requestedEncoding ? `&encoding=${encodeURIComponent(requestedEncoding)}` : "";
      const data = await api(`/api/connections/${id}/sftp/read?path=${encodeURIComponent(path)}${suffix}`);
      const next = await sftpTextModal(path, data.content || "", data.size || 0, data.limit || 512*1024, data.encoding || "utf8", data.preferred_encoding || "auto");
      if (next === null) return;
      if (next.action === "encoding") {
        requestedEncoding = next.encoding;
        continue;
      }
      if (next.content === (data.content || "") && !(next.persist_default && data.preferred_encoding !== next.encoding)) return notify("文件内容没有变化", "info");
      await api(`/api/connections/${id}/sftp/write`, {method:"POST", body:JSON.stringify({path, content:next.content, backup:next.backup, encoding:next.encoding, persist_default:next.persist_default})});
      const connection = connections.find(item => item.id === id);
      if (connection && next.persist_default) connection.sftp_text_encoding = next.encoding;
      notify(`文件已按 ${sftpTextEncodingLabel(next.encoding)} 保存`, "success");
      return;
    }
  } catch (error) {
    notify(error.message || "读取文件失败", "error");
  }
}

function toggleSftpAll(checked) {
  document.querySelectorAll(".sftp-check").forEach(input => { input.checked = checked; });
  updateSftpSelection();
}

function updateSftpSelection() {
  const inputs = [...document.querySelectorAll(".sftp-check")];
  const count = inputs.filter(input => input.checked).length;
  const box = $("sftpSelectedInfo");
  const bar = $("sftpSelectionBar");
  const selectAll = $("sftpSelectAll");
  const extract = $("sftpSelectionExtract");
  const compress = $("sftpSelectionCompress");
  const permissions = $("sftpSelectionPermissions");
  if (box) box.innerHTML = `<strong>已选择 ${count} 项</strong><span>可批量操作当前页项目</span>`;
  if (bar) bar.hidden = count === 0;
  if (selectAll) {
    selectAll.checked = inputs.length > 0 && count === inputs.length;
    selectAll.indeterminate = count > 0 && count < inputs.length;
  }
  if (extract) extract.hidden = !(count === 1 && isArchiveName(inputs.find(input => input.checked)?.value));
  if (compress) compress.hidden = count === 0;
  if (permissions) permissions.hidden = count === 0;
  inputs.forEach(input => input.closest(".sftp-row")?.classList.toggle("is-selected", input.checked));
}

function clearSftpSelection() {
  document.querySelectorAll(".sftp-check").forEach(input => { input.checked = false; });
  updateSftpSelection();
}

function selectedSftpPaths() {
  return [...document.querySelectorAll(".sftp-check:checked")].map(input => input.value);
}

function selectedSftpEntries() {
  return [...document.querySelectorAll(".sftp-check:checked")].map(input => ({
    path: input.value,
    name: input.dataset.name || input.value.split("/").pop() || input.value,
    type: input.dataset.type || "file",
    mode: input.dataset.mode || "",
    owner: input.dataset.owner || "",
    group: input.dataset.group || ""
  }));
}

function isArchiveName(name) {
  return /\.(zip|tar|tar\.gz|tgz)$/i.test(String(name || ""));
}

function selectSftpEntry(id, path, name, type) {
  sftpState.selected = { id, path, name, type };
  document.querySelectorAll(".sftp-row").forEach(row => row.classList.remove("active"));
  const input = [...document.querySelectorAll(".sftp-check")].find(item => item.value === path);
  if (input) input.closest(".sftp-row")?.classList.add("active");
}

function activateSftpEntry(event, id, path, name, type) {
  if (event?.target?.closest(".sftp-check, .sftp-row-actions")) return;
  event?.preventDefault();
  event?.stopPropagation();
  selectSftpEntry(id, path, name, type);
  if (type === "dir") return openSftp(id, path);
  return previewSftpText(id, path);
}

function sftpRowActionsHtml(id, path, name, type) {
  const isDir = type === "dir";
  const archive = !isDir && isArchiveName(name);
  return [
    isDir
      ? `<button class="sftp-row-action sftp-row-action-core" title="打开目录" onclick="event.stopPropagation();openSftp(${id},'${escAttr(path)}')">${icon("folder-open")}<span>打开</span></button>`
      : `<button class="sftp-row-action sftp-row-action-core" title="以文本打开" onclick="event.stopPropagation();previewSftpText(${id},'${escAttr(path)}')">${icon("file-text")}<span>打开</span></button>`,
    !isDir ? `<button class="sftp-row-action sftp-row-action-medium" title="下载" onclick="event.stopPropagation();downloadSftp(${id},'${escAttr(path)}')">${icon("download")}<span>下载</span></button>` : "",
    archive ? `<button class="sftp-row-action sftp-row-action-medium" title="解压" onclick="event.stopPropagation();extractSingleSftp(${id},'${escAttr(path)}')">${icon("archive-restore")}<span>解压</span></button>` : "",
    `<button class="sftp-row-action sftp-row-action-medium" title="压缩" onclick="event.stopPropagation();compressSingleSftp(${id},'${escAttr(path)}')">${icon("archive")}<span>压缩</span></button>`,
    `<button class="sftp-row-action sftp-row-action-wide" title="复制" onclick="event.stopPropagation();copySingleSftp('${escAttr(path)}','copy')">${icon("copy")}<span>复制</span></button>`,
    `<button class="sftp-row-action sftp-row-action-wide" title="移动" onclick="event.stopPropagation();copySingleSftp('${escAttr(path)}','move')">${icon("folder-input")}<span>移动</span></button>`,
    `<button class="sftp-row-action sftp-row-action-medium" title="重命名" onclick="event.stopPropagation();renameSftp(${id},'${escAttr(path)}','${escAttr(name)}')">${icon("pencil")}<span>重命名</span></button>`,
    `<button class="sftp-row-action sftp-row-action-wide" title="设置权限" onclick="event.stopPropagation();openSftpPermissionsForSelection(['${escAttr(path)}'])">${icon("key-round")}<span>权限</span></button>`,
    `<button class="sftp-row-action sftp-row-action-wide danger" title="删除" onclick="event.stopPropagation();deleteSftp(${id},'${escAttr(path)}')">${icon("trash-2")}<span>删除</span></button>`,
    `<button class="sftp-row-action sftp-row-action-more" title="更多操作" aria-label="${esc(name)}的更多操作" onclick="showSftpEntryMenu(event, ${id},'${escAttr(path)}','${escAttr(name)}','${escAttr(type)}')">${icon("ellipsis")}<span>更多</span></button>`
  ].filter(Boolean).join("");
}

function refreshSftp(options={}) {
  clearTimeout(sftpSearchTimer);
  const tab = tabs.find(item => item.key === activeTabKey);
  if (tab?.kind === "sftp") return loadSftpPage({connectionId:tab.id, path:sftpState.path || tab.path || ".", page:sftpState.page || 1, tabKey:tab.key, refresh:true, preserveView:true, ...options});
}

async function mkdirSftp() {
  const tab = tabs.find(item => item.key === activeTabKey);
  const name = await inputModal("新建目录", "目录名称", "");
  if (!tab || !name) return;
  if (!isValidSftpChildName(name, "目录名")) return;
  try {
    await api(`/api/connections/${tab.id}/sftp/mkdir`, {method:"POST", body:JSON.stringify({path:joinRemotePath(sftpState.path || ".", name)})});
    notify("目录已创建", "success");
    refreshSftp();
  } catch (error) {
    notify(error.message || "新建目录失败", "error");
  }
}

function isValidSftpChildName(value, label = "名称") {
  const name = String(value || "").trim();
  if (!name || name === "." || name === ".." || /[\\/]/.test(name) || name.includes("\0")) {
    notify(`${label}不能包含路径分隔符或特殊目录名`, "error");
    return false;
  }
  return true;
}

async function createSftpFile() {
  const tab = tabs.find(item => item.key === activeTabKey);
  const name = await inputModal("新建文件", "文件名", "");
  if (!tab || !name || !isValidSftpChildName(name, "文件名")) return;
  const remotePath = joinRemotePath(sftpState.path || ".", name);
  try {
    await api(`/api/connections/${tab.id}/sftp/create-file`, {method:"POST", body:JSON.stringify({path:remotePath})});
    notify("文件已创建", "success");
    await refreshSftp();
  } catch (error) {
    notify(error.message || "新建文件失败", "error");
  }
}

async function renameSftp(id, from, oldName) {
  const name = await inputModal("重命名", "新名称", oldName);
  if (!name) return;
  await api(`/api/connections/${id}/sftp/rename`, {method:"POST", body:JSON.stringify({from, to:joinRemotePath(parentRemotePath(from), name)})});
  refreshSftp();
}

async function currentSftpRecycleBinEnabled() {
  if (runtimeSettings?.saved && typeof runtimeSettings.saved.sftp_recycle_bin_enabled === "boolean") {
    return runtimeSettings.saved.sftp_recycle_bin_enabled;
  }
  try {
    runtimeSettings = normalizeRuntimeSettingsResponse(await api("/api/runtime-settings"));
    return runtimeSettings.saved.sftp_recycle_bin_enabled;
  } catch {
    return null;
  }
}

function sftpDeleteConfirmation(enabled, count, remotePath="") {
  const itemText = count === 1 ? "该远程项目" : `选中的 ${count} 个远程项目`;
  if (enabled === true) return {
    title:"移入回收站",
    message:`将${itemText}移入回收站？${remotePath ? `\n${remotePath}` : ""}`,
    confirm:"移入回收站",
    danger:false
  };
  if (enabled === false) return {
    title:"永久删除远程项目",
    message:`回收站未开启，将永久删除${itemText}且无法恢复。${remotePath ? `\n${remotePath}` : ""}`,
    confirm:"永久删除",
    danger:true
  };
  return {
    title:"删除远程项目",
    message:`删除${itemText}？系统将按当前回收站设置处理。${remotePath ? `\n${remotePath}` : ""}`,
    confirm:"继续",
    danger:true
  };
}

async function deleteSftp(id, path) {
  const confirmation = sftpDeleteConfirmation(await currentSftpRecycleBinEnabled(), 1, path);
  if (!await confirmModal(confirmation.message, confirmation.title, confirmation.confirm, "取消", confirmation.danger)) return;
  const result = await api(`/api/connections/${id}/sftp/delete`, {method:"POST", body:JSON.stringify({path})});
  notify(result.recycled ? "已移入 SFTP 回收站" : "远程项目已永久删除", "success");
  refreshSftp();
}

async function deleteSftpSelection() {
  const tab = tabs.find(item => item.key === activeTabKey);
  const paths = selectedSftpPaths();
  if (!tab || !paths.length) return notify("请选择文件或目录", "info");
  const confirmation = sftpDeleteConfirmation(await currentSftpRecycleBinEnabled(), paths.length);
  if (!await confirmModal(confirmation.message, confirmation.title, confirmation.confirm, "取消", confirmation.danger)) return;
  let recycled = 0;
  for (const path of paths) {
    const result = await api(`/api/connections/${tab.id}/sftp/delete`, {method:"POST", body:JSON.stringify({path})});
    if (result.recycled) recycled += 1;
  }
  notify(recycled ? `已将 ${recycled} 个远程项目移入回收站` : `已永久删除 ${paths.length} 个远程项目`, "success");
  refreshSftp();
}

function copySftpSelection(mode) {
  const paths = selectedSftpPaths();
  if (!paths.length) return notify("请选择文件或目录", "info");
  const tab = tabs.find(item => item.key === activeTabKey);
  sftpClipboard = {mode, paths, connectionId:Number(sftpState.connectionId), connectionName:tab?.title || tab?.name || ""};
  refreshSftpDirectoryActions();
  notify(`${mode === "move" ? "移动" : "复制"}队列已保存，进入目标目录后点击粘贴`, "success");
}

function copySingleSftp(path, mode) {
  const tab = tabs.find(item => item.key === activeTabKey);
  sftpClipboard = { mode, paths:[path], connectionId:Number(sftpState.connectionId), connectionName:tab?.title || tab?.name || "" };
  refreshSftpDirectoryActions();
  notify(`${mode === "move" ? "移动" : "复制"}队列已保存，进入目标目录后点击粘贴`, "success");
}

async function pasteSftpClipboard() {
  const tab = tabs.find(item => item.key === activeTabKey);
  if (!tab || !sftpClipboard?.paths?.length) return notify("剪贴板为空", "info");
  const sameConnection = sftpClipboardMatchesConnection();
  if (!sameConnection && sftpClipboard.mode !== "copy") return notify("跨主机只支持复制，不能移动", "error");
  const endpoint = sftpClipboard.mode === "move" ? "move" : "copy";
  try {
    const sourceConnectionId = Number(sftpClipboard.connectionId);
    const requestUrl = sameConnection
      ? `/api/connections/${tab.id}/sftp/${endpoint}`
      : `/api/connections/${sourceConnectionId}/sftp/cross-copy`;
    const requestBody = sameConnection
      ? {paths:sftpClipboard.paths, target:sftpState.path || ".", background:true}
      : {paths:sftpClipboard.paths, target_connection_id:Number(tab.id), target:sftpState.path || "."};
    const job = await api(requestUrl, {method:"POST", body:JSON.stringify(requestBody)});
    trackSftpMutationJob(job);
    sftpClipboard = null;
    refreshSftpDirectoryActions();
    notify(sameConnection ? "已加入 SFTP 后台任务" : "已加入跨主机复制任务", "success");
    refreshSftpJobs();
  } catch (error) {
    notify(error.message || "粘贴失败", "error");
  }
}

async function extractSftpSelection() {
  const tab = tabs.find(item => item.key === activeTabKey);
  const paths = selectedSftpPaths();
  if (!tab || paths.length !== 1) return notify("请选择一个压缩包", "info");
  const job = await api(`/api/connections/${tab.id}/sftp/extract`, {method:"POST", body:JSON.stringify({path:paths[0], target:sftpState.path || ".", background:true})});
  trackSftpMutationJob(job);
  notify("已加入 SFTP 后台任务", "success");
  refreshSftpJobs();
}

function sftpPathName(remotePath) {
  return String(remotePath || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "archive";
}

function defaultSftpArchiveName(entries) {
  if (entries.length === 1) return `${sftpPathName(entries[0].path)}.tar.gz`;
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `archive-${stamp}.tar.gz`;
}

async function compressSftpSelection() {
  const tab = tabs.find(item => item.key === activeTabKey);
  const entries = selectedSftpEntries();
  if (!tab || !entries.length) return notify("请选择要压缩的文件或目录", "info");
  const name = await inputModal("压缩选中项目", "压缩包名称（自动使用 tar.gz）", defaultSftpArchiveName(entries));
  if (!name) return;
  try {
    const job = await api(`/api/connections/${tab.id}/sftp/compress`, {method:"POST", body:JSON.stringify({paths:entries.map(item => item.path), target:sftpState.path || ".", filename:name})});
    trackSftpMutationJob(job);
    notify(`已加入压缩任务：${name}`, "success");
    refreshSftpJobs();
  } catch (error) {
    notify(error.message || "压缩任务创建失败", "error");
  }
}

function normalizePermissionMode(value) {
  const mode = String(value ?? "").trim();
  return /^[0-7]{3}$/.test(mode) ? mode : "";
}

function permissionModeToChecks(value) {
  const mode = normalizePermissionMode(value);
  const digits = mode ? mode.split("").map(Number) : [0, 0, 0];
  return {
    ownerRead: Boolean(digits[0] & 4), ownerWrite: Boolean(digits[0] & 2), ownerExecute: Boolean(digits[0] & 1),
    groupRead: Boolean(digits[1] & 4), groupWrite: Boolean(digits[1] & 2), groupExecute: Boolean(digits[1] & 1),
    publicRead: Boolean(digits[2] & 4), publicWrite: Boolean(digits[2] & 2), publicExecute: Boolean(digits[2] & 1)
  };
}

function permissionChecksToMode(checks) {
  const digit = (read, write, execute) => (read ? 4 : 0) + (write ? 2 : 0) + (execute ? 1 : 0);
  return `${digit(checks.ownerRead, checks.ownerWrite, checks.ownerExecute)}${digit(checks.groupRead, checks.groupWrite, checks.groupExecute)}${digit(checks.publicRead, checks.publicWrite, checks.publicExecute)}`;
}

function selectedSftpPermissionMetadata(entries) {
  const modes = entries.map(item => normalizePermissionMode(item.mode)).filter(Boolean);
  const owners = entries.map(item => item.owner).filter(Boolean);
  const groups = entries.map(item => item.group).filter(Boolean);
  return {
    mode: modes.length === entries.length && modes.every(item => item === modes[0]) ? modes[0] : "",
    owner: owners.length === entries.length && owners.every(item => item === owners[0]) ? owners[0] : "",
    group: groups.length === entries.length && groups.every(item => item === groups[0]) ? groups[0] : "",
    mixedMode: modes.length > 1 && new Set(modes).size > 1,
    hasDirectory: entries.some(item => item.type === "dir")
  };
}

function permissionFieldsetHtml(title, prefix, checks) {
  return `<fieldset class="sftp-permission-group"><legend>${title}</legend><label><input type="checkbox" data-permission="${prefix}Read" ${checks[`${prefix}Read`] ? "checked" : ""}>读取</label><label><input type="checkbox" data-permission="${prefix}Write" ${checks[`${prefix}Write`] ? "checked" : ""}>写入</label><label><input type="checkbox" data-permission="${prefix}Execute" ${checks[`${prefix}Execute`] ? "checked" : ""}>执行</label></fieldset>`;
}

function openSftpPermissionsForSelection(paths = null) {
  const selected = paths ? paths.map(path => ({path, name:sftpPathName(path)})) : selectedSftpEntries();
  if (!selected.length) return notify("请选择要设置权限的文件或目录", "info");
  const entries = selected.map(item => {
    const known = (sftpState.entries || []).find(entry => joinRemotePath(sftpState.path, entry.name) === item.path);
    return {...item, mode:item.mode || known?.mode || "", owner:item.owner || known?.owner || "", group:item.group || known?.group || "", type:item.type || known?.type || "file"};
  });
  const metadata = selectedSftpPermissionMetadata(entries);
  const modal = $("modal");
  modal.onclick = null;
  const mode = metadata.mode;
  const checks = permissionModeToChecks(mode);
  modal.innerHTML = `<div class="modal-card wide sftp-permission-modal" role="dialog" aria-modal="true" aria-labelledby="sftpPermissionTitle"><div class="sftp-permission-head"><div><h2 id="sftpPermissionTitle">设置权限</h2><span>${entries.length} 个项目${metadata.mixedMode ? " · 当前权限不一致，请输入新的权限值" : ""}</span></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" id="sftpPermissionClose">${icon("x")}</button></div><div class="sftp-permission-groups">${permissionFieldsetHtml("所有者", "owner", checks)}${permissionFieldsetHtml("用户组", "group", checks)}${permissionFieldsetHtml("公共", "public", checks)}</div><div class="sftp-permission-fields"><label>权限值<input id="sftpPermissionMode" inputmode="numeric" maxlength="3" value="${esc(mode)}" placeholder="例如 755"><span>三位八进制数字</span></label><label>所有者<input id="sftpPermissionOwner" value="${esc(metadata.owner)}" placeholder="多个值，留空不修改" autocomplete="off"><span>留空表示不修改</span></label><label>用户组<input id="sftpPermissionGroup" value="${esc(metadata.group)}" placeholder="多个值，留空不修改" autocomplete="off"><span>留空表示不修改</span></label></div>${metadata.hasDirectory ? `<label class="check-row sftp-permission-recursive"><input id="sftpPermissionRecursive" type="checkbox">应用到目录内的子目录和文件</label>` : ""}<p class="sftp-permission-note">修改所有者或用户组需要远端账号具备相应权限；不会自动使用 sudo。只修改权限值时可将这两个字段留空。</p><div id="sftpPermissionStatus" class="sftp-permission-status" role="status" aria-live="polite">等待应用</div><div class="actions"><button id="sftpPermissionCancel">取消</button><button class="primary" id="sftpPermissionApply">应用</button></div></div>`;
  modal.hidden = false;
  const modeInput = $("sftpPermissionMode");
  const apply = $("sftpPermissionApply");
  const syncChecks = () => {
    const next = normalizePermissionMode(modeInput.value);
    apply.disabled = !next;
    if (!next) return;
    const nextChecks = permissionModeToChecks(next);
    modal.querySelectorAll("[data-permission]").forEach(input => { input.checked = Boolean(nextChecks[input.dataset.permission]); });
  };
  const syncMode = () => {
    const next = {};
    modal.querySelectorAll("[data-permission]").forEach(input => { next[input.dataset.permission] = input.checked; });
    modeInput.value = permissionChecksToMode(next);
    apply.disabled = false;
  };
  modal.querySelectorAll("[data-permission]").forEach(input => input.addEventListener("change", syncMode));
  modeInput.addEventListener("input", syncChecks);
  syncChecks();
  let busy = false;
  const applyIdleHtml = apply.innerHTML;
  const status = $("sftpPermissionStatus");
  const setBusy = (value, message = "") => {
    busy = value;
    modal.querySelectorAll("input, button").forEach(control => { control.disabled = value; });
    apply.setAttribute("aria-busy", value ? "true" : "false");
    apply.innerHTML = value ? `${icon("loader-circle")}<span>正在应用</span>` : applyIdleHtml;
    apply.classList.toggle("is-loading", value);
    status.className = `sftp-permission-status${value ? " busy" : ""}`;
    status.textContent = message || (value ? "正在连接远程服务器并修改权限…" : "等待应用");
    if (!value) syncChecks();
  };
  const close = (force = false) => {
    if (busy && !force) return;
    modal.hidden = true;
    modal.onclick = null;
    modal.innerHTML = "";
  };
  $("sftpPermissionClose").onclick = () => close();
  $("sftpPermissionCancel").onclick = () => close();
  apply.onclick = async () => {
    if (busy) return;
    const nextMode = normalizePermissionMode(modeInput.value);
    if (!nextMode) return notify("权限值必须是三位八进制数字，例如 755", "error");
    try {
      const ownerInput = $("sftpPermissionOwner");
      const groupInput = $("sftpPermissionGroup");
      const owner = ownerInput.value.trim() && ownerInput.value.trim() !== metadata.owner ? ownerInput.value.trim() : "";
      const group = groupInput.value.trim() && groupInput.value.trim() !== metadata.group ? groupInput.value.trim() : "";
      setBusy(true);
      await api(`/api/connections/${sftpState.connectionId}/sftp/permissions`, {method:"POST", body:JSON.stringify({paths:entries.map(item => item.path), mode:nextMode, owner, group, recursive:Boolean($("sftpPermissionRecursive")?.checked)})});
      close(true);
      notify("权限修改完成", "success");
      refreshSftp();
    } catch (error) {
      const message = error.message || "权限修改失败";
      setBusy(false, `修改失败：${message}`);
      status.classList.add("error");
      notify(message, "error");
    }
  };
  if (!mode) modeInput.focus();
}

function startSftpJobsTimer() {
  if (sftpJobsTimer) return;
  sftpJobsTimer = setInterval(() => {
    if ($("sftpJobs")) refreshSftpJobs();
  }, 3000);
}

function trackSftpMutationJob(job) {
  if (job?.id) sftpKnownJobStatuses.set(String(job.id), String(job.status || "running"));
}

function completedSftpMutationForCurrentView(jobs) {
  let shouldRefresh = false;
  const visibleIds = new Set();
  for (const job of jobs) {
    const id = String(job.id || "");
    if (!id) continue;
    visibleIds.add(id);
    const previous = sftpKnownJobStatuses.get(id);
    if (previous && previous !== "done" && job.status === "done" && SFTP_MUTATING_JOB_TYPES.has(job.type) && Number(job.connection_id) === Number(sftpState.connectionId)) {
      shouldRefresh = true;
    }
    sftpKnownJobStatuses.set(id, String(job.status || ""));
  }
  for (const id of [...sftpKnownJobStatuses.keys()]) {
    if (!visibleIds.has(id) && sftpKnownJobStatuses.size > 80) sftpKnownJobStatuses.delete(id);
  }
  return shouldRefresh;
}

function flushPendingSftpDirectoryRefresh() {
  const connectionId = Number(sftpState.connectionId || 0);
  if (!connectionId || sftpState.loading || activeView !== "sftp" || !sftpPendingDirectoryRefreshes.has(connectionId)) return;
  sftpPendingDirectoryRefreshes.delete(connectionId);
  refreshSftp();
}

async function refreshSftpJobs() {
  const box = $("sftpJobs");
  if (!box) return;
  const jobs = await api("/api/sftp/jobs").catch(() => []);
  sftpLatestJobs = jobs;
  const refreshDirectory = completedSftpMutationForCurrentView(jobs);
  const current = jobs.filter(job => ["running", "pending", "paused", "failed"].includes(job.status)).slice(0, 8);
  const history = jobs.filter(job => ["done", "cancelled"].includes(job.status));
  const wasOpen = box.querySelector("details")?.open;
  const hasActive = jobs.some(job => ["running", "pending", "paused"].includes(job.status));
  const failedCount = current.filter(job => job.status === "failed").length;
  const activeCount = current.length - failedCount;
  const summary = [activeCount ? `${activeCount} 项进行中` : "", failedCount ? `${failedCount} 项失败` : ""].filter(Boolean).join(" · ") || "没有进行中或失败的任务";
  box.classList.toggle("is-empty", !current.length);
  box.innerHTML = `<details class="sftp-task-drawer" ${(wasOpen || hasActive || failedCount) ? "open" : ""}><summary><span>${icon(hasActive ? "loader-circle" : failedCount ? "circle-alert" : "list-checks")}<strong>SFTP 任务</strong><small>${summary}</small></span><span class="sftp-task-summary-actions"><button type="button" onclick="event.preventDefault();event.stopPropagation();showSftpJobHistory()" ${history.length ? "" : "disabled"}>${icon("history")}<span>历史记录</span>${history.length ? `<small>${history.length}</small>` : ""}</button><span class="task-drawer-chevron">${icon("chevron-down")}</span></span></summary><div class="sftp-task-body">${current.length ? current.map(renderSftpJob).join("") : `<div class="sftp-task-empty">没有进行中或失败的任务</div>`}</div></details>`;
  if (jobs.some(job => job.status === "running")) startSftpJobsTimer();
  if (refreshDirectory) {
    sftpPendingDirectoryRefreshes.add(Number(sftpState.connectionId));
    flushPendingSftpDirectoryRefresh();
  }
  if ($("sftpJobHistoryList")) renderSftpJobHistoryModal();
  return jobs;
}

function renderSftpJob(job) {
  const done = job.status === "done";
  const running = job.status === "running";
  const paused = job.status === "paused";
  const pending = job.status === "pending";
  const cancelable = running || paused || pending;
  const resumable = Boolean(job.can_resume);
  const showProgress = job.size ? job.size > 0 : false;
  const progress = showProgress ? Math.max(0, Math.min(100, Number(job.progress || 0))) : (running || paused ? (job.transferred ? Math.max(0, Math.min(100, Number(job.progress || 0))) : 0) : 0);
  const speed = running ? Number(job.speed_bps || 0) : Number(job.average_bps || 0);
  const detail = [sftpJobStatus(job.status), job.size ? `${formatBytes(job.transferred || 0)} / ${formatBytes(job.size)}` : formatBytes(job.transferred || 0), speed ? `${formatBytes(speed)}/s${running ? "" : " 平均"}` : "", job.size ? `${Math.round(progress)}%` : ""].filter(Boolean).join(" · ");
  const progressBar = ["running", "pending", "paused", "done", "failed"].includes(job.status) && job.size ? `<div class="progress" aria-label="${Math.round(progress)}%"><i style="width:${progress}%"></i></div>` : "";
  const saveBtn = done && job.type === "download" ? `<button class="primary" onclick="saveSftpJobFile('${escAttr(job.id)}')">保存</button>` : "";
  const resumeBtn = resumable && (job.type === "download" || job.type === "upload") ? `<button class="${job.status === "failed" ? "primary" : ""}" onclick="resumeSftpJob('${escAttr(job.id)}')">${job.status === "failed" ? "重试" : "继续"}</button>` : "";
  const pauseBtn = running && (job.type === "download" || job.type === "upload") ? `<button onclick="pauseSftpJob('${escAttr(job.id)}')">暂停</button>` : "";
  const cancelBtn = cancelable ? `<button onclick="cancelSftpJob('${escAttr(job.id)}')">取消</button>` : "";
  const deleteBtn = !running ? `<button class="danger" onclick="deleteSftpJob('${escAttr(job.id)}')">删除</button>` : "";
  const finishedAt = job.finished_at ? `<time datetime="${escAttr(new Date(job.finished_at).toISOString())}">${esc(new Date(job.finished_at).toLocaleString())}</time>` : "";
  return `<div class="sftp-job ${escAttr(job.status)}"><div><strong>${esc(job.label || job.type)}</strong><span>${esc(job.connection_name || "")} · ${esc(detail)}${finishedAt ? ` · ${finishedAt}` : ""}</span>${progressBar}${job.error ? `<div class="sftp-job-error"><strong>失败原因</strong><span>${esc(job.error).slice(0,500)}</span></div>` : ""}</div><div class="actions tight">${saveBtn}${resumeBtn}${pauseBtn}${cancelBtn}${deleteBtn}</div></div>`;
}

function closeSftpJobHistory() {
  const modal = $("modal");
  modal.hidden = true;
  modal.onclick = null;
  modal.innerHTML = "";
}

function renderSftpJobHistoryModal() {
  const modal = $("modal");
  if (!modal || !$("sftpJobHistoryList")) return;
  const history = sftpLatestJobs.filter(job => ["done", "cancelled"].includes(job.status));
  const list = $("sftpJobHistoryList");
  list.innerHTML = history.length ? history.map(renderSftpJob).join("") : `<div class="sftp-task-empty">暂无已完成或已取消的任务</div>`;
  const count = $("sftpJobHistoryCount");
  if (count) count.textContent = `${history.length} 条记录`;
  const clear = $("sftpJobHistoryClear");
  if (clear) clear.hidden = !history.length;
}

async function showSftpJobHistory() {
  if (!sftpLatestJobs.length) sftpLatestJobs = await api("/api/sftp/jobs").catch(() => []);
  const modal = $("modal");
  modal.onclick = event => { if (event.target === modal) closeSftpJobHistory(); };
  modal.innerHTML = `<div class="modal-card wide sftp-history-modal" role="dialog" aria-modal="true" aria-labelledby="sftpJobHistoryTitle"><div class="sftp-modal-head"><div><h2 id="sftpJobHistoryTitle">SFTP 任务历史</h2><span id="sftpJobHistoryCount"></span></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" onclick="closeSftpJobHistory()">${icon("x")}</button></div><div id="sftpJobHistoryList" class="sftp-history-list"></div><div class="actions"><button id="sftpJobHistoryClear" class="danger" type="button" onclick="clearFinishedSftpJobs()">${icon("trash-2")}<span>清空历史</span></button><button type="button" onclick="closeSftpJobHistory()">关闭</button></div></div>`;
  modal.hidden = false;
  renderSftpJobHistoryModal();
}

function closeSftpRecycleBin() {
  const modal = $("modal");
  modal.hidden = true;
  modal.onclick = null;
  modal.innerHTML = "";
  sftpRecycleBinConnectionId = 0;
}

function sftpRecycleItemHtml(connectionId, item) {
  const deletedAt = item.deleted_at ? new Date(item.deleted_at).toLocaleString() : "时间未知";
  return `<div class="sftp-recycle-item"><span class="sftp-recycle-icon ${escAttr(item.type)}">${icon(item.type === "dir" ? "folder" : "file")}</span><div><strong title="${escAttr(item.original_path)}">${esc(item.name || item.original_path)}</strong><span>${esc(item.original_path)}</span><small>删除于 ${esc(deletedAt)}</small></div><div class="actions tight"><button type="button" onclick="restoreSftpRecycleItem(${connectionId},'${escAttr(item.id)}')">${icon("undo-2")}<span>恢复</span></button><button class="danger" type="button" onclick="deleteSftpRecycleItem(${connectionId},'${escAttr(item.id)}','${escAttr(item.name || item.original_path)}')">${icon("trash-2")}<span>永久删除</span></button></div></div>`;
}

async function openSftpRecycleBin() {
  const tab = tabs.find(item => item.key === activeTabKey);
  const connectionId = Number(tab?.id || sftpState.connectionId);
  if (!connectionId) return;
  sftpRecycleBinConnectionId = connectionId;
  const modal = $("modal");
  modal.onclick = event => { if (event.target === modal) closeSftpRecycleBin(); };
  modal.innerHTML = `<div class="modal-card wide sftp-recycle-modal" role="dialog" aria-modal="true" aria-labelledby="sftpRecycleTitle"><div class="sftp-modal-head"><div><h2 id="sftpRecycleTitle">SFTP 回收站</h2><span id="sftpRecycleSummary">正在读取远端回收站</span></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" onclick="closeSftpRecycleBin()">${icon("x")}</button></div><div id="sftpRecycleList" class="sftp-recycle-list">${stateView("loading", "正在读取回收站")}</div><div class="actions"><button id="sftpRecycleClear" class="danger" type="button" hidden onclick="clearSftpRecycleBin(${connectionId})">${icon("trash-2")}<span>清空回收站</span></button><button type="button" onclick="closeSftpRecycleBin()">关闭</button></div></div>`;
  modal.hidden = false;
  try {
    const data = await api(`/api/connections/${connectionId}/sftp/trash`);
    if (sftpRecycleBinConnectionId !== connectionId || !$("sftpRecycleList")) return;
    const items = data.items || [];
    $("sftpRecycleSummary").textContent = `${data.enabled ? "已开启" : "当前关闭"} · ${items.length} 个项目`;
    $("sftpRecycleList").innerHTML = items.length
      ? items.map(item => sftpRecycleItemHtml(connectionId, item)).join("")
      : stateView("empty", "回收站为空", data.enabled ? "删除的远程项目会保存在这里。" : "可在设置的通用设置中开启回收站。");
    $("sftpRecycleClear").hidden = !items.length;
  } catch (error) {
    if ($("sftpRecycleList")) $("sftpRecycleList").innerHTML = stateView("error", "回收站读取失败", error.message, `<button onclick="openSftpRecycleBin()">重试</button>`);
  }
}

async function restoreSftpRecycleItem(connectionId, id) {
  try {
    const result = await api(`/api/connections/${connectionId}/sftp/trash/restore`, {method:"POST", body:JSON.stringify({id})});
    notify(`已恢复：${result.original_path || "远程项目"}`, "success");
    sftpPendingDirectoryRefreshes.add(Number(connectionId));
    flushPendingSftpDirectoryRefresh();
  } catch (error) {
    notify(error.message || "恢复失败", "error");
  }
  openSftpRecycleBin();
}

async function deleteSftpRecycleItem(connectionId, id, name) {
  if (!await confirmModal(`永久删除回收站中的项目且无法恢复？\n${name}`, "永久删除", "永久删除", "取消", true)) return openSftpRecycleBin();
  try {
    await api(`/api/connections/${connectionId}/sftp/trash/delete`, {method:"POST", body:JSON.stringify({id})});
    notify("回收站项目已永久删除", "success");
  } catch (error) {
    notify(error.message || "永久删除失败", "error");
  }
  openSftpRecycleBin();
}

async function clearSftpRecycleBin(connectionId) {
  if (!await confirmModal("永久删除当前服务器回收站内的全部项目？此操作无法撤销。", "清空 SFTP 回收站", "全部永久删除", "取消", true)) return openSftpRecycleBin();
  try {
    await api(`/api/connections/${connectionId}/sftp/trash/clear`, {method:"POST", body:"{}"});
    notify("SFTP 回收站已清空", "success");
  } catch (error) {
    notify(error.message || "清空回收站失败", "error");
  }
  openSftpRecycleBin();
}

function sftpJobStatus(status) {
  return {pending:"准备中", running:"执行中", done:"完成", failed:"失败", cancelled:"已取消", paused:"已暂停"}[status] || status;
}

async function cancelSftpJob(id) {
  await api(`/api/sftp/jobs/${encodeURIComponent(id)}/cancel`, {method:"POST"});
  refreshSftpJobs();
}

async function pauseSftpJob(id) {
  await api(`/api/sftp/jobs/${encodeURIComponent(id)}/pause`, {method:"POST"});
  refreshSftpJobs();
}

async function resumeSftpJob(id) {
  try {
    const result = await api(`/api/sftp/jobs/${encodeURIComponent(id)}/resume`, {method:"POST"});
    if (result && result.error) return notify(result.error, "error");
    notify("SFTP 任务已重新开始", "success");
    refreshSftpJobs();
  } catch (error) {
    notify(error.message || "重试任务失败", "error");
  }
}

async function deleteSftpJob(id) {
  if (!await confirmModal("删除该任务记录？","删除 SFTP 任务","删除","取消", true)) return;
  await api(`/api/sftp/jobs/${encodeURIComponent(id)}`, {method:"DELETE"});
  await refreshSftpJobs();
}

function saveSftpJobFile(id) {
  const a = document.createElement("a");
  a.href = `/api/sftp/jobs/${encodeURIComponent(id)}/fetch`;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}

async function extractSingleSftp(id, path) {
  const job = await api(`/api/connections/${id}/sftp/extract`, {method:"POST", body:JSON.stringify({path, target:sftpState.path || ".", background:true})});
  trackSftpMutationJob(job);
  notify("已加入 SFTP 解压任务", "success");
  refreshSftpJobs();
}

async function compressSingleSftp(id, path) {
  const name = await inputModal("压缩远程项目", "压缩包名称（自动使用 tar.gz）", `${sftpPathName(path)}.tar.gz`);
  if (!name) return;
  try {
    const job = await api(`/api/connections/${id}/sftp/compress`, {method:"POST", body:JSON.stringify({paths:[path], target:sftpState.path || ".", filename:name})});
    trackSftpMutationJob(job);
    notify(`已加入压缩任务：${name}`, "success");
    refreshSftpJobs();
  } catch (error) {
    notify(error.message || "压缩任务创建失败", "error");
  }
}

function openSftpActionSheet() {
  const actions = [
    { label: "复制选中", value: "copy" },
    { label: "移动选中", value: "move" },
    ...(sftpClipboardMatchesConnection() ? [{ label: "粘贴到当前目录", value: "paste" }] : []),
    ...(sftpClipboard?.paths?.length ? [{ label: "取消复制/移动队列", value: "cancelClipboard" }] : []),
    { label: "压缩选中", value: "compress" },
    { label: "设置权限", value: "permissions" },
    { label: "解压选中压缩包", value: "extract" },
    { label: "删除选中", value: "delete", className: "danger" },
    { label: "取消", value: "" }
  ];
  chooseModal("SFTP 操作", "选择要执行的文件操作。", actions).then(value => {
    if (value === "copy" || value === "move") copySftpSelection(value);
    if (value === "paste") pasteSftpClipboard();
    if (value === "cancelClipboard") cancelSftpClipboard();
    if (value === "compress") compressSftpSelection();
    if (value === "permissions") openSftpPermissionsForSelection();
    if (value === "extract") extractSftpSelection();
    if (value === "delete") deleteSftpSelection();
  });
}

async function clearFinishedSftpJobs() {
  if (!await confirmModal("清空全部已完成和已取消的 SFTP 任务记录？失败记录会保留。", "清空任务历史", "清空历史", "取消", true)) return;
  const result = await api("/api/sftp/jobs/clear-finished", {method:"POST"});
  notify(`已清理 ${result.removed || 0} 条 SFTP 历史任务`, "success");
  await refreshSftpJobs();
}

async function downloadSftp(id, path) {
  try {
    await api(`/api/connections/${id}/sftp/download`, {method:"POST", body:JSON.stringify({path})});
    notify("已加入 SFTP 下载任务", "success");
    refreshSftpJobs();
  } catch (error) {
    notify(error.message || "下载失败", "error");
  }
}

function downloadWithProgress(url, onProgress, fallbackName="download") {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "blob";
    xhr.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded / event.total * 100)), event.loaded);
      else onProgress(-1, event.loaded || 0);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        const reader = new FileReader();
        reader.onload = () => {
          try { reject(new Error(JSON.parse(String(reader.result || "")).error || xhr.statusText || "下载失败")); }
          catch { reject(new Error(xhr.statusText || "下载失败")); }
        };
        reader.onerror = () => reject(new Error(xhr.statusText || "下载失败"));
        reader.readAsText(xhr.response);
        return;
      }
      const link = document.createElement("a");
      const disposition = xhr.getResponseHeader("Content-Disposition") || "";
      const match = disposition.match(/filename=\"?([^\";]+)\"?/i);
      link.download = match ? decodeURIComponent(match[1]) : fallbackName;
      link.href = URL.createObjectURL(xhr.response);
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(link.href);
        link.remove();
      }, 1000);
      resolve();
    };
    xhr.onerror = () => reject(new Error("下载连接失败：可能是 TunnelDesk 服务重启或网络中断。"));
    xhr.send();
  });
}

async function uploadSftpFile() {
  const tab = tabs.find(item => item.key === activeTabKey);
  const file = $("sftpUpload")?.files?.[0];
  if (!tab || !file) return;
  const url = `/api/connections/${tab.id}/sftp/upload?path=${encodeURIComponent(sftpState.path || ".")}&filename=${encodeURIComponent(file.name)}`;
  notify(`正在接收 ${file.name}：0%`, "info");
  try {
    const job = await uploadWithProgress(url, file, percent => notify(`正在接收 ${file.name}：${percent}%`, "info"), file.name);
    trackSftpMutationJob(job);
    notify("已加入 SFTP 上传后台任务", "success");
    refreshSftpJobs();
  } catch (error) {
    notify(error.message || "上传失败", "error");
  }
}

function uploadWithProgress(url, body, onProgress, filename="upload.bin") {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(filename));
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded / event.total * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(JSON.parse(xhr.responseText || "{}"));
      try {
        const data = JSON.parse(xhr.responseText || "{}");
        reject(new Error(data.error || xhr.statusText || "上传失败"));
      } catch {
        reject(new Error(xhr.responseText || xhr.statusText || "上传失败"));
      }
    };
    xhr.onerror = () => reject(new Error("上传连接失败：可能是 TunnelDesk 服务重启或网络中断。"));
    xhr.send(body);
  });
}

function formatBytes(size) {
  const n = Number(size || 0);
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function hideSftpContextMenu() {
  $("sftpContextMenu")?.remove();
}

function showSftpEntryMenu(event, id, path, name, type) {
  const isDir = type === "dir";
  const rect = event.currentTarget?.getBoundingClientRect?.();
  const menuEvent = {
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
    clientX: event.clientX || rect?.right || 8,
    clientY: event.clientY || rect?.bottom || 8
  };
  showActionMenu(menuEvent, [
    isDir
      ? {label:"打开", icon:"folder-open", run:()=>openSftp(id, path)}
      : {label:"以文本打开", icon:"file-text", run:()=>previewSftpText(id, path)},
    ...(!isDir ? [{label:"下载", icon:"download", run:()=>downloadSftp(id, path)}] : []),
    ...(!isDir && isArchiveName(name) ? [{label:"解压", icon:"archive-restore", run:()=>extractSingleSftp(id, path)}] : []),
    {label:"压缩", icon:"archive", run:()=>compressSingleSftp(id, path)},
    {separator:true},
    {label:"复制路径", icon:"clipboard", run:()=>copyText(path)},
    {label:"复制", icon:"copy", run:()=>copySingleSftp(path, "copy")},
    {label:"移动", icon:"folder-input", run:()=>copySingleSftp(path, "move")},
    {label:"重命名", icon:"pencil", run:()=>renameSftp(id, path, name)},
    {label:"设置权限", icon:"key-round", run:()=>openSftpPermissionsForSelection([path])},
    {separator:true},
    {label:"删除", icon:"trash-2", danger:true, run:()=>deleteSftp(id, path)}
  ]);
}
