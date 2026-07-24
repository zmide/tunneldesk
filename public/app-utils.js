function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1", "[::1]", ""].includes(String(host || "").toLowerCase());
}

function icon(name, label="") {
  const key = String(name || "").split("-").map(part => part ? part[0].toUpperCase() + part.slice(1) : "").join("");
  const nodes = window.lucide?.icons?.[key] || window.lucide?.[key];
  if (!Array.isArray(nodes)) return `<span class="icon-fallback" aria-hidden="true"></span>`;
  const children = nodes.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([attr,value]) => `${attr}="${esc(String(value))}"`).join(" ")}></${tag}>`).join("");
  const accessibility = label ? `aria-label="${escAttr(label)}"` : `aria-hidden="true"`;
  return `<svg class="lucide lucide-${escAttr(name)}" ${accessibility} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`;
}

function refreshIcons() {
  if (!window.lucide || !document.querySelector("i[data-lucide]")) return;
  window.lucide.createIcons({attrs:{"stroke-width":1.8}});
  document.querySelectorAll("svg[data-lucide]").forEach(svg => svg.removeAttribute("data-lucide"));
}

function hideActionMenu() {
  $("actionMenu")?.remove();
  $("actionMenuBackdrop")?.remove();
}

function showActionMenu(event, actions) {
  event.preventDefault();
  event.stopPropagation();
  hideActionMenu();
  const menu = document.createElement("div");
  menu.id = "actionMenu";
  menu.className = "context-menu action-menu";
  for (const action of actions) {
    if (action.separator) {
      const separator = document.createElement("div");
      separator.className = "menu-separator";
      menu.appendChild(separator);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = action.danger ? "danger" : "";
    button.innerHTML = `${icon(action.icon || "circle")}<span>${esc(action.label)}</span>`;
    button.onclick = () => {
      hideActionMenu();
      Promise.resolve(action.run()).catch(error => notify(error?.message || "操作失败", "error"));
    };
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  if (isMobileLayout()) {
    const backdrop = document.createElement("button");
    backdrop.id = "actionMenuBackdrop";
    backdrop.className = "action-menu-backdrop";
    backdrop.type = "button";
    backdrop.setAttribute("aria-label", "关闭菜单");
    backdrop.onclick = hideActionMenu;
    document.body.insertBefore(backdrop, menu);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "action-menu-close";
    close.innerHTML = `${icon("x")}<span>关闭</span>`;
    close.onclick = hideActionMenu;
    menu.appendChild(close);
    menu.classList.add("mobile-action-menu");
    return;
  }
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
}

function updateFilePicker(input) {
  const name = input.closest(".file-picker")?.querySelector(".file-picker-name");
  if (!name) return;
  const files = Array.from(input.files || []);
  name.textContent = files.length > 1 ? `已选择 ${files.length} 个文件` : files[0]?.name || "未选择文件";
}

function currentPageHostForForward(bindHost) {
  const currentHost = location.hostname;
  if (isLoopbackHost(currentHost)) return bindHost;
  if (["0.0.0.0", "::", ""].includes(String(bindHost || ""))) return currentHost;
  return bindHost;
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value || "").replace(/["\\]/g, "\\$&");
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 760px), (hover: none) and (pointer: coarse)").matches;
}

function preferredTheme() {
  return localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme", theme);
  const text = theme === "dark" ? "切换为亮色" : "切换为暗色";
  document.querySelectorAll(".theme-toggle").forEach(btn => {
    btn.title = text;
    btn.setAttribute("aria-label", text);
    btn.innerHTML = icon(theme === "dark" ? "sun" : "moon");
  });
  window.tunnelDeskDesktop?.setTheme?.(theme);
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

function loadGroupState() {
  try {
    return new Set(JSON.parse(localStorage.getItem("openGroups") || "[]"));
  } catch {
    return new Set();
  }
}

function saveGroupState() {
  localStorage.setItem("openGroups", JSON.stringify([...groupOpen]));
}

function loadRunningState() {
  try {
    return new Set(JSON.parse(localStorage.getItem("openRunningGroups") || "[]"));
  } catch {
    return new Set();
  }
}

function saveRunningState() {
  localStorage.setItem("openRunningGroups", JSON.stringify([...runningOpen]));
}

function loadLogState() {
  try {
    return new Set(JSON.parse(localStorage.getItem("openLogs") || "[\"system\",\"batch\"]"));
  } catch {
    return new Set(["system", "batch"]);
  }
}

function saveLogState() {
  localStorage.setItem("openLogs", JSON.stringify([...logOpen]));
}

function notify(text, type="info") {
  const n = $("notice");
  if (n) {
    n.textContent = "";
    n.className = "notice";
  }
  if (text) {
    const t = $("toast");
    t.textContent = text;
    t.className = `toast show ${type}`;
    clearTimeout(window.toastTimer);
    window.toastTimer = setTimeout(()=>t.className="toast", type==="error"?8000:3500);
  }
}

function desktopNotificationEnabled() {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

async function requestDesktopNotifications() {
  if (typeof Notification === "undefined") return notify("当前浏览器不支持系统通知", "info");
  const permission = await Notification.requestPermission();
  notify(permission === "granted" ? "桌面通知已开启" : "桌面通知未授权", permission === "granted" ? "success" : "info");
}

function showDesktopNotification(event) {
  if (!desktopNotificationEnabled()) return;
  try {
    const n = new Notification(event.title || "TunnelDesk", {
      body: event.message || "",
      tag: event.key || String(event.id || Date.now()),
      renotify: false
    });
    n.onclick = () => {
      window.focus();
      handleNotificationAction(event.action);
      n.close();
    };
  } catch {}
}

function handleNotificationAction(action) {
  if (!action) return;
  if (action.view === "forwards" && action.connection_id) return openForwards(Number(action.connection_id));
  if (action.view === "sftp" && action.connection_id) return openSftp(Number(action.connection_id));
  if (action.view === "log" && action.path) return openLog(action.path, action.title || "日志");
  if (action.url) {
    try {
      const target = new URL(action.url, location.href);
      if (target.protocol === "https:" && target.hostname === "github.com") window.open(target.href, "_blank", "noopener");
    } catch {}
  }
}

async function pollNotifications() {
  try {
    if (!notificationCursorInitialized) {
      await initializeNotificationCursor();
      return;
    }
    const events = await api(`/api/notifications?since=${encodeURIComponent(lastNotificationId)}`);
    for (const event of events) {
      lastNotificationId = Math.max(lastNotificationId, Number(event.id || 0));
      if (event.type === "update" && typeof loadCachedUpdateStatus === "function") await loadCachedUpdateStatus();
      if (event.type === "update" && updateSettings?.update_ignored) continue;
      if (!['off', 'muted'].includes(securitySettings?.notification_mode)) {
        notify(`${event.title}${event.message ? `\n${event.message}` : ""}`, event.level === "error" ? "error" : event.level === "success" ? "success" : "info");
        showDesktopNotification(event);
      }
    }
    localStorage.setItem("lastNotificationId", String(lastNotificationId));
  } catch {}
}

async function initializeNotificationCursor() {
  if (notificationCursorInitialized) return;
  if (!notificationCursorPromise) {
    notificationCursorPromise = api("/api/notifications?since=0").then(events => {
      const latest = Array.isArray(events)
        ? events.reduce((max, event) => Math.max(max, Number(event.id || 0)), 0)
        : 0;
      lastNotificationId = latest;
      localStorage.setItem("lastNotificationId", String(lastNotificationId));
      notificationCursorInitialized = true;
    }).finally(() => {
      notificationCursorPromise = null;
    });
  }
  return notificationCursorPromise;
}

function setButtonBusy(button, busy, text) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = text;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    delete button.dataset.originalText;
  }
}

function captureUiState(root=document) {
  const active = document.activeElement;
  const editable = active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
  const activeName = editable ? active.getAttribute("name") || "" : "";
  const activeValue = editable && "value" in active ? active.value : "";
  return {
    activeId: editable ? active.id : "",
    activeName,
    activeValue,
    selectionStart: editable && typeof active.selectionStart === "number" ? active.selectionStart : null,
    selectionEnd: editable && typeof active.selectionEnd === "number" ? active.selectionEnd : null,
    treeScrollTop: $("connectionGroups")?.scrollTop || 0,
    workspaceScrollTop: document.querySelector(".workspace")?.scrollTop || 0,
    openDetails: [...root.querySelectorAll?.("details[id]") || []].filter(item => item.open).map(item => item.id)
  };
}

function restoreUiState(state) {
  if (!state) return;
  if ($("connectionGroups")) $("connectionGroups").scrollTop = state.treeScrollTop || 0;
  const workspace = document.querySelector(".workspace");
  if (workspace) workspace.scrollTop = state.workspaceScrollTop || 0;
  for (const id of state.openDetails || []) {
    const detail = $(id);
    if (detail) detail.open = true;
  }
  if (state.activeId) {
    let next = $(state.activeId);
    if (!next && state.activeName) next = document.querySelector(`[name="${cssEscape(state.activeName)}"]`);
    if (next) {
      if (state.activeValue !== undefined && "value" in next && next.value !== state.activeValue) next.value = state.activeValue;
      next.focus();
      if (state.selectionStart !== null && typeof next.setSelectionRange === "function") {
        try { next.setSelectionRange(state.selectionStart, state.selectionEnd); } catch {}
      }
    }
  }
}

function keepTerminalKeyboardClosed(event) {
  if (isMobileLayout()) event?.preventDefault?.();
}

function syncViewportHeight() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
  scheduleTerminalFit();
}

function scheduleTerminalFit() {
  fitVisibleTerminals();
  clearTimeout(window.terminalViewportFitTimer);
  window.terminalViewportFitTimer = setTimeout(fitVisibleTerminals, 80);
  clearTimeout(window.terminalViewportFitLaterTimer);
  window.terminalViewportFitLaterTimer = setTimeout(fitVisibleTerminals, 240);
  clearTimeout(window.terminalViewportFitFinalTimer);
  window.terminalViewportFitFinalTimer = setTimeout(fitVisibleTerminals, 700);
}

function fitVisibleTerminals() {
  for (const session of terminalSessions.values()) {
    const box = session.term?.element?.closest?.(".terminal-box");
    let grew = false;
    const buffer = session.term?.buffer?.active;
    const previousViewportY = Number(buffer?.viewportY || 0);
    const wasAtBottom = !buffer || previousViewportY >= Number(buffer.baseY || 0) - 1;
    if (box) {
      box.style.minHeight = "0px";
      const rect = box.getBoundingClientRect();
      if (rect.height > 0) {
        grew = Number(session.lastBoxHeight || 0) && rect.height > Number(session.lastBoxHeight || 0) + 24;
        session.lastBoxHeight = rect.height;
        session.term.element.style.height = `${Math.floor(rect.height)}px`;
      }
    }
    try { session.fit?.fit(); } catch {}
    try { session.term?.refresh?.(0, Math.max(0, session.term.rows - 1)); } catch {}
    try {
      if (wasAtBottom) session.term?.scrollToBottom?.();
      else session.term?.scrollToLine?.(previousViewportY);
    } catch {}
  }
}

function chooseModal(title, message, actions) {
  return new Promise((resolve) => {
    const modal = $("modal");
    modal.onclick = null;
    modal.innerHTML = `<div class="modal-card"><h2>${esc(title)}</h2><div class="modal-message">${esc(message)}</div><div class="actions">${actions.map((item, index)=>`<button class="${item.className || ""}" data-choice="${index}">${esc(item.label)}</button>`).join("")}</div></div>`;
    modal.hidden = false;
    modal.querySelectorAll("button[data-choice]").forEach(button => {
      button.addEventListener("click", () => {
        modal.hidden = true;
        resolve(actions[Number(button.dataset.choice)].value);
      });
    });
  });
}

function inputModal(title, label, defaultValue="") {
  return new Promise((resolve) => {
    const modal = $("modal");
    modal.onclick = null;
    modal.innerHTML = `<div class="modal-card"><h2>${esc(title)}</h2><label>${esc(label)}</label><input id="modalInputValue" value="${esc(defaultValue)}"><div class="actions"><button class="primary" id="modalConfirmBtn">确定</button><button id="modalCancelBtn">取消</button></div></div>`;
    modal.hidden = false;
    const input = $("modalInputValue");
    input.focus();
    input.select();
    const finish = (value) => {
      modal.hidden = true;
      resolve(value);
    };
    $("modalConfirmBtn").onclick = () => finish(input.value.trim());
    $("modalCancelBtn").onclick = () => finish("");
    input.onkeydown = (event) => {
      if (event.key === "Enter") finish(input.value.trim());
      if (event.key === "Escape") finish("");
    };
  });
}

function confirmModal(message, title="确认操作", confirmText="确定", cancelText="取消", danger=false) {
  return chooseModal(title, message, [
    { label: confirmText, value: true, className: danger ? "danger" : "primary" },
    { label: cancelText, value: false }
  ]);
}

function stateView(kind, title, detail="", actionHtml="") {
  const type = ["loading", "error", "empty", "success"].includes(kind) ? kind : "empty";
  return `<div class="ui-state ${type}"><span class="ui-state-icon" aria-hidden="true"></span><strong>${esc(title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ""}${actionHtml ? `<div class="actions">${actionHtml}</div>` : ""}</div>`;
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  notify("已复制", "success");
}

function toggleCheckGroup(box, cls){ document.querySelectorAll(`.${cls}-check`).forEach(x=>x.checked=box.checked); }

function esc(s){ return String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

function escAttr(s){
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
