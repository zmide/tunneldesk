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
  $("view-terminal").innerHTML = `<div class="terminal-toolbar"><div class="terminal-title-row"><button class="terminal-mobile-back" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="backToExplorer()">${icon("arrow-left")}<span>返回</span></button><span class="terminal-connection-dot"></span><div class="terminal-status" id="terminalStatus">${esc(c.ssh_user)}@${esc(c.ssh_host)}:${c.ssh_port}</div></div><div class="actions terminal-actions"><button class="icon-button" title="减小字体" aria-label="减小字体" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="changeTerminalFont('${key}',-1)">${icon("minus")}</button><button class="icon-button" title="增大字体" aria-label="增大字体" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="changeTerminalFont('${key}',1)">${icon("plus")}</button><button title="${terminalKeysVisible ? "隐藏快捷键" : "显示快捷键"}" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="toggleTerminalKeys('${key}')">${icon("keyboard")}<span>${terminalKeysVisible ? "隐藏快捷键" : "快捷键"}</span></button><button title="最近命令" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="showRecentTerminalCommands('${key}')">${icon("history")}<span>最近命令</span></button><button title="重新连接" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="reconnectTerminal(${c.id}, '${key}')">${icon("refresh-cw")}<span>重连</span></button>${connectionToggleButton(c).replace("<button ", "<button onpointerdown=\"keepTerminalKeyboardClosed(event)\" ")}</div></div>${renderTerminalKeys(key)}<div id="terminalMount" class="terminal-box"></div><div class="terminal-mobile-composer"><input id="terminalMobileInput" type="text" enterkeyhint="send" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="输入命令" onkeydown="handleMobileTerminalInput(event,'${key}')"><button class="primary icon-button" title="发送命令" onclick="sendMobileTerminalInput('${key}')">${icon("send")}</button></div>`;
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
      fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",
      fontSize:terminalFontSize,
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
  setTimeout(()=>{
    try { session.fit.fit(); } catch {}
    if (!isMobileLayout()) try { session.term.focus(); } catch {}
    if (!session.socket) connectTerminal(c, key);
    scheduleTerminalFit();
  }, 0);
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
  terminalFontSize = Math.max(10, Math.min(24, terminalFontSize + delta));
  localStorage.setItem("terminalFontSize", String(terminalFontSize));
  const session = terminalSessions.get(key);
  if (!session) return;
  session.term.options.fontSize = terminalFontSize;
  setTimeout(() => { try { session.fit.fit(); } catch {} }, 0);
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
  session.socket = socket;
  session.connected = false;
  session.term.writeln(`连接 ${c.ssh_user}@${c.ssh_host}:${c.ssh_port} ...`);
  socket.addEventListener("open", () => {
    session.connected = true;
    const status = $("terminalStatus");
    if (status && activeTabKey === key) status.textContent = `${c.ssh_user}@${c.ssh_host}:${c.ssh_port} · 已连接`;
  });
  socket.addEventListener("message", event => {
    session.term.write(event.data);
    if (isMobileLayout()) scheduleTerminalFit();
  });
  socket.addEventListener("close", () => {
    session.connected = false;
    session.term.writeln("\r\n[连接已关闭]");
    const status = $("terminalStatus");
    if (status && activeTabKey === key) status.textContent = `${c.ssh_user}@${c.ssh_host}:${c.ssh_port} · 已断开`;
  });
  socket.addEventListener("error", () => session.term.writeln("\r\n[WebSocket 连接失败]"));
  session.inputDisposable = session.term.onData(data => {
    const beforeCtrl = terminalCtrlArmed || terminalCtrlLocked;
    const outgoing = transformTerminalInputForCtrl(key, data);
    if (!beforeCtrl) trackTerminalCommand(session, data);
    if (socket.readyState === WebSocket.OPEN) socket.send(outgoing);
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
