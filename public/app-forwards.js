function openForwards(id, updateTab=true) {
  const c = selectConnection(id);
  if (!c) return;
  $("view-forwards").innerHTML = `<div class="workspace-head"><div class="subtitle">${c.forwards.length} 条转发规则</div><div class="actions">${connectionToggleButton(c)}</div></div>` + $("forwardManagerTpl").innerHTML;
  $("forward_conn_id").value = c.id;
  wireForwardForm();
  toggleForwardLabels();
  renderForwards();
  setWorkspace(`${c.name} · 转发列表`, `${c.forwards.length} 条转发`, "forwards", `forwards-${c.id}`, updateTab, true, {kind:"forwards", id:c.id});
}

async function connectionForwardAction(id, action, button=null){
  const c = currentConnection(id);
  if (action === "start" && !(c?.forwards || []).length) return notify("该连接还没有添加转发规则", "info");
  setButtonBusy(button, true, action === "start" ? "启用中..." : "停止中...");
  try {
    if (action === "start") {
      const handled = await handleConnectionPortConflicts(c);
      if (!handled) return;
    }
    await api(`/api/connections/${id}/${action}-forwards`,{method:"POST"});
    await loadAll();
    if (activeView === "forwards" && selectedId === id) openForwards(id);
    else if (activeView === "terminal" && selectedId === id) {
      const tab = tabs.find(item => item.key === activeTabKey);
      openTerminal(id, false, activeTabKey, tab?.title || "");
    }
    notify(action==="start"?"已启动该连接全部转发":"已停止该连接全部转发","success");
  } catch (error) {
    await loadAll().catch(()=>{});
    notify(error.message || "转发操作失败", "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function handleConnectionPortConflicts(connection) {
  for (const forward of connection?.forwards || []) {
    if (!["local", "socks"].includes(forward.mode) || forward.status === "running") continue;
    const diagnosis = await diagnoseForwardPort(forward.id, {silent:true});
    if (!diagnosis.occupied) continue;
    const resolved = await offerResolvePortConflict(forward, diagnosis);
    if (!resolved) {
      notify(`${forwardDisplayName(forward)} 启动前发现端口占用，已取消启用。`, "error");
      return false;
    }
  }
  return true;
}

async function startAllForwards(button=null){
  setButtonBusy(button, true, "启用中...");
  try {
    const targets = connections.filter(c => (c.forwards || []).length);
    if (!targets.length) return notify("暂无可启动的转发", "info");
    let ok = 0, failed = 0;
    for (const c of targets) {
      try {
        const handled = await handleConnectionPortConflicts(c);
        if (!handled) {
          failed++;
          continue;
        }
        await api(`/api/connections/${c.id}/start-forwards`, {method:"POST"});
        ok++;
      } catch (error) {
        failed++;
        notify(`${c.name} 启动失败：${error.message}`, "error");
      }
    }
    await loadAll();
    notify(`启动全部转发完成：成功 ${ok} 个，失败 ${failed} 个`, failed ? "error" : "success");
  } finally {
    setButtonBusy(button, false);
  }
}

async function restoreForwards() {
  try {
    const result = await api("/api/forwards/restore", {method:"POST"});
    await loadAll();
    if (primaryView === "running") renderRunningForwards();
    notify(`恢复上次转发完成：成功 ${result.ok} 个，失败 ${result.failed} 个`, result.failed ? "error" : "success");
  } catch (error) {
    notify(error.message, "error");
  }
}

async function stopAllForwardsUi(button=null){
  setButtonBusy(button, true, "停止中...");
  try {
    const targets = connections.filter(c => (c.forwards || []).some(f => f.status === "running"));
    if (!targets.length) return notify("暂无运行中的转发", "info");
    let ok = 0, failed = 0;
    for (const c of targets) {
      try {
        await api(`/api/connections/${c.id}/stop-forwards`, {method:"POST"});
        ok++;
      } catch {
        failed++;
      }
    }
    await loadAll();
    notify(`停止全部转发完成：成功 ${ok} 个，失败 ${failed} 个`, failed ? "error" : "success");
  } finally {
    setButtonBusy(button, false);
  }
}

function wireForwardForm() {
  renderForwardTemplateOptions();
  $("forwardForm").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      const id=Number($("forward_conn_id").value);
      if(!id) throw new Error("请先选择连接");
      const checkedPayload = await confirmForwardPortBeforeSave(forwardPayload(), editingForwardId);
      if (!checkedPayload) return;
      if (editingForwardId) {
        const forward = currentForward(editingForwardId);
        await api(`/api/forwards/${editingForwardId}`, {method:"PUT", body:JSON.stringify(checkedPayload)});
        if (forward?.status === "running" && await confirmModal("该转发正在运行，是否立即重启以应用修改？", "重启转发", "立即重启", "稍后手动")) {
          await api(`/api/forwards/${editingForwardId}/stop`, {method:"POST"});
          await api(`/api/forwards/${editingForwardId}/start`, {method:"POST"});
        }
        notify("转发已保存", "success");
        cancelForwardEdit();
      } else {
        await api(`/api/connections/${id}/forwards`,{method:"POST",body:JSON.stringify(checkedPayload)});
        clearForwardForm();
        notify("转发已添加","success");
      }
      await loadAll();
      openForwards(id);
    } catch(err){notify(err.message,"error");}
  });
}

async function confirmForwardPortBeforeSave(payload, excludeId=0) {
  if (!["local", "socks"].includes(payload.mode)) return payload;
  const result = await api("/api/ports/check-forward", {method:"POST", body:JSON.stringify({host:payload.bind_host, port:payload.bind_port, exclude_id:excludeId})});
  if (!result.configured && !result.usage?.occupied) return payload;
  const messages = [];
  if (result.configured) messages.push(`该本地端口已被【${result.configured.connection_name}】配置`);
  if (result.usage?.occupied) {
    const owners = (result.usage.processes || []).map(p => `${p.name || "未知程序"}（PID：${p.pid}）`).join("、") || "未知程序";
    messages.push(`该本地端口已被 ${owners} 占用`);
  }
  const recommended = result.recommended?.recommended_port;
  const choice = await chooseModal("端口冲突", `${messages.join("\n")}\n\n继续配置可能导致批量启动报错。`, [
    {label:"依旧保存", value:"save", className:"danger"},
    {label:`推荐 ${recommended || ""} 保存`, value:"recommend", className:"primary"},
    {label:"取消", value:"cancel"}
  ]);
  if (choice === "save") return payload;
  if (choice === "recommend" && recommended) {
    $("forward_bind_port").value = recommended;
    return {...payload, bind_port:recommended};
  }
  return null;
}

function toggleForwardLabels(){
  if (!$("forward_mode")) return;
  const m=$("forward_mode").value;
  const socks=m==="socks";
  $("targetHostBox").style.display=socks?"none":"block";
  $("targetPortBox").style.display=socks?"none":"block";
  $("forward_bind_label").textContent=m==="remote"?"远程监听地址":(socks?"SOCKS5 监听地址":"本地监听地址");
  $("forward_bind_port_label").textContent=m==="remote"?"远程监听端口":(socks?"SOCKS5 监听端口":"本地监听端口");
}

function forwardPayload(){
  return {
    mode:$("forward_mode").value,
    service_name:$("forward_service_name").value.trim(),
    service_type:$("forward_service_type").value.trim(),
    service_note:$("forward_service_note").value.trim(),
    url_scheme:$("forward_url_scheme").value.trim(),
    bind_host:$("forward_bind_host").value.trim()||"127.0.0.1",
    bind_port:Number($("forward_bind_port").value),
    target_host:$("forward_target_host").value.trim()||"127.0.0.1",
    target_port:Number($("forward_target_port").value)
  };
}

function clearForwardForm() {
  $("forward_bind_port").value="";
  $("forward_target_port").value="";
  $("forward_service_name").value="";
  $("forward_service_type").value="";
  $("forward_service_note").value="";
  $("forward_url_scheme").value="";
}

function editForward(id) {
  const f = currentForward(id);
  if (!f) return notify("转发不存在", "error");
  editingForwardId = Number(id);
  $("forward_mode").value = f.mode;
  $("forward_bind_host").value = f.bind_host || "127.0.0.1";
  $("forward_bind_port").value = f.bind_port || "";
  $("forward_target_host").value = f.target_host || "127.0.0.1";
  $("forward_target_port").value = f.target_port || "";
  $("forward_service_name").value = f.service_name || "";
  $("forward_service_type").value = f.service_type || "";
  $("forward_service_note").value = f.service_note || "";
  $("forward_url_scheme").value = f.url_scheme || "";
  $("forwardSubmitBtn").textContent = "保存转发";
  $("cancelForwardEditBtn").hidden = false;
  toggleForwardLabels();
  $("forwardForm").scrollIntoView({block:"start", behavior:"smooth"});
}

function cancelForwardEdit() {
  editingForwardId = 0;
  if ($("forwardSubmitBtn")) $("forwardSubmitBtn").textContent = "添加转发";
  if ($("cancelForwardEditBtn")) $("cancelForwardEditBtn").hidden = true;
  if ($("forwardForm")) clearForwardForm();
}

async function saveForwardTemplate() {
  const payload = forwardPayload();
  const fallbackName = payload.service_name || serviceTypeText(payload.service_type) || forwardModeText(payload.mode) || "转发模板";
  const current = forwardTemplates.find(item => String(item.id) === String(editingForwardTemplateId));
  const name = await inputModal(editingForwardTemplateId ? "保存模板修改" : "保存转发模板", "模板名称", current?.name || fallbackName);
  if (!name) return notify("已取消保存模板", "info");
  if (editingForwardTemplateId && current) {
    await api(`/api/forward-templates/${editingForwardTemplateId}`, {method:"PUT", body:JSON.stringify({name, ...payload})});
  } else {
    await api("/api/forward-templates", {method:"POST", body:JSON.stringify({name, ...payload})});
  }
  editingForwardTemplateId = "";
  await loadForwardTemplates();
  renderForwardTemplateOptions();
  const box = $("forwardTemplateManager");
  if (box) box.hidden = false;
  renderForwardTemplateManager();
  notify(`转发模板已保存：${name}`, "success");
}

async function loadForwardTemplates() {
  forwardTemplates = await api("/api/forward-templates");
  return forwardTemplates;
}

function renderForwardTemplateOptions() {
  const select = $("forward_template_select");
  if (!select) return;
  select.innerHTML = `<option value="">选择模板</option>${forwardTemplates.map(t=>`<option value="${escAttr(t.id)}">${esc(t.name)}</option>`).join("")}`;
}

function applyForwardTemplate(id) {
  const t = forwardTemplates.find(item => String(item.id) === String(id));
  if (!t) return;
  $("forward_mode").value = t.mode || "local";
  $("forward_bind_host").value = t.bind_host || "127.0.0.1";
  $("forward_bind_port").value = t.bind_port || "";
  $("forward_target_host").value = t.target_host || "127.0.0.1";
  $("forward_target_port").value = t.target_port || "";
  $("forward_service_name").value = t.service_name || t.name || "";
  $("forward_service_type").value = t.service_type || "";
  $("forward_service_note").value = t.service_note || "";
  $("forward_url_scheme").value = t.url_scheme || "";
  toggleForwardLabels();
}

function showForwardTemplateManager() {
  const box = $("forwardTemplateManager");
  box.hidden = !box.hidden;
  renderForwardTemplateManager();
}

function renderForwardTemplateManager() {
  const box = $("forwardTemplateManager");
  if (!box) return;
  box.innerHTML = forwardTemplates.map(t => `<div class="template-row ${String(t.id) === String(editingForwardTemplateId) ? "active" : ""}"><button class="template-main" onclick="applyForwardTemplate('${escAttr(t.id)}')"><span class="conn-name">${esc(t.name)}</span><span class="muted">${esc(forwardText(t))}</span></button><div class="template-actions"><button onclick="editForwardTemplate('${escAttr(t.id)}')">${String(t.id) === String(editingForwardTemplateId) ? "正在编辑" : "编辑"}</button><button onclick="applyForwardTemplateBatch('${escAttr(t.id)}')">批量应用</button><button class="danger" onclick="deleteForwardTemplate('${escAttr(t.id)}')">删除</button></div></div>`).join("") || `<div class="empty compact">暂无转发模板</div>`;
}

function editForwardTemplate(id) {
  const t = forwardTemplates.find(item => String(item.id) === String(id));
  if (!t) return;
  editingForwardTemplateId = id;
  applyForwardTemplate(id);
  const box = $("forwardTemplateManager");
  if (box) box.hidden = false;
  notify("模板内容已载入表单，修改后点击“保存为模板”即可保存修改", "info");
}

async function deleteForwardTemplate(id) {
  if (!await confirmModal("删除该转发模板？", "删除转发模板", "删除", "取消", true)) return;
  await api(`/api/forward-templates/${id}`, {method:"DELETE"});
  await loadForwardTemplates();
  renderForwardTemplateOptions();
  renderForwardTemplateManager();
}

async function applyForwardTemplateBatch(id) {
  const current = currentConnection();
  const choices = [
    {label:"当前连接", value:"current", className:"primary"},
    {label:"当前分组", value:"group"},
    {label:"全部连接", value:"all"},
    {label:"取消", value:"cancel"}
  ];
  const choice = await chooseModal("批量应用模板", "选择要应用该转发模板的范围。", choices);
  if (choice === "cancel") return;
  let ids = [];
  if (choice === "current" && current) ids = [current.id];
  else if (choice === "group" && current) ids = connections.filter(item => item.group_name === current.group_name).map(item => item.id);
  else if (choice === "all") ids = connections.map(item => item.id);
  if (!ids.length) return notify("没有可应用的连接", "info");
  const result = await api(`/api/forward-templates/${id}/apply`, {method:"POST", body:JSON.stringify({connection_ids:ids})});
  await loadAll();
  if (selectedId) openForwards(selectedId);
  notify(`已应用模板，新增 ${result.created?.length || 0} 条转发`, "success");
}

async function recommendForwardPort() {
  const host = $("forward_bind_host").value.trim() || "127.0.0.1";
  const port = $("forward_bind_port").value ? Number($("forward_bind_port").value) : 6000;
  const result = await api("/api/ports/recommend", {method:"POST", body:JSON.stringify({host, port, exclude_id:editingForwardId})});
  $("forward_bind_port").value = result.recommended_port;
  notify(`推荐可用端口：${result.recommended_port}`, "success");
}

function renderForwards(){
  if (!$("forwardList")) return;
  const c=currentConnection();
  if(!c){$("forwardList").innerHTML=stateView("empty", "未选择 SSH 连接", "请从左侧连接列表打开转发列表。"); return;}
  $("forwardList").innerHTML = c.forwards.length ? `<div class="forward-bulk-toolbar">
    <label class="checkline"><input id="forwardSelectAll" type="checkbox" onchange="toggleCheckGroup(this,'forward'); updateForwardBulkActions()"> 全选转发</label>
  </div><div class="forward-list">
    <div class="forward-list-head">
      <span>选择</span>
      <span>规则</span><span>状态</span><span>服务入口</span><span>操作</span>
    </div>
    ${c.forwards.map(f=>renderForwardCard(f)).join("")}
  </div>` : stateView("empty", "暂无转发规则", "使用上方表单添加第一条本地、远程或 SOCKS5 转发。", `<button class="primary" onclick="document.getElementById('forwardMode')?.focus()">添加转发</button>`);
  updateForwardBulkActions();
}

function updateForwardBulkActions() {
  const btn = $("bulkDeleteForwardsBtn");
  const checks = [...document.querySelectorAll(".forward-check")];
  const selected = checks.filter(item => item.checked).length;
  const selectAll = $("forwardSelectAll");
  if (selectAll) {
    selectAll.checked = checks.length > 0 && selected === checks.length;
    selectAll.indeterminate = selected > 0 && selected < checks.length;
  }
  if (!btn) return;
  btn.hidden = !selected;
  btn.textContent = `删除选中转发 (${selected})`;
}

function renderForwardCard(f) {
  const access = forwardAccessInfo(f);
  return `<div class="forward-card">
    <label class="checkline"><input class="forward-check" type="checkbox" value="${f.id}" onchange="updateForwardBulkActions()"><span>${esc(forwardDisplayName(f))}</span></label>
    <div class="forward-rule"><div class="field-label">规则</div><div>${forwardText(f)}</div></div>
    <div class="forward-status"><div class="field-label">状态</div><span class="status-pill ${escAttr(f.status || "stopped")}">${forwardStatusText(f.status)}</span><div class="conn-meta">${forwardQualityText(f)}</div>${f.last_error ? `<div class="conn-meta error">${esc(f.last_error).slice(0,160)}</div>` : ""}</div>
    <div class="forward-service"><div class="field-label">服务入口</div><div class="forward-tags"><span>${forwardModeText(f.mode)}</span>${f.service_type ? `<span>${serviceTypeText(f.service_type)}</span>` : ""}</div>${f.service_note ? `<div class="conn-meta">${esc(f.service_note)}</div>` : ""}${forwardAccessHtml(access)}${access.url ? `<div class="actions tight"><a class="open-forward-link" href="${esc(access.url)}" target="_blank" rel="noopener">打开</a><button onclick="copyText('${escAttr(access.url)}')">复制</button></div>` : `<span class="muted">无可打开地址</span>`}</div>
    <div class="forward-actions">${f.status === "running" ? `<button onclick="stopSingleForward(${f.id},this)">${icon("square")}<span>停止</span></button>` : `<button class="primary" onclick="startSingleForward(${f.id},this)">${icon("play")}<span>启动</span></button>`}<button class="icon-button" title="更多操作" aria-label="更多操作" onclick="showForwardMenu(event,${f.id})">${icon("ellipsis")}</button></div>
  </div>`;
}

function showForwardMenu(event, id) {
  showActionMenu(event, [
    {label:"编辑规则", icon:"pencil", run:()=>editForward(id)},
    {label:"复制规则信息", icon:"copy", run:()=>copyText(forwardText(currentForward(id)))},
    {separator:true},
    {label:"删除规则", icon:"trash-2", danger:true, run:()=>deleteForward(id)}
  ]);
}

function forwardModeText(mode){ return {local:"本地转发", remote:"远程转发", socks:"SOCKS5"}[mode] || esc(mode); }

function forwardStatusText(status){ return {running:"运行中", stopped:"已停止", failed:"启动失败", reconnecting:"重连中"}[status] || esc(status); }

function serviceTypeText(type){ return {web:"Web", mysql:"MySQL", redis:"Redis", ssh:"SSH", socks:"SOCKS5", other:"其他"}[type] || esc(type || "服务"); }

function forwardDisplayName(f) {
  if (f.service_name) return f.service_name;
  if (f.service_type && f.service_type !== "other") return serviceTypeText(f.service_type);
  return forwardModeText(f.mode);
}

function forwardText(f){
  if(f.mode==="socks") return `${esc(f.bind_host)}:${f.bind_port}`;
  const arrow = f.mode === "remote" ? "远程监听" : "本地监听";
  return `${arrow} ${esc(f.bind_host)}:${f.bind_port} → 目标 ${esc(f.target_host)}:${f.target_port}`;
}

function forwardAccessInfo(f) {
  if (f.mode === "remote") return { url: "", note: "" };
  const rawBindHost = String(f.bind_host || "");
  const wildcard = ["0.0.0.0", "::", ""].includes(rawBindHost);
  const bindHost = wildcard ? "0.0.0.0" : rawBindHost;
  const host = currentPageHostForForward(bindHost);
  const scheme = f.url_scheme || (f.service_type === "web" ? "http" : "http");
  const url = `${scheme}://${host}:${f.bind_port}`;
  const lanPage = !isLoopbackHost(location.hostname);
  let note = "";
  if (lanPage && isLoopbackHost(bindHost)) note = "该转发只监听本机，局域网设备无法直接打开；需要把监听地址改为 0.0.0.0 后重新启动转发。";
  else if (lanPage && wildcard) note = "局域网可访问地址";
  else if (!lanPage) note = isLoopbackHost(bindHost) ? "仅本机可访问" : "可按监听地址访问";
  return { url, note, localOnly: lanPage && isLoopbackHost(bindHost) };
}

function forwardOpenUrl(f) {
  return forwardAccessInfo(f).url || "";
}

function forwardAccessHtml(access) {
  if (!access?.url) return "";
  return `<div class="service-url">${esc(access.url)}</div>${access.note ? `<div class="conn-meta ${access.localOnly ? "warning-text" : ""}">${esc(access.note)}</div>` : ""}`;
}

function forwardQualityText(f) {
  const parts = [];
  if (f.pid) parts.push(`PID ${f.pid}`);
  if (f.started_at) parts.push(`运行 ${formatDuration(Date.now()/1000 - Number(f.started_at))}`);
  if (Number(f.reconnect_count || 0)) parts.push(`重连 ${f.reconnect_count} 次`);
  return parts.join(" · ") || "未运行";
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}小时${m}分`;
  if (m) return `${m}分${s % 60}秒`;
  return `${s}秒`;
}

async function deleteForward(id){ await api(`/api/forwards/${id}`,{method:"DELETE"}); await loadAll(); if(selectedId) openForwards(selectedId); notify("已删除转发","success"); }

function currentForward(id) {
  for (const c of connections) {
    const found = (c.forwards || []).find(f => f.id === Number(id));
    if (found) return found;
  }
  return null;
}

async function diagnoseForwardPort(id, options={}) {
  setButtonBusy(options.button, true, "诊断中...");
  const f = currentForward(id);
  try {
    if (!f) throw new Error("转发不存在");
    if (f.mode === "remote") {
      notify("远程转发端口在服务器侧监听，本机无法直接检测占用进程；启动失败时会显示 SSH 返回的原因。", "info");
      return {occupied:false, remote:true};
    }
    const result = await api("/api/ports/diagnose", {method:"POST", body:JSON.stringify({host:f.bind_host || "127.0.0.1", port:f.bind_port})});
    if (!result.occupied) {
      if (!options.silent) notify(result.message, "success");
      return result;
    }
    const detail = result.processes?.length
      ? result.processes.map(p => `${p.name || "未知程序"} PID ${p.pid}${p.path ? `\n${p.path}` : ""}`).join("\n")
      : "未能识别占用进程";
    if (options.offerFix) {
      const killed = await offerKillPortOwners(result);
      if (killed) {
        const after = await api("/api/ports/diagnose", {method:"POST", body:JSON.stringify({host:f.bind_host || "127.0.0.1", port:f.bind_port})});
        notify(after.occupied ? `端口仍被占用：${after.message}` : "占用程序已处理，端口现在可用", after.occupied ? "error" : "success");
        return after;
      }
    }
    if (!options.silent) notify(`${result.message}\n${detail}`, "error");
    return result;
  } finally {
    setButtonBusy(options.button, false);
  }
}

async function offerKillPortOwners(diagnosis) {
  const processes = diagnosis.processes || [];
  if (!processes.length) return false;
  const detail = processes.map(p => `${p.name || "未知程序"} PID ${p.pid}${p.path ? `\n${p.path}` : ""}`).join("\n");
  if (!await confirmModal(`${diagnosis.message}\n\n${detail}\n\n是否尝试关闭这些占用程序？`, "关闭占用程序", "尝试关闭", "取消", true)) return false;
  for (const p of processes) {
    if (!await confirmModal(`确认关闭 ${p.name || "未知程序"} PID ${p.pid}？`, "确认关闭进程", "关闭", "跳过", true)) continue;
    await api("/api/ports/kill", {method:"POST", body:JSON.stringify({pid:p.pid})});
  }
  return true;
}

async function offerResolvePortConflict(forward, diagnosis) {
  const owners = (diagnosis.processes || []).map(p => `${p.name || "未知程序"} PID ${p.pid}${p.path ? `\n${p.path}` : ""}`).join("\n") || "未能识别占用进程";
  const choice = await chooseModal("端口冲突处理", `${diagnosis.message}\n${owners}`, [
    { label:"尝试关闭占用程序", value:"kill", className:"danger" },
    { label:"改用推荐端口", value:"recommend", className:"primary" },
    { label:"取消", value:"cancel" }
  ]);
  if (choice === "kill") return offerKillPortOwners(diagnosis);
  if (choice === "recommend") {
    const recommended = await api("/api/ports/recommend", {method:"POST", body:JSON.stringify({host:forward.bind_host || "127.0.0.1", port:forward.bind_port})});
    const nextPort = recommended.recommended_port;
    if (!await confirmModal(`改用推荐端口 ${nextPort} 并保存该转发规则？`, "改用推荐端口", "保存", "取消")) return false;
    await api(`/api/forwards/${forward.id}`, {method:"PUT", body:JSON.stringify({...forward, bind_port:nextPort})});
    await loadAll({silent:true});
    notify(`已改用推荐端口 ${nextPort}`, "success");
    return true;
  }
  return false;
}

async function startSingleForward(id, button=null) {
  setButtonBusy(button, true, "启用中...");
  try {
    const diagnosis = await diagnoseForwardPort(id, {silent:true});
    if (diagnosis.occupied) {
      const f = currentForward(id);
      const resolved = await offerResolvePortConflict(f, diagnosis);
      if (!resolved) {
        notify(diagnosis.message, "error");
        return;
      }
    }
    await api(`/api/forwards/${id}/start`, {method:"POST"});
    await loadAll();
    if (selectedId) openForwards(selectedId);
    notify("已启动转发", "success");
  } catch (error) {
    await loadAll({silent:true}).catch(()=>{});
    notify(error.message || "启动转发失败", "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function stopSingleForward(id, button=null) {
  setButtonBusy(button, true, "停止中...");
  try {
    await api(`/api/forwards/${id}/stop`, {method:"POST"});
    await loadAll();
    if (selectedId) openForwards(selectedId);
    notify("已停止转发", "success");
  } catch (error) {
    notify(error.message || "停止转发失败", "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function stopForwardFromRunning(id) {
  await api(`/api/forwards/${id}/stop`, {method:"POST"});
  await loadAll();
  renderRunningForwards();
  notify("已停止转发", "success");
}

async function retryForwardFromRunning(id, button=null) {
  setButtonBusy(button, true, "重试中...");
  try {
    const forward = currentForward(id);
    if (forward && ["local", "socks"].includes(forward.mode)) {
      const diagnosis = await diagnoseForwardPort(id, {silent:true});
      if (diagnosis.occupied) {
        const resolved = await offerResolvePortConflict(forward, diagnosis);
        if (!resolved) {
          notify(`${forwardDisplayName(forward)} 端口占用未解除，已取消重试。`, "error");
          return;
        }
      }
    }
    await api(`/api/forwards/${id}/stop`, {method:"POST"}).catch(()=>{});
    await api(`/api/forwards/${id}/start`, {method:"POST"});
    await loadAll();
    renderRunningForwards();
    notify("已重新启动转发", "success");
  } catch (error) {
    await loadAll({silent:true}).catch(()=>{});
    renderRunningForwards();
    notify(error.message || "重试转发失败", "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function bulkDeleteForwards(){
  const ids=[...document.querySelectorAll(".forward-check:checked")].map(x=>Number(x.value));
  if(!ids.length) return notify("请选择转发","error");
  await api("/api/forwards/bulk-delete",{method:"POST",body:JSON.stringify({ids})});
  await loadAll();
  if(selectedId) openForwards(selectedId);
  notify("批量删除转发完成","success");
}
