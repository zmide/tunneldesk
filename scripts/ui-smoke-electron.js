const { app, BrowserWindow, clipboard, session } = require("electron");
const path = require("node:path");

const url = process.env.TUNNELDESK_CHECK_URL || "http://127.0.0.1:8099";
const errors = [];

app.whenReady().then(async () => {
  await session.defaultSession.clearCache();
  const window = new BrowserWindow({ show:false, width:1200, height:800, webPreferences:{ contextIsolation:true } });
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  window.webContents.on("did-fail-load", (_event, code, description) => errors.push(`${code}: ${description}`));
  await window.loadURL(url);
  await new Promise(resolve => setTimeout(resolve, 1200));
  console.log("[ui-smoke] page loaded");
  await window.webContents.executeJavaScript(`(() => {
    if (Array.isArray(connections) && connections.length) return;
    connections = [{
      id: 900001,
      name: 'UI Smoke',
      group_name: 'UI Smoke',
      ssh_host: '127.0.0.1',
      ssh_port: 22,
      ssh_user: 'tester',
      tags: '',
      forwards: [{
        id: 900001,
        connection_id: 900001,
        mode: 'local',
        service_name: 'UI Smoke Web',
        service_type: 'web',
        url_scheme: 'http',
        bind_host: '127.0.0.1',
        bind_port: 18099,
        target_host: '127.0.0.1',
        target_port: 80,
        status: 'running',
        reconnect_count: 0
      }]
    }];
    groupOpen.add('UI Smoke');
    renderConnections();
    // Keep the in-memory fixture stable when the isolated test service has no records.
    loadAll = async () => {};
  })()`);
  console.log("[ui-smoke] base layout");
  const result = await window.webContents.executeJavaScript(`(() => {
    const activity = document.querySelector('.activity');
    const activityRect = activity?.getBoundingClientRect();
    const activityItems = [...document.querySelectorAll('.activity-top > button, .activity-bottom > a')].map(item => {
      const itemRect = item.getBoundingClientRect();
      const iconRect = item.querySelector('svg')?.getBoundingClientRect();
      return {
        id: item.id || 'github',
        itemCenter: itemRect.left + itemRect.width / 2,
        iconCenter: iconRect ? iconRect.left + iconRect.width / 2 : NaN,
        iconDelta: iconRect ? Math.abs((iconRect.left + iconRect.width / 2) - (itemRect.left + itemRect.width / 2)) : Infinity,
        insideColumn: Boolean(activityRect && itemRect.left >= activityRect.left - 0.5 && itemRect.right <= activityRect.right + 0.5)
      };
    });
    const baseline = activityItems[0]?.itemCenter;
    const groupActionButton = document.querySelector('.connection-group-menu-button');
    document.querySelector('.group-head')?.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:180, clientY:180}));
    const groupMenuLabels = [...document.querySelectorAll('#actionMenu button span')].map(node => node.textContent.trim());
    hideActionMenu();
    return {
      title: document.title,
      icons: document.querySelectorAll('svg.lucide').length,
      pendingIcons: document.querySelectorAll('i[data-lucide]').length,
      connections: document.querySelectorAll('.conn-row').length,
      groups: document.querySelectorAll('.group').length,
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      visibleView: Array.from(document.querySelectorAll('.view')).find(el => !el.hidden)?.id || '',
      groupRenameMenu: groupMenuLabels.includes('重命名分组'),
      groupActionButton: Boolean(groupActionButton && groupActionButton.getAttribute('aria-label')?.includes('分组操作')),
      activity: {
        count: activityItems.length,
        iconCentered: activityItems.every(item => item.iconDelta <= 0.5),
        centersAligned: activityItems.every(item => Math.abs(item.itemCenter - baseline) <= 0.5),
        insideColumn: activityItems.every(item => item.insideColumn),
        items: activityItems
      }
    };
  })()`);
  console.log("[ui-smoke] primary pages");
  const pages = await window.webContents.executeJavaScript(`(async () => {
    const rows = [];
    for (const name of ['connections','running','command','logs','settings','import']) {
      showPrimary(name);
      await new Promise(resolve => setTimeout(resolve, 250));
      rows.push({name, width:document.documentElement.clientWidth, scrollWidth:document.documentElement.scrollWidth, visibleView:Array.from(document.querySelectorAll('.view')).find(el => !el.hidden)?.id || ''});
    }
    return rows;
  })()`);
  console.log("[ui-smoke] settings and import navigation");
  const navigationUi = await window.webContents.executeJavaScript(`(async () => {
    const previousPrimary = primaryView;
    const previousActiveView = activeView;
    const previousSettingsSection = activeSettingsSection;
    const previousImportSection = activeImportSection;
    const previousUpdate = updateSettings;
    const previousRuntimeSettings = runtimeSettings;
    const previousRuntimeMessage = runtimeSettingsMessage;
    const previousRuntimeCheck = runtimeSettingsCheck;
    const previousReadVersion = updateNoticeReadVersion;
    const previousStoredVersion = sessionStorage.getItem(UPDATE_NOTICE_SESSION_KEY);
    try {
      primaryView = 'settings';
      activeSettingsSection = 'settings-general';
      updateSettings = {current_version:'1.0.8',latest_version:'1.0.9',update_available:true};
      runtimeSettings = normalizeRuntimeSettingsResponse({
        saved:{listen_hosts:['127.0.0.1','192.0.2.10'],listen_port:18100,sftp_recycle_bin_enabled:true},
        effective:{listen_hosts:['127.0.0.1','192.0.2.10'],listen_port:18100},
        available_hosts:[
          {address:'192.0.2.10',interface:'Ethernet',label:'Ethernet · 192.0.2.10'},
          {address:'192.0.2.11',interface:'Wi-Fi',label:'Wi-Fi · 192.0.2.11'}
        ],
        local_url:'http://127.0.0.1:18100',
        lan_urls:['http://192.0.2.10:18100'],
        restart_required:true
      });
      runtimeSettingsMessage = null;
      runtimeSettingsCheck = null;
      updateNoticeReadVersion = '';
      sessionStorage.removeItem(UPDATE_NOTICE_SESSION_KEY);
      setWorkspace('设置', '通用设置', 'settings', 'settings-ui-smoke', false, true, {kind:'settings'});
      renderSettings();
      renderExplorerTools();
      syncUpdateNoticeDots();
      const tools = document.querySelector('#explorerTools');
      const settingsButtons = [...tools.querySelectorAll(':scope > button[data-explorer-section]')];
      const settingsLabels = settingsButtons.map(button => button.querySelector('span')?.textContent.trim() || '');
      const settingsExpected = ['通用设置','安全设置','通知设置','启动与运行','关于'];
      const settingsRects = settingsButtons.map(button => button.getBoundingClientRect());
      const settingsVertical = settingsRects.every((rect,index) => index === 0 || rect.top >= settingsRects[index-1].bottom - 0.5) && settingsRects.every(rect => Math.abs(rect.left-settingsRects[0].left)<1 && Math.abs(rect.width-settingsRects[0].width)<1);
      const settingsChecks = [];
      for (const button of settingsButtons.filter(item => item.dataset.explorerSection !== 'settings-about')) {
        button.click();
        await Promise.resolve();
        const visible = [...document.querySelectorAll('#view-settings .settings-group')].filter(group => !group.hidden).map(group => group.id);
        const active = [...tools.querySelectorAll(':scope > button.active')].map(item => item.dataset.explorerSection);
        settingsChecks.push({requested:button.dataset.explorerSection, visible, active});
      }
      const updateDotIds = ['navSettingsUpdateDot','mobileSettingsUpdateDot','settingsExplorerUpdateDot'];
      const dotsBeforeRead = updateDotIds.map(id => ({id, found:Boolean(document.getElementById(id)), hidden:document.getElementById(id)?.hidden}));
      tools.querySelector('[data-explorer-section="settings-about"]')?.click();
      await Promise.resolve();
      const aboutVisible = [...document.querySelectorAll('#view-settings .settings-group')].filter(group => !group.hidden).map(group => group.id);
      const aboutActive = [...tools.querySelectorAll(':scope > button.active')].map(item => item.dataset.explorerSection);
      const dotsAfterRead = updateDotIds.map(id => ({id, found:Boolean(document.getElementById(id)), hidden:document.getElementById(id)?.hidden}));
      const storedReadVersion = sessionStorage.getItem(UPDATE_NOTICE_SESSION_KEY);
      const sameVersionStaysRead = !shouldShowUpdateNotice();
      tools.querySelector('[data-explorer-section="settings-basic"]')?.click();
      updateSettings = {...updateSettings, latest_version:'1.0.10'};
      syncUpdateNoticeForCurrentSection();
      const newerVersionShowsAgain = shouldShowUpdateNotice() && updateDotIds.every(id => document.getElementById(id)?.hidden === false);

      tools.querySelector('[data-explorer-section="settings-runtime"]')?.click();
      await Promise.resolve();
      const runtimeGroup = document.querySelector('#settings-runtime');
      const runtimeHosts = [...document.querySelectorAll('[name="runtimeListenHost"]')];
      const wildcard = runtimeHosts.find(input => input.value === '0.0.0.0');
      wildcard.checked = true;
      syncRuntimeHostOptions(wildcard);
      const wildcardCollapsed = runtimeHosts.filter(input => input !== wildcard).every(input => input.closest('.runtime-host-option')?.hidden);
      const runtimeUrlLinks = [...document.querySelectorAll('#runtimeCurrentUrls .runtime-url-row')];
      const runtimeUi = {
        found:Boolean(runtimeGroup && document.querySelector('#runtimeSettingsPanel')),
        selectedHosts:runtimeHosts.filter(input => input.checked).map(input => input.value),
        port:document.querySelector('#runtimeListenPort')?.value || '',
        recycleSettingChecked:Boolean(document.querySelector('#sftpRecycleBinEnabled')?.checked),
        wildcardCollapsed,
        urlLinks:runtimeUrlLinks.map(link => link.href),
        restartNotice:runtimeGroup?.textContent.includes('等待重启') || false
      };

      primaryView = 'import';
      activeImportSection = 'import-source';
      showImport(false);
      renderExplorerTools();
      await Promise.resolve();
      const importButtons = [...tools.querySelectorAll(':scope > button[data-explorer-section]')];
      const importLabels = importButtons.map(button => button.querySelector('span')?.textContent.trim() || '');
      const importExpected = ['SSH config 导入导出','数据库导入导出','配置快照'];
      const importRects = importButtons.map(button => button.getBoundingClientRect());
      const importVertical = importRects.every((rect,index) => index === 0 || rect.top >= importRects[index-1].bottom - 0.5) && importRects.every(rect => Math.abs(rect.left-importRects[0].left)<1 && Math.abs(rect.width-importRects[0].width)<1);
      const importResults = document.querySelector('#import-source #import-results');
      const importResultsMerged = Boolean(importResults && importResults.parentElement?.id === 'import-source');
      const importChecks = [];
      for (const button of importButtons) {
        button.click();
        await Promise.resolve();
        const visible = Object.keys(IMPORT_SECTION_META).filter(id => document.getElementById(id) && !document.getElementById(id).hidden);
        const active = [...tools.querySelectorAll(':scope > button.active')].map(item => item.dataset.explorerSection);
        importChecks.push({requested:button.dataset.explorerSection, visible, active, resultsVisible: Boolean(importResults?.offsetParent)});
      }
      return {
        settingsLabels,
        settingsOnlySections:JSON.stringify(settingsLabels) === JSON.stringify(settingsExpected),
        settingsSectionMode:tools.classList.contains('section-mode'),
        settingsVertical,
        settingsChecks,
        aboutVisible,
        aboutActive,
        duplicateSettingsNav:document.querySelectorAll('.settings-nav').length,
        inlineUpdateDotPresent:Boolean(document.getElementById('settingsInlineUpdateDot')),
        dotsBeforeRead,
        dotsAfterRead,
        storedReadVersion,
        sameVersionStaysRead,
        newerVersionShowsAgain,
        runtimeUi,
        importLabels,
        importOwnSections:JSON.stringify(importLabels) === JSON.stringify(importExpected),
        importSectionMode:tools.classList.contains('section-mode'),
        importVertical,
        importResultsMerged,
        importChecks,
        treeHidden:Boolean(document.querySelector('#connectionGroups')?.hidden)
      };
    } finally {
      updateSettings = previousUpdate;
      runtimeSettings = previousRuntimeSettings;
      runtimeSettingsMessage = previousRuntimeMessage;
      runtimeSettingsCheck = previousRuntimeCheck;
      updateNoticeReadVersion = previousReadVersion;
      activeSettingsSection = previousSettingsSection;
      activeImportSection = previousImportSection;
      if (previousStoredVersion === null) sessionStorage.removeItem(UPDATE_NOTICE_SESSION_KEY);
      else sessionStorage.setItem(UPDATE_NOTICE_SESSION_KEY, previousStoredVersion);
      primaryView = previousPrimary;
      activeView = previousActiveView;
      renderExplorerTools();
      syncUpdateNoticeDots();
    }
  })()`);
  console.log("[ui-smoke] about modal");
  const aboutUi = await window.webContents.executeJavaScript(`(async () => {
    try {
      showPrimary('settings');
      for (let i = 0; i < 40 && (activeView !== 'settings' || !document.querySelector('#settings-about')); i += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const aboutButton = document.querySelector('#explorerTools [data-explorer-section="settings-about"]');
      aboutButton?.click();
      await Promise.resolve();
      const section = document.querySelector('#settings-about');
      const visibleGroups = [...document.querySelectorAll('#view-settings .settings-group')].filter(group => !group.hidden).map(group => group.id);
      const sourceLink = section?.querySelector('.about-actions a');
      const trigger = document.querySelector('#openLicenseBtn');
      if (!section || !trigger) return {found:false, visibleGroups};
      trigger.click();
      for (let i = 0; i < 20 && document.querySelector('#modal')?.hidden; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const modal = document.querySelector('#modal');
      const card = modal?.querySelector('.license-modal');
      const text = modal?.querySelector('#licenseText');
      const cardRect = card?.getBoundingClientRect();
      const textStyle = text ? getComputedStyle(text) : null;
      const result = {
        found:true,
        aboutSelected:visibleGroups.length === 1 && visibleGroups[0] === 'settings-about' && aboutButton?.classList.contains('active'),
        duplicateSettingsNav:document.querySelectorAll('.settings-nav').length,
        versionMatches:Boolean(aboutSettings?.version && section.textContent.includes('版本 ' + aboutSettings.version)),
        licenseMetadata:section.textContent.includes('GPL-3.0-only'),
        sourceLink:Boolean(sourceLink && sourceLink.target === '_blank' && sourceLink.relList.contains('noopener') && sourceLink.href === aboutSettings?.repository_url),
        modalOpen:Boolean(modal && !modal.hidden && card),
        accessible:Boolean(card?.getAttribute('role') === 'dialog' && card?.getAttribute('aria-modal') === 'true' && card?.getAttribute('aria-labelledby') === 'licenseModalTitle'),
        fullText:Boolean(text?.textContent.includes('GNU GENERAL PUBLIC LICENSE') && text?.textContent.includes('END OF TERMS AND CONDITIONS') && text.textContent === aboutSettings?.license_text),
        textScrollable:Boolean(text && text.scrollHeight > text.clientHeight && textStyle?.overflowY === 'auto'),
        cardWithinViewport:Boolean(cardRect && cardRect.left >= -0.5 && cardRect.right <= innerWidth + 0.5 && cardRect.top >= -0.5 && cardRect.bottom <= innerHeight + 0.5),
        closeFocused:document.activeElement?.id === 'licenseModalClose'
      };
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
      await new Promise(resolve => setTimeout(resolve, 25));
      result.closedByEscape = Boolean(modal?.hidden && !modal.querySelector('.license-modal'));
      result.focusReturned = document.activeElement === trigger;
      const followup = chooseModal('后续确认框', '验证共享弹窗状态已经清理。', [{label:'确定', value:'ok'}]);
      result.followupBackdropClean = modal.onclick === null;
      modal.querySelector('button[data-choice]')?.click();
      result.followupResolved = await followup === 'ok';
      const previousUpdate = updateSettings;
      updateSettings = {current_version:'1.0.8',latest_version:'1.0.9',update_available:true,release_url:'https://github.com/zmide/tunneldesk/releases/tag/v1.0.9',published_at:'2026-07-20T00:00:00Z',checked_at:'2026-07-20T00:01:00Z',notes:'更新检查测试'};
      document.querySelector('#updateCheckArea').innerHTML = updateStatusHtml();
      const updateLink = document.querySelector('#updateCheckArea a');
      result.updateUi = document.querySelector('#updateCheckArea')?.textContent.includes('发现新版本 v1.0.9') && updateLink?.href === 'https://github.com/zmide/tunneldesk/releases/tag/v1.0.9';
      updateSettings = previousUpdate;
      return result;
    } catch (error) {
      return {error:error?.stack || error?.message || String(error)};
    }
  })()`);
  console.log("[ui-smoke] menus and actions");
  const desktopMenu = await window.webContents.executeJavaScript(`(() => {
    showPrimary('connections');
    if (!document.querySelector('.conn-row')) document.querySelector('.group-head')?.click();
    document.querySelector('.conn-actions .icon-button')?.click();
    const opened = Boolean(document.querySelector('#actionMenu'));
    document.dispatchEvent(new Event('scroll', {bubbles:true}));
    return {opened, closedOnScroll:!document.querySelector('#actionMenu')};
  })()`);
  const runningActions = await window.webContents.executeJavaScript(`(() => {
    showPrimary('running');
    const open = document.querySelector('.running-actions .open-forward-link');
    const retry = Array.from(document.querySelectorAll('.running-actions button')).find(button => button.textContent.includes('重试'));
    if (!open || !retry) return {found:false};
    const openRect = open.getBoundingClientRect();
    const retryRect = retry.getBoundingClientRect();
    return {found:true,open:{width:openRect.width,height:openRect.height},retry:{width:retryRect.width,height:retryRect.height}};
  })()`);
  const authUi = await window.webContents.executeJavaScript(`(() => {
    newConnection();
    const auth = document.querySelector('#conn_auth_type');
    const keyBox = document.querySelector('#keyAuthBox');
    const passwordBox = document.querySelector('#passwordAuthBox');
    if (!auth || !keyBox || !passwordBox) return {found:false};
    auth.value = 'password';
    toggleAuthFields();
    const passwordMode = {
      keyHidden:keyBox.hidden && getComputedStyle(keyBox).display === 'none',
      keyDisabled:Array.from(keyBox.querySelectorAll('input,select,button')).every(control=>control.disabled),
      passwordVisible:!passwordBox.hidden && getComputedStyle(passwordBox).display !== 'none',
      passwordEnabled:Array.from(passwordBox.querySelectorAll('input,select,button')).every(control=>!control.disabled)
    };
    auth.value = 'key';
    toggleAuthFields();
    const keyMode = {
      keyVisible:!keyBox.hidden && getComputedStyle(keyBox).display !== 'none',
      keyEnabled:Array.from(keyBox.querySelectorAll('input,select,button')).every(control=>!control.disabled),
      passwordHidden:passwordBox.hidden && getComputedStyle(passwordBox).display === 'none',
      passwordDisabled:Array.from(passwordBox.querySelectorAll('input,select,button')).every(control=>control.disabled)
    };
    return {found:true,passwordMode,keyMode};
  })()`);
  const saveAndClearUi = await window.webContents.executeJavaScript(`(async () => {
    const originalApi = api;
    const originalLoadAll = loadAll;
    const originalLoadKeys = loadKeys;
    const originalNotify = notify;
    const saved = [];
    const notices = [];
    api = async (url, options={}) => { if(url==='/api/connections'&&options.method==='POST') saved.push(JSON.parse(options.body)); return {}; };
    loadAll = async () => {};
    loadKeys = async () => {};
    notify = (...args) => notices.push(args);
    newConnection();
    document.querySelector('#conn_name').value='save-clear-test';
    document.querySelector('#conn_user').value='root';
    document.querySelector('#conn_host').value='example.test';
    const button=document.querySelector('#connSaveAndClear');
    const visible=Boolean(button&&!button.hidden&&getComputedStyle(button).display!=='none');
    button?.click();
    await new Promise(resolve=>setTimeout(resolve,25));
    const result={
      visible,
      saved:saved.length===1&&saved[0].name==='save-clear-test'&&saved[0].ssh_host==='example.test'&&saved[0].sort_order===1,
      cleared:document.querySelector('#conn_name')?.value===''&&document.querySelector('#conn_user')?.value===''&&document.querySelector('#conn_host')?.value===''&&document.querySelector('#conn_port')?.value==='22',
      defaultsRestored:document.querySelector('#conn_auth_type')?.value==='key'&&document.querySelector('#conn_sort_order')?.value==='1'&&document.querySelector('#conn_extra')?.value.includes('ServerAliveInterval=60'),
      focused:document.activeElement===document.querySelector('#conn_name'),
      notice:notices.some(args=>String(args[0]).includes('表单已清空')),
      readyAgain:button?.disabled===false&&button?.textContent.trim()==='保存并清空'
    };
    api=originalApi;
    loadAll=originalLoadAll;
    loadKeys=originalLoadKeys;
    notify=originalNotify;
    return result;
  })()`);
  const notificationUi = await window.webContents.executeJavaScript(`(async () => {
    const originalNotify = notify;
    const originalDesktop = showDesktopNotification;
    const replayed = [];
    notify = (...args) => replayed.push({type:'toast',args});
    showDesktopNotification = event => replayed.push({type:'desktop',id:event?.id});
    lastNotificationId = 0;
    notificationCursorInitialized = false;
    notificationCursorPromise = null;
    localStorage.removeItem('lastNotificationId');
    await pollNotifications();
    const result = {replayed:replayed.length,cursor:lastNotificationId,initialized:notificationCursorInitialized,stored:Number(localStorage.getItem('lastNotificationId')||0)};
    notify = originalNotify;
    showDesktopNotification = originalDesktop;
    return result;
  })()`);
  const restoreKeyUi = await window.webContents.executeJavaScript(`(async () => {
    const originalLoadIdentityBindingOptions = loadIdentityBindingOptions;
    const windowsIdentityPath = ['C:','Users','junruo','.ssh','id_rsa_junruo'].join('\\\\');
    loadIdentityBindingOptions = async () => ({
      items:[
        {name:'id_rsa_junruo',path:windowsIdentityPath,source_label:'用户 ~/.ssh'},
        {name:'id_rsa_project',path:'/project/.ssh/id_rsa_project',source_label:'当前密钥目录'}
      ],
      upload_directory:'/project/.ssh'
    });
    const items = Array.from({length:12}, (_, index) => ({
      binding_id:String(index),
      connection_id:index + 1,
      key_name:index < 6 ? 'old-key-a' : 'old-key-b',
      connection_name:'server-'+index,
      ssh_user:'test',
      ssh_host:'127.0.0.1',
      ssh_port:22,
      missing_identity:true
    }));
    const pending = showIdentityBindingModal(items, {subtitle:'UI smoke'});
    await new Promise(resolve => setTimeout(resolve, 0));
    const modal = document.querySelector('#modal');
    const card = modal?.querySelector('.restore-key-modal');
    const rows = [...modal.querySelectorAll('.identity-binding-row')];
    const candidates = [...modal.querySelectorAll('#identityBindingCandidate option')].map(item => item.textContent.trim());
    const candidate = modal.querySelector('#identityBindingCandidate');
    candidate.value = windowsIdentityPath;
    const candidateValuePreserved = candidate.value === windowsIdentityPath;
    modal.querySelector('#identityBindingRows input').checked = true;
    modal.querySelector('#identityBindingStage').click();
    const stagesWindowsPath = modal.querySelector('[data-binding-result="0"]')?.textContent.includes('已暂存：id_rsa_junruo');
    const input = modal?.querySelector('#identityBindingUpload');
    const status = modal?.querySelector('#restoreKeyStatus');
    const cardRect = card?.getBoundingClientRect();
    const result = {
      opened:Boolean(card && !modal.hidden),
      rowCount:rows.length,
      originalNames:[...new Set(rows.map(row => row.querySelector('code')?.textContent.trim()))],
      candidates,
      candidateValuePreserved,
      stagesWindowsPath,
      acceptsAll:input?.getAttribute('accept') === '*/*',
      uploadDirectory:modal.querySelector('#identityBindingDirectory')?.textContent.includes('/project/.ssh'),
      actions:['identityBindingTest','identityBindingStage','identityBindingFinish'].every(id => Boolean(modal.querySelector('#'+id))),
      statusReady:Boolean(status?.textContent),
      cardWithinViewport:Boolean(cardRect && cardRect.left >= -0.5 && cardRect.right <= innerWidth + 0.5 && cardRect.top >= -0.5 && cardRect.bottom <= innerHeight + 0.5)
    };
    modal.querySelector('#identityBindingFinish')?.click();
    const completedBindings = await pending;
    result.continuedWithUnbound = Array.isArray(completedBindings) && completedBindings.length === 1 && completedBindings[0].identity_path === windowsIdentityPath;
    const skipPending = showIdentityBindingModal(items, {subtitle:'UI smoke skip'});
    await new Promise(resolve => setTimeout(resolve, 0));
    document.querySelector('#identityBindingFinish')?.click();
    const skippedBindings = await skipPending;
    result.continuedAllUnbound = Array.isArray(skippedBindings) && skippedBindings.length === 0;
    const previousImportState = importState;
    importState = {tunnels:[{name:'unbound',ssh_user:'root',ssh_host:'config.example',ssh_port:22,sort_order:1,missing_identity:true}],missing_keys:['id_rsa_old']};
    try {
      importReady();
      result.configAllowsUnbound = true;
      renderImport();
      const sortInput = document.querySelector('#importResults .import-connection-head input');
      sortInput.value='4';
      sortInput.dispatchEvent(new Event('change',{bubbles:true}));
      result.configSortEditable=importState.tunnels[0].sort_order===4;
    } catch {
      result.configAllowsUnbound = false;
      result.configSortEditable = false;
    }
    importState = previousImportState;
    result.closed = document.querySelector('#modal').hidden && !document.querySelector('#modal .restore-key-modal');
    loadIdentityBindingOptions = originalLoadIdentityBindingOptions;
    return result;
  })()`);
  const restoreCredentialUi = await window.webContents.executeJavaScript(`(async () => {
    const originalLoadIdentityBindingOptions = loadIdentityBindingOptions;
    loadIdentityBindingOptions = async () => ({items:[{name:'id_key',path:'/fixture/.ssh/id_key',source_label:'当前密钥目录'}],upload_directory:'/fixture/.ssh'});
    const items = [
      {connection_id:1,connection_name:'key-server',ssh_user:'root',ssh_host:'key.example',ssh_port:22,sort_order:5,original_auth_type:'key',key_name:'id_old',has_password:false},
      {connection_id:2,connection_name:'password-saved',ssh_user:'root',ssh_host:'saved.example',ssh_port:22,sort_order:1,original_auth_type:'password',has_password:true,password_encrypted:false},
      {connection_id:3,connection_name:'password-empty',ssh_user:'root',ssh_host:'empty.example',ssh_port:22,sort_order:1,original_auth_type:'password',has_password:false,password_encrypted:false}
    ];
    const pending = showDatabaseCredentialModal(items,{subtitle:'credential smoke',password_replacement_allowed:true});
    await new Promise(resolve => setTimeout(resolve,0));
    const modal = document.querySelector('#modal');
    const originalLabels = [...modal.querySelectorAll('.identity-binding-row code')].map(node=>node.textContent.trim());
    const initialStatuses = [...modal.querySelectorAll('.identity-binding-result')].map(node=>node.textContent.trim());
    const candidate = modal.querySelector('#identityBindingCandidate');
    candidate.value='/fixture/.ssh/id_key';
    modal.querySelector('input[value="1"]').checked=true;
    modal.querySelector('#identityBindingStage').click();
    modal.querySelector('#identitySelectNone').click();
    modal.querySelector('input[value="3"]').checked=true;
    modal.querySelector('#credentialPassword').value='fixture-password';
    modal.querySelector('#credentialPasswordStage').click();
    const stagedStatuses = [...modal.querySelectorAll('.identity-binding-result')].map(node=>node.textContent.trim());
    const sortFields = [...modal.querySelectorAll('[data-restore-sort]')].map(input=>input.value);
    modal.querySelector('[data-restore-sort="1"]').value='7';
    const cardRect = modal.querySelector('.restore-credential-modal')?.getBoundingClientRect();
    modal.querySelector('#identityBindingFinish').click();
    const bindings = await pending;
    loadIdentityBindingOptions = originalLoadIdentityBindingOptions;
    return {
      opened:originalLabels.length===3,
      originalLabels,
      initialStatuses,
      stagedStatuses,
      preservesSavedPassword:bindings.some(item=>item.connection_id===2&&item.auth_type==='password'&&item.password_action==='preserve'),
      replacesMissingPassword:bindings.some(item=>item.connection_id===3&&item.auth_type==='password'&&item.password_action==='replace'&&item.password==='fixture-password'),
      bindsKey:bindings.some(item=>item.connection_id===1&&item.auth_type==='key'&&item.identity_path==='/fixture/.ssh/id_key'),
      sortFields:JSON.stringify(sortFields)===JSON.stringify(['5','1','1']),
      updatesSort:bindings.some(item=>item.connection_id===1&&item.sort_order===7),
      preservesSort:bindings.some(item=>item.connection_id===2&&item.sort_order===1)&&bindings.some(item=>item.connection_id===3&&item.sort_order===1),
      cardWithinViewport:Boolean(cardRect&&cardRect.left>=-0.5&&cardRect.right<=innerWidth+0.5&&cardRect.top>=-0.5&&cardRect.bottom<=innerHeight+0.5),
      closed:modal.hidden&&!modal.querySelector('.restore-credential-modal')
    };
  })()`);
  const terminalUi = await window.webContents.executeJavaScript(`(() => {
    const first = connections[0];
    if (!first) return {found:false};
    const key = 'terminal-ui-smoke';
    let binaryWrite = false;
    const fakeTerm = {
      hasSelection:()=>true,
      getSelection:()=> 'selected text',
      selectAll:()=>{}, clear:()=>{}, focus:()=>{}, scrollToBottom:()=>{}, writeln:()=>{},
      write:data=>{ binaryWrite = data instanceof Uint8Array && data[0]===0xff && data[1]===0xfe; },
      onData:()=>({dispose:()=>{}}), onResize:()=>({dispose:()=>{}}),
      cols:80, rows:24, options:{fontSize:13}, buffer:{active:{length:0}}
    };
    terminalSessions.set(key,{term:fakeTerm,fit:{fit:()=>{}},id:first.id});
    const OriginalWebSocket = window.WebSocket;
    class FakeWebSocket extends EventTarget {
      static OPEN = 1;
      constructor(){ super(); this.readyState=1; this.binaryType='blob'; }
      send(){}
      close(){}
    }
    window.WebSocket = FakeWebSocket;
    connectTerminal(first,key);
    const fakeSocket = terminalSessions.get(key).socket;
    fakeSocket.dispatchEvent(new MessageEvent('message',{data:new Uint8Array([0xff,0xfe]).buffer}));
    const binaryType = fakeSocket.binaryType;
    window.WebSocket = OriginalWebSocket;
    document.querySelector('#view-terminal').innerHTML='<div id="terminalMount" class="terminal-box"></div>';
    setWorkspace('终端测试','UI','terminal',key,false,true,{kind:'terminal',id:first.id});
    const mount=document.querySelector('#terminalMount');
    mount.dataset.contextMenuBound='1';
    showTerminalEncodingMenu(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:160,clientY:100}),key,first.id);
    const encodingLabels=[...document.querySelectorAll('#actionMenu button span')].map(item=>item.textContent.trim());
    const encodingMenuOpened=['UTF-8','GB18030','GBK','Big5','Shift_JIS','EUC-KR','ISO-8859-1'].every(label=>encodingLabels.includes(label));
    hideActionMenu();
    showTerminalFontMenu(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:180,clientY:100}),key,first.id);
    const fontLabels=[...document.querySelectorAll('#actionMenu button span')].map(item=>item.textContent.trim());
    const fontMenuOpened=['系统等宽','Cascadia','JetBrains Mono','Consolas','自定义字体…'].every(label=>fontLabels.includes(label));
    hideActionMenu();
    mount.addEventListener('contextmenu',event=>showTerminalContextMenu(event,key,first.id),{capture:true});
    mount.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:120}));
    const labels=Array.from(document.querySelectorAll('#actionMenu button span')).map(el=>el.textContent.trim());
    const toolbar=document.createElement('div');
    toolbar.className='terminal-actions';
    toolbar.innerHTML='<button>'+icon('keyboard')+'<span>快捷键</span></button><button>'+icon('history')+'<span>最近命令</span></button><button>'+icon('refresh-cw')+'<span>重连</span></button>';
    document.body.appendChild(toolbar);
    const backFixture=document.createElement('div');
    backFixture.className='terminal-title-row';
    backFixture.innerHTML='<button class="terminal-mobile-back">'+icon('arrow-left')+'<span>返回</span></button>';
    document.body.appendChild(backFixture);
    const desktopBackHidden=getComputedStyle(backFixture.querySelector('.terminal-mobile-back')).display==='none';
    const metrics=Array.from(toolbar.querySelectorAll('button')).map(button=>{const br=button.getBoundingClientRect(),svg=button.querySelector('svg').getBoundingClientRect();return {iconWidth:svg.width,iconHeight:svg.height,centerDelta:Math.abs((svg.top+svg.height/2)-(br.top+br.height/2))}});
    toolbar.remove();
    backFixture.remove();
    hideActionMenu();
    terminalSessions.delete(key);
    return {found:true,labels,metrics,desktopBackHidden,binaryType,binaryWrite,encodingMenuOpened,fontMenuOpened};
  })()`);
  console.log("[ui-smoke] SFTP views");
  const sftpUi = await window.webContents.executeJavaScript(`(async () => {
    try {
    const view = document.querySelector('#view-sftp');
    const previousHtml = view.innerHTML;
    const previousHidden = view.hidden;
    const previousState = sftpState;
    const previousOpen = openSftp;
    const previousPreview = previewSftpText;
    const previousClipboardState = sftpClipboard;
    const previousLoadSftpPage = loadSftpPage;
    const previousRefreshSftpJobs = refreshSftpJobs;
    const previousStartSftpJobsTimer = startSftpJobsTimer;
    const previousSelectedId = selectedId;
    const previousActiveView = activeView;
    const connection = connections[0];
    let directoryActionsUi = {found:false};
    try {
      loadSftpPage = async () => true;
      refreshSftpJobs = async () => {};
      startSftpJobsTimer = () => {};
      sftpClipboard = null;
      await openSftp(connection.id, '/Users/junruo/Public', false);
      const stickyTop = view.querySelector('.sftp-top');
      const breadcrumb = view.querySelector('.sftp-breadcrumb');
      const directoryBar = view.querySelector('.sftp-directory-bar');
      const clipboardActions = view.querySelector('#sftpClipboardActions');
      const actionLabels = [...view.querySelectorAll('.sftp-directory-actions > button > span, .sftp-directory-actions > label > span')].map(node => node.textContent.trim());
      const emptyClipboardHidden = Boolean(clipboardActions && !clipboardActions.querySelector('button') && !clipboardActions.textContent.trim());

      copySingleSftp('/Users/junruo/Public/copy.txt', 'copy');
      const copyPaste = [...clipboardActions.querySelectorAll('button')].find(button => button.textContent.includes('粘贴'));
      const copyCancel = clipboardActions.querySelector('[aria-label="取消复制或移动队列"]');
      const copyQueueVisible = clipboardActions.textContent.includes('复制队列 1 项') && Boolean(copyPaste && !copyPaste.disabled && copyCancel);
      copyCancel?.click();
      const copyCancelled = sftpClipboard === null && !clipboardActions.querySelector('button');

      copySingleSftp('/Users/junruo/Public/move.txt', 'move');
      const movePaste = [...clipboardActions.querySelectorAll('button')].find(button => button.textContent.includes('粘贴'));
      const moveCancel = clipboardActions.querySelector('[aria-label="取消复制或移动队列"]');
      const moveQueueVisible = clipboardActions.textContent.includes('移动队列 1 项') && Boolean(movePaste && !movePaste.disabled && moveCancel);
      moveCancel?.click();
      const moveCancelled = sftpClipboard === null && !clipboardActions.querySelector('button');
      sftpClipboard = {mode:'copy', paths:['/source/cross.txt'], connectionId:999999, connectionName:'另一台主机'};
      refreshSftpDirectoryActions();
      const crossCopyButton = [...clipboardActions.querySelectorAll('button')].find(button => button.textContent.includes('跨主机复制'));
      const crossHostCopyEnabled = Boolean(crossCopyButton && !crossCopyButton.disabled);
      sftpClipboard = {mode:'move', paths:['/source/cross.txt'], connectionId:999999, connectionName:'另一台主机'};
      refreshSftpDirectoryActions();
      const crossHostMoveDisabled = Boolean([...clipboardActions.querySelectorAll('button')].find(button => button.disabled));
      sftpClipboard = null;
      refreshSftpDirectoryActions();
      const filenameEncodingButton = view.querySelector('#sftpFilenameEncodingButton');
      filenameEncodingButton?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:160,clientY:100}));
      const filenameEncodingLabels = [...document.querySelectorAll('#actionMenu button span')].map(item=>item.textContent.trim());
      const filenameEncodingMenu = ['UTF-8','GB18030','GBK','Big5','Shift_JIS','EUC-KR','ISO-8859-1'].every(label=>filenameEncodingLabels.includes(label));
      hideActionMenu();

      directoryActionsUi = {
        found:Boolean(stickyTop && breadcrumb && directoryBar),
        stickyPosition:stickyTop ? getComputedStyle(stickyTop).position : '',
        barInsideSticky:Boolean(stickyTop?.contains(directoryBar)),
        barAfterBreadcrumb:Boolean(breadcrumb && directoryBar && (breadcrumb.compareDocumentPosition(directoryBar) & Node.DOCUMENT_POSITION_FOLLOWING)),
        actionLabels,
        emptyClipboardHidden,
        copyQueueVisible,
        copyCancelled,
        moveQueueVisible,
        moveCancelled,
        crossHostCopyEnabled,
        crossHostMoveDisabled,
        filenameEncodingMenu,
        terminalJump:Boolean(view.querySelector('button[title="打开此连接的终端"]'))
      };
    } finally {
      loadSftpPage = previousLoadSftpPage;
      refreshSftpJobs = previousRefreshSftpJobs;
      startSftpJobsTimer = previousStartSftpJobsTimer;
      sftpClipboard = previousClipboardState;
      sftpState = previousState;
      selectedId = previousSelectedId;
      activeView = previousActiveView;
    }
    const actions = [];
    openSftp = (id, path) => actions.push({kind:'dir', id, path});
    previewSftpText = (id, path) => actions.push({kind:'file', id, path});
    const specialName = "weird" + String.fromCharCode(39, 34) + "<&>.bin";
    view.hidden = false;
    view.innerHTML = '<div class="sftp-shell"><div class="sftp-top"><div class="sftp-path-block"><div class="sftp-title">iMac</div><nav class="sftp-breadcrumb" id="sftpBreadcrumb" aria-label="远程目录路径">'+sftpBreadcrumbHtml(1,'/Users/junruo/Public')+'</nav></div><div class="sftp-top-actions"></div><div class="sftp-selection-bar" id="sftpSelectionBar" hidden><div class="sftp-selected" id="sftpSelectedInfo"></div><div class="sftp-selection-actions"><button id="sftpSelectionCompress">压缩</button><button id="sftpSelectionPermissions">权限</button><button id="sftpSelectionExtract" hidden>解压</button><button>复制</button><button>移动</button><button>删除</button><button onclick="clearSftpSelection()">取消</button></div></div></div><div id="sftpList" class="sftp-list"></div></div>';
    const pageEntries = [
      {name:'folder', type:'dir', size:0, mtime:0, mode:'755', owner:'root', group:'wheel'},
      {name:specialName, type:'file', size:12, mtime:'2026-07-20T12:34:56Z', mode:'600', owner:'junruo', group:'staff'},
      ...Array.from({length:48},(_,index)=>({name:'file-'+String(index+1).padStart(2,'0')+'.txt',type:'file',size:index+1,mtime:index+1,mode:'644',owner:'junruo',group:'staff'}))
    ];
    sftpState = {...sftpState, connectionId:1, path:'/fixture', query:'', sort:'name', dir:'asc', selected:null, page:1, pageSize:50, total:75, totalPages:2, unfilteredTotal:75, entries:pageEntries};
    renderSftpEntries();
    const rows = [...document.querySelectorAll('#view-sftp .sftp-row')];
    rows[0]?.dispatchEvent(new MouseEvent('dblclick', {bubbles:true, cancelable:true}));
    rows[1]?.dispatchEvent(new MouseEvent('dblclick', {bubbles:true, cancelable:true}));
    const top = document.querySelector('#view-sftp .sftp-top');
    const checks = [...document.querySelectorAll('#view-sftp .sftp-check')];
    checks[0].checked = true;
    checks[1].checked = true;
    updateSftpSelection();
    const selectionBar = document.querySelector('#view-sftp #sftpSelectionBar');
    const selectionShown = !selectionBar.hidden && selectionBar.textContent.includes('已选择 2 项');
    const selectionActionsShown = getComputedStyle(document.querySelector('#sftpSelectionCompress')).display !== 'none' && getComputedStyle(document.querySelector('#sftpSelectionPermissions')).display !== 'none';
    const specialSelectionExact = selectedSftpPaths().includes('/fixture/' + specialName);
    const selectedRows = document.querySelectorAll('#view-sftp .sftp-row.is-selected').length;
    clearSftpSelection();
    const selectionCleared = selectionBar.hidden;
    const moreButton = rows[1]?.querySelector('.sftp-row-action-more');
    moreButton?.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:320, clientY:240}));
    const moreMenuLabels = [...document.querySelectorAll('#actionMenu button span')].map(node => node.textContent.trim());
    const moreMenuOpened = moreMenuLabels.includes('以文本打开') && moreMenuLabels.includes('压缩') && moreMenuLabels.includes('设置权限') && moreMenuLabels.includes('删除');
    hideActionMenu();
    rows[0]?.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:260, clientY:220}));
    const contextMenuOpened = Boolean(document.querySelector('#actionMenu')) && document.querySelector('#actionMenu')?.textContent.includes('打开') && document.querySelector('#actionMenu')?.textContent.includes('压缩') && document.querySelector('#actionMenu')?.textContent.includes('设置权限');
    hideActionMenu();
    const fileHasCompression = Boolean(rows[1]?.querySelector('.sftp-row-action[title="压缩"]'));
    const fileHasPermissions = Boolean(rows[1]?.querySelector('.sftp-row-action[title="设置权限"]'));
    const permissionOwnerColumn = rows[1]?.querySelector(':scope > .sftp-access code')?.textContent === '600' && rows[1]?.querySelector(':scope > .sftp-access span')?.textContent === 'junruo';
    const permissionOwnerTitle = rows[1]?.querySelector(':scope > .sftp-access')?.title.includes('用户组 staff');
    openSftpPermissionsForSelection(['/fixture/folder']);
    const permissionModal = document.querySelector('#sftpPermissionMode');
    permissionModal.value = '640';
    permissionModal.dispatchEvent(new Event('input', {bubbles:true}));
    const permissionModeSync = permissionModal.value === '640' && document.querySelector('[data-permission="ownerWrite"]')?.checked && !document.querySelector('[data-permission="ownerExecute"]')?.checked;
    const recursiveVisible = Boolean(document.querySelector('#sftpPermissionRecursive'));
    document.querySelector('#sftpPermissionCancel')?.click();
    const breadcrumbText = document.querySelector('#view-sftp #sftpBreadcrumb')?.textContent.replace(/\s+/g,' ').trim() || '';
    const breadcrumbLabels = [...document.querySelectorAll('#view-sftp #sftpBreadcrumb .crumb')].map(node => node.textContent.trim());
    const compactRowHeight = rows[0]?.getBoundingClientRect().height || 0;
    const sftpList = document.querySelector('#view-sftp #sftpList');
    sftpList.style.width = '1280px';
    syncSftpListLayout(sftpList, 1280);
    const head = sftpList.querySelector('.sftp-head');
    const alignmentSelectors = ['.sftp-size','.sftp-time','.sftp-access','.sftp-head-actions'];
    const rowAlignmentSelectors = ['.sftp-size','.sftp-time','.sftp-access','.sftp-row-actions'];
    const wideColumnAlignment = alignmentSelectors.every((selector,index) => {
      const headLeft = head.querySelector(selector)?.getBoundingClientRect().left;
      const rowLeft = rows[0]?.querySelector(':scope > ' + rowAlignmentSelectors[index])?.getBoundingClientRect().left;
      return Number.isFinite(headLeft) && Number.isFinite(rowLeft) && Math.abs(headLeft - rowLeft) <= 1;
    });
    const wideActions = rows[0]?.querySelector(':scope > .sftp-row-actions');
    const wideLastAction = wideActions?.lastElementChild;
    const wideActionsFit = Boolean(wideActions && wideLastAction && wideLastAction.getBoundingClientRect().right <= wideActions.getBoundingClientRect().right + 1);
    sftpList.style.width = '760px';
    syncSftpListLayout(sftpList, 760);
    const compactSizeVisible = getComputedStyle(rows[1].querySelector(':scope > .sftp-size')).display !== 'none';
    const compactTimeVisible = getComputedStyle(rows[1].querySelector(':scope > .sftp-time')).display !== 'none';
    const compactAccessVisible = getComputedStyle(rows[1].querySelector(':scope > .sftp-access')).display !== 'none';
    const compactMediumHidden = getComputedStyle(rows[1].querySelector('.sftp-row-action-medium')).display === 'none';
    const compactCoreVisible = getComputedStyle(rows[1].querySelector('.sftp-row-action-core')).display !== 'none';
    const compactNoOverflow = sftpList.scrollWidth <= sftpList.clientWidth + 1;
    sftpList.style.width = '390px';
    syncSftpListLayout(sftpList, 390);
    const narrowListWidth = sftpList.getBoundingClientRect().width;
    const narrowCoreDisplay = getComputedStyle(rows[0].querySelector('.sftp-row-action-core')).display;
    const narrowCoreHidden = narrowCoreDisplay === 'none';
    const narrowMoreVisible = getComputedStyle(rows[0].querySelector('.sftp-row-action-more')).display !== 'none';
    const narrowMetaVisible = getComputedStyle(rows[1].querySelector('.sftp-mobile-meta')).display !== 'none' && rows[1].querySelector('.sftp-mobile-meta')?.textContent.includes('12 B');
    const narrowAccessHidden = getComputedStyle(rows[1].querySelector(':scope > .sftp-access')).display === 'none';
    const narrowLayoutClass = sftpList.classList.contains('sftp-actions-more-only');
    sftpList.style.width = '';
    sftpKnownJobStatuses.set('ui-smoke-extract', 'running');
    const completedMutationDetected = completedSftpMutationForCurrentView([{id:'ui-smoke-extract',status:'done',type:'extract',connection_id:1}]);
    sftpKnownJobStatuses.delete('ui-smoke-extract');
    let jobUi = {found:false};
    const jobFixture = document.createElement('div');
    jobFixture.id = 'sftpJobs';
    document.body.appendChild(jobFixture);
    const previousApi = api;
    const previousJobTimer = startSftpJobsTimer;
    const previousLatestJobs = sftpLatestJobs;
    try {
      const jobFixtures = [
        {id:'running-job',status:'running',type:'upload',label:'正在上传任务',connection_name:'iMac',size:100,transferred:40,progress:40},
        {id:'failed-job',status:'failed',type:'copy',label:'失败任务',connection_name:'iMac',error:'fixture failed'},
        {id:'done-job',status:'done',type:'compress',label:'完成历史任务',connection_name:'iMac',finished_at:Date.now()-1000},
        {id:'cancelled-job',status:'cancelled',type:'move',label:'取消历史任务',connection_name:'iMac',finished_at:Date.now()-2000}
      ];
      api = async pathname => pathname === '/api/sftp/jobs' ? jobFixtures : [];
      startSftpJobsTimer = () => {};
      await refreshSftpJobs();
      const mainText = jobFixture.textContent.replace(/\s+/g,' ').trim();
      const historyButton = jobFixture.querySelector('.sftp-task-summary-actions button');
      const mainJobRowHeight = jobFixture.querySelector('.sftp-job')?.getBoundingClientRect().height || 0;
      await showSftpJobHistory();
      const historyText = document.querySelector('#sftpJobHistoryList')?.textContent.replace(/\s+/g,' ').trim() || '';
      jobUi = {
        found:Boolean(jobFixture.querySelector('.sftp-task-drawer')),
        mainHasRunning:mainText.includes('正在上传任务'),
        mainHasFailed:mainText.includes('失败任务'),
        mainHidesDone:!mainText.includes('完成历史任务') && !mainText.includes('取消历史任务'),
        historyEnabled:Boolean(historyButton && !historyButton.disabled),
        historyCount:historyButton?.querySelector('small')?.textContent || '',
        historyHasDone:historyText.includes('完成历史任务') && historyText.includes('取消历史任务'),
        historyHidesCurrent:!historyText.includes('正在上传任务') && !historyText.includes('失败任务'),
        noManualRefresh:!jobFixture.textContent.includes('刷新目录') && !historyText.includes('刷新目录'),
        compactRow:mainJobRowHeight > 0 && mainJobRowHeight <= 88
      };
      closeSftpJobHistory();
    } finally {
      api = previousApi;
      startSftpJobsTimer = previousJobTimer;
      sftpLatestJobs = previousLatestJobs;
      jobFixture.remove();
    }
    const editorPromise = sftpTextModal('/tmp/gbk.txt', '中文内容', 8, 512*1024, 'gbk', 'auto');
    await new Promise(resolve=>setTimeout(resolve,20));
    const textEncodingUi={
      opened:Boolean(document.querySelector('.sftp-editor-modal')),
      selected:document.querySelector('#sftpTextEncoding')?.value||'',
      options:[...document.querySelectorAll('#sftpTextEncoding option')].map(option=>option.value),
      persistDefault:Boolean(document.querySelector('#sftpPersistEncoding')),
      backup:Boolean(document.querySelector('#sftpBackupBeforeSave')?.checked)
    };
    document.querySelector('#sftpTextClose')?.click();
    await editorPromise;
    const result = {
      folderOpened: actions[0]?.kind === 'dir' && actions[0]?.path === '/fixture/folder',
      fileOpened: actions[1]?.kind === 'file' && actions[1]?.path === '/fixture/' + specialName,
      directoryActionsUi,
      unknownAction: Boolean([...document.querySelectorAll('#view-sftp .sftp-row-actions button')].find(button => button.title === '以文本打开')),
      stickyPosition: top ? getComputedStyle(top).position : '',
      breadcrumbScrollable: Boolean(document.querySelector('#view-sftp .sftp-breadcrumb')),
      breadcrumbText,
      breadcrumbLabels,
      singlePathPresentation: !document.querySelector('#view-sftp #sftpPath'),
      selectionShown,
      selectionActionsShown,
      specialSelectionExact,
      selectedRows,
      selectionCleared,
      fileHasCompression,
      fileHasPermissions,
      permissionOwnerColumn,
      permissionOwnerTitle,
      wideColumnAlignment,
      wideActionsFit,
      compactSizeVisible,
      compactTimeVisible,
      compactAccessVisible,
      compactMediumHidden,
      compactCoreVisible,
      compactNoOverflow,
      permissionModeSync,
      recursiveVisible,
      compactRowHeight,
      moreMenuOpened,
      contextMenuOpened,
      narrowCoreHidden,
      narrowCoreDisplay,
      narrowListWidth,
      narrowLayoutClass,
      narrowMoreVisible,
      narrowMetaVisible,
      narrowAccessHidden,
      completedMutationDetected,
      textEncodingUi,
      jobUi,
      pageRows:rows.length,
      pagerVisible:Boolean(document.querySelector('#view-sftp .sftp-pager')),
      pagerText:document.querySelector('#view-sftp .sftp-pager')?.textContent.replace(/\s+/g,' ').trim()||'',
      previousDisabled:Boolean(document.querySelector('#view-sftp .sftp-pager button:first-child')?.disabled),
      nextEnabled:!document.querySelector('#view-sftp .sftp-pager button:last-child')?.disabled
    };
    sftpState = previousState;
    view.innerHTML = previousHtml;
    view.hidden = previousHidden;
    openSftp = previousOpen;
    previewSftpText = previousPreview;
    hideActionMenu();
    return result;
    } catch (error) {
      return {error:error?.stack || error?.message || String(error)};
    }
  })()`);
  console.log("[ui-smoke] clipboard and themes");
  const previousClipboard = clipboard.readText();
  window.setAlwaysOnTop(true);
  window.show();
  window.focus();
  window.webContents.focus();
  await new Promise(resolve => setTimeout(resolve, 120));
  const clipboardFixture = JSON.stringify(previousClipboard);
  const clipboardUi = await window.webContents.executeJavaScript(`(async()=>{
    return Promise.race([
      (async()=>{
        try {
          const expected = ${clipboardFixture};
          await navigator.clipboard.writeText(expected);
          return {ok:(await navigator.clipboard.readText())===expected};
        } catch (error) {
          return {ok:false,error:error.message};
        }
      })(),
      new Promise(resolve=>setTimeout(()=>resolve({ok:false,error:'clipboard timeout'}),3000))
    ]);
  })()`);
  window.setAlwaysOnTop(false);
  if (process.env.TUNNELDESK_UI_SCREENSHOT !== "1") window.hide();
  const dark = await window.webContents.executeJavaScript(`(async () => {
    const testStyle = document.createElement('style');
    testStyle.textContent = '*{transition:none!important}';
    document.head.appendChild(testStyle);
    applyTheme('dark');
    await new Promise(resolve => setTimeout(resolve, 50));
    const button = document.querySelector('button');
    const style = getComputedStyle(button);
    const root = getComputedStyle(document.documentElement);
    const result = {theme:document.documentElement.dataset.theme,panel:root.getPropertyValue('--panel').trim(),buttonPanel:style.getPropertyValue('--panel').trim(),buttonBackground:style.backgroundColor,buttonColor:style.color};
    applyTheme('light');
    testStyle.remove();
    return result;
  })()`);
  if (process.env.TUNNELDESK_UI_SCREENSHOT === "1") {
    const image = await window.webContents.capturePage();
    require("node:fs").writeFileSync(path.join(process.cwd(), "data", "ui-smoke-desktop.png"), image.toPNG());
  }
  console.log("[ui-smoke] mobile layout");
  window.setContentSize(390, 844);
  await new Promise(resolve => setTimeout(resolve, 400));
  const mobile = await window.webContents.executeJavaScript(`(async()=>{
    const mobileSftpLoad = loadSftpPage;
    const mobileSftpJobs = refreshSftpJobs;
    const mobileSftpTimer = startSftpJobsTimer;
    loadSftpPage = async () => true;
    refreshSftpJobs = async () => {};
    startSftpJobsTimer = () => {};
    await openSftp(connections[0].id, '.', false);
    const mobileSftpActions = document.querySelector('.sftp-top-actions');
    const mobileSftpLayout = {
      found:Boolean(mobileSftpActions),
      fits:Boolean(mobileSftpActions && mobileSftpActions.scrollWidth <= mobileSftpActions.clientWidth + 0.5),
      encodingVisible:Boolean(document.querySelector('#sftpFilenameEncodingButton')?.getBoundingClientRect().width),
      terminalJumpVisible:Boolean(document.querySelector('.sftp-top-actions button[title="打开此连接的终端"]')?.getBoundingClientRect().width)
    };
    loadSftpPage = mobileSftpLoad;
    refreshSftpJobs = mobileSftpJobs;
    startSftpJobsTimer = mobileSftpTimer;
    showPrimary('import');
    await new Promise(resolve=>setTimeout(resolve,80));
    const leftPane=document.querySelector('.left-pane');
    const content=document.querySelector('#content');
    const importExplorerFirst=!leftPane?.classList.contains('mobile-hide')&&!content?.classList.contains('mobile-show');
    document.querySelector('#explorerTools [data-explorer-section="import-source"]')?.click();
    for(let i=0;i<40&&(activeView!=='import'||!content?.classList.contains('mobile-show'));i+=1)await new Promise(resolve=>setTimeout(resolve,25));
    const layout={
      width:document.documentElement.clientWidth,
      scrollWidth:document.documentElement.scrollWidth,
      bodyWidth:document.body.scrollWidth,
      mobileNav:getComputedStyle(document.querySelector('.mobile-tabs')).display,
      contentVisible:getComputedStyle(content).display,
      active:document.querySelector('.mobile-tabs .active')?.getAttribute('aria-label')||'',
      importExplorerFirst,
      importWorkspaceEntered:leftPane?.classList.contains('mobile-hide')&&content?.classList.contains('mobile-show'),
      sftp:mobileSftpLayout
    };
    const mobileTabs=document.querySelector('.mobile-tabs');
    const mobileTabItems=[...mobileTabs.querySelectorAll('button, a')];
    const mobileTabLabels=[...mobileTabs.querySelectorAll('.mobile-tab-label')];
    const mobileTabIcons=mobileTabItems.map(item=>item.querySelector('svg'));
    const mobileTabRects=mobileTabItems.map(item=>item.getBoundingClientRect());
    layout.mobileTabs={
      count:mobileTabItems.length,
      labelsHidden:mobileTabLabels.every(label=>getComputedStyle(label).display==='none'),
      iconsCentered:mobileTabIcons.every((svg,index)=>{const icon=svg?.getBoundingClientRect();const rect=mobileTabRects[index];return Boolean(icon&&rect&&Math.abs((icon.left+icon.width/2)-(rect.left+rect.width/2))<0.5&&Math.abs((icon.top+icon.height/2)-(rect.top+rect.height/2))<0.5)}),
      fits:mobileTabs.scrollWidth<=mobileTabs.clientWidth+0.5&&mobileTabRects.every(rect=>rect.left>=-0.5&&rect.right<=innerWidth+0.5)
    };
    showPrimary('settings');
    await new Promise(resolve=>setTimeout(resolve,80));
    const settingsButtons=[...document.querySelectorAll('#explorerTools > button[data-explorer-section]')];
    const settingsLabels=settingsButtons.map(button=>button.querySelector('span')?.textContent.trim()||'');
    const settingsRects=settingsButtons.map(button=>button.getBoundingClientRect());
    const settingsVertical=settingsRects.every((rect,index)=>index===0||rect.top>=settingsRects[index-1].bottom-0.5)&&settingsRects.every(rect=>Math.abs(rect.left-settingsRects[0].left)<1&&Math.abs(rect.width-settingsRects[0].width)<1);
    const settingsExplorerFirst=!leftPane?.classList.contains('mobile-hide')&&!content?.classList.contains('mobile-show');
    document.querySelector('#explorerTools [data-explorer-section="settings-about"]')?.click();
    for (let i=0;i<80&&(activeView!=='settings'||!document.querySelector('#settings-about')||document.querySelector('#settings-about').hidden||!content?.classList.contains('mobile-show'));i+=1) await new Promise(resolve=>setTimeout(resolve,50));
    const visibleSettingsGroups=[...document.querySelectorAll('#view-settings .settings-group')].filter(group=>!group.hidden).map(group=>group.id);
    layout.settingsNavigation={
      labels:settingsLabels,
      vertical:settingsVertical,
      explorerFirst:settingsExplorerFirst,
      workspaceEntered:leftPane?.classList.contains('mobile-hide')&&content?.classList.contains('mobile-show'),
      selectedOnly:visibleSettingsGroups.length===1&&visibleSettingsGroups[0]==='settings-about',
      noDuplicateMenu:document.querySelectorAll('.settings-nav').length===0
    };
    const licenseTrigger=document.querySelector('#openLicenseBtn');
    licenseTrigger?.click();
    for (let i=0;i<20&&document.querySelector('#modal')?.hidden;i+=1) await new Promise(resolve=>setTimeout(resolve,25));
    const modal=document.querySelector('#modal');
    const card=modal?.querySelector('.license-modal');
    const text=modal?.querySelector('#licenseText');
    const close=document.querySelector('#licenseModalClose');
    const cardRect=card?.getBoundingClientRect();
    const textRect=text?.getBoundingClientRect();
    const closeRect=close?.getBoundingClientRect();
    layout.about={
      modalOpen:Boolean(modal&&!modal.hidden&&card),
      cardWithinViewport:Boolean(cardRect&&cardRect.left>=-0.5&&cardRect.right<=innerWidth+0.5&&cardRect.top>=-0.5&&cardRect.bottom<=innerHeight+0.5),
      textWithinCard:Boolean(cardRect&&textRect&&textRect.left>=cardRect.left-0.5&&textRect.right<=cardRect.right+0.5),
      textScrollable:Boolean(text&&text.scrollHeight>text.clientHeight&&getComputedStyle(text).overflowY==='auto'),
      closeVisible:Boolean(closeRect&&closeRect.width>0&&closeRect.height>0&&closeRect.top>=-0.5&&closeRect.bottom<=innerHeight+0.5)
    };
    close?.click();
    await new Promise(resolve=>setTimeout(resolve,25));
    layout.about.closed=Boolean(modal?.hidden&&!modal.querySelector('.license-modal'));
    showPrimary('connections');
    if(!document.querySelector('.conn-row'))document.querySelector('.group-head')?.click();
    const groupActionButton=document.querySelector('.connection-group-menu-button');
    const groupDragHandle=document.querySelector('.connection-group-drag-handle');
    const groupTitle=document.querySelector('.connection-group-head-row .group-head');
    const actionRect=groupActionButton?.getBoundingClientRect();
    const dragRect=groupDragHandle?.getBoundingClientRect();
    const titleRect=groupTitle?.getBoundingClientRect();
    layout.groupControlsInline=Boolean(actionRect&&dragRect&&titleRect&&Math.abs((actionRect.top+actionRect.height/2)-(dragRect.top+dragRect.height/2))<2&&Math.abs((actionRect.top+actionRect.height/2)-(titleRect.top+titleRect.height/2))<2);
    layout.groupDragFirst=Boolean(actionRect&&dragRect&&titleRect&&dragRect.left<titleRect.left&&titleRect.left<actionRect.left);
    const toastBeforeCancel=document.querySelector('#toast')?.textContent||'';
    groupDragHandle?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:77,pointerType:'touch',button:0,clientX:dragRect?.left||10,clientY:dragRect?.top||10}));
    await new Promise(resolve=>setTimeout(resolve,500));
    const draggingNode=document.querySelector('.group-dragging');
    renderConnections();
    await new Promise(resolve=>setTimeout(resolve,1800));
    layout.groupDragSurvivesRefresh=Boolean(draggingNode&&draggingNode.isConnected&&draggingNode.classList.contains('group-dragging'));
    document.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:77,pointerType:'touch'}));
    await new Promise(resolve=>setTimeout(resolve,30));
    layout.groupCancelDoesNotSave=!document.querySelector('.group-dragging')&&(document.querySelector('#toast')?.textContent||'')===toastBeforeCancel;
    const refreshedGroupActionButton=document.querySelector('.connection-group-menu-button');
    layout.groupActionVisible=Boolean(refreshedGroupActionButton&&getComputedStyle(refreshedGroupActionButton).opacity==='1'&&refreshedGroupActionButton.getBoundingClientRect().width>0);
    refreshedGroupActionButton?.click();
    layout.groupActionMenuOpened=Boolean(document.querySelector('#actionMenu')?.textContent.includes('重命名分组')&&document.querySelector('#actionMenuBackdrop'));
    document.querySelector('#actionMenuBackdrop')?.click();
    document.querySelector('.conn-actions .icon-button')?.click();
    layout.menuOpened=Boolean(document.querySelector('#actionMenu')&&document.querySelector('#actionMenuBackdrop'));
    document.querySelector('#actionMenuBackdrop')?.click();
    layout.menuClosed=!document.querySelector('#actionMenu')&&!document.querySelector('#actionMenuBackdrop');
    const terminalBackFixture=document.createElement('div');
    terminalBackFixture.className='terminal-title-row';
    terminalBackFixture.innerHTML='<button class="terminal-mobile-back" onpointerdown="keepTerminalKeyboardClosed(event)" onclick="backToExplorer()">'+icon('arrow-left')+'<span>返回</span></button>';
    document.body.appendChild(terminalBackFixture);
    document.querySelector('.left-pane')?.classList.add('mobile-hide');
    document.querySelector('#content')?.classList.add('mobile-show');
    document.body.classList.add('mobile-terminal-active');
    const terminalBackButton=terminalBackFixture.querySelector('.terminal-mobile-back');
    const terminalBackStyle=getComputedStyle(terminalBackButton);
    const terminalBackRect=terminalBackButton.getBoundingClientRect();
    const terminalBackVisible=terminalBackStyle.display!=='none'&&terminalBackRect.width>0&&terminalBackRect.height>0;
    terminalBackButton.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch'}));
    terminalBackButton.click();
    layout.terminalBack={
      visible:terminalBackVisible,
      display:terminalBackStyle.display,
      returned:!document.querySelector('.left-pane')?.classList.contains('mobile-hide')&&!document.querySelector('#content')?.classList.contains('mobile-show')&&!document.body.classList.contains('mobile-terminal-active')
    };
    terminalBackFixture.remove();
    return layout
  })()`);
  if (process.env.TUNNELDESK_UI_SCREENSHOT === "1") {
    const image = await window.webContents.capturePage();
    require("node:fs").writeFileSync(path.join(process.cwd(), "data", "ui-smoke-mobile.png"), image.toPNG());
  }
  console.log(JSON.stringify({ ...result, pages, navigationUi, aboutUi, desktopMenu, runningActions, authUi, saveAndClearUi, notificationUi, restoreKeyUi, restoreCredentialUi, terminalUi, sftpUi, clipboardUi, dark, mobile, errors }, null, 2));
  const overflow = pages.some(page => page.scrollWidth > page.width) || mobile.scrollWidth > mobile.width || mobile.bodyWidth > mobile.width;
  const darkFailed = dark.theme !== "dark" || dark.buttonBackground === "rgb(255, 255, 255)";
  const menuFailed = !desktopMenu.opened || !desktopMenu.closedOnScroll || !mobile.menuOpened || !mobile.menuClosed;
  const runningActionsFailed = runningActions.found && (Math.abs(runningActions.open.width - runningActions.retry.width) > 1 || Math.abs(runningActions.open.height - runningActions.retry.height) > 1);
  const authUiFailed = !authUi.found || !Object.values(authUi.passwordMode).every(Boolean) || !Object.values(authUi.keyMode).every(Boolean);
  const saveAndClearUiFailed = !Object.values(saveAndClearUi).every(Boolean);
  const notificationUiFailed = notificationUi.replayed !== 0 || !notificationUi.initialized || notificationUi.cursor !== notificationUi.stored;
  const restoreKeyUiFailed = !restoreKeyUi.opened || restoreKeyUi.rowCount !== 12 || JSON.stringify(restoreKeyUi.originalNames) !== JSON.stringify(['old-key-a','old-key-b']) || restoreKeyUi.candidates.length !== 3 || !restoreKeyUi.candidates.some(item=>item.includes('当前密钥目录')) || !restoreKeyUi.candidates.some(item=>item.includes('用户 ~/.ssh')) || !restoreKeyUi.candidateValuePreserved || !restoreKeyUi.stagesWindowsPath || !restoreKeyUi.continuedWithUnbound || !restoreKeyUi.continuedAllUnbound || !restoreKeyUi.configAllowsUnbound || !restoreKeyUi.configSortEditable || !restoreKeyUi.acceptsAll || !restoreKeyUi.uploadDirectory || !restoreKeyUi.actions || !restoreKeyUi.statusReady || !restoreKeyUi.cardWithinViewport || !restoreKeyUi.closed;
  const restoreCredentialUiFailed = !restoreCredentialUi.opened || !restoreCredentialUi.originalLabels.some(item=>item.includes('私钥：id_old')) || !restoreCredentialUi.originalLabels.some(item=>item.includes('备份含密码')) || !restoreCredentialUi.originalLabels.some(item=>item.includes('备份未包含密码')) || !restoreCredentialUi.initialStatuses.includes('保留备份密码') || !restoreCredentialUi.stagedStatuses.some(item=>item.includes('将绑定：id_key')) || !restoreCredentialUi.stagedStatuses.includes('将使用新密码') || !restoreCredentialUi.preservesSavedPassword || !restoreCredentialUi.replacesMissingPassword || !restoreCredentialUi.bindsKey || !restoreCredentialUi.sortFields || !restoreCredentialUi.updatesSort || !restoreCredentialUi.preservesSort || !restoreCredentialUi.cardWithinViewport || !restoreCredentialUi.closed;
  const settingsSectionsFailed = navigationUi.settingsChecks.some(item=>item.visible.length!==1||item.visible[0]!==item.requested||item.active.length!==1||item.active[0]!==item.requested) || navigationUi.aboutVisible?.length!==1 || navigationUi.aboutVisible?.[0]!=='settings-about' || navigationUi.aboutActive?.length!==1 || navigationUi.aboutActive?.[0]!=='settings-about';
  const importSectionsFailed = navigationUi.importChecks.some(item=>item.visible.length!==1||item.visible[0]!==item.requested||item.active.length!==1||item.active[0]!==item.requested);
  const importSourceCheck = navigationUi.importChecks.find(item => item.requested === 'import-source');
  const runtimeUi = navigationUi.runtimeUi || {};
  const runtimeUiFailed = !runtimeUi.found || runtimeUi.port !== '18100' || JSON.stringify(runtimeUi.selectedHosts) !== JSON.stringify(['0.0.0.0']) || !runtimeUi.recycleSettingChecked || !runtimeUi.wildcardCollapsed || runtimeUi.urlLinks.length !== 2 || !runtimeUi.urlLinks.some(url=>url.includes('192.0.2.10:18100')) || !runtimeUi.restartNotice;
  const activityUiFailed = result.activity.count !== 7 || !result.activity.iconCentered || !result.activity.centersAligned || !result.activity.insideColumn;
  const navigationUiFailed = !navigationUi.settingsOnlySections || !navigationUi.settingsSectionMode || !navigationUi.settingsVertical || settingsSectionsFailed || runtimeUiFailed || navigationUi.duplicateSettingsNav !== 0 || navigationUi.inlineUpdateDotPresent || !navigationUi.importOwnSections || !navigationUi.importSectionMode || !navigationUi.importVertical || !navigationUi.importResultsMerged || !importSourceCheck?.resultsVisible || importSectionsFailed || !navigationUi.treeHidden || navigationUi.dotsBeforeRead.some(dot=>!dot.found||dot.hidden!==false) || navigationUi.dotsAfterRead.some(dot=>!dot.found||dot.hidden!==true) || navigationUi.storedReadVersion !== '1.0.9' || !navigationUi.sameVersionStaysRead || !navigationUi.newerVersionShowsAgain;
  const aboutUiFailed = Boolean(aboutUi.error) || !aboutUi.found || !aboutUi.aboutSelected || aboutUi.duplicateSettingsNav !== 0 || !aboutUi.versionMatches || !aboutUi.licenseMetadata || !aboutUi.sourceLink || !aboutUi.modalOpen || !aboutUi.accessible || !aboutUi.fullText || !aboutUi.textScrollable || !aboutUi.cardWithinViewport || !aboutUi.closeFocused || !aboutUi.closedByEscape || !aboutUi.focusReturned || !aboutUi.followupBackdropClean || !aboutUi.followupResolved || !aboutUi.updateUi;
  const expectedSettingsActions = ['通用设置','安全设置','通知设置','启动与运行','关于'];
  const mobileNavigationFailed = !mobile.importExplorerFirst || !mobile.importWorkspaceEntered || !mobile.sftp?.found || !mobile.sftp?.fits || !mobile.sftp?.encodingVisible || !mobile.sftp?.terminalJumpVisible || !mobile.settingsNavigation?.explorerFirst || !mobile.settingsNavigation?.workspaceEntered || !mobile.settingsNavigation?.vertical || !mobile.settingsNavigation?.selectedOnly || !mobile.settingsNavigation?.noDuplicateMenu || JSON.stringify(mobile.settingsNavigation?.labels)!==JSON.stringify(expectedSettingsActions) || mobile.mobileTabs?.count !== 7 || !mobile.mobileTabs?.labelsHidden || !mobile.mobileTabs?.iconsCentered || !mobile.mobileTabs?.fits || !mobile.groupActionVisible || !mobile.groupActionMenuOpened || !mobile.groupControlsInline || !mobile.groupDragFirst || !mobile.groupCancelDoesNotSave || !mobile.groupDragSurvivesRefresh;
  const mobileAboutFailed = !mobile.about || !mobile.about.modalOpen || !mobile.about.cardWithinViewport || !mobile.about.textWithinCard || !mobile.about.textScrollable || !mobile.about.closeVisible || !mobile.about.closed;
  const terminalLabels = ['复制选中','复制全部输出','粘贴','全选终端','清屏','滚动到底部','减小字体','增大字体','重新连接'];
  const terminalUiFailed = !terminalUi.found || !terminalUi.desktopBackHidden || terminalUi.binaryType !== 'arraybuffer' || !terminalUi.binaryWrite || !terminalUi.encodingMenuOpened || !terminalUi.fontMenuOpened || !mobile.terminalBack?.visible || !mobile.terminalBack?.returned || !terminalLabels.every(label=>terminalUi.labels.includes(label)) || terminalUi.metrics.some(item=>Math.abs(item.iconWidth-16)>0.5||Math.abs(item.iconHeight-16)>0.5||item.centerDelta>0.5);
  const expectedDirectoryActions = ['收藏','新建目录','新建文件','上传','回收站'];
  const directoryActionsUi = sftpUi.directoryActionsUi || {};
  const jobUi = sftpUi.jobUi || {};
  const textEncodingUi = sftpUi.textEncodingUi || {};
  const jobUiFailed = !jobUi.found || !jobUi.mainHasRunning || !jobUi.mainHasFailed || !jobUi.mainHidesDone || !jobUi.historyEnabled || jobUi.historyCount !== '2' || !jobUi.historyHasDone || !jobUi.historyHidesCurrent || !jobUi.noManualRefresh || !jobUi.compactRow;
  const textEncodingUiFailed = !textEncodingUi.opened || textEncodingUi.selected !== 'gbk' || !textEncodingUi.persistDefault || !textEncodingUi.backup || !['utf8','utf8bom','gb18030','gbk','big5','shift_jis','euc-kr','latin1'].every(value=>textEncodingUi.options?.includes(value));
  const sftpUiFailed = Boolean(sftpUi.error) || jobUiFailed || textEncodingUiFailed || !directoryActionsUi.found || directoryActionsUi.stickyPosition !== 'sticky' || !directoryActionsUi.barInsideSticky || !directoryActionsUi.barAfterBreadcrumb || JSON.stringify(directoryActionsUi.actionLabels) !== JSON.stringify(expectedDirectoryActions) || !directoryActionsUi.emptyClipboardHidden || !directoryActionsUi.copyQueueVisible || !directoryActionsUi.copyCancelled || !directoryActionsUi.moveQueueVisible || !directoryActionsUi.moveCancelled || !directoryActionsUi.crossHostCopyEnabled || !directoryActionsUi.crossHostMoveDisabled || !directoryActionsUi.filenameEncodingMenu || !directoryActionsUi.terminalJump || !sftpUi.folderOpened || !sftpUi.fileOpened || !sftpUi.unknownAction || sftpUi.stickyPosition !== "sticky" || !sftpUi.breadcrumbScrollable || !sftpUi.singlePathPresentation || sftpUi.breadcrumbLabels?.join('/') !== '根目录/Users/junruo/Public' || sftpUi.breadcrumbText.includes('//') || !sftpUi.selectionShown || !sftpUi.selectionActionsShown || !sftpUi.specialSelectionExact || sftpUi.selectedRows !== 2 || !sftpUi.selectionCleared || !sftpUi.fileHasCompression || !sftpUi.fileHasPermissions || !sftpUi.permissionOwnerColumn || !sftpUi.permissionOwnerTitle || !sftpUi.wideColumnAlignment || !sftpUi.wideActionsFit || !sftpUi.compactSizeVisible || !sftpUi.compactTimeVisible || !sftpUi.compactAccessVisible || !sftpUi.compactMediumHidden || !sftpUi.compactCoreVisible || !sftpUi.compactNoOverflow || !sftpUi.permissionModeSync || !sftpUi.recursiveVisible || sftpUi.compactRowHeight > 48 || !sftpUi.moreMenuOpened || !sftpUi.contextMenuOpened || !sftpUi.narrowLayoutClass || !sftpUi.narrowCoreHidden || !sftpUi.narrowMoreVisible || !sftpUi.narrowMetaVisible || !sftpUi.narrowAccessHidden || !sftpUi.completedMutationDetected || sftpUi.pageRows !== 50 || !sftpUi.pagerVisible || !sftpUi.pagerText.includes('第 1/2 页') || !sftpUi.previousDisabled || !sftpUi.nextEnabled;
  const code = errors.length || overflow || darkFailed || menuFailed || runningActionsFailed || authUiFailed || saveAndClearUiFailed || notificationUiFailed || restoreKeyUiFailed || restoreCredentialUiFailed || activityUiFailed || navigationUiFailed || aboutUiFailed || mobileNavigationFailed || mobileAboutFailed || terminalUiFailed || sftpUiFailed || !clipboardUi.ok || mobile.contentVisible === "none" || !result.groups || !result.icons || !result.groupRenameMenu || !result.groupActionButton ? 1 : 0;
  window.destroy();
  process.exit(code);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
