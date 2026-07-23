function grouped(){ return connections.reduce((m,c)=>{(m[c.group_name] ||= []).push(c); return m;},{}); }

function filteredConnections() {
  const q = connectionSearch.trim().toLowerCase();
  if (!q) return connections;
  return connections.filter(c => [
    c.name, c.group_name, c.tags, c.ssh_host, c.ssh_user, c.ssh_port,
    ...(c.forwards || []).flatMap(f => [f.mode, f.bind_host, f.bind_port, f.target_host, f.target_port])
  ].some(value => String(value ?? "").toLowerCase().includes(q)));
}

function setConnectionSearch(value) {
  connectionSearch = value || "";
  localStorage.setItem("connectionSearch", connectionSearch);
  renderConnections();
}

function connectionHasRunningForwards(c){ return (c.forwards||[]).some(f=>f.status==="running"); }

function connectionToggleButton(c){
  const action=connectionHasRunningForwards(c)?"stop":"start";
  const text=action==="start"?"启用转发":"停止转发";
  return `<button onclick="connectionForwardAction(${c.id},'${action}',this)">${icon(action === "start" ? "play" : "square")}<span>${text}</span></button>`;
}

function showConnectionMenu(event, id) {
  const c = connections.find(item => item.id === id);
  if (!c) return;
  showActionMenu(event, [
    {label:"SFTP 文件", icon:"folder-open", run:()=>openSftp(id)},
    {label:"服务器仪表盘", icon:"gauge", run:()=>openServerDashboard(id)},
    {label:"健康检查", icon:"activity", run:()=>checkConnectionHealth(id)},
    {separator:true},
    {label:"编辑连接", icon:"pencil", run:()=>editConnection(id)},
    {label:"删除连接", icon:"trash-2", danger:true, run:()=>deleteConnection(id)}
  ]);
}

function renderConnections(){
  if (primaryView === "logs") return renderLogs().catch(e=>notify(e.message,"error"));
  if (primaryView === "running") return renderRunningForwards();
  const uiState = captureUiState($("connectionGroups") || document);
  connectionVirtual.scrollTop = $("connectionGroups")?.scrollTop || connectionVirtual.scrollTop;
  const groups = filteredConnections().reduce((m,c)=>{(m[c.group_name] ||= []).push(c); return m;},{});
  const names = Object.keys(groups);
  const existingIds = new Set(connections.map(c => c.id));
  [...selectedConnectionIds].forEach(id => { if (!existingIds.has(id)) selectedConnectionIds.delete(id); });
  const groupHtml = names.map(g=>{
    const open = groupOpen.has(g);
    return `<div class="group">
      <button class="group-head" onclick="toggleGroupOpen(decodeURIComponent('${encodeURIComponent(g)}'))"><span class="chev">${open ? "▾" : "▸"}</span><span>${esc(g)}</span><span class="count">${groups[g].length}</span></button>
      ${open ? renderVirtualConnectionRows(groups[g]) : ""}
    </div>`;
  }).join("");
  const emptyHtml = stateView("empty", connectionSearch ? "没有匹配的连接" : "暂无 SSH 连接", connectionSearch ? "请调整搜索关键词。" : "添加第一台服务器后即可使用终端、转发和 SFTP。", connectionSearch ? `<button onclick="setConnectionSearch('')">清除搜索</button>` : `<button class="primary" onclick="newConnection()">添加 SSH</button>`);
  $("connectionGroups").innerHTML = renderGroupCreator() + renderConnectionBulkBar() + (groupHtml || emptyHtml);
  restoreUiState(uiState);
  syncConnectionBulkBar();
}

function renderConnectionBulkBar() {
  if (!connectionBulkMode) return "";
  return `<div class="connection-bulk-bar">
    <label class="checkline"><input id="connectionSelectAll" type="checkbox" onchange="toggleAllConnections(this.checked)"><span id="connectionBulkCount">已选 0 项</span></label>
    <div class="actions tight"><button id="connectionBulkEditBtn" onclick="openConnectionBulkSettings()" disabled>${icon("settings-2")}<span>批量设置</span></button><button id="connectionBulkDeleteBtn" class="danger" onclick="bulkDeleteConnections()" disabled>${icon("trash-2")}<span>删除</span></button></div>
  </div>`;
}

function toggleConnectionBulkMode() {
  connectionBulkMode = !connectionBulkMode;
  selectedConnectionIds.clear();
  if (connectionBulkMode) filteredConnections().forEach(c => groupOpen.add(c.group_name));
  saveGroupState();
  renderExplorerTools();
  renderConnections();
}

function setConnectionSelected(id, checked) {
  if (checked) selectedConnectionIds.add(Number(id));
  else selectedConnectionIds.delete(Number(id));
  syncConnectionBulkBar();
}

function toggleAllConnections(checked) {
  filteredConnections().forEach(c => checked ? selectedConnectionIds.add(c.id) : selectedConnectionIds.delete(c.id));
  renderConnections();
}

function syncConnectionBulkBar() {
  if (!connectionBulkMode) return;
  const visibleIds = filteredConnections().map(c => c.id);
  const selectedVisible = visibleIds.filter(id => selectedConnectionIds.has(id)).length;
  const selectAll = $("connectionSelectAll");
  if (selectAll) {
    selectAll.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  }
  if ($("connectionBulkCount")) $("connectionBulkCount").textContent = `已选 ${selectedConnectionIds.size} 项`;
  if ($("connectionBulkEditBtn")) $("connectionBulkEditBtn").disabled = !selectedConnectionIds.size;
  if ($("connectionBulkDeleteBtn")) $("connectionBulkDeleteBtn").disabled = !selectedConnectionIds.size;
}

function renderVirtualConnectionRows(items) {
  if (items.length <= 80) return items.map(c=>renderConnectionRow(c)).join("");
  const viewport = $("connectionGroups")?.clientHeight || 600;
  const start = Math.max(0, Math.floor(connectionVirtual.scrollTop / connectionVirtual.rowHeight) - connectionVirtual.buffer);
  const visibleCount = Math.ceil(viewport / connectionVirtual.rowHeight) + connectionVirtual.buffer * 2;
  const end = Math.min(items.length, start + visibleCount);
  const top = start * connectionVirtual.rowHeight;
  const bottom = Math.max(0, (items.length - end) * connectionVirtual.rowHeight);
  return `<div class="virtual-spacer" style="height:${top}px"></div>${items.slice(start,end).map(c=>renderConnectionRow(c)).join("")}<div class="virtual-spacer" style="height:${bottom}px"></div>`;
}

function onConnectionScroll() {
  connectionVirtual.scrollTop = $("connectionGroups")?.scrollTop || 0;
  if (primaryView === "connections") {
    clearTimeout(window.connectionVirtualTimer);
    window.connectionVirtualTimer = setTimeout(renderConnections, 40);
  }
}

function renderGroupCreator() {
  if (!addingGroup) return "";
  return `<div class="panel" style="margin:8px;padding:8px">
    <label style="margin-top:0">新分组</label>
    <div class="upload-line"><input id="newGroupName" placeholder="例如：生产环境"><button onclick="confirmAddGroup()">确定</button></div>
    <div class="actions"><button onclick="cancelAddGroup()">取消</button></div>
  </div>`;
}

function confirmAddGroup() {
  const name = $("newGroupName")?.value.trim();
  if (!name) return notify("请输入分组名称", "error");
  pendingGroup = name;
  groupOpen.add(name);
  saveGroupState();
  addingGroup = false;
  renderConnections();
  newConnection(name);
}

function cancelAddGroup() {
  addingGroup = false;
  renderConnections();
}

function renderConnectionRow(c) {
  const active = c.id === selectedId ? " active" : "";
  const running = connectionHasRunningForwards(c) ? " running" : "";
  const health = healthResults.get(c.id);
  const healthClass = health ? (health.ok ? " ok" : " bad") : "";
  const healthText = health ? health.status : "未检测";
  const bulkClass = connectionBulkMode ? " bulk-mode" : "";
  const bulkCheck = connectionBulkMode ? `<label class="connection-bulk-check" title="选择 ${escAttr(c.name)}"><input type="checkbox" ${selectedConnectionIds.has(c.id) ? "checked" : ""} onchange="setConnectionSelected(${c.id},this.checked)"><span class="sr-only">选择 ${esc(c.name)}</span></label>` : "";
  return `<div class="conn-row${active}${bulkClass}">
    ${bulkCheck}
    <div class="conn-main"><span class="conn-name">${esc(c.name)}</span><span class="conn-state"><span class="status-dot${running}"></span>${running ? "运行中" : "已停止"}</span></div>
    <div class="conn-meta">${esc(c.ssh_user)}@${esc(c.ssh_host)}:${c.ssh_port}</div>
    <div class="conn-summary"><span>${icon("route")} ${c.forwards.length} 条转发</span><span class="health-badge${healthClass}">${icon(health?.ok ? "circle-check" : health ? "circle-alert" : "circle-help")} ${esc(healthText)}</span></div>
    ${c.tags ? `<div class="forward-tags">${String(c.tags).split(",").filter(Boolean).map(tag=>`<span>${esc(tag)}</span>`).join("")}</div>` : ""}
    <div class="conn-actions">
      <button onclick="openTerminal(${c.id})">${icon("square-terminal")}<span>终端</span></button>
      <button onclick="openForwards(${c.id})">${icon("route")}<span>转发</span></button>
      ${connectionToggleButton(c)}
      <button class="icon-button" onclick="showConnectionMenu(event,${c.id})" title="更多操作" aria-label="更多操作">${icon("ellipsis")}</button>
    </div>
  </div>`;
}

async function openConnectionBulkSettings() {
  const count = selectedConnectionIds.size;
  if (!count) return notify("请选择 SSH 连接", "info");
  const info = await api("/api/identity-files/info");
  const groups = groupNames().map(name => `<option value="${escAttr(name)}"></option>`).join("");
  $("modal").hidden = false;
  $("modal").innerHTML = `<div class="modal-card wide connection-bulk-modal">
    <h2>批量设置 SSH 连接</h2>
    <div class="muted">将设置应用到已选的 ${count} 个连接。未勾选的项目保持原值；修改端口或凭据时会停止这些连接的转发。</div>
    <div class="bulk-setting-row"><label class="checkline"><input id="bulkSetGroup" type="checkbox" onchange="toggleConnectionBulkField('Group',this.checked)">修改分组</label><input id="bulkGroup" list="bulkGroupOptions" placeholder="选择或输入分组" disabled><datalist id="bulkGroupOptions">${groups}</datalist></div>
    <div class="bulk-setting-row"><label class="checkline"><input id="bulkSetPort" type="checkbox" onchange="toggleConnectionBulkField('Port',this.checked)">修改端口</label><input id="bulkPort" type="number" min="1" max="65535" value="22" disabled></div>
    <div class="bulk-setting-row credentials"><label class="checkline"><input id="bulkSetAuth" type="checkbox" onchange="toggleConnectionBulkField('Auth',this.checked)">修改登录凭据</label><div id="bulkAuthFields">
      <select id="bulkAuthType" disabled onchange="toggleConnectionBulkAuthType()"><option value="password">密码</option><option value="key">私钥</option></select>
      <input id="bulkPassword" type="password" autocomplete="new-password" placeholder="输入新 SSH 密码" disabled>
      <select id="bulkIdentity" disabled hidden><option value="">选择私钥</option></select>
    </div></div>
    <div class="actions"><button onclick="closeModal()">取消</button><button class="primary" onclick="applyConnectionBulkSettings()">应用设置</button></div>
  </div>`;
  $("bulkIdentity").replaceChildren(
    new Option("选择私钥", ""),
    ...(info.items || []).map(item => new Option(`${item.label}${item.source_label ? ` · ${item.source_label}` : ""}`, String(item.path || "")))
  );
  refreshIcons();
}

function toggleConnectionBulkField(name, enabled) {
  if (name === "Auth") {
    $("bulkAuthType").disabled = !enabled;
    toggleConnectionBulkAuthType();
  } else {
    $(`bulk${name}`).disabled = !enabled;
    if (enabled) $(`bulk${name}`).focus();
  }
}

function toggleConnectionBulkAuthType() {
  const enabled = Boolean($("bulkSetAuth")?.checked);
  const password = $("bulkAuthType")?.value === "password";
  $("bulkPassword").hidden = !password;
  $("bulkIdentity").hidden = password;
  $("bulkPassword").disabled = !enabled || !password;
  $("bulkIdentity").disabled = !enabled || password;
}

async function applyConnectionBulkSettings() {
  const changes = {};
  if ($("bulkSetGroup").checked) changes.group_name = $("bulkGroup").value.trim();
  if ($("bulkSetPort").checked) changes.ssh_port = Number($("bulkPort").value);
  if ($("bulkSetAuth").checked) {
    changes.auth = $("bulkAuthType").value === "password"
      ? {type:"password", password:$("bulkPassword").value}
      : {type:"key", identity_file:$("bulkIdentity").value};
  }
  if (!Object.keys(changes).length) return notify("请至少勾选一项批量设置", "info");
  try {
    const result = await api("/api/connections/bulk-update", {method:"POST", body:JSON.stringify({ids:[...selectedConnectionIds], changes})});
    closeModal();
    selectedConnectionIds.clear();
    await loadAll();
    notify(`已更新 ${result.updated || 0} 个 SSH 连接`, "success");
  } catch (error) {
    notify(error.message, "error");
  }
}

function bulkDeleteConnections() {
  const ids = [...selectedConnectionIds];
  if (!ids.length) return notify("请选择 SSH 连接", "info");
  $("modal").hidden = false;
  $("modal").innerHTML = `<div class="modal-card"><h2>批量删除 SSH 连接</h2><div class="modal-message">确定删除选中的 ${ids.length} 个 SSH 连接及其全部转发吗？删除前会自动创建配置快照。</div><div class="actions"><button onclick="closeModal()">取消</button><button class="danger" onclick="performBulkDeleteConnections()">确认删除</button></div></div>`;
}

async function performBulkDeleteConnections() {
  const ids = [...selectedConnectionIds];
  closeModal();
  const result = await api("/api/connections/bulk-delete", {method:"POST", body:JSON.stringify({ids})});
  if (ids.includes(selectedId)) selectedId = null;
  selectedConnectionIds.clear();
  await loadAll();
  notify(`已删除 ${result.deleted || ids.length} 个 SSH 连接`, "success");
}

function toggleGroupOpen(group) {
  if (groupOpen.has(group)) groupOpen.delete(group);
  else groupOpen.add(group);
  saveGroupState();
  renderConnections();
}

function addGroup() {
  addingGroup = true;
  renderConnections();
  setTimeout(()=>$("newGroupName")?.focus(), 0);
}

function newConnection(groupName="") {
  selectedId = null;
  $("view-edit").innerHTML = $("connectionFormTpl").innerHTML;
  setWorkspace("添加 SSH", groupName || pendingGroup ? `分组：${groupName || pendingGroup}` : "新建连接", "edit");
  resetConnectionForm();
  renderGroupOptions(groupName || pendingGroup);
  loadKeys().catch(()=>{});
  wireConnectionForm();
}

function connPayload() {
  const groupValue = $("conn_group").value;
  const passwordAuth = $("conn_auth_type").value === "password";
  return {
    id:$("conn_id").value,
    name:$("conn_name").value.trim(),
    group_name:(groupValue === "__new_group__" ? pendingGroup : groupValue).trim()||"默认分组",
    ssh_user:$("conn_user").value.trim(),
    ssh_host:$("conn_host").value.trim(),
    ssh_port:Number($("conn_port").value||22),
    sort_order:Number($("conn_sort_order").value||1),
    auth_type:passwordAuth ? "password" : "key",
    identity_file:passwordAuth ? "" : $("conn_key").value,
    ssh_password:passwordAuth ? $("conn_password").value : "",
    tags:$("conn_tags").value.trim(),
    autostart_forwards:Number($("conn_autostart").value),
    extra_args:$("conn_extra").value.trim()
  };
}

function toggleAuthFields() {
  const password = $("conn_auth_type")?.value === "password";
  const keyBox = $("keyAuthBox");
  const passwordBox = $("passwordAuthBox");
  if (keyBox) {
    keyBox.hidden = password;
    keyBox.setAttribute("aria-hidden", String(password));
    keyBox.querySelectorAll("input, select, button").forEach(control => { control.disabled = password; });
  }
  if (passwordBox) {
    passwordBox.hidden = !password;
    passwordBox.setAttribute("aria-hidden", String(!password));
    passwordBox.querySelectorAll("input, select, button").forEach(control => { control.disabled = !password; });
  }
}

function groupNames(extra="") {
  const names = new Set(connections.map(c => c.group_name || "默认分组"));
  names.add("默认分组");
  if (extra) names.add(extra);
  return [...names].sort((a,b)=>a.localeCompare(b, "zh-Hans-CN"));
}

function renderGroupOptions(selected="") {
  if (!$("conn_group")) return;
  const value = selected || pendingGroup || "默认分组";
  $("conn_group").innerHTML = groupNames(value).map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join("") + `<option value="__new_group__">新增分组...</option>`;
  $("conn_group").value = value;
  pendingGroupSelectValue = value;
  $("conn_group").onchange = handleGroupSelectChange;
}

function handleGroupSelectChange() {
  if ($("conn_group").value !== "__new_group__") return;
  $("conn_group").value = pendingGroupSelectValue || "默认分组";
  openGroupModal((name) => {
    pendingGroup = name;
    groupOpen.add(pendingGroup);
    saveGroupState();
    renderGroupOptions(pendingGroup);
  });
}

function openGroupModal(onSave) {
  $("modal").hidden = false;
  $("modal").innerHTML = `<div class="modal-card">
    <h2>新增分组</h2>
    <label>分组名称</label>
    <input id="modalGroupName" placeholder="例如：生产环境">
    <div class="actions">
      <button class="primary" onclick="saveGroupModal()">保存</button>
      <button onclick="closeModal()">取消</button>
    </div>
  </div>`;
  window.pendingGroupModalSave = onSave;
  setTimeout(()=>$("modalGroupName")?.focus(), 0);
}

function saveGroupModal() {
  const name = $("modalGroupName")?.value.trim();
  if (!name) return notify("请输入分组名称", "error");
  const save = window.pendingGroupModalSave;
  closeModal();
  if (save) save(name);
}

function closeModal() {
  $("modal").hidden = true;
  $("modal").innerHTML = "";
  window.pendingGroupModalSave = null;
}

function resetConnectionForm(){
  if (!$("connectionForm")) return;
  $("connectionForm").reset();
  $("conn_id").value="";
  renderGroupOptions(pendingGroup || "默认分组");
  $("conn_port").value=22;
  $("conn_sort_order").value=1;
  $("conn_auth_type").value="key";
  $("conn_password").value="";
  $("conn_tags").value="";
  $("conn_autostart").value="0";
  if ($("connTestStatus")) {
    $("connTestStatus").hidden = true;
    $("connTestStatus").textContent = "";
    $("connTestStatus").className = "connection-test-status";
  }
  $("conn_extra").value=`-o StrictHostKeyChecking=accept-new
-o ServerAliveInterval=60
-o ServerAliveCountMax=3
-o TCPKeepAlive=yes`;
  toggleAuthFields();
}

function wireConnectionForm() {
  $("connectionForm").addEventListener("submit", async e => {
    e.preventDefault();
    await saveConnectionForm(false, e.submitter);
  });
}

async function saveConnectionForm(clearAfterSave=false, trigger=null) {
  const form = $("connectionForm");
  if (!form || form.dataset.saving === "1") return;
  form.dataset.saving = "1";
  if (trigger) setButtonBusy(trigger, true, "保存中...");
  try {
    const p=connPayload();
    if(p.id) await api(`/api/connections/${p.id}`,{method:"PUT",body:JSON.stringify(p)});
    else await api("/api/connections",{method:"POST",body:JSON.stringify(p)});
    pendingGroup = "";
    groupOpen.add(p.group_name);
    saveGroupState();
    await loadAll();
    if (clearAfterSave && !p.id) {
      resetConnectionForm();
      await loadKeys().catch(()=>{});
      $("conn_name")?.focus();
      notify("连接已保存，表单已清空","success");
    } else {
      notify("连接已保存","success");
    }
  } catch(err){notify(err.message,"error");}
  finally {
    delete form.dataset.saving;
    if (trigger) setButtonBusy(trigger, false);
  }
}

async function loadKeys(selected) {
  if (!$("conn_key")) return;
  const keys = await api("/api/identity-files");
  const current = selected ?? $("conn_key").value;
  $("conn_key").innerHTML = `<option value="">不使用私钥</option>` + keys.map(k=>`<option value="${esc(k.path)}">${esc(k.label)}${k.permission_ok ? "" : "（需检查权限）"}</option>`).join("");
  if (current) $("conn_key").value = current;
  renderKeyStatus();
}

async function uploadOneKey(file){
  const form = new FormData();
  form.append("key", file);
  const res = await fetch("/api/identity-files", {method:"POST", body:form});
  const data = await res.json();
  if(!res.ok) throw new Error(data.error||res.statusText);
  return data;
}

async function uploadKey(){
  const f=$("key_upload").files[0];
  if(!f) return notify("请选择密钥文件","error");
  const data=await uploadOneKey(f);
  await loadKeys(data.path);
  notify("密钥已上传","success");
}

async function renderKeyStatus() {
  const box = $("keyStatus");
  if (!box) return;
  const key = $("conn_key")?.value || "";
  if (!key) {
    box.textContent = "未选择私钥";
    box.className = "key-status muted";
    return;
  }
  try {
    const status = await api("/api/identity-files/check", {method:"POST", body:JSON.stringify({path:key})});
    box.textContent = status.ok ? `权限正常：${status.label}` : `需要修复权限：${status.details}`;
    box.className = `key-status ${status.ok ? "success" : "error"}`;
  } catch (error) {
    box.textContent = error.message;
    box.className = "key-status error";
  }
}

async function repairSelectedKey() {
  const key = $("conn_key")?.value || "";
  if (!key) return notify("请先选择私钥", "info");
  try {
    const status = await api("/api/identity-files/repair", {method:"POST", body:JSON.stringify({path:key})});
    await loadKeys(key);
    notify(status.ok ? "私钥权限已修复" : `已尝试修复：${status.details}`, status.ok ? "success" : "error");
  } catch (error) {
    notify(error.message, "error");
  }
}

async function testConnectionForm(button=null){
  button = button || $("connTestBtn");
  const status = $("connTestStatus");
  setButtonBusy(button, true, "测试中...");
  if (status) { status.hidden = false; status.className = "connection-test-status busy"; status.textContent = "正在测试 SSH 连接，请稍候..."; }
  notify("正在测试 SSH 连接，请稍候...", "info");
  try {
    const r=await api("/api/test-ssh",{method:"POST",body:JSON.stringify(connPayload())});
    const message = r.ok ? `SSH 测试成功，用时 ${r.elapsed_ms}ms` : `SSH 测试失败：${r.output}`;
    if (status) { status.className = `connection-test-status ${r.ok ? "success" : "error"}`; status.textContent = message; }
    notify(message, r.ok?"success":"error");
  } catch(e){
    const message = `SSH 测试无法完成：${e.message}`;
    if (status) { status.className = "connection-test-status error"; status.textContent = message; }
    notify(message,"error");
  }
  finally { setButtonBusy(button, false); }
}

async function checkConnectionHealth(id, button=null) {
  const c = currentConnection(id) || connections.find(item => item.id === id);
  setButtonBusy(button, true, "检查中...");
  try {
    const result = await api(`/api/connections/${id}/health`, {method:"POST"});
    healthResults.set(id, result);
    renderConnections();
    notify(formatHealthMessage(c, result), result.ok ? "success" : "error");
  } catch (error) {
    notify(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function formatHealthMessage(connection, result) {
  const lines = [`${connection?.name || result.id} 健康检查：${result.status}${result.cached ? `（缓存 ${Math.round((result.cache_age_ms || 0)/1000)} 秒）` : ""}`];
  if (!result.ssh?.ok) lines.push(result.ssh?.output || "SSH 连接异常");
  for (const forward of result.forwards || []) {
    if (forward.reachable === false) lines.push(`转发 ${forward.id} 本地端口不可达`);
    if (forward.port_usage?.occupied) {
      const owners = (forward.port_usage.processes || []).map(p => `${p.name || "未知程序"}(${p.pid})`).join("、") || "未知程序";
      lines.push(`转发 ${forward.id} 端口被占用：${owners}`);
    }
  }
  return lines.join("\n");
}

async function checkAllHealth(button=null) {
  setButtonBusy(button, true, "检查中...");
  try {
    notify("正在执行健康检查...", "info");
    const results = await api("/api/health?refresh=1");
    for (const item of results) healthResults.set(item.id, item);
    renderConnections();
    const failed = results.filter(item => !item.ok);
    notify(`健康检查完成：正常 ${results.length - failed.length} 个，异常 ${failed.length} 个`, failed.length ? "error" : "success");
  } catch (error) {
    notify(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function openServerDashboard(id, updateTab=true) {
  const c = selectConnection(id);
  if (!c) return;
  $("view-dashboard").innerHTML = `<div class="panel">
    <div class="workspace-head">
      <div>
        <h2>${esc(c.name)} · 仪表盘</h2>
        <div class="subtitle">${esc(c.ssh_user)}@${esc(c.ssh_host)}:${c.ssh_port}</div>
      </div>
      <div class="actions"><button onclick="openServerDashboard(${c.id},false)">刷新巡检</button><button onclick="openTerminal(${c.id})">打开终端</button></div>
    </div>
    <div id="serverDashboardBody" class="dashboard-grid">
      <div class="dashboard-card"><strong>巡检中</strong><span>正在通过 SSH 获取系统信息...</span></div>
    </div>
  </div>`;
  setWorkspace(`${c.name} · 仪表盘`, "服务器基础巡检", "dashboard", `dashboard-${c.id}`, updateTab, true, {kind:"dashboard", id:c.id});
  try {
    const result = await api(`/api/connections/${c.id}/inspect`, {method:"POST"});
    $("serverDashboardBody").innerHTML = renderServerInspection(result);
  } catch (error) {
    $("serverDashboardBody").innerHTML = `<div class="dashboard-card bad"><strong>巡检失败</strong><span>${esc(error.message)}</span></div>`;
  }
}

function renderServerInspection(result) {
  const sections = parseInspectionOutput(result.output || "");
  const names = [
    ["system", "系统"],
    ["os", "发行版"],
    ["uptime", "运行时间"],
    ["memory", "内存"],
    ["disk", "磁盘"],
    ["ports", "监听端口"]
  ];
  return names.map(([key, title]) => `<div class="dashboard-card ${result.ok ? "" : "bad"}"><strong>${title}</strong><pre>${esc(sections[key] || "暂无数据")}</pre></div>`).join("");
}

function parseInspectionOutput(text) {
  const out = {};
  let key = "summary";
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^##\s+(.+)$/);
    if (match) {
      key = match[1].trim();
      out[key] = "";
    } else {
      out[key] = `${out[key] || ""}${line}\n`;
    }
  }
  for (const name of Object.keys(out)) out[name] = out[name].trim();
  return out;
}

function currentConnection(id=selectedId){ return connections.find(x=>x.id===id); }

function selectConnection(id) {
  selectedId = id;
  const c = currentConnection();
  if (c) {
    groupOpen.add(c.group_name);
    saveGroupState();
  }
  renderConnections();
  return c;
}

function editConnection(id, updateTab=true){
  const c = selectConnection(id);
  if(!c) return;
  $("view-edit").innerHTML = $("connectionFormTpl").innerHTML;
  $("conn_id").value=c.id;
  if ($("connSaveAndClear")) $("connSaveAndClear").hidden = true;
  $("conn_name").value=c.name;
  renderGroupOptions(c.group_name);
  $("conn_user").value=c.ssh_user;
  $("conn_host").value=c.ssh_host;
  $("conn_port").value=c.ssh_port;
  $("conn_sort_order").value=c.sort_order || 1;
  $("conn_auth_type").value=c.auth_type || "key";
  $("conn_password").value="";
  $("conn_tags").value=c.tags || "";
  $("conn_autostart").value=String(c.autostart_forwards||0);
  $("conn_extra").value=c.extra_args||"";
  toggleAuthFields();
  loadKeys(c.identity_file);
  wireConnectionForm();
  setWorkspace(`${c.name} · 编辑`, `${c.ssh_user}@${c.ssh_host}:${c.ssh_port}`, "edit", `edit-${c.id}`, updateTab, true, {kind:"edit", id:c.id});
}

async function deleteConnection(id){
  const c = currentConnection(id);
  if(!await confirmModal(`删除连接 ${c?.name || id} 及其所有转发？`, "删除 SSH 连接", "删除", "取消", true)) return;
  await api(`/api/connections/${id}`,{method:"DELETE"});
  if(selectedId===id) selectedId=null;
  await loadAll();
  renderWelcome();
  notify("已删除连接","success");
}
