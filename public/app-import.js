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
    ? "已启用配置加密：建议下载 .tdbackup 加密迁移包。迁移包包含完整数据库和配置加密元数据，不包含 SSH 私钥文件、Web 密码或访问 Token。"
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
  $("importResults").innerHTML = tunnels.map((t,i)=>`<div class="panel"><div class="import-connection-head"><strong>${esc(t.name)}</strong><label>排序 <input type="number" min="1" max="2147483647" step="1" value="${Number(t.sort_order) || 1}" onchange="setImportSortOrder(${i},this.value)"></label></div><div class="cmd">${esc(t.ssh_user)}@${esc(t.ssh_host)}:${t.ssh_port}</div><div>${(t.forwards||[]).map(f=>`${f.bind_host}:${f.bind_port} -> ${f.target_host}:${f.target_port}`).join("；")}</div>${t.identity_name ? `<div class="identity-binding-summary"><span>原密钥：${esc(t.identity_name)}</span><span class="${t.missing_identity ? "muted" : "success"}">${t.missing_identity ? "未绑定（可直接导入）" : `已绑定：${esc(identityDisplayName(t.identity_file))}`}</span></div>` : ""}<div class="muted">${results?esc(results[i]?.output||"OK"):(t.missing_identity?"未指定私钥，可稍后补充；使用前请确认默认 SSH 认证可用":"待测试")}</div></div>`).join("") || "";
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
  const passwordChoice = await chooseModal(
    "下载数据库备份",
    "数据库备份可能包含 SSH 登录密码。请选择是否导出密码信息；不包含密码更适合日常备份和跨设备传输。",
    [
      {label:"不包含密码（推荐）", value:"exclude", className:"primary"},
      {label:"包含密码", value:"include", className:"danger"},
      {label:"取消", value:"cancel"}
    ]
  );
  if (passwordChoice === "cancel") return;
  const includePasswords = passwordChoice === "include";
  const res = await fetch(`/api/backup/database?include_passwords=${includePasswords ? "1" : "0"}`);
  if (!res.ok) return notify(await res.text(), "error");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tunneldesk-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
  a.click();
  URL.revokeObjectURL(url);
  notify(includePasswords ? "数据库备份已下载（包含 SSH 密码）" : "数据库备份已下载（不包含 SSH 密码）", "success");
}

function setImportSortOrder(index, value) {
  const order = Number(value);
  if (!Number.isInteger(order) || order < 1 || order > 2147483647) {
    importState.tunnels[index].sort_order = 1;
    renderImport();
    return notify("排序值必须是大于等于 1 的整数", "error");
  }
  importState.tunnels[index].sort_order = order;
}

async function downloadBackupBundle() {
  if (!await confirmModal("加密迁移包会包含数据库中的加密 SSH 凭据和解锁元数据，请妥善保管。继续下载？", "下载加密迁移包", "继续下载", "取消")) return;
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

function showDatabaseCredentialModal(items, options={}) {
  const rows = (items || []).map((item, index) => ({...item, binding_id:String(item.connection_id ?? index)}));
  return new Promise((resolve) => {
    const modal = $("modal");
    modal.onclick = null;
    const staged = new Map(rows.filter(row => row.original_auth_type === "password").map(row => [row.binding_id, {
      connection_id:Number(row.connection_id),
      auth_type:"password",
      password_action:row.has_password ? "preserve" : "clear"
    }]));
    let identityInfo = {items:[], upload_directory:options.upload_directory || ""};
    const originalCredential = row => row.original_auth_type === "password"
      ? `密码登录（${row.has_password ? row.password_encrypted ? "含加密密码" : "备份含密码" : "备份未包含密码"}）`
      : row.identity_encrypted ? "私钥登录（路径已加密）" : `私钥：${row.key_name || "未记录"}`;
    modal.innerHTML = `<div class="modal-card wide restore-key-modal restore-credential-modal" role="dialog" aria-modal="true" aria-labelledby="restoreKeyModalTitle">
      <div class="restore-key-head"><div><h2 id="restoreKeyModalTitle">恢复连接凭据</h2><span>${esc(options.subtitle || "确认备份中每个连接原来的验证方式，并按需重新设置凭据。")}</span></div><button id="restoreKeyClose" class="icon-button" type="button" title="取消" aria-label="取消">${icon("x")}</button></div>
      <p class="restore-key-intro">所有连接都会列在下方。可为选中连接绑定私钥或设置新密码；未重新绑定的普通私钥路径会被清除，备份中已有的密码默认保留。</p>
      <div class="credential-binding-source">
        <div><label for="identityBindingCandidate">已有私钥</label><select id="identityBindingCandidate"><option value="">正在加载私钥...</option></select></div>
        <div><label>上传私钥</label><div class="upload-line"><label class="file-picker"><input id="identityBindingUpload" type="file" accept="*/*" onchange="updateFilePicker(this)"><span class="file-picker-button">选择文件</span><span class="file-picker-name">未选择文件</span></label><button id="identityBindingUploadBtn" type="button">上传</button></div></div>
        <div><label for="credentialPassword">设置新 SSH 密码</label><input id="credentialPassword" type="password" autocomplete="new-password" placeholder="输入后应用到选中连接" ${options.password_replacement_allowed === false ? "disabled" : ""}></div>
      </div>
      <div id="identityBindingDirectory" class="muted"></div>
      <div class="identity-binding-toolbar"><span>选择要设置凭据的连接</span><div class="actions tight"><button id="identitySelectMatching" type="button">选择原同名</button><button id="identitySelectAll" type="button">全选</button><button id="identitySelectNone" type="button">取消选择</button></div></div>
      <div id="identityBindingRows" class="identity-binding-rows">${rows.map(row => `<div class="identity-binding-row" data-binding-row="${escAttr(row.binding_id)}"><input type="checkbox" value="${escAttr(row.binding_id)}" aria-label="选择 ${escAttr(row.connection_name || `连接 ${row.binding_id}`)}"><span><strong>${esc(row.connection_name || `连接 ${row.binding_id}`)}</strong><small>${esc(row.ssh_user || "")}@${esc(row.ssh_host || "")}:${esc(row.ssh_port || 22)}</small></span><span><small>原验证方式</small><code>${esc(originalCredential(row))}</code></span><span class="restore-sort-field"><small>排序</small><input data-restore-sort="${escAttr(row.binding_id)}" aria-label="${escAttr(row.connection_name || `连接 ${row.binding_id}`)} 排序" type="number" min="1" max="2147483647" step="1" value="${Number(row.sort_order) || 1}"></span><span class="identity-binding-result" data-binding-result="${escAttr(row.binding_id)}"></span></div>`).join("") || `<div class="restore-credential-empty">该数据库没有 SSH 连接，可直接继续恢复。</div>`}</div>
      <div id="restoreKeyStatus" class="restore-key-status" role="status" aria-live="polite">${options.password_replacement_allowed === false ? "加密迁移包恢复前不能改写密码；恢复并解锁后可在连接设置中修改。" : "请选择连接后绑定私钥或设置密码，也可保留当前提示状态继续恢复。"}</div>
      <div class="actions credential-binding-actions"><button id="restoreKeyCancel">取消</button><button id="identityBindingTest" type="button">测试选中连接</button><button id="credentialClearSelected" type="button">清除选中凭据</button><button id="identityBindingStage" type="button">绑定所选私钥</button><button id="credentialPasswordStage" type="button" ${options.password_replacement_allowed === false ? "disabled" : ""}>设置所填密码</button><button id="identityBindingFinish" class="primary" type="button">继续恢复</button></div>
    </div>`;
    modal.hidden = false;
    const status = $("restoreKeyStatus");
    const candidateSelect = $("identityBindingCandidate");
    const passwordInput = $("credentialPassword");
    const selectedRows = () => [...modal.querySelectorAll('#identityBindingRows input[type="checkbox"]:checked')].map(input => rows.find(row => row.binding_id === input.value)).filter(Boolean);
    const currentCandidate = () => identityInfo.items.find(item => item.path === candidateSelect.value);
    const finish = result => {
      modal.hidden = true;
      modal.onclick = null;
      modal.innerHTML = "";
      resolve(result);
    };
    const setStatus = (text, type="") => {
      status.className = `restore-key-status ${type}`.trim();
      status.textContent = text;
    };
    const bindingLabel = row => {
      const binding = staged.get(row.binding_id);
      if (binding?.auth_type === "key") return `将绑定：${identityDisplayName(binding.identity_path)}`;
      if (binding?.password_action === "replace") return "将使用新密码";
      if (binding?.password_action === "preserve") return row.password_encrypted ? "保留备份中的加密密码" : "保留备份密码";
      if (binding?.password_action === "clear") return "密码未设置";
      if (row.identity_encrypted) return "保留加密私钥路径";
      return "私钥未绑定";
    };
    const renderBindings = () => rows.forEach(row => {
      const result = modal.querySelector(`[data-binding-result="${CSS.escape(row.binding_id)}"]`);
      if (!result) return;
      const binding = staged.get(row.binding_id);
      result.textContent = bindingLabel(row);
      result.className = `identity-binding-result ${binding?.identity_path || binding?.password_action === "replace" || binding?.password_action === "preserve" || row.identity_encrypted ? "success" : ""}`;
    });
    const requireRows = () => {
      const selected = selectedRows();
      if (!selected.length) throw new Error("请勾选至少一个连接");
      return selected;
    };
    const refreshCandidates = (selectedPath="") => {
      candidateSelect.replaceChildren(new Option("选择私钥", ""), ...identityInfo.items.map(item => new Option(`${item.name} · ${item.source_label}`, String(item.path || ""))));
      if (selectedPath) candidateSelect.value = selectedPath;
      $("identityBindingDirectory").textContent = identityInfo.upload_directory ? `上传目标目录：${identityInfo.upload_directory}` : "上传后会保存到当前设置使用的密钥目录。";
    };
    renderBindings();
    $("identityBindingUploadBtn").onclick = async () => {
      const file = $("identityBindingUpload").files?.[0];
      if (!file) return setStatus("请选择要上传的私钥", "error");
      try {
        setStatus(`正在上传 ${file.name}...`, "busy");
        const uploaded = await uploadOneKey(file);
        identityInfo = await loadIdentityBindingOptions();
        refreshCandidates(uploaded.path);
        setStatus(`已上传 ${uploaded.label}，可应用到选中连接。`, "success");
      } catch (error) { setStatus(`上传失败：${error.message || "未知错误"}`, "error"); }
    };
    $("identitySelectMatching").onclick = () => {
      const candidate = currentCandidate();
      if (!candidate) return setStatus("请先选择一把私钥", "error");
      modal.querySelectorAll('#identityBindingRows input[type="checkbox"]').forEach(input => {
        const row = rows.find(item => item.binding_id === input.value);
        input.checked = row?.original_auth_type === "key" && row.key_name === candidate.name;
      });
    };
    $("identitySelectAll").onclick = () => modal.querySelectorAll('#identityBindingRows input[type="checkbox"]').forEach(input => { input.checked = true; });
    $("identitySelectNone").onclick = () => modal.querySelectorAll('#identityBindingRows input[type="checkbox"]').forEach(input => { input.checked = false; });
    $("identityBindingStage").onclick = () => {
      try {
        const candidate = currentCandidate();
        if (!candidate) throw new Error("请先选择或上传一把私钥");
        const selected = requireRows();
        selected.forEach(row => staged.set(row.binding_id, {connection_id:Number(row.connection_id), auth_type:"key", identity_path:candidate.path}));
        renderBindings();
        setStatus(`已为 ${selected.length} 个连接暂存私钥绑定。`, "success");
      } catch (error) { setStatus(error.message, "error"); }
    };
    $("credentialPasswordStage").onclick = () => {
      try {
        const password = passwordInput.value;
        if (!password) throw new Error("请先输入新 SSH 密码");
        const selected = requireRows();
        selected.forEach(row => staged.set(row.binding_id, {connection_id:Number(row.connection_id), auth_type:"password", password_action:"replace", password}));
        passwordInput.value = "";
        renderBindings();
        setStatus(`已为 ${selected.length} 个连接暂存新密码。`, "success");
      } catch (error) { setStatus(error.message, "error"); }
    };
    $("credentialClearSelected").onclick = () => {
      try {
        const selected = requireRows();
        selected.forEach(row => {
          const current = staged.get(row.binding_id);
          if (current?.auth_type === "password" || row.original_auth_type === "password") staged.set(row.binding_id, {connection_id:Number(row.connection_id), auth_type:"password", password_action:"clear"});
          else staged.delete(row.binding_id);
        });
        renderBindings();
        setStatus(`已清除 ${selected.length} 个连接暂存的凭据。`, "success");
      } catch (error) { setStatus(error.message, "error"); }
    };
    $("identityBindingTest").onclick = async () => {
      try {
        const selected = requireRows();
        const tunnels = selected.map(row => {
          const binding = staged.get(row.binding_id);
          if (binding?.auth_type === "key" && binding.identity_path) return {...row, auth_type:"key", identity_file:binding.identity_path, ssh_password:"", missing_identity:false};
          if (binding?.auth_type === "password" && binding.password_action === "replace") return {...row, auth_type:"password", identity_file:"", ssh_password:binding.password, missing_identity:false};
          throw new Error(`连接 ${row.connection_name} 需要先暂存可测试的新私钥或新密码`);
        });
        setStatus(`正在测试 ${tunnels.length} 个连接...`, "busy");
        const response = await api("/api/import/test", {method:"POST", body:JSON.stringify({tunnels})});
        response.results.forEach((result, index) => {
          const target = modal.querySelector(`[data-binding-result="${CSS.escape(selected[index].binding_id)}"]`);
          target.textContent = result.ok ? "测试成功" : `测试失败：${result.output || "连接失败"}`;
          target.className = `identity-binding-result ${result.ok ? "success" : "error"}`;
        });
        setStatus(`测试完成：成功 ${response.ok} 个，失败 ${response.failed} 个。`, response.failed ? "error" : "success");
      } catch (error) { setStatus(error.message, "error"); }
    };
    $("identityBindingFinish").onclick = () => {
      try {
        const result = rows.map(row => {
          const input = modal.querySelector(`[data-restore-sort="${CSS.escape(row.binding_id)}"]`);
          const sortOrder = Number(input?.value || 1);
          if (!Number.isInteger(sortOrder) || sortOrder < 1 || sortOrder > 2147483647) throw new Error(`连接 ${row.connection_name || row.connection_id} 的排序值无效`);
          return {...(staged.get(row.binding_id) || {connection_id:Number(row.connection_id)}), sort_order:sortOrder};
        });
        finish(result);
      } catch (error) { setStatus(error.message, "error"); }
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

async function inspectDatabaseBackup(file) {
  const response = await fetch("/api/restore/database/check", {
    method:"POST",
    headers:{"Content-Type":"application/octet-stream", "X-TunnelDesk-Filename":encodeURIComponent(file.name || "backup.db")},
    body:file
  });
  const result = await response.json().catch(()=>({error:"数据库检查失败"}));
  if (!response.ok) throw new Error(result.error || "数据库检查失败");
  return result;
}

async function restoreDatabaseBackup() {
  const file = $("db_restore_upload")?.files?.[0];
  if (!file) return notify("请选择数据库备份文件", "error");
  let credentialBindings = [];
  let check;
  try {
    check = await inspectDatabaseBackup(file);
    const selected = await showDatabaseCredentialModal(check.connections || [], {
      subtitle:"请确认每个连接原来的验证方式；可重新绑定私钥、保留备份密码或设置新密码。",
      upload_directory:check.upload_directory,
      password_replacement_allowed:check.password_replacement_allowed
    });
    if (!selected) {
      await api("/api/restore/database/stage", {method:"DELETE", body:JSON.stringify({restore_token:check.restore_token})}).catch(()=>{});
      return;
    }
    credentialBindings = selected;
  } catch (error) {
    return notify(error.message || "数据库检查失败", "error");
  }
  const encryptedText = check.encrypted_bundle ? "\n\n该备份包含配置加密元数据，恢复后需要使用原主密码解锁加密配置。" : "";
  const encryptedWithoutMetadata = !check.encrypted_bundle && (check.connections || []).some(item => item.identity_encrypted || item.password_encrypted)
    ? "\n\n检测到已加密凭据，但普通 .db 不包含解锁元数据；跨设备恢复应改用原设备导出的加密迁移包。"
    : "";
  const unboundCount = check.unresolved_identities?.length || 0;
  const unboundText = unboundCount ? `\n\n${unboundCount} 个连接将不绑定私钥，旧机器上的私钥路径会被清除；之后可在连接设置中补充。` : "";
  if (!await confirmModal(`恢复数据库会覆盖当前连接配置，建议先下载备份。继续？${unboundText}${encryptedText}${encryptedWithoutMetadata}`, "恢复数据库", "继续恢复", "取消", true)) {
    await api("/api/restore/database/stage", {method:"DELETE", body:JSON.stringify({restore_token:check.restore_token})}).catch(()=>{});
    return;
  }
  const res = await fetch("/api/restore/database", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({restore_token:check.restore_token, credential_bindings:credentialBindings})});
  const body = await res.json().catch(()=>({error:"恢复失败"}));
  if (!res.ok) return notify(body.error || "恢复失败", "error");
  const restoredUnbound = body.unresolved_identities?.length || 0;
  const suffix = restoredUnbound ? `；${restoredUnbound} 个连接保持未绑定` : "";
  await loadAll();
  if ($("db_restore_upload")) $("db_restore_upload").value = "";
  renderImport();
  notify(body.encrypted_bundle ? `加密迁移包已恢复并刷新，请用原主密码解锁${suffix}` : `数据库已恢复并自动刷新${suffix}`, "success");
}
