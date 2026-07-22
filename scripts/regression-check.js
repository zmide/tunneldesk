const fs = require("node:fs");
const path = require("node:path");
const { expectedArtifacts, relevantArtifacts, verifyReleaseVersion } = require("./release-artifacts-check");

const root = path.resolve(__dirname, "..");
const checks = [];
const frontendFiles = [
  "public/app-api.js", "public/app-utils.js", "public/app-workspace.js", "public/app-settings.js",
  "public/app-running.js", "public/app-batch.js", "public/app-logs.js", "public/app-connections.js",
  "public/app-terminal.js", "public/app-forwards.js", "public/app-import.js", "public/app-sftp.js", "public/app.js"
];

function ok(name, pass, detail = "") {
  checks.push({ name, pass, detail });
  const mark = pass ? "OK" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` - ${detail}` : ""}`);
}

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

async function webUrl(packageJson, licenseText) {
  if (process.env.TUNNELDESK_CHECK_URL) return process.env.TUNNELDESK_CHECK_URL;
  let persisted = "";
  try {
    const info = JSON.parse(read("data/web.json"));
    persisted = info.local_url || info.urls?.[0] || "";
  } catch {
    try {
      persisted = read("data/web.url").trim();
    } catch {}
  }
  const candidates = [...new Set(["http://127.0.0.1:8099", persisted].filter(Boolean))];
  for (const candidate of candidates) {
    try {
      const response = await fetch(`${candidate.replace(/\/$/, "")}/api/about`);
      const about = response.ok ? await response.json() : null;
      if (about?.version === packageJson.version && about?.license_text === licenseText) return candidate;
    } catch {}
  }
  return persisted || "http://127.0.0.1:8099";
}

async function checkFetch(url, name) {
  try {
    const res = await fetch(url);
    ok(name, res.ok, `${res.status} ${res.statusText}`);
    return res.ok ? await res.json().catch(() => null) : null;
  } catch (error) {
    ok(name, false, error.message);
    return null;
  }
}

async function main() {
  const packageJson = JSON.parse(read("package.json"));
  const licenseText = read("LICENSE");
  ok("GNU GPL v3 license is declared and packaged", packageJson.license === "GPL-3.0-only" && licenseText.includes("GNU GENERAL PUBLIC LICENSE") && packageJson.build?.extraResources?.includes("LICENSE"));
  ok("Electron unpacks node-pty", Array.isArray(packageJson.build?.asarUnpack) && packageJson.build.asarUnpack.includes("node_modules/node-pty/**/*"));
  ok("Electron afterPack hook exists", typeof packageJson.build?.afterPack === "string" && fs.existsSync(path.join(root, packageJson.build.afterPack)));
  ok("macOS package verifies PTY helper", read(".github/workflows/release.yml").includes("Verify packaged PTY helper") && read("scripts/after-pack.js").includes("chmodSync(helper, 0o755)"));
  const macIcon = packageJson.build?.mac?.icon;
  const macIconPath = typeof macIcon === "string" ? path.join(root, macIcon) : "";
  const macIconHeader = macIconPath && fs.existsSync(macIconPath) ? fs.readFileSync(macIconPath).subarray(0, 4).toString("ascii") : "";
  ok("macOS package uses TunnelDesk ICNS", macIcon === "desktop/assets/icon.icns" && macIconHeader === "icns");
  const releaseWorkflow = read(".github/workflows/release.yml");
  ok("macOS afterPack verifies application icon", read("scripts/after-pack.js").includes("verifyMacIcon(context)") && read("scripts/after-pack.js").includes("CFBundleIconFile"));
  ok("macOS package verifies application icon", releaseWorkflow.includes("Verify packaged macOS icon") && releaseWorkflow.includes("CFBundleIconFile") && releaseWorkflow.includes('test "$icon_file" = "icon.icns"') && releaseWorkflow.includes("icon_512x512@2x.png"));
  ok(
    "桌面发布文件名包含系统、架构和安装类型",
    packageJson.build?.nsis?.artifactName === "${productName}-${version}-windows-${arch}-installer.${ext}"
      && packageJson.build?.portable?.artifactName === "${productName}-${version}-windows-${arch}-portable.${ext}"
      && packageJson.build?.linux?.artifactName === "${productName}-${version}-linux-${arch}.${ext}"
      && packageJson.build?.mac?.artifactName === "${productName}-${version}-macos-${arch}.${ext}"
  );
  const expectedReleaseArtifacts = {
    windows: ["TunnelDesk-1.2.3-windows-x64-installer.exe", "TunnelDesk-1.2.3-windows-x64-portable.exe"],
    linux: ["TunnelDesk-1.2.3-linux-x86_64.AppImage", "TunnelDesk-1.2.3-linux-amd64.deb", "TunnelDesk-1.2.3-linux-x86_64.rpm"],
    macos: ["TunnelDesk-1.2.3-macos-x64.dmg", "TunnelDesk-1.2.3-macos-x64.zip", "TunnelDesk-1.2.3-macos-arm64.dmg", "TunnelDesk-1.2.3-macos-arm64.zip"],
    "linux-source": ["TunnelDesk-1.2.3-linux-source-noarch.tar.gz"]
  };
  let mismatchedReleaseTagRejected = false;
  try {
    verifyReleaseVersion(`v${packageJson.version}-mismatch`, "tag");
  } catch {
    mismatchedReleaseTagRejected = true;
  }
  ok(
    "发布校验覆盖所有平台和真实架构",
    Object.entries(expectedReleaseArtifacts).every(([platform, expected]) => JSON.stringify(expectedArtifacts(platform, "1.2.3")) === JSON.stringify(expected))
      && relevantArtifacts("macos", ["unexpected.blockmap"]).includes("unexpected.blockmap")
      && verifyReleaseVersion(`v${packageJson.version}`, "branch").checked === false
      && verifyReleaseVersion(`v${packageJson.version}`, "tag").checked === true
      && mismatchedReleaseTagRejected
  );
  ok(
    "GitHub Actions 在上传前校验产物名称",
    ["windows", "linux", "macos", "linux-source"].every((platform) => releaseWorkflow.includes(`release-artifacts-check.js ${platform}`))
      && releaseWorkflow.includes("TunnelDesk-windows-x64")
      && releaseWorkflow.includes("TunnelDesk-linux-x64")
      && releaseWorkflow.includes("TunnelDesk-macos-x64-arm64")
      && releaseWorkflow.includes("TunnelDesk-linux-source-noarch")
  );
  const sftpBackend = read("src/sftp.ts");
  const sftpFrontend = read("public/app-sftp.js");
  const sftpCss = read("public/app.css");
  ok("SFTP 目录枚举不依赖 GNU find 参数", !sftpBackend.includes("-maxdepth") && !sftpBackend.includes("-mindepth") && !sftpBackend.includes("-printf"));
  ok("SFTP 目录枚举兼容 GNU 与 BSD stat", sftpBackend.includes('stat -c "%s %Y %a %U %G"') && sftpBackend.includes('stat -f "%z %m %Lp %Su %Sg"') && sftpBackend.includes("find . ! -name .") && sftpBackend.includes("-prune -exec"));
  ok("SFTP 普通目录列表隐藏专用回收站", sftpBackend.includes('! -name ${shellQuote(SFTP_RECYCLE_DIRECTORY)} -prune'));
  ok("SFTP 单次 stat 读取大小、时间和权限元数据", sftpBackend.includes('meta=$(stat -c "%s %Y %a %U %G"') && sftpBackend.includes('meta=$(stat -f "%z %m %Lp %Su %Sg"') && !sftpBackend.includes('size=$(stat'));
  ok("SFTP 支持单项/多项压缩和权限设置", sftpBackend.includes("normalizeRemotePermissionRequest") && sftpBackend.includes("buildRemotePermissionCommand") && read("src/sftp-jobs.ts").includes("normalizeCompressionRequest") && sftpFrontend.includes("compressSftpSelection") && sftpFrontend.includes("openSftpPermissionsForSelection"));
  ok("SFTP 大目录使用服务端分页与快照", sftpBackend.includes("paginateRemoteEntries") && sftpBackend.includes("DIRECTORY_CACHE_TTL_MS") && sftpFrontend.includes("loadSftpPage") && sftpFrontend.includes("sftp-pager"));
  ok("SFTP 双击目录进入、文件打开编辑", sftpFrontend.includes("activateSftpEntry") && sftpFrontend.includes('ondblclick="activateSftpEntry'));
  ok("SFTP 任意扩展名显示文本打开", !sftpFrontend.includes("isTextPreviewName") && sftpFrontend.includes("以文本打开"));
  ok("SFTP 面包屑跟随滚动", sftpCss.includes(".sftp-top { position:sticky") && sftpCss.includes(".sftp-breadcrumb { display:flex") && sftpCss.includes("overflow-x:auto"));
  ok("SFTP 固定目录操作栏支持新建文件和条件粘贴", sftpFrontend.includes('class="sftp-directory-bar"') && sftpFrontend.includes("createSftpFile") && sftpFrontend.includes("renderSftpClipboardActions") && sftpFrontend.includes("cancelSftpClipboard"));
  ok("SFTP 列表展示权限/所有者并支持无感后台同步", sftpFrontend.includes("权限 / 所有者") && sftpFrontend.includes("captureSftpViewState") && sftpFrontend.includes("restoreSftpViewState") && sftpFrontend.includes("completedSftpMutationForCurrentView") && sftpFrontend.includes("sftpPendingDirectoryRefreshes") && sftpFrontend.includes('list.classList.toggle("is-refreshing", keepContents)'));
  ok("SFTP 任务仅展示进行中与失败并提供历史记录", sftpFrontend.includes('["running", "pending", "paused", "failed"].includes(job.status)') && sftpFrontend.includes('["done", "cancelled"].includes(job.status)') && sftpFrontend.includes("showSftpJobHistory") && !sftpFrontend.includes("刷新目录</button>"));
  ok("SFTP 回收站默认关闭且支持恢复和永久删除", sftpBackend.includes('SFTP_RECYCLE_DIRECTORY = ".tunneldesk-recycle-bin"') && sftpBackend.includes("buildRestoreRemoteRecycleCommand") && sftpBackend.includes("buildDeleteRemoteRecycleCommand") && sftpFrontend.includes("openSftpRecycleBin") && read("src/runtime-settings.ts").includes("sftp_recycle_bin_enabled"));
  ok("SFTP 权限命令兼容 Linux 与 macOS", sftpBackend.includes("permissionPathOperand") && sftpBackend.includes("chgrp") && !sftpBackend.includes("chown ${recursiveFlag}${shellQuote(`${normalized.owner}:${normalized.group}`)} --") && !sftpBackend.includes("chmod ${recursiveFlag}${normalized.mode} --"));
  ok("终端返回按钮仅在移动布局显示", sftpCss.includes(".terminal-title-row > .terminal-mobile-back { display:none") && sftpCss.includes(".terminal-title-row > .terminal-mobile-back { display:inline-flex"));
  ok("SFTP 文本读取保护并支持原字节备份", sftpBackend.includes("new TextDecoder") && sftpBackend.includes("[ ! -f") && sftpBackend.includes("backup_path"));
  ok("密码 SSH 使用内置跨平台依赖", Boolean(packageJson.dependencies?.ssh2));
  const startBat = read("start.bat");
  const detachedStarter = read("scripts/start-detached.js");
  ok("Windows 后台启动不保留控制台并透传桌面监听参数", startBat.includes("start-detached.js desktop %SERVER_ARGS%") && startBat.includes("start-detached.js web") && detachedStarter.includes("[root, ...process.argv.slice(3)]") && read("desktop/main.js").includes("...parseServerArgs()") && detachedStarter.includes("windowsHide: true") && detachedStarter.includes("child.unref()") && !startBat.includes("cmd /c npm run desktop:run") && !startBat.includes("timeout /t"));
  ok("Linux/macOS 桌面启动透传监听参数", read("start.sh").includes('npm run desktop:run -- "$@"'));
  ok("关闭流程停止健康监控并退出桌面主进程", read("src/server.ts").includes("await stopForwardHealthMonitor()") && read("src/ssh.ts").includes("async function stopForwardHealthMonitor()") && read("desktop/main.js").includes("onShutdown: () =>"));
  ok("dist/server.js 存在", fs.existsSync(path.join(root, "dist/server.js")));
  const missingFrontend = frontendFiles.filter(file => !fs.existsSync(path.join(root, file)));
  ok("前端模块文件完整", missingFrontend.length === 0, missingFrontend.join(", "));
  const indexHtml = read("public/index.html");
  let cursor = -1;
  const ordered = frontendFiles.every(file => {
    const next = indexHtml.indexOf(`/${path.basename(file)}`, cursor + 1);
    if (next < 0) return false;
    cursor = next;
    return true;
  });
  ok("public/index.html 按顺序加载前端模块", ordered);
  const assetVersions = [...indexHtml.matchAll(/[?&]v=([0-9]+\.[0-9]+\.[0-9]+)/g)].map(match => match[1]);
  ok("静态资源缓存版本与程序版本一致", assetVersions.length > 0 && assetVersions.every(version => version === packageJson.version), [...new Set(assetVersions)].join(", "));
  ok("Lucide 在业务脚本前加载", indexHtml.indexOf("/vendor/lucide/lucide.min.js") >= 0 && indexHtml.indexOf("/vendor/lucide/lucide.min.js") < indexHtml.indexOf("/app-api.js"));

  const frontend = frontendFiles.map(read).join("\n");
  const settingsFrontend = read("public/app-settings.js");
  const importFrontend = read("public/app-import.js");
  const workspaceFrontend = read("public/app-workspace.js");
  const appCss = read("public/app.css");
  const serverSource = read("src/server.ts");
  const desktopSource = read("desktop/main.js");
  const appMenuSource = desktopSource.slice(desktopSource.indexOf("function buildAppMenu"), desktopSource.indexOf("function createTray"));
  const trayMenuSource = desktopSource.slice(desktopSource.indexOf("function refreshTrayMenu"), desktopSource.indexOf("function showError"));
  ok("无原生 alert/confirm/prompt", !/\b(alert|confirm|prompt)\s*\(/.test(frontend));
  ok("图标刷新不监听全部 DOM 变化", !frontend.includes("new MutationObserver(refreshIcons)"));
  ok("动态图标直接输出 SVG", frontend.includes('return `<svg class="lucide'));
  ok("转发入口包含局域网监听提示", frontend.includes("0.0.0.0") && frontend.includes("仅本机可访问"));
  ok("工作区标签菜单包含四种关闭方式", ["关闭当前标签", "关闭其他标签", "关闭右侧标签", "关闭所有标签"].every(text => frontend.includes(text)));
  ok("SSH 表单支持密钥和密码登录", indexHtml.includes("私钥登录") && indexHtml.includes("密码登录") && frontend.includes("toggleAuthFields"));
  ok("SSH 登录方式隔离认证字段", frontend.includes('identity_file:passwordAuth ? ""') && frontend.includes('ssh_password:passwordAuth ?') && frontend.includes('control.disabled = password') && frontend.includes('control.disabled = !password'));
  ok("通知首次加载只建立游标", frontend.includes("initializeNotificationCursor") && frontend.includes('api("/api/notifications?since=0")') && frontend.includes("notificationCursorInitialized = true"));
  ok("SFTP 读取响应不缓存敏感内容", read("src/server.ts").includes('"Cache-Control": "no-store"'));
  ok("SFTP 删除由服务端设置决定是否进入回收站", serverSource.includes("const recycleEnabled = readRuntimeSettings(RUNTIME_SETTINGS_FILE).sftp_recycle_bin_enabled") && serverSource.includes("await recycleRemotePath(connectionId, data.path)") && serverSource.includes('parts[4] === "trash" && parts[5] === "restore"'));
  ok("关于页与开源许可弹窗已接入", settingsFrontend.includes('id="settings-about"') && settingsFrontend.includes("查看开源许可正文") && settingsFrontend.includes("showLicenseModal") && serverSource.includes('pathname === "/api/about"'));
  ok("设置页支持 GitHub Releases 更新检查", settingsFrontend.includes("refreshUpdateStatus") && settingsFrontend.includes("查看 Release") && serverSource.includes('pathname === "/api/updates/check"'));
  ok("设置与导入导出使用独立操作区", workspaceFrontend.includes('primaryView === "settings"') && workspaceFrontend.includes('primaryView === "import"') && workspaceFrontend.includes("data-explorer-section") && importFrontend.includes("scrollToImportSection"));
  const importSourceAt = indexHtml.indexOf('id="import-source"');
  const importResultsAt = indexHtml.indexOf('id="import-results"');
  const importExportAt = indexHtml.indexOf('id="import-export"');
  ok("导入结果并入导入配置", importSourceAt >= 0 && importResultsAt > importSourceAt && importResultsAt < importExportAt && !importFrontend.includes('"import-results"') && !workspaceFrontend.includes('"import-results"'));
  ok("SSH config 与数据库使用连接级私钥绑定器", importFrontend.includes("showIdentityBindingModal") && importFrontend.includes("测试选中连接") && importFrontend.includes("暂存绑定") && importFrontend.includes("选择原同名") && serverSource.includes("normalizeIdentityBindings"));
  ok("数据库导出明确选择是否包含 SSH 密码", importFrontend.includes("不包含密码（推荐）") && importFrontend.includes("包含密码") && serverSource.includes('include_passwords') && read("src/db.ts").includes("UPDATE connections SET ssh_password=NULL"));
  ok("数据库恢复始终列出全部连接及原验证方式", importFrontend.includes("showDatabaseCredentialModal") && importFrontend.includes("原验证方式") && importFrontend.includes("设置所填密码") && serverSource.includes("connections: rows.map") && serverSource.includes("credential_bindings"));
  const importerSource = read("src/importer.ts");
  ok("同名私钥不会绕过连接级绑定", importerSource.includes("identity_file: null") && importerSource.includes("missing_identity: Boolean(keyName)") && !importerSource.includes("identityFileMap") && serverSource.includes("const target = requested ?") && !serverSource.includes("existingByName.get(keyName)"));
  ok("私钥绑定只接受已枚举路径", serverSource.includes("allowedPaths.has(path.resolve(requested))") && serverSource.includes("私钥绑定无效，请重新选择"));
  ok("SSH config 与数据库恢复允许保留未绑定私钥", !importFrontend.includes("个连接尚未绑定私钥") && importFrontend.includes("未重新绑定的普通私钥路径会被清除") && serverSource.includes("updateIdentity.run(null, item.connection_id)") && !serverSource.includes("数据库备份中的连接尚未全部绑定私钥"));
  ok("数据库恢复后重新打开句柄并自动刷新", serverSource.includes("reopenDatabase()") && serverSource.includes("database_reopened: true") && importFrontend.includes("数据库已恢复并自动刷新") && importFrontend.includes("await loadAll()"));
  ok("数据库迁移包同步启用或关闭加密状态", serverSource.includes("if (payload.security) {") && serverSource.includes("encryption_enabled: Boolean(payload.security.encryption_enabled)"));
  ok("导入导出按 SSH config 与数据库拆分", workspaceFrontend.includes("SSH config 导入导出") && workspaceFrontend.includes("数据库导入导出") && indexHtml.indexOf("导出 SSH config") < indexHtml.indexOf("数据库导入导出"));
  ok("设置活动栏按通用与安全职责重组", workspaceFrontend.includes('"settings-general", "settings-2", "通用设置"') && workspaceFrontend.includes('"settings-basic", "shield-check", "安全设置"') && !workspaceFrontend.includes('"settings-advanced"') && settingsFrontend.indexOf("storageSettingsPanelHtml()") < settingsFrontend.indexOf('id="settings-basic"'));
  ok("桌面设置并入程序且菜单去重", settingsFrontend.includes("desktopBehaviorPanelHtml") && settingsFrontend.includes("storageSettingsPanelHtml") && serverSource.includes('pathname === "/api/desktop-settings"') && desktopSource.includes("desktopIntegration") && !appMenuSource.includes('{ label: "设置"') && !trayMenuSource.includes('{ label: "设置"') && !trayMenuSource.includes("备份配置数据库"));
  ok("Web 数据路径支持跨根目录浏览、安全远程管理与自动重启", settingsFrontend.includes("openStorageDirectoryBrowser") && settingsFrontend.includes("data-storage-root") && serverSource.includes('pathname === "/api/storage/directories"') && serverSource.includes("storageManagementAvailable") && serverSource.includes("!authRequired(req)") && serverSource.includes("restart-web.js") && fs.existsSync(path.join(root, "scripts/restart-web.js")) && read("src/config.ts").includes(".tunneldesk-storage.json"));
  ok("活动栏按钮整栏居中且选中线独立", appCss.includes('.activity button, .activity a { position:relative; width:100%') && appCss.includes('.activity button.active::before') && !appCss.includes('width:46px; min-height:44px;'));
  ok("新版本红点使用会话已读状态", settingsFrontend.includes("tunneldeskUpdateReadVersion") && settingsFrontend.includes("sessionStorage") && settingsFrontend.includes("markUpdateNoticeRead") && indexHtml.includes("navSettingsUpdateDot") && serverSource.includes('pathname === "/api/updates/status"'));

  const base = (await webUrl(packageJson, licenseText)).replace(/\/$/, "");
  const restoreFixturePath = path.join(root, "data", `.restore-regression-${process.pid}.db`);
  let restoreFixtureDb = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const missingKeyName = `missing-regression-${process.pid}-${Date.now()}`;
    restoreFixtureDb = new DatabaseSync(restoreFixturePath);
    restoreFixtureDb.exec("CREATE TABLE connections (id INTEGER PRIMARY KEY, name TEXT, identity_file TEXT)");
    const insert = restoreFixtureDb.prepare("INSERT INTO connections(id,name,identity_file) VALUES(?,?,?)");
    for (let index = 1; index <= 12; index += 1) insert.run(index, `fixture-${index}`, `C:\\old\\.ssh\\${missingKeyName}`);
    restoreFixtureDb.close();
    restoreFixtureDb = null;
    const response = await fetch(`${base}/api/restore/database/check`, {method:"POST", body:fs.readFileSync(restoreFixturePath)});
    const restoreCheck = await response.json().catch(() => null);
    ok("数据库恢复检查返回分组、逐连接引用和原验证方式", response.ok && restoreCheck?.missing_identities?.length === 1 && restoreCheck.missing_identities[0].key_name === missingKeyName && restoreCheck.missing_identities[0].connection_count === 12 && restoreCheck.missing_identities[0].connection_names?.length === 12 && restoreCheck.unresolved_identities?.length === 12 && restoreCheck.connections?.length === 12 && restoreCheck.connections.every(item => item.original_auth_type === "key") && typeof restoreCheck.upload_directory === "string");
  } catch (error) {
    ok("数据库恢复检查返回分组、逐连接引用和原验证方式", false, error.message);
  } finally {
    try { restoreFixtureDb?.close(); } catch {}
    try { fs.unlinkSync(restoreFixturePath); } catch {}
  }
  const about = await checkFetch(`${base}/api/about`, "Web API /api/about");
  ok(
    "关于接口版本与许可元数据一致",
    about?.product_name === "TunnelDesk"
      && about?.version === packageJson.version
      && about?.license === packageJson.license
      && about?.repository_url === packageJson.homepage,
    about ? `${about.product_name || "?"} v${about.version || "?"} · ${about.license || "?"}` : "无响应"
  );
  ok("关于接口不返回作者邮箱", typeof about?.author === "string" && !about.author.includes("<") && !about.author.includes(">"));
  ok(
    "关于接口返回完整 GPL v3 正文",
    typeof about?.license_text === "string"
      && about.license_text === licenseText
      && about.license_text.includes("GNU GENERAL PUBLIC LICENSE")
      && about.license_text.includes("END OF TERMS AND CONDITIONS"),
    typeof about?.license_text === "string" ? `${about.license_text.length} 字符` : "无正文"
  );
  const updateStatus = await checkFetch(`${base}/api/updates/status`, "Web API /api/updates/status");
  ok("更新状态接口不联网即可返回当前版本", updateStatus?.current_version === packageJson.version && typeof updateStatus?.update_available === "boolean");
  const connections = await checkFetch(`${base}/api/connections`, "Web API /api/connections");
  if (Array.isArray(connections)) {
    ok("连接列表响应为数组", true, `${connections.length} 条连接`);
    ok("连接 API 不返回 SSH 密码", connections.every(item => !("ssh_password" in item)));
  }
  else ok("连接列表响应为数组", false);

  const keys = await checkFetch(`${base}/api/identity-files`, "Web API /api/identity-files");
  ok("密钥列表包含来源信息", Array.isArray(keys) && keys.every(item => item.source && item.source_label));

  const diagnostics = await checkFetch(`${base}/api/diagnostics/runtime`, "Web API /api/diagnostics/runtime");
  if (diagnostics?.pty?.available && diagnostics.platform === "darwin") {
    ok("PTY diagnostics include spawn-helper", Boolean(diagnostics.pty.helper_exists), diagnostics.pty.helper_path || "not found");
  }
  ok("运行诊断包含日志目录", Boolean(diagnostics?.log_dir), diagnostics?.log_dir || "");
  ok("运行诊断包含 PTY 状态", typeof diagnostics?.pty?.available === "boolean");
  ok("运行诊断包含 PTY 可运行状态", typeof diagnostics?.pty?.operational === "boolean");

  const startup = await checkFetch(`${base}/api/startup-status`, "Web API /api/startup-status");
  ok("启动状态包含实际 Web 地址", Boolean(startup?.local_url), startup?.local_url || "");
  ok("启动状态包含自动转发汇总", startup?.autostart && typeof startup.autostart.failed === "number");

  const snapshots = await checkFetch(`${base}/api/config-snapshots`, "Web API /api/config-snapshots");
  ok("配置快照列表响应为数组", Array.isArray(snapshots), Array.isArray(snapshots) ? `${snapshots.length} 个快照` : "");
  ok("批量命令提供 TXT/JSON 导出", frontend.includes("导出 TXT") && frontend.includes("导出 JSON"));
  ok("SSH 连接支持批量选择、设置与删除", frontend.includes("toggleConnectionBulkMode") && frontend.includes("openConnectionBulkSettings") && frontend.includes("/api/connections/bulk-update") && frontend.includes("performBulkDeleteConnections"));
  ok("新增 SSH 连接支持保存并清空", indexHtml.includes('id="connSaveAndClear"') && indexHtml.includes("保存并清空") && indexHtml.includes("saveConnectionForm(true,this)") && frontend.includes("表单已清空") && frontend.includes('$("connSaveAndClear").hidden = true'));
  ok("SSH 批量设置仅允许分组、端口和登录凭据", read("src/db.ts").includes("function bulkUpdateConnections") && read("src/db.ts").includes('changes, "group_name"') && read("src/db.ts").includes('changes, "ssh_port"') && read("src/server.ts").includes("所选私钥不在允许的密钥目录中"));
  ok("转发列表全选同步全选与半选状态", frontend.includes('id="forwardSelectAll"') && frontend.includes("selectAll.indeterminate") && frontend.includes("全选转发"));

  const failed = checks.filter(item => !item.pass);
  if (failed.length) {
    console.error(`回归检查失败：${failed.length} 项`);
    process.exit(1);
  }
  console.log(`回归检查通过：${checks.length} 项`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
