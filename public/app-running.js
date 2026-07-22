function renderRunningForwards() {
  const uiState = captureUiState($("connectionGroups") || document);
  const rows = connections.flatMap(connection => (connection.forwards || [])
    .filter(forward => forward.status === "running" || forward.status === "reconnecting" || forward.status === "failed")
    .map(forward => ({connection, forward})));
  const filter = runningFilter.trim().toLowerCase();
  const visibleRows = rows.filter(({connection, forward}) => {
    if (!filter) return true;
    return [connection.name, connection.ssh_host, forwardDisplayName(forward), forwardText(forward), forward.service_note, forwardStatusText(forward.status)]
      .filter(Boolean)
      .some(value => String(value).toLowerCase().includes(filter));
  });
  const groups = new Map();
  for (const row of visibleRows) {
    const key = runningGroupMode === "type" ? serviceTypeText(row.forward.service_type || row.forward.mode) : (runningGroupMode === "status" ? forwardStatusText(row.forward.status) : row.connection.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const key of groups.keys()) if (!localStorage.getItem("openRunningGroups")) runningOpen.add(key);
  saveRunningState();
  const runningCount = rows.filter(({forward}) => forward.status === "running").length;
  const abnormalCount = rows.length - runningCount;
  $("connectionGroups").innerHTML = `<div class="running-overview"><span><strong>${runningCount}</strong> 运行中</span><span class="${abnormalCount ? "bad" : ""}"><strong>${abnormalCount}</strong> 异常</span></div><div class="running-toolbar"><div class="search-field">${icon("search")}<input id="runningFilterInput" placeholder="搜索转发、服务器、端口" value="${esc(runningFilter)}" oninput="setRunningFilter(this.value)"></div><button class="${runningGroupMode === "server" ? "active" : ""}" onclick="setRunningGroupMode('server')">服务器</button><button class="${runningGroupMode === "type" ? "active" : ""}" onclick="setRunningGroupMode('type')">类型</button><button class="${runningGroupMode === "status" ? "active" : ""}" onclick="setRunningGroupMode('status')">状态</button></div>` +
    [...groups.entries()].map(([title, items]) => {
      const open = runningOpen.has(title);
      return `<div class="group">
    <button class="group-head" onclick="toggleRunningGroup(decodeURIComponent('${encodeURIComponent(title)}'))"><span class="chev">${open ? "▾" : "▸"}</span><span>${esc(title)}</span><span class="count">${items.length}</span></button>
    ${open ? items.map(({connection, forward}) => {
      const access = forwardAccessInfo(forward);
      return `<div class="forward-running-row">
      <div>
        <div class="conn-name">${esc(forwardDisplayName(forward))}</div>
        <div class="forward-tags"><span>${forwardModeText(forward.mode)}</span>${forward.service_type ? `<span>${serviceTypeText(forward.service_type)}</span>` : ""}</div>
        <div class="conn-meta">${esc(connection.name)} · ${forwardText(forward)}</div>
        <div class="conn-meta">${forwardQualityText(forward)}</div>
        ${forward.service_note ? `<div class="conn-meta">${esc(forward.service_note)}</div>` : ""}
        ${forwardAccessHtml(access)}
      </div>
      <div class="running-actions">${access.url ? `<a class="open-forward-link" href="${esc(access.url)}" target="_blank" rel="noopener">${icon("external-link")}<span>打开</span></a><button class="icon-button" title="复制地址" aria-label="复制地址" onclick="copyText('${escAttr(access.url)}')">${icon("copy")}</button>` : `<span class="muted">无可打开地址</span>`}<button title="重试转发" onclick="retryForwardFromRunning(${forward.id},this)">${icon("rotate-cw")}<span>重试</span></button><button class="danger icon-button" title="停止转发" aria-label="停止转发" onclick="stopForwardFromRunning(${forward.id})">${icon("square")}</button></div>
    </div>`;
    }).join("") : ""}
  </div>`;
    }).join("") || stateView("empty", rows.length ? "没有匹配的转发" : "暂无正在转发", rows.length ? "请调整搜索条件或分组方式。" : "启动连接的转发后会显示在这里。");
  restoreUiState(uiState);
}

function setRunningFilter(value) {
  runningFilter = value || "";
  localStorage.setItem("runningFilter", runningFilter);
  renderRunningForwards();
}

function toggleRunningGroup(name) {
  if (runningOpen.has(name)) runningOpen.delete(name);
  else runningOpen.add(name);
  saveRunningState();
  renderRunningForwards();
}

function setRunningGroupMode(mode) {
  runningGroupMode = mode;
  localStorage.setItem("runningGroupMode", mode);
  renderRunningForwards();
}
