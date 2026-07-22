function textSelectionFromTextarea(el) {
  return el.value.slice(el.selectionStart || 0, el.selectionEnd || 0);
}

async function copyCommandContext(target, all=false) {
  const text = target.matches("textarea")
    ? (all ? target.value : textSelectionFromTextarea(target) || target.value)
    : (all ? target.textContent : String(getSelection()?.toString() || "").trim() || target.textContent);
  await copyText(text || "");
}

async function pasteCommandContext(target) {
  if (!target?.matches("textarea")) return;
  const text = await navigator.clipboard.readText();
  const start = target.selectionStart || 0;
  const end = target.selectionEnd || 0;
  target.value = `${target.value.slice(0, start)}${text}${target.value.slice(end)}`;
  const next = start + text.length;
  target.focus();
  target.setSelectionRange(next, next);
}

function hideCommandContextMenu() {
  $("commandContextMenu")?.remove();
}

function showCommandContextMenu(event) {
  const target = event.target.closest?.("textarea.command-textarea, .command-output");
  if (!target) return;
  event.preventDefault();
  hideCommandContextMenu();
  const isInput = target.matches("textarea");
  const menu = document.createElement("div");
  menu.id = "commandContextMenu";
  menu.className = "context-menu";
  const items = [
    ["复制", () => copyCommandContext(target)],
    ...(isInput ? [["粘贴", () => pasteCommandContext(target)], ["全选", () => { target.focus(); target.select(); }]] : [["复制全部", () => copyCommandContext(target, true)]])
  ];
  for (const [label, action] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", async () => {
      try { await action(); } catch (error) { notify(error.message || "操作失败", "error"); }
      hideCommandContextMenu();
    });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - rect.height - 8)}px`;
}

async function renderCommandTemplates() {
  await loadCommandTemplates();
  $("connectionGroups").innerHTML = `<div class="command-template-manager">
    <div id="templateEditor">${renderTemplateEditor()}</div>
    <div class="template-list">
      ${commandTemplates.map(template => renderTemplateRow(template)).join("") || stateView("empty", "暂无命令模板", "可以新建模板，也可以直接进入批量执行输入命令。", `<button class="primary" onclick="newCommandTemplate()">新增模板</button>`)}
    </div>
  </div>`;
}

function renderTemplateEditor(template=null) {
  const editing = Boolean(template);
  editingTemplateId = editing ? template.id : "";
  return `<div class="panel template-editor-panel">
    <label>模板名称</label>
    <input id="templateName" value="${esc(template?.name || "")}" placeholder="例如：查看系统信息">
    <label>命令</label>
    <textarea id="templateCommand" placeholder="例如：uname -a">${esc(template?.command || "")}</textarea>
    <label>备注</label>
    <input id="templateDescription" value="${esc(template?.description || "")}" placeholder="可选">
    <div class="actions">
      <button class="primary" onclick="saveTemplateForm()">${editing ? "保存模板" : "新增模板"}</button>
      ${editing ? `<button onclick="newCommandTemplate()">取消</button>` : ""}
    </div>
  </div>`;
}

function renderTemplateRow(template) {
  return `<div class="template-row">
    <button class="template-main" onclick="applyTemplateToCommand('${escAttr(template.id)}')">
      <span class="conn-name">${esc(template.name)}</span>
      <span class="conn-meta">${esc(template.command)}</span>
      ${template.description ? `<span class="muted">${esc(template.description)}</span>` : ""}
    </button>
    <div class="template-actions">
      <button onclick="editCommandTemplate('${escAttr(template.id)}')">编辑</button>
      <button class="danger" onclick="deleteCommandTemplate('${escAttr(template.id)}')">删除</button>
    </div>
  </div>`;
}

function newCommandTemplate() {
  const box = $("templateEditor");
  if (box) box.innerHTML = renderTemplateEditor();
}

function editCommandTemplate(id) {
  const template = commandTemplates.find(item => item.id === id);
  if (!$("templateEditor") || !template) return;
  $("templateEditor").innerHTML = renderTemplateEditor(template);
}

async function saveTemplateForm() {
  const payload = {
    name: $("templateName")?.value.trim(),
    command: $("templateCommand")?.value.trim(),
    description: $("templateDescription")?.value.trim()
  };
  const path = editingTemplateId ? `/api/command-templates/${encodeURIComponent(editingTemplateId)}` : "/api/command-templates";
  await api(path, {method: editingTemplateId ? "PUT" : "POST", body:JSON.stringify(payload)});
  notify(editingTemplateId ? "模板已保存" : "模板已新增", "success");
  await renderCommandTemplates();
  renderCommandTemplateOptions();
}

async function deleteCommandTemplate(id) {
  const template = commandTemplates.find(item => item.id === id);
  if (!await confirmModal(`删除模板 ${template?.name || ""}？`, "删除命令模板", "删除", "取消", true)) return;
  await api(`/api/command-templates/${encodeURIComponent(id)}`, {method:"DELETE"});
  notify("模板已删除", "success");
  await renderCommandTemplates();
  renderCommandTemplateOptions();
}

function applyTemplateToCommand(id) {
  primaryView = "command";
  const template = commandTemplates.find(item => item.id === id);
  if (!template) return;
  openBatchCommand();
  setTimeout(() => {
    const select = $("batchCommandTemplate");
    if (select) select.value = id;
    if ($("batchCommandText")) $("batchCommandText").value = template.command || "";
  }, 0);
}

function openBatchCommand(updateTab=true) {
  const selected = new Set([selectedId].filter(Boolean).map(String));
  if (!commandTemplates.length) loadCommandTemplates().then(renderCommandTemplateOptions).catch(()=>{});
  $("view-command").innerHTML = `<div class="panel command-panel">
    <div class="workspace-head">
      <div>
        <h2>批量执行</h2>
        <div class="subtitle">选择多个 SSH 连接后执行同一条命令，每台服务器实时显示独立输出。</div>
      </div>
      <div class="actions">
        <button onclick="setBatchCommandChecks(true)">${icon("list-checks")}<span>全选</span></button>
        <button onclick="setBatchCommandChecks(false)">${icon("list-x")}<span>取消选择</span></button>
      </div>
    </div>
    <div class="grid">
      <div>
        <label>预设模板</label>
        <select id="batchCommandTemplate" onchange="useCommandTemplate(this.value)">${renderCommandTemplateOptionsHtml()}</select>
      </div>
      <div>
        <label>超时时间（秒）</label>
        <input id="batchCommandTimeout" type="number" min="5" max="600" value="60">
      </div>
    </div>
    <label>命令</label>
    <textarea id="batchCommandText" class="command-textarea" placeholder="例如：whoami 或 uname -a"></textarea>
    <div class="actions command-actions">
      <button id="batchCommandRunBtn" class="primary" onclick="runBatchCommand()">${icon("play")}<span>执行命令</span></button>
      <button id="batchCommandStopBtn" onclick="stopBatchCommand()" disabled>${icon("square")}<span>停止</span></button>
      <button id="batchExportTxtBtn" onclick="exportBatchCommand('txt')" hidden>${icon("file-text")}<span>导出 TXT</span></button>
      <button id="batchExportJsonBtn" onclick="exportBatchCommand('json')" hidden>${icon("braces")}<span>导出 JSON</span></button>
      <span id="batchCommandStatus" class="muted"></span>
    </div>
    <label>目标 SSH <span id="batchTargetCount" class="field-count">已选择 ${selected.size} 台</span></label>
    <div class="command-targets">${renderBatchCommandTargets(selected)}</div>
    <div id="batchCommandResults" class="command-results"></div>
  </div>`;
  setWorkspace("批量执行", "选择多个 SSH 执行命令", "command", "command", updateTab, true, {kind:"command"});
}

async function loadCommandTemplates() {
  commandTemplates = await api("/api/command-templates");
  return commandTemplates;
}

function renderCommandTemplateOptionsHtml() {
  return `<option value="">手动输入命令</option>` + commandTemplates.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
}

function renderCommandTemplateOptions() {
  const select = $("batchCommandTemplate");
  if (select) select.innerHTML = renderCommandTemplateOptionsHtml();
}

function useCommandTemplate(id) {
  const item = commandTemplates.find(template => template.id === id);
  if (item && $("batchCommandText")) $("batchCommandText").value = item.command || "";
}

function renderBatchCommandTargets(selected=new Set()) {
  const groups = filteredConnections().reduce((m,c)=>{(m[c.group_name] ||= []).push(c); return m;},{});
  const names = Object.keys(groups);
  if (!names.length) return stateView("empty", "暂无可执行连接", "请先在连接列表添加 SSH 服务器。");
  return names.map(group => `<div class="command-target-group">
    <div class="command-target-title">${esc(group)} <span>${groups[group].length}</span></div>
    ${groups[group].map(c => `<label class="command-target">
      <input class="batch-command-check" type="checkbox" value="${c.id}" ${selected.has(String(c.id)) ? "checked" : ""} onchange="updateBatchTargetCount()">
      <span><strong>${esc(c.name)}</strong><em>${esc(c.ssh_user)}@${esc(c.ssh_host)}:${c.ssh_port}</em></span>
    </label>`).join("")}
  </div>`).join("");
}

function setBatchCommandChecks(checked) {
  document.querySelectorAll(".batch-command-check").forEach(input => input.checked = checked);
  updateBatchTargetCount();
}

function updateBatchTargetCount() {
  const count = document.querySelectorAll(".batch-command-check:checked").length;
  if ($("batchTargetCount")) $("batchTargetCount").textContent = `已选择 ${count} 台`;
}

function commandLooksDangerous(command) {
  return /\b(rm\s+(-[a-z]*r[a-z]*f|-rf|-[a-z]*f[a-z]*r)|mkfs|shutdown|reboot|poweroff|halt|chmod\s+-R\s+777|chown\s+-R)\b|dd\s+if=|:\s*\(\)\s*\{\s*:\s*\|\s*:\s*;\s*\}/i.test(command);
}

async function runBatchCommand() {
  const button = $("batchCommandRunBtn");
  const ids = [...document.querySelectorAll(".batch-command-check:checked")].map(input => Number(input.value));
  let command = normalizeBatchCommandInput($("batchCommandText")?.value || "");
  const timeout = Math.max(5, Math.min(600, Number($("batchCommandTimeout")?.value || 60)));
  if (!ids.length) return notify("请选择要执行命令的 SSH", "error");
  if (!command) return notify("请输入要执行的命令", "error");
  const nonEmptyLines = command.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const uniqueLines = [...new Set(nonEmptyLines)];
  if (nonEmptyLines.length > 1 && uniqueLines.length === 1) {
    if (await confirmModal(`检测到同一条命令重复了 ${nonEmptyLines.length} 次，是否只执行一次？`, "重复命令", "只执行一次", "按原内容执行")) {
      command = uniqueLines[0];
    }
  } else if (nonEmptyLines.length > 1 && !await confirmModal(`当前是 ${nonEmptyLines.length} 行命令，将通过一次 SSH 连接按脚本逐行执行。继续吗？`, "批量执行确认", "继续", "取消")) {
    return;
  }
  if ($("batchCommandText").value !== command) $("batchCommandText").value = command;
  if (commandLooksDangerous(command) && !await confirmModal("这条命令看起来有破坏风险，确定要批量执行吗？", "危险命令确认", "继续执行", "取消", true)) return;
  batchCommandExport = {command, started_at:new Date().toISOString(), finished_at:null, results:Object.fromEntries(ids.map(id => { const c=currentConnection(id); return [id,{id,name:c?.name || String(id),host:c ? `${c.ssh_user}@${c.ssh_host}:${c.ssh_port}` : "",output:"",ok:null,exit_code:null,error:"",elapsed_ms:null}]; }))};
  $("batchExportTxtBtn").hidden = true;
  $("batchExportJsonBtn").hidden = true;
  setButtonBusy(button, true, "执行中...");
  $("batchCommandStopBtn").disabled = false;
  $("batchCommandStatus").textContent = "正在连接执行通道...";
  $("batchCommandResults").innerHTML = ids.map(id => {
    const c = currentConnection(id) || connections.find(item => item.id === id);
    return `<div class="command-result" id="batchResult-${id}">
      <div class="command-result-head"><strong>${esc(c?.name || id)}</strong><span>等待执行</span></div>
      <pre class="command-output live" id="batchOutput-${id}"></pre>
    </div>`;
  }).join("");
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  batchCommandSocket = new WebSocket(`${protocol}://${location.host}/ws/batch-command`);
  batchCommandSocket.addEventListener("open", () => {
    batchCommandSocket.send(JSON.stringify({ids, command, timeout_ms: timeout * 1000}));
    $("batchCommandStatus").textContent = "正在执行...";
  });
  batchCommandSocket.addEventListener("message", event => handleBatchCommandEvent(JSON.parse(event.data)));
  batchCommandSocket.addEventListener("error", () => notify("批量命令连接失败", "error"));
  batchCommandSocket.addEventListener("close", () => {
    setButtonBusy(button, false);
    $("batchCommandStopBtn").disabled = true;
    batchCommandSocket = null;
  });
}

function stopBatchCommand() {
  try { batchCommandSocket?.close(); } catch {}
}

function handleBatchCommandEvent(message) {
  if (message.type === "ready") return;
  if (message.type === "meta") {
    $("batchCommandStatus").innerHTML = `日志：<button class="ghost" onclick="openLog('${escAttr(message.log_path)}','${escAttr(message.log_label)}')">${esc(message.log_label)}</button>`;
    return;
  }
  if (message.type === "start") {
    updateBatchResultHead(message.id, "执行中");
    return;
  }
  if (message.type === "data") {
    const output = $(`batchOutput-${message.id}`);
    if (output) {
      output.textContent += message.data || "";
      output.scrollTop = output.scrollHeight;
    }
    if (batchCommandExport?.results?.[message.id]) batchCommandExport.results[message.id].output += message.data || "";
    return;
  }
  if (message.type === "exit") {
    const row = $(`batchResult-${message.id}`);
    if (row) row.classList.add(message.ok ? "ok" : "bad");
    updateBatchResultHead(message.id, `${message.ok ? "成功" : "失败"} · exit ${message.exit_code ?? ""}${message.error ? ` · ${message.error}` : ""}`);
    if (batchCommandExport?.results?.[message.id]) Object.assign(batchCommandExport.results[message.id], {ok:message.ok,exit_code:message.exit_code,error:message.error || "",elapsed_ms:message.elapsed_ms});
    return;
  }
  if (message.type === "done") {
    $("batchCommandStatus").textContent = `完成：成功 ${message.ok} 个，失败 ${message.failed} 个`;
    notify(`批量命令完成：成功 ${message.ok} 个，失败 ${message.failed} 个`, message.failed ? "error" : "success");
    if (batchCommandExport) batchCommandExport.finished_at = new Date().toISOString();
    $("batchExportTxtBtn").hidden = false;
    $("batchExportJsonBtn").hidden = false;
    return;
  }
  if (message.type === "error") notify(message.error || "批量命令失败", "error");
}

function exportBatchCommand(format) {
  if (!batchCommandExport) return notify("暂无可导出的批量执行结果", "info");
  const data = {...batchCommandExport, results:Object.values(batchCommandExport.results)};
  const text = format === "json" ? JSON.stringify(data, null, 2) : [`命令：${data.command}`, `开始：${data.started_at}`, `结束：${data.finished_at || ""}`, "", ...data.results.flatMap(item => [`===== ${item.name} · ${item.host} =====`, `状态：${item.ok ? "成功" : "失败"} · exit ${item.exit_code ?? ""} · ${item.elapsed_ms ?? ""}ms`, item.error ? `错误：${item.error}` : "", item.output || "（无输出）", ""])] .join("\n");
  const blob = new Blob([text], {type:format === "json" ? "application/json" : "text/plain"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tunneldesk-batch-${new Date().toISOString().replace(/[:.]/g,"-")}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

function updateBatchResultHead(id, text) {
  const row = $(`batchResult-${id}`);
  const status = row?.querySelector(".command-result-head span");
  if (status) status.textContent = text;
}

function normalizeBatchCommandInput(command) {
  return String(command || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "")
    .replace(/\n{3,}/g, "\n\n");
}
