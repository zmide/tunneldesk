const IMPORT_SECTION_META = {
  "import-source": "SSH config 导入导出",
  "import-export": "数据库导入导出",
  "configSnapshots": "配置快照"
};
let activeImportSection = "import-source";

function showImport(updateTab=true) {
  $("view-import").innerHTML = $("importTpl").innerHTML;
  refreshIcons();
  setWorkspace("导入导出", "SSH config 与数据库迁移", "import", "import", updateTab, true, {kind:"import"});
  renderBackupControls();
  loadSecuritySettings().then(renderBackupControls).catch(() => {});
  renderImport();
  renderConfigSnapshots();
  showImportSection(activeImportSection, {moveToWorkspace:false});
}

function normalizeImportSection(id) {
  return Object.prototype.hasOwnProperty.call(IMPORT_SECTION_META, id) ? id : "import-source";
}

function openImportSection(id) {
  activeImportSection = normalizeImportSection(id);
  if (activeView !== "import") showImport();
  showImportSection(activeImportSection);
}

function showImportSection(id, options={}) {
  const next = normalizeImportSection(id);
  activeImportSection = next;
  const mainPanel = $("importMainPanel");
  if (mainPanel) mainPanel.hidden = next === "configSnapshots";
  for (const sectionId of Object.keys(IMPORT_SECTION_META)) {
    const section = $(sectionId);
    if (section) section.hidden = sectionId !== next;
  }
  setExplorerSectionActive(next);
  if (activeView === "import" && $("workspaceSubtitle")) $("workspaceSubtitle").textContent = IMPORT_SECTION_META[next];
  if (options.moveToWorkspace !== false) {
    document.querySelector(".workspace")?.scrollTo?.({top:0, behavior:"auto"});
    if (isMobileLayout()) showMobileWorkspace();
  }
}

function scrollToImportSection(id) {
  openImportSection(id);
}

async function renderConfigSnapshots() {
  const root = $("view-import");
  if (!root) return;
  let box = $("configSnapshots");
  if (!box) {
    box = document.createElement("div");
    box.id = "configSnapshots";
    box.className = "panel snapshot-panel";
    root.appendChild(box);
  }
  box.innerHTML = stateView("loading", "正在加载配置快照");
  try {
    const items = await api("/api/config-snapshots");
    box.innerHTML = `<div class="workspace-head"><div><h3>配置版本快照</h3><div class="subtitle">导入、恢复和批量应用模板前会自动创建，最多保留 20 个。</div></div><button onclick="createConfigSnapshotUi()">立即创建</button></div>${items.length ? `<div class="snapshot-list">${items.map(item => `<div class="snapshot-row"><div><strong>${esc(item.reason)}</strong><span>${new Date(item.created_at).toLocaleString("zh-CN",{hour12:false})} · 连接 ${item.counts?.connections || 0} · 转发 ${item.counts?.forwards || 0} · 模板 ${item.counts?.templates || 0}</span></div><div class="actions tight"><button onclick="restoreConfigSnapshotUi('${escAttr(item.id)}')">回滚</button><button class="danger" onclick="deleteConfigSnapshotUi('${escAttr(item.id)}')">删除</button></div></div>`).join("")}</div>` : stateView("empty", "暂无配置快照", "可手动创建，后续高风险操作也会自动保存。")}`;
  } catch (error) { box.innerHTML = stateView("error", "快照加载失败", error.message); }
  showImportSection(activeImportSection, {moveToWorkspace:false});
}

async function createConfigSnapshotUi() {
  await api("/api/config-snapshots", {method:"POST",body:JSON.stringify({reason:"手动快照"})});
  notify("配置快照已创建", "success");
  renderConfigSnapshots();
}

async function restoreConfigSnapshotUi(id) {
  if (!await confirmModal("回滚会停止当前转发并覆盖连接、转发和模板配置。继续？", "回滚配置快照", "确认回滚", "取消", true)) return;
  await api(`/api/config-snapshots/${id}/restore`, {method:"POST"});
  await loadAll();
  notify("配置快照已回滚", "success");
  renderConfigSnapshots();
}

async function deleteConfigSnapshotUi(id) {
  if (!await confirmModal("删除该配置快照？", "删除快照", "删除", "取消", true)) return;
  await api(`/api/config-snapshots/${id}`, {method:"DELETE"});
  renderConfigSnapshots();
}

function renderBackupControls() {
  const bundleBtn = $("backupBundleBtn");
  const bundleNote = $("backupBundleNote");
  if (!bundleBtn || !bundleNote) return;
  const enabled = Boolean(securitySettings?.encryption_enabled);
  bundleBtn.hidden = !enabled;
  bundleNote.textContent = enabled
    ? "已启用配置加密：建议下载 .tdbackup.json 加密迁移包。迁移包包含完整数据库和配置加密元数据，不包含 SSH 私钥文件、Web 密码或访问 Token。"
    : "未启用配置加密：通常下载普通 .db 数据库备份即可。启用配置加密后才会显示加密迁移包下载入口。";
}

async function parseImportConfig(){
  const f=$("config_upload").files[0];
  if(!f) return notify("请选择 config 文件","error");
  const form=new FormData();
  form.append("config", f);
  const res=await fetch("/api/import/parse",{method:"POST",body:form});
  importState=await res.json();
  if(!res.ok) return notify(importState.error,"error");
  renderImport();
  notify(importState.missing_keys.length?`发现未绑定私钥，可选绑定：${importState.missing_keys.join(", ")}`:`解析成功：${importState.count} 个连接`, importState.missing_keys.length?"info":"success");
}

async function parseImportText(){
  const text=$("config_text").value.trim();
  if(!text) return notify("请粘贴 config 内容","error");
  importState=await api("/api/import/parse-text",{method:"POST",body:JSON.stringify({text})});
  renderImport();
  notify(importState.missing_keys.length?`发现未绑定私钥，可选绑定：${importState.missing_keys.join(", ")}`:`解析成功：${importState.count} 个连接`, importState.missing_keys.length?"info":"success");
}

async function uploadImportKeys(){
  const files=[...$("import_key_upload").files];
  if(!files.length) return notify("请选择密钥文件","error");
  for(const f of files) await uploadOneKey(f);
  notify(`已上传 ${files.length} 个密钥，请重新解析 config`, "success");
}

function renderImport(results){
  if (!$("importResults")) return;
  const tunnels = importState.tunnels || [];
  $("importResults").innerHTML = tunnels.map((t,i)=>`<div class="panel"><strong>${esc(t.name)}</strong><div class="cmd">${esc(t.ssh_user)}@${esc(t.ssh_host)}:${t.ssh_port}</div><div>${(t.forwards||[]).map(f=>`${f.bind_host}:${f.bind_port} -> ${f.target_host}:${f.target_port}`).join("；")}</div>${t.identity_name ? `<div class="identity-binding-summary"><span>原密钥：${esc(t.identity_name)}</span><span class="${t.missing_identity ? "muted" : "success"}">${t.missing_identity ? "未绑定（可直接导入）" : `已绑定：${esc(identityDisplayName(t.identity_file))}`}</span></div>` : ""}<div class="muted">${results?esc(results[i]?.output||"OK"):(t.missing_identity?"未指定私钥，可稍后补充；使用前请确认默认 SSH 认证可用":"待测试")}</div></div>`).join("") || "";
  const bindButton = $("bindImportKeysBtn");
  if (bindButton) {
    bindButton.hidden = !tunnels.some(item => item.identity_name);
    bindButton.textContent = tunnels.some(item => item.missing_identity) ? "绑定私钥（可选）" : "调整私钥绑定";
  }
}

function clearImportState(){
  importState = {tunnels: [], missing_keys: []};
  if ($("config_upload")) $("config_upload").value = "";
  if ($("config_text")) $("config_text").value = "";
  if ($("import_key_upload")) $("import_key_upload").value = "";
  if ($("importResults")) $("importResults").innerHTML = "";
}

function importReady(){ if(!importState.tunnels?.length) throw new Error("请先解析 config"); }

async function batchTestImport(){
  const btn=$("batchTestBtn");
  try{
    importReady();
    setButtonBusy(btn,true,"测试中...");
    renderImport((importState.tunnels||[]).map(()=>({output:"正在测试..."})));
    const r=await api("/api/import/test",{method:"POST",body:JSON.stringify({tunnels:importState.tunnels})});
    renderImport(r.results);
    notify(`批量测试完成：成功 ${r.ok} 个，失败 ${r.failed} 个`, r.failed?"error":"success");
  }catch(e){notify(e.message,"error");} finally { setButtonBusy(btn,false); }
}

async function batchSaveImport(){
  const btn=$("batchSaveBtn");
  try{
    importReady();
    setButtonBusy(btn,true,"保存中...");
    const r=await api("/api/import/save",{method:"POST",body:JSON.stringify({tunnels:importState.tunnels})});
    await loadAll();
    if(!r.errors.length) clearImportState();
    notify(`成功导入 ${r.saved} 个连接${r.errors.length?`，失败 ${r.errors.length} 个`:""}`, r.errors.length?"error":"success");
  }catch(e){notify(e.message,"error");} finally { setButtonBusy(btn,false); }
}

async function exportConfig(){
  const r=await api("/api/export/config",{method:"POST",body:JSON.stringify({ids:[]})});
  $("export_text").value=r.config;
  notify("已生成 config", "success");
}

async function copyExport(){ await navigator.clipboard.writeText($("export_text").value); notify("已复制", "success"); }

async function downloadDatabaseBackup() {
  const res = await fetch("/api/backup/database");
  if (!res.ok) return notify(await res.text(), "error");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tunneldesk-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
  a.click();
  URL.revokeObjectURL(url);
  notify("数据库备份已下载", "success");
}

async function downloadBackupBundle() {
  const res = await fetch("/api/backup/bundle");
  if (!res.ok) return notify(await res.text(), "error");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tunneldesk-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tdbackup.json`;
  a.click();
  URL.revokeObjectURL(url);
  notify("加密迁移包已下载", "success");
}

function identityDisplayName(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "未命名私钥";
}

async function loadIdentityBindingOptions() {
  const info = await api("/api/identity-files/info");
  return {items:Array.isArray(info?.items) ? info.items : [], upload_directory:String(info?.upload_directory || "")};
}

function showIdentityBindingModal(items, options={}) {
  const rows = (items || []).map((item, index) => ({...item, binding_id:String(item.binding_id ?? item.connection_id ?? index)}));
  return new Promise((resolve) => {
    const modal = $("modal");
    modal.onclick = null;
    const bindings = new Map(rows.filter(row => !row.missing_identity && row.identity_file).map(row => [row.binding_id, {path:row.identity_file, name:identityDisplayName(row.identity_file)}]));
    let identityInfo = {items:[], upload_directory:options.upload_directory || ""};
    modal.innerHTML = `<div class="modal-card wide restore-key-modal" role="dialog" aria-modal="true" aria-labelledby="restoreKeyModalTitle">
      <div class="restore-key-head"><div><h2 id="restoreKeyModalTitle">绑定连接私钥</h2><span>${esc(options.subtitle || "为待导入连接选择实际使用的私钥。")}</span></div><button id="restoreKeyClose" class="icon-button" type="button" title="取消" aria-label="取消">${icon("x")}</button></div>
      <p class="restore-key-intro">私钥不要求与原文件同名。可为部分连接选择或上传私钥并暂存；未绑定的连接会保留为空，之后可在连接设置中补充。</p>
      <div class="identity-binding-source">
        <div><label for="identityBindingCandidate">已有私钥</label><select id="identityBindingCandidate"><option value="">正在加载私钥...</option></select></div>
        <div><label>上传私钥到当前密钥目录</label><div class="upload-line"><label class="file-picker"><input id="identityBindingUpload" type="file" accept="*/*" onchange="updateFilePicker(this)"><span class="file-picker-button">选择文件</span><span class="file-picker-name">未选择文件</span></label><button id="identityBindingUploadBtn" type="button">上传</button></div></div>
      </div>
      <div id="identityBindingDirectory" class="muted"></div>
      <div class="identity-binding-toolbar"><span>选择要绑定的连接</span><div class="actions tight"><button id="identitySelectMatching" type="button">选择原同名</button><button id="identitySelectAll" type="button">全选未绑定</button><button id="identitySelectNone" type="button">取消选择</button></div></div>
      <div id="identityBindingRows" class="identity-binding-rows">${rows.map(row => `<label class="identity-binding-row" data-binding-row="${escAttr(row.binding_id)}"><input type="checkbox" value="${escAttr(row.binding_id)}"><span><strong>${esc(row.connection_name || row.name || `连接 ${row.binding_id}`)}</strong><small>${esc(row.ssh_user || "")}@${esc(row.ssh_host || "")}:${esc(row.ssh_port || 22)}</small></span><span><small>原密钥</small><code>${esc(row.key_name || identityDisplayName(row.old_path || row.identity_name))}</code></span><span class="identity-binding-result" data-binding-result="${escAttr(row.binding_id)}">未绑定</span></label>`).join("")}</div>
      <div id="restoreKeyStatus" class="restore-key-status" role="status" aria-live="polite">可选择私钥进行绑定，也可直接继续并保留未绑定连接。</div>
      <div class="actions"><button id="restoreKeyCancel">取消</button><button id="identityBindingTest" type="button">测试选中连接</button><button id="identityBindingStage" type="button">暂存绑定</button><button id="identityBindingFinish" class="primary" type="button">${esc(options.finish_label || "继续")}</button></div>
    </div>`;
    modal.hidden = false;
    const status = $("restoreKeyStatus");
    const candidateSelect = $("identityBindingCandidate");
    const selectedRows = () => [...modal.querySelectorAll("#identityBindingRows input:checked")].map(input => rows.find(row => row.binding_id === input.value)).filter(Boolean);
    const currentCandidate = () => identityInfo.items.find(item => item.path === candidateSelect.value);
    const refreshCandidates = (selectedPath="") => {
      candidateSelect.replaceChildren(
        new Option("选择私钥", ""),
        ...identityInfo.items.map(item => new Option(`${item.name} · ${item.source_label}`, String(item.path || "")))
      );
      if (selectedPath) candidateSelect.value = selectedPath;
      $("identityBindingDirectory").textContent = identityInfo.upload_directory ? `上传目标目录：${identityInfo.upload_directory}` : "上传后会保存到当前设置使用的密钥目录。";
    };
    const finish = (result) => {
      modal.hidden = true;
      modal.onclick = null;
      modal.innerHTML = "";
      resolve(result);
    };
    const setStatus = (text, type="") => {
      status.className = `restore-key-status ${type}`.trim();
      status.textContent = text;
    };
    const renderBindings = () => {
      for (const row of rows) {
        const result = modal.querySelector(`[data-binding-result="${CSS.escape(row.binding_id)}"]`);
        const binding = bindings.get(row.binding_id);
        result.textContent = binding ? `已暂存：${binding.name}` : "未绑定";
        result.className = `identity-binding-result ${binding ? "success" : ""}`;
      }
    };
    renderBindings();
    const requireSelection = () => {
      const candidate = currentCandidate();
      const selected = selectedRows();
      if (!candidate) throw new Error("请先选择或上传一把私钥");
      if (!selected.length) throw new Error("请勾选至少一个连接");
      return {candidate, selected};
    };
    $("identityBindingUploadBtn").onclick = async () => {
      const input = $("identityBindingUpload");
      const file = input.files?.[0];
      if (!file) return setStatus("请选择要上传的私钥", "error");
      try {
        setStatus(`正在上传 ${file.name}...`, "busy");
        const uploaded = await uploadOneKey(file);
        identityInfo = await loadIdentityBindingOptions();
        refreshCandidates(uploaded.path);
        setStatus(`已上传 ${uploaded.label}，可勾选连接进行绑定。`, "success");
      } catch (error) {
        setStatus(`上传失败：${error.message || "未知错误"}`, "error");
      }
    };
    $("identitySelectMatching").onclick = () => {
      const candidate = currentCandidate();
      if (!candidate) return setStatus("请先选择一把私钥", "error");
      modal.querySelectorAll("#identityBindingRows input").forEach(input => {
        const row = rows.find(item => item.binding_id === input.value);
        input.checked = identityDisplayName(row?.key_name || row?.old_path || row?.identity_name) === candidate.name;
      });
    };
    $("identitySelectAll").onclick = () => modal.querySelectorAll("#identityBindingRows input").forEach(input => { input.checked = !bindings.has(input.value); });
    $("identitySelectNone").onclick = () => modal.querySelectorAll("#identityBindingRows input").forEach(input => { input.checked = false; });
    $("identityBindingTest").onclick = async () => {
      try {
        const {candidate, selected} = requireSelection();
        setStatus(`正在测试 ${selected.length} 个连接...`, "busy");
        const tunnels = selected.map(row => ({...row, identity_file:candidate.path, missing_identity:false, extra_args:String(row.extra_args || "").startsWith("tdenc:v1:") ? "" : row.extra_args || ""}));
        const response = await api("/api/import/test", {method:"POST", body:JSON.stringify({tunnels})});
        response.results.forEach((result, index) => {
          const target = modal.querySelector(`[data-binding-result="${CSS.escape(selected[index].binding_id)}"]`);
          target.textContent = result.ok ? "测试成功" : `测试失败：${result.output || "连接失败"}`;
          target.className = `identity-binding-result ${result.ok ? "success" : "error"}`;
        });
        setStatus(`测试完成：成功 ${response.ok} 个，失败 ${response.failed} 个。`, response.failed ? "error" : "success");
      } catch (error) { setStatus(error.message, "error"); }
    };
    $("identityBindingStage").onclick = () => {
      try {
        const {candidate, selected} = requireSelection();
        selected.forEach(row => bindings.set(row.binding_id, candidate));
        renderBindings();
        modal.querySelectorAll("#identityBindingRows input:checked").forEach(input => { input.checked = false; });
        setStatus(`已暂存 ${selected.length} 个连接的绑定，可继续选择下一把私钥。`, "success");
      } catch (error) { setStatus(error.message, "error"); }
    };
    $("identityBindingFinish").onclick = () => {
      finish(rows.filter(row => bindings.has(row.binding_id)).map(row => ({connection_id:Number(row.connection_id || row.binding_id), binding_id:row.binding_id, identity_path:bindings.get(row.binding_id).path, identity_name:bindings.get(row.binding_id).name})));
    };
    $("restoreKeyCancel").onclick = () => finish(null);
    $("restoreKeyClose").onclick = () => finish(null);
    modal.onclick = event => { if (event.target === modal) finish(null); };
    loadIdentityBindingOptions().then(info => { identityInfo=info; refreshCandidates(); }).catch(error => setStatus(error.message || "私钥列表加载失败", "error"));
  });
}

async function bindImportIdentities() {
  const items = (importState.tunnels || []).map((tunnel, index) => ({...tunnel, binding_id:String(index), connection_id:index + 1})).filter(item => item.identity_name);
  if (!items.length) return notify("当前 SSH config 没有引用私钥", "success");
  const bindings = await showIdentityBindingModal(items, {subtitle:"可为 SSH config 中的连接指定私钥；未绑定连接仍可导入。", finish_label:"继续导入"});
  if (!bindings) return;
  for (const binding of bindings) {
    const tunnel = importState.tunnels[Number(binding.binding_id)];
    if (!tunnel) continue;
    tunnel.identity_file = binding.identity_path;
    tunnel.missing_identity = false;
  }
  importState.missing_keys = [...new Set(importState.tunnels.filter(item => item.missing_identity).map(item => item.identity_name))];
  renderImport();
  const remaining = importState.tunnels.filter(item => item.missing_identity).length;
  notify(`已暂存 ${bindings.length} 个私钥绑定${remaining ? `，${remaining} 个连接保持未绑定` : ""}`, remaining ? "info" : "success");
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function databaseRestoreRequest(buffer, bindings=[]) {
  return JSON.stringify({type:"tunneldesk-restore-request-v1", payload_base64:arrayBufferToBase64(buffer), identity_bindings:bindings});
}

async function inspectDatabaseBackup(buffer, bindings=[]) {
  const response = await fetch("/api/restore/database/check", {method:"POST", headers:{"Content-Type":"application/json"}, body:databaseRestoreRequest(buffer, bindings)});
  const result = await response.json().catch(()=>({error:"数据库检查失败"}));
  if (!response.ok) throw new Error(result.error || "数据库检查失败");
  return result;
}

async function restoreDatabaseBackup() {
  const file = $("db_restore_upload")?.files?.[0];
  if (!file) return notify("请选择数据库备份文件", "error");
  const buffer = await file.arrayBuffer();
  let identityBindings = [];
  let check;
  try {
    check = await inspectDatabaseBackup(buffer, identityBindings);
    if (check.missing_identities?.length) {
      const rows = check.unresolved_identities?.length ? check.unresolved_identities : check.missing_identities;
      const selected = await showIdentityBindingModal(rows, {subtitle:"可为待恢复连接重新绑定私钥；未绑定连接将清除旧路径并继续恢复。", upload_directory:check.upload_directory, finish_label:"继续恢复"});
      if (!selected) return;
      identityBindings = [...identityBindings, ...selected.map(item => ({connection_id:item.connection_id, identity_path:item.identity_path}))];
      check = await inspectDatabaseBackup(buffer, identityBindings);
    }
  } catch (error) {
    return notify(error.message || "数据库检查失败", "error");
  }
  const encryptedText = check.encrypted_bundle ? "\n\n该备份包含配置加密元数据，恢复后需要使用原主密码解锁加密配置。" : "";
  const unboundCount = check.unresolved_identities?.length || 0;
  const unboundText = unboundCount ? `\n\n${unboundCount} 个连接将不绑定私钥，旧机器上的私钥路径会被清除；之后可在连接设置中补充。` : "";
  if (!await confirmModal(`恢复数据库会覆盖当前连接配置，建议先下载备份。继续？${unboundText}${encryptedText}`, "恢复数据库", "继续恢复", "取消", true)) return;
  const res = await fetch("/api/restore/database", {method:"POST", headers:{"Content-Type":"application/json"}, body:databaseRestoreRequest(buffer, identityBindings)});
  const body = await res.json().catch(()=>({error:"恢复失败"}));
  if (!res.ok) return notify(body.error || "恢复失败", "error");
  const restoredUnbound = body.unresolved_identities?.length || 0;
  const suffix = restoredUnbound ? `；${restoredUnbound} 个连接保持未绑定` : "";
  await loadAll();
  if ($("db_restore_upload")) $("db_restore_upload").value = "";
  renderImport();
  notify(body.encrypted_bundle ? `加密迁移包已恢复并刷新，请用原主密码解锁${suffix}` : `数据库已恢复并自动刷新${suffix}`, "success");
}
