async function ensureTerminalLibs() {
  if (TerminalClass && FitAddonClass) return;
  const errors = [];
  try {
    await loadScriptOnce("/vendor/xterm/xterm.js");
    await loadScriptOnce("/vendor/xterm/addon-fit.js");
    TerminalClass = window.Terminal || globalThis.Terminal;
    FitAddonClass = window.FitAddon?.FitAddon || window.FitAddon || globalThis.FitAddon?.FitAddon || globalThis.FitAddon;
  } catch (error) {
    errors.push(error.message);
  }
  if (!TerminalClass || !FitAddonClass) {
    try {
      const termModule = await import("/vendor/xterm/xterm.mjs");
      const fitModule = await import("/vendor/xterm/addon-fit.mjs");
      TerminalClass = termModule.Terminal;
      FitAddonClass = fitModule.FitAddon;
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!TerminalClass || !FitAddonClass) throw new Error(`xterm 组件加载失败：${errors.join("；") || "未找到 Terminal/FitAddon"}`);
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const found = document.querySelector(`script[src="${src}"]`);
    if (found?.dataset.loaded === "1") return resolve();
    if (found) {
      found.addEventListener("load", resolve, { once:true });
      found.addEventListener("error", () => reject(new Error(`加载失败：${src}`)), { once:true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.onload = () => {
      script.dataset.loaded = "1";
      resolve();
    };
    script.onerror = () => reject(new Error(`加载失败：${src}`));
    document.head.appendChild(script);
  });
}

function loadRecentTerminalCommands() {
  try {
    const items = JSON.parse(localStorage.getItem("recentTerminalCommands") || "[]");
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function saveRecentTerminalCommand(command) {
  const text = String(command || "").trim();
  if (!text || text.length > 500) return;
  recentTerminalCommands = [text, ...recentTerminalCommands.filter(item => item !== text)].slice(0, 30);
  localStorage.setItem("recentTerminalCommands", JSON.stringify(recentTerminalCommands));
}

const terminalEncodingOptions = [
  ["utf8", "UTF-8"], ["gb18030", "GB18030"], ["gbk", "GBK"], ["big5", "Big5"],
  ["shift_jis", "Shift_JIS"], ["euc-kr", "EUC-KR"], ["latin1", "ISO-8859-1"]
];
const terminalFontOptions = [
  ["ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", "系统等宽"],
  ["Cascadia Mono, Cascadia Code, Consolas, monospace", "Cascadia"],
  ["JetBrains Mono, Consolas, monospace", "JetBrains Mono"],
  ["Consolas, monospace", "Consolas"],
  ["Menlo, Monaco, monospace", "Menlo / Monaco"],
  ["DejaVu Sans Mono, monospace", "DejaVu Sans Mono"],
  ["Noto Sans Mono, monospace", "Noto Sans Mono"]
];

function terminalEncodingLabel(connection) {
  return terminalEncodingOptions.find(([value]) => value === (connection.terminal_encoding || "utf8"))?.[1] || "UTF-8";
}

function updateTerminalConnectionStatus(connection, key, state="") {
  if (activeTabKey !== key) return;
  const status = $("terminalStatus");
  if (!status) return;
  const text = `${connection.ssh_user}@${connection.ssh_host}:${connection.ssh_port}${state ? ` · ${state}` : ""}`;
  status.textContent = text;
  status.title = text;
}

function terminalLatencyTone(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "pending";
  if (milliseconds < 100) return "good";
  if (milliseconds < 250) return "medium";
  return "slow";
}

function terminalLatencyText(session) {
  return Number.isFinite(session?.latencyMs) ? `延迟 ${session.latencyMs} ms` : "延迟 -- ms";
}

function terminalLatencyHtml(key) {
  const session = terminalSessions.get(key);
  const latency = Number(session?.latencyMs);
  return `<span id="terminalLatency" class="terminal-latency ${terminalLatencyTone(latency)}" title="交互响应延迟：从按键发送到远端终端首次返回数据的时间" ${terminalLatencyVisible ? "" : "hidden"}>${esc(terminalLatencyText(session))}</span>`;
}

function updateTerminalLatencyDisplay(key) {
  if (activeTabKey !== key) return;
  const indicator = $("terminalLatency");
  if (!indicator) return;
  const session = terminalSessions.get(key);
  const latency = Number(session?.latencyMs);
  indicator.hidden = !terminalLatencyVisible;
  indicator.className = `terminal-latency ${terminalLatencyTone(latency)}`;
  indicator.textContent = terminalLatencyText(session);
  indicator.title = Number.isFinite(latency)
    ? `最近交互响应延迟 ${latency} ms；从按键发送到远端终端首次返回数据`
    : "交互响应延迟：从按键发送到远端终端首次返回数据的时间";
}

function setTerminalLatencyVisible(visible) {
  terminalLatencyVisible = Boolean(visible);
  localStorage.setItem("terminalLatencyVisible", terminalLatencyVisible ? "1" : "0");
  const input = $("terminalLatencyVisible");
  if (input) input.checked = terminalLatencyVisible;
  if (!terminalLatencyVisible) {
    for (const session of terminalSessions.values()) {
      session.latencyPendingAt = 0;
      clearTimeout(session.latencyPendingTimer);
      session.latencyPendingTimer = null;
    }
  }
  updateTerminalLatencyDisplay(activeTabKey);
}

function startTerminalLatencySample(session) {
  if (!terminalLatencyVisible || !session?.connected || session.latencyPendingAt) return;
  const now = performance.now();
  if (now - Number(session.latencySampledAt || 0) < 500) return;
  session.latencyPendingAt = now;
  clearTimeout(session.latencyPendingTimer);
  session.latencyPendingTimer = setTimeout(() => {
    session.latencyPendingAt = 0;
    session.latencyPendingTimer = null;
  }, 5000);
}

function finishTerminalLatencySample(session, key) {
  const startedAt = Number(session?.latencyPendingAt || 0);
  if (!startedAt) return;
  session.latencyPendingAt = 0;
  clearTimeout(session.latencyPendingTimer);
  session.latencyPendingTimer = null;
  const sample = Math.max(0, Math.round(performance.now() - startedAt));
  if (sample > 5000) return;
  session.latencySamples = [...(session.latencySamples || []), sample].slice(-5);
  const ordered = [...session.latencySamples].sort((left, right) => left - right);
  session.latencyMs = ordered[Math.floor(ordered.length / 2)];
  session.latencySampledAt = performance.now();
  updateTerminalLatencyDisplay(key);
}

function openTerminal(id, updateTab=true, existingKey="", existingTitle="") {
  const c = selectConnection(id);
  if (!c) return;
  let key = existingKey;
  let title = existingTitle;
  if (!key) {
    const next = (terminalCounts.get(c.id) || 0) + 1;
    terminalCounts.set(c.id, next);
    key = `terminal-${c.id}-${next}`;
    title = `${c.name} · 终端${next > 1 ? ` #${next}` : ""}`;
  }
  const connectionAddress = `${c.ssh_user}@${c.ssh_host}:${c.ssh_port}`;
  $("view-terminal").innerHTML = `<div class="terminal-toolbar"><div class="terminal-title-row"><button class="terminal-mobile-back" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="backToExplorer()">${icon("arrow-left")}<span>返回</span></button><span class="terminal-connection-dot"></span><div class="terminal-status" id="terminalStatus" title="${esc(connectionAddress)}">${esc(connectionAddress)}</div>${terminalLatencyHtml(key)}</div><div class="actions terminal-actions"><button class="icon-button" title="打开此连接的 SFTP" aria-label="打开此连接的 SFTP" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="openSftp(${c.id})">${icon("folder-open")}</button><button class="icon-button" title="减小字体（Ctrl+滚轮）" aria-label="减小字体" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="changeTerminalFont('${key}',-1)">${icon("minus")}</button><button class="icon-button" title="增大字体（Ctrl+滚轮）" aria-label="增大字体" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="changeTerminalFont('${key}',1)">${icon("plus")}</button><button class="terminal-dropdown-button" title="切换终端编码" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="showTerminalEncodingMenu(event,'${key}',${c.id})">${icon("languages")}<span>${esc(terminalEncodingLabel(c))}</span>${icon("chevron-down")}</button><button class="terminal-dropdown-button" title="切换终端字体" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="showTerminalFontMenu(event,'${key}',${c.id})">${icon("type")}<span>字体</span>${icon("chevron-down")}</button><button title="${terminalKeysVisible ? "隐藏快捷键" : "显示快捷键"}" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="toggleTerminalKeys('${key}')">${icon("keyboard")}<span>${terminalKeysVisible ? "隐藏快捷键" : "快捷键"}</span></button><button title="最近命令" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="showRecentTerminalCommands('${key}')">${icon("history")}<span>最近命令</span></button><button title="重新连接" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="reconnectTerminal(${c.id}, '${key}')">${icon("refresh-cw")}<span>重连</span></button>${connectionToggleButton(c).replace("<button ", "<button onpointerdown=\"keepTerminalKeyboardClosed(event)\" ")}</div></div>${renderTerminalKeys(key)}<div id="terminalMount" class="terminal-box"></div><div class="terminal-mobile-composer"><input id="terminalMobileInput" type="text" enterkeyhint="send" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="输入命令" onkeydown="handleMobileTerminalInput(event,'${key}')"><button class="primary icon-button" title="发送命令" onclick="sendMobileTerminalInput('${key}')">${icon("send")}</button></div>`;
  setWorkspace(title, `${c.ssh_user}@${c.ssh_host}:${c.ssh_port}`, "terminal", key, updateTab, true, {kind:"terminal", id:c.id});
  attachTerminal(c, key).catch(error => {
    const mount = $("terminalMount");
    if (mount) mount.innerHTML = stateView("error", "终端组件加载失败", error.message, `<button onclick="reconnectTerminal(${c.id},'${key}')">重新连接</button>`);
  });
}

async function attachTerminal(c, key) {
  const mount = $("terminalMount");
  if (!mount.dataset.contextMenuBound) {
    mount.dataset.contextMenuBound = "1";
    mount.addEventListener("contextmenu", event => showTerminalContextMenu(event, key, c.id), {capture:true});
  }
  await ensureTerminalLibs();
  let session = terminalSessions.get(key);
  if (!session) {
    const term = new TerminalClass({
      cursorBlink:true,
      convertEol:true,
      fontFamily:c.terminal_font_family || "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize:Number(c.terminal_font_size) || 13,
      lineHeight:Number(c.terminal_line_height) || 1,
      fontWeight:c.terminal_font_weight || "normal",
      theme:{
        background:"#0f1720",
        foreground:"#d1e7dd",
        cursor:"#ffffff",
        black:"#2e3436",
        red:"#ef4444",
        green:"#22c55e",
        yellow:"#eab308",
        blue:"#60a5fa",
        magenta:"#c084fc",
        cyan:"#2dd4bf",
        white:"#e5e7eb",
        brightBlack:"#6b7280",
        brightRed:"#f87171",
        brightGreen:"#86efac",
        brightYellow:"#fde047",
        brightBlue:"#93c5fd",
        brightMagenta:"#d8b4fe",
        brightCyan:"#67e8f9",
        brightWhite:"#ffffff"
      }
    });
    const fit = new FitAddonClass();
    term.loadAddon(fit);
    session = {term, fit, socket:null, connected:false, id:c.id};
    terminalSessions.set(key, session);
  }
  if (session.term.element) mount.appendChild(session.term.element);
  else session.term.open(mount);
  observeTerminalBox(session);
  enableTerminalTouchScroll(session);
  enableTerminalFontWheel(session, key);
  setTimeout(()=>{
    try { session.fit.fit(); } catch {}
    if (!isMobileLayout()) try { session.term.focus(); } catch {}
    if (!session.socket) connectTerminal(c, key);
    else {
      updateTerminalConnectionStatus(c, key, session.connected ? "已连接" : "已断开");
      updateTerminalLatencyDisplay(key);
    }
    scheduleTerminalFit();
  }, 0);
}

function enableTerminalFontWheel(session, key) {
  const box = session.term?.element?.closest?.(".terminal-box");
  if (!box || session.fontWheelEnabled) return;
  session.fontWheelEnabled = true;
  box.addEventListener("wheel", event => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    changeTerminalFont(key, event.deltaY < 0 ? 1 : -1);
  }, {passive:false});
}

function observeTerminalBox(session) {
  if (session.resizeObserver) return;
  const box = session.term?.element?.closest?.(".terminal-box");
  if (!box || typeof ResizeObserver === "undefined") return;
  session.resizeObserver = new ResizeObserver(() => scheduleTerminalFit());
  session.resizeObserver.observe(box);
}

function enableTerminalTouchScroll(session) {
  const box = session.term?.element?.closest?.(".terminal-box");
  if (!box || session.touchScrollEnabled) return;
  session.touchScrollEnabled = true;
  let lastY = 0;
  let carry = 0;
  box.addEventListener("touchstart", event => {
    if (event.target.closest?.("button,a,input,textarea,select")) return;
    lastY = event.touches[0]?.clientY || 0;
    carry = 0;
  }, {passive:true});
  box.addEventListener("touchmove", event => {
    if (event.target.closest?.("button,a,input,textarea,select")) return;
    const y = event.touches[0]?.clientY || lastY;
    const dy = y - lastY;
    lastY = y;
    carry += dy;
    const lineHeight = session.term?._core?._renderService?.dimensions?.css?.cell?.height || 18;
    const lines = Math.trunc(carry / lineHeight);
    if (lines) {
      try { session.term.scrollLines(-lines); } catch {}
      carry -= lines * lineHeight;
      event.preventDefault();
    }
  }, {passive:false});
}

function handleMobileTerminalInput(event, key) {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  sendMobileTerminalInput(key);
}

function sendMobileTerminalInput(key) {
  const input = $("terminalMobileInput");
  const command = String(input?.value || "");
  if (!command.trim()) return;
  sendTerminalData(key, `${command}\r`);
  saveRecentTerminalCommand(command);
  input.value = "";
  input.focus();
}

function renderTerminalKeys(key) {
  return `<div id="terminalKeys" class="terminal-keys ${terminalKeysVisible ? "" : "hidden"}">
    ${["Esc","Tab","/","-","|","~"].map(label => `<button onpointerdown="keepTerminalKeyboardClosed(event)" onclick="sendTerminalKey('${key}','${escAttr(label)}')">${esc(label)}</button>`).join("")}
    <span class="terminal-arrow-pad"><button class="arrow-up" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="sendTerminalKey('${key}','↑')">↑</button><button class="arrow-left" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="sendTerminalKey('${key}','←')">←</button><button class="arrow-down" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="sendTerminalKey('${key}','↓')">↓</button><button class="arrow-right" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="sendTerminalKey('${key}','→')">→</button></span>
    <button class="${terminalCtrlArmed || terminalCtrlLocked ? "active" : ""}" title="Ctrl 一次：下一个字母按 Ctrl 组合键发送" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="armTerminalCtrl(event)">Ctrl一次</button>
    <button class="${terminalCtrlLocked ? "active" : ""}" title="Ctrl 锁定：连续发送 Ctrl 组合键，再点一次关闭" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="toggleCtrlLock()">Ctrl锁</button>
    ${["C","D","L","A","E","R","Z"].map(label => `<button onpointerdown="keepTerminalKeyboardClosed(event)" onclick="sendCtrlCombo('${key}','${label}')">^${label}</button>`).join("")}
  </div>`;
}

function rerenderTerminalKeys(key=activeTabKey) {
  const box = $("terminalKeys");
  if (!box) return;
  const left = box.scrollLeft;
  box.outerHTML = renderTerminalKeys(key);
  const next = $("terminalKeys");
  if (next) next.scrollLeft = left;
}

function toggleTerminalKeys(key) {
  terminalKeysVisible = !terminalKeysVisible;
  localStorage.setItem("terminalKeysVisible", terminalKeysVisible ? "1" : "0");
  openTerminal(currentConnection()?.id || selectedId, false, key, tabs.find(tab => tab.key === key)?.title || "");
}

function armTerminalCtrl() {
  terminalCtrlArmed = !terminalCtrlArmed;
  rerenderTerminalKeys();
}

function toggleCtrlLock() {
  terminalCtrlLocked = !terminalCtrlLocked;
  terminalCtrlArmed = false;
  rerenderTerminalKeys();
}

function terminalSequence(label) {
  return {Esc:"\x1b", Tab:"\t", "↑":"\x1b[A", "↓":"\x1b[B", "→":"\x1b[C", "←":"\x1b[D"}[label] || label;
}

function sendTerminalData(key, data, options={}) {
  const session = terminalSessions.get(key);
  if (!session?.socket || session.socket.readyState !== WebSocket.OPEN) return notify("终端尚未连接", "error");
  startTerminalLatencySample(session);
  session.socket.send(data);
  const shouldFocus = options.focus ?? !isMobileLayout();
  if (shouldFocus) try { session.term.focus(); } catch {}
}

function transformTerminalInputForCtrl(key, data) {
  if (!(terminalCtrlArmed || terminalCtrlLocked)) return data;
  if (!/^[A-Za-z]$/.test(data)) return data;
  const code = data.toUpperCase().charCodeAt(0) - 64;
  if (code < 1 || code > 26) return data;
  if (!terminalCtrlLocked) terminalCtrlArmed = false;
  rerenderTerminalKeys(key);
  return String.fromCharCode(code);
}

function sendTerminalKey(key, label) {
  if ((terminalCtrlArmed || terminalCtrlLocked) && /^[A-Za-z]$/.test(label)) {
    sendCtrlCombo(key, label);
    return;
  }
  sendTerminalData(key, terminalSequence(label));
  if (terminalCtrlArmed && !terminalCtrlLocked) terminalCtrlArmed = false;
  rerenderTerminalKeys(key);
}

function sendCtrlCombo(key, letter) {
  const code = String(letter).toUpperCase().charCodeAt(0) - 64;
  if (code < 1 || code > 26) return;
  sendTerminalData(key, String.fromCharCode(code));
  if (!terminalCtrlLocked) terminalCtrlArmed = false;
  rerenderTerminalKeys(key);
}

function showRecentTerminalCommands(key) {
  const items = recentTerminalCommands.slice(0, 80);
  if (!items.length) return notify("暂无最近命令", "info");
  const modal = $("modal");
  modal.innerHTML = `<div class="modal-card wide"><h2>最近命令</h2><div class="recent-command-list">${items.map((cmd, index) => `<button data-index="${index}"><code>${esc(cmd)}</code></button>`).join("")}</div><div class="actions"><button id="recentCommandClear" class="danger">清空</button><button id="recentCommandClose">关闭</button></div></div>`;
  modal.hidden = false;
  modal.querySelectorAll(".recent-command-list button").forEach(button => {
    button.onclick = () => {
      const cmd = items[Number(button.dataset.index)];
      modal.hidden = true;
      sendTerminalData(key, `${cmd}\r`);
    };
  });
  $("recentCommandClear").onclick = () => {
    recentTerminalCommands = [];
    localStorage.removeItem("recentTerminalCommands");
    modal.hidden = true;
    notify("最近命令已清空", "success");
  };
  $("recentCommandClose").onclick = () => { modal.hidden = true; };
}

function cleanTerminalCommandText(text) {
  return String(text || "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .trim();
}

function currentTerminalPromptCommand(session) {
  try {
    const buffer = session.term?.buffer?.active;
    const row = buffer?.baseY + buffer?.cursorY;
    const line = buffer?.getLine(row)?.translateToString(true) || "";
    const text = cleanTerminalCommandText(line);
    const markers = ["# ", "$ ", "> "];
    let index = -1;
    for (const marker of markers) index = Math.max(index, text.lastIndexOf(marker));
    return index >= 0 ? text.slice(index + 2).trim() : "";
  } catch {
    return "";
  }
}

function changeTerminalFont(key, delta) {
  const session = terminalSessions.get(key);
  if (!session) return;
  const size = Math.max(10, Math.min(32, Number(session.term.options.fontSize || 13) + delta));
  session.term.options.fontSize = size;
  const connection = connections.find(item => item.id === session.id);
  if (connection) {
    connection.terminal_font_size = size;
    scheduleTerminalPreferencesSave(connection);
  }
  setTimeout(() => { try { session.fit.fit(); } catch {} }, 0);
}

const terminalPreferencesSaveTimers = new Map();

function scheduleTerminalPreferencesSave(connection) {
  clearTimeout(terminalPreferencesSaveTimers.get(connection.id));
  terminalPreferencesSaveTimers.set(connection.id, setTimeout(() => {
    terminalPreferencesSaveTimers.delete(connection.id);
    api(`/api/connections/${connection.id}/terminal-preferences`, {
      method:"POST",
      body:JSON.stringify({
        terminal_encoding:connection.terminal_encoding || "utf8",
        terminal_font_family:connection.terminal_font_family,
        terminal_font_size:connection.terminal_font_size,
        terminal_line_height:connection.terminal_line_height ?? 1,
        terminal_font_weight:connection.terminal_font_weight || "normal"
      })
    }).catch(error => notify(`终端设置保存失败：${error.message}`, "error"));
  }, 300));
}

function focusTerminalSession(key) {
  const session = terminalSessions.get(key);
  setTimeout(() => {
    try { session?.term.focus(); } catch {}
  }, 0);
}

function showTerminalEncodingMenu(event, key, connectionId) {
  const connection = connections.find(item => item.id === connectionId);
  if (!connection) return;
  const current = connection.terminal_encoding || "utf8";
  showActionMenu(event, terminalEncodingOptions.map(([value,label]) => ({
    label,
    icon:value === current ? "check" : "languages",
    run:()=>applyTerminalPreferences(key, connectionId, {terminal_encoding:value}, `编码已切换为 ${label}`)
  })));
}

function showTerminalFontMenu(event, key, connectionId) {
  const connection = connections.find(item => item.id === connectionId);
  if (!connection) return;
  const current = connection.terminal_font_family || terminalFontOptions[0][0];
  const currentLineHeight = Number(connection.terminal_line_height) || 1;
  const currentWeight = connection.terminal_font_weight || "normal";
  showActionMenu(event, [
    ...terminalFontOptions.map(([value,label]) => ({
      label,
      icon:value === current ? "check" : "type",
      run:()=>applyTerminalPreferences(key, connectionId, {terminal_font_family:value}, `终端字体已切换为 ${label}`)
    })),
    {separator:true},
    {label:"自定义字体…", icon:"pencil", run:()=>setCustomTerminalFont(key, connectionId)},
    {separator:true},
    ...[[1,"紧凑行距 1.0"],[1.2,"行距 1.2"],[1.4,"行距 1.4"],[1.6,"宽松行距 1.6"]].map(([value,label]) => ({
      label,
      icon:Number(value) === currentLineHeight ? "check" : "between-horizontal-start",
      run:()=>applyTerminalPreferences(key, connectionId, {terminal_line_height:Number(value)}, `终端${label}已保存`)
    })),
    {separator:true},
    ...[["normal","常规字重"],["500","中等字重"],["600","半粗字重"],["bold","粗体"]].map(([value,label]) => ({
      label,
      icon:value === currentWeight ? "check" : "bold",
      run:()=>applyTerminalPreferences(key, connectionId, {terminal_font_weight:value}, `终端${label}已保存`)
    })),
    {separator:true},
    {label:"恢复终端显示默认值", icon:"rotate-ccw", run:()=>resetTerminalDisplayPreferences(key, connectionId)}
  ]);
}

async function setCustomTerminalFont(key, connectionId) {
  const connection = connections.find(item => item.id === connectionId);
  if (!connection) return;
  const value = await inputModal("自定义终端字体", "字体名称或字体栈", connection.terminal_font_family || terminalFontOptions[0][0]);
  if (value) await applyTerminalPreferences(key, connectionId, {terminal_font_family:value}, "自定义终端字体已保存");
  else focusTerminalSession(key);
}

async function resetTerminalDisplayPreferences(key, connectionId) {
  await applyTerminalPreferences(key, connectionId, {
    terminal_font_family:terminalFontOptions[0][0],
    terminal_font_size:13,
    terminal_line_height:1,
    terminal_font_weight:"normal"
  }, "终端字体、字号、行距和字重已恢复默认");
}

async function applyTerminalPreferences(key, connectionId, changes, successText="终端设置已保存") {
  const connection = connections.find(item => item.id === connectionId);
  if (!connection) return;
  try {
    const settings = await api(`/api/connections/${connectionId}/terminal-preferences`, {
      method:"POST",
      body:JSON.stringify({
        terminal_encoding:changes.terminal_encoding ?? connection.terminal_encoding ?? "utf8",
        terminal_font_family:changes.terminal_font_family ?? connection.terminal_font_family ?? terminalFontOptions[0][0],
        terminal_font_size:changes.terminal_font_size ?? connection.terminal_font_size ?? 13,
        terminal_line_height:changes.terminal_line_height ?? connection.terminal_line_height ?? 1,
        terminal_font_weight:changes.terminal_font_weight ?? connection.terminal_font_weight ?? "normal"
      })
    });
    Object.assign(connection, settings);
    for (const activeSession of terminalSessions.values()) {
      if (activeSession.id !== connectionId) continue;
      activeSession.term.options.fontFamily = settings.terminal_font_family;
      activeSession.term.options.fontSize = settings.terminal_font_size;
      activeSession.term.options.lineHeight = settings.terminal_line_height;
      activeSession.term.options.fontWeight = settings.terminal_font_weight;
      if (activeSession.socket?.readyState === WebSocket.OPEN) {
        activeSession.socket.send(JSON.stringify({type:"terminal-encoding", encoding:settings.terminal_encoding}));
      }
      setTimeout(() => { try { activeSession.fit.fit(); } catch {} }, 0);
    }
    const encodingButton = document.querySelector(`button[onclick*="showTerminalEncodingMenu"][onclick*="'${key}'"] span`);
    if (encodingButton) encodingButton.textContent = terminalEncodingLabel(connection);
    notify(successText, "success");
  } finally {
    focusTerminalSession(key);
  }
}

function terminalBufferText(session) {
  const buffer = session?.term?.buffer?.active;
  if (!buffer) return "";
  const lines = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) || "");
  }
  return lines.join("\n").replace(/\s+$/, "");
}

async function copyTerminalText(key, all=false) {
  const session = terminalSessions.get(key);
  if (!session) return notify("终端会话不存在", "error");
  const text = all ? terminalBufferText(session) : (session.term.hasSelection?.() ? session.term.getSelection() : "");
  if (!text) return notify(all ? "终端暂无可复制内容" : "请先选择终端文本", "info");
  await copyText(text);
}

async function pasteTerminalText(key) {
  const text = await navigator.clipboard.readText();
  if (!text) return notify("剪贴板中没有文本", "info");
  sendTerminalData(key, text);
}

function showTerminalContextMenu(event, key, connectionId) {
  const session = terminalSessions.get(key);
  if (!session) return;
  showActionMenu(event, [
    {label:"复制选中", icon:"copy", run:()=>copyTerminalText(key)},
    {label:"复制全部输出", icon:"copy-check", run:()=>copyTerminalText(key, true)},
    {label:"粘贴", icon:"clipboard-paste", run:()=>pasteTerminalText(key)},
    {label:"全选终端", icon:"text-select", run:()=>session.term.selectAll()},
    {separator:true},
    {label:"清屏", icon:"eraser", run:()=>{ session.term.clear(); session.term.focus(); }},
    {label:"滚动到底部", icon:"arrow-down-to-line", run:()=>session.term.scrollToBottom()},
    {separator:true},
    {label:"减小字体", icon:"minus", run:()=>changeTerminalFont(key, -1)},
    {label:"增大字体", icon:"plus", run:()=>changeTerminalFont(key, 1)},
    {label:"重新连接", icon:"refresh-cw", run:()=>reconnectTerminal(connectionId, key)}
  ]);
}

function connectTerminal(c, key) {
  const session = terminalSessions.get(key);
  if (!session) return;
  try { session.socket?.close(); } catch {}
  try { session.inputDisposable?.dispose(); } catch {}
  try { session.resizeDisposable?.dispose(); } catch {}
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const tab = tabs.find(item => item.key === key);
  const title = tab?.title || `${c.name} · 终端`;
  const socket = new WebSocket(`${protocol}://${location.host}/ws/terminal?id=${encodeURIComponent(c.id)}&cols=${session.term.cols || 80}&rows=${session.term.rows || 24}&title=${encodeURIComponent(title)}`);
  socket.binaryType = "arraybuffer";
  session.socket = socket;
  session.connected = false;
  session.term.writeln(`连接 ${c.ssh_user}@${c.ssh_host}:${c.ssh_port} ...`);
  socket.addEventListener("open", () => {
    session.connected = true;
    updateTerminalConnectionStatus(c, key, "已连接");
  });
  socket.addEventListener("message", event => {
    finishTerminalLatencySample(session, key);
    session.term.write(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data);
    if (isMobileLayout()) scheduleTerminalFit();
  });
  socket.addEventListener("close", () => {
    session.connected = false;
    session.latencyPendingAt = 0;
    clearTimeout(session.latencyPendingTimer);
    session.term.writeln("\r\n[连接已关闭]");
    updateTerminalConnectionStatus(c, key, "已断开");
  });
  socket.addEventListener("error", () => session.term.writeln("\r\n[WebSocket 连接失败]"));
  session.inputDisposable = session.term.onData(data => {
    const beforeCtrl = terminalCtrlArmed || terminalCtrlLocked;
    const outgoing = transformTerminalInputForCtrl(key, data);
    if (!beforeCtrl) trackTerminalCommand(session, data);
    if (socket.readyState === WebSocket.OPEN) {
      startTerminalLatencySample(session);
      socket.send(outgoing);
    }
  });
  session.resizeDisposable = session.term.onResize(size => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type:"resize", cols:size.cols, rows:size.rows}));
  });
}

function trackTerminalCommand(session, data) {
  session.commandBuffer = session.commandBuffer || "";
  const raw = String(data || "");
  if (raw.includes("\x1b")) return;
  for (const ch of String(data || "")) {
    if (ch === "\r" || ch === "\n") {
      saveRecentTerminalCommand(currentTerminalPromptCommand(session) || session.commandBuffer);
      session.commandBuffer = "";
    } else if (ch === "\x7f" || ch === "\b") {
      session.commandBuffer = session.commandBuffer.slice(0, -1);
    } else if (ch === "\x03") {
      session.commandBuffer = "";
    } else if (ch === "\t") {
      session.commandBuffer = "";
    } else if (ch >= " " && ch !== "\x7f") {
      session.commandBuffer += ch;
    }
  }
}

function reconnectTerminal(id, key=`terminal-${id}-1`) {
  const c = currentConnection(id);
  if (!c) return;
  const session = terminalSessions.get(key);
  if (session) session.term.reset();
  connectTerminal(c, key);
}
