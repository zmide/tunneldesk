const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  __cacheDirectorySnapshot,
  __cachedDirectorySnapshot,
  buildClearRemoteRecycleCommand,
  buildDeleteRemoteRecycleCommand,
  buildListRemoteRecycleCommand,
  buildRecycleRemotePathCommand,
  buildRestoreRemoteRecycleCommand,
  buildRemoteCreateFileCommand,
  buildRemotePermissionCommand,
  invalidateRemoteDirectoryCache,
  normalizeRemotePermissionRequest,
  normalizeRemoteDirectoryListOptions,
  parseRemoteRecycleItems,
  paginateRemoteEntries
} = require("../dist/sftp");
const { normalizeCompressionRequest } = require("../dist/sftp-jobs");

function names(result) {
  return result.entries.map((entry) => entry.name);
}

const fixtures = [
  { name: "z-folder", type: "dir", size: 0, mtime: 30 },
  { name: "a-folder", type: "dir", size: 0, mtime: 20 },
  { name: "file-10.txt", type: "file", size: 10, mtime: 10 },
  { name: "file-2.txt", type: "file", size: 10, mtime: 20 },
  { name: "other.log", type: "file", size: 5, mtime: 30 }
];

const defaults = normalizeRemoteDirectoryListOptions();
assert.deepEqual(defaults, { page:1, page_size:50, query:"", sort:"name", dir:"asc", refresh:false });
assert.equal(normalizeRemoteDirectoryListOptions({page_size:999}).page_size, 200);
assert.equal(normalizeRemoteDirectoryListOptions({refresh:"1"}).refresh, true);
assert.throws(() => normalizeRemoteDirectoryListOptions({page:0}), /页码必须是正整数/);
assert.throws(() => normalizeRemoteDirectoryListOptions({sort:"owner"}), /目录排序字段无效/);
assert.throws(() => normalizeRemoteDirectoryListOptions({dir:"sideways"}), /目录排序方向无效/);

const byName = paginateRemoteEntries(fixtures, {page:1, page_size:25, sort:"name", dir:"asc"});
assert.deepEqual(names(byName), ["a-folder", "z-folder", "file-2.txt", "file-10.txt", "other.log"]);
assert.equal(byName.total, 5);
assert.equal(byName.unfiltered_total, 5);
assert.equal(byName.total_pages, 1);

const bySizeDescending = paginateRemoteEntries(fixtures, {page:1, page_size:25, sort:"size", dir:"desc"});
assert.deepEqual(names(bySizeDescending).slice(0, 2), ["z-folder", "a-folder"], "目录在降序时也必须位于文件之前");
assert.deepEqual(names(bySizeDescending).slice(2), ["file-10.txt", "file-2.txt", "other.log"]);

const filtered = paginateRemoteEntries(fixtures, {page:1, page_size:25, query:"FILE", sort:"name", dir:"asc"});
assert.deepEqual(names(filtered), ["file-2.txt", "file-10.txt"]);
assert.equal(filtered.total, 2);
assert.equal(filtered.unfiltered_total, 5);

const many = Array.from({length: 215}, (_, index) => ({
  name: `item-${String(index + 1).padStart(3, "0")}`,
  type: "file",
  size: index,
  mtime: index
}));
const secondPage = paginateRemoteEntries(many, {page:2, page_size:50, sort:"mtime", dir:"asc"});
assert.equal(secondPage.entries.length, 50);
assert.equal(secondPage.entries[0].name, "item-051");
assert.equal(secondPage.page, 2);
assert.equal(secondPage.total_pages, 5);

const clampedPage = paginateRemoteEntries(many, {page:99, page_size:50, sort:"mtime", dir:"asc"});
assert.equal(clampedPage.page, 5);
assert.equal(clampedPage.entries.length, 15);
assert.equal(clampedPage.entries[0].name, "item-201");

const empty = paginateRemoteEntries([], {page:8, page_size:25});
assert.deepEqual(empty, {entries:[], page:1, page_size:25, total:0, total_pages:1, unfiltered_total:0});

const cacheExpiry = Date.now() + 60 * 1000;
__cacheDirectorySnapshot(9001, ".", {path:"/home/test", entries:fixtures, expires_at:cacheExpiry});
assert.equal(__cachedDirectorySnapshot(9001, ".")?.path, "/home/test", "请求路径应命中规范路径快照");
assert.equal(__cachedDirectorySnapshot(9001, "/home/test")?.entries.length, fixtures.length, "规范路径应命中同一快照");
__cacheDirectorySnapshot(9002, ".", {path:"/home/other", entries:[], expires_at:cacheExpiry});
invalidateRemoteDirectoryCache(9001);
assert.equal(__cachedDirectorySnapshot(9001, "."), null, "连接级失效应清除请求路径别名");
assert.equal(__cachedDirectorySnapshot(9001, "/home/test"), null, "连接级失效应清除规范路径快照");
assert.equal(__cachedDirectorySnapshot(9002, ".")?.path, "/home/other", "连接级失效不能影响其他连接");
invalidateRemoteDirectoryCache(9002);

__cacheDirectorySnapshot(9003, ".", {path:"/expired", entries:fixtures, expires_at:Date.now() - 1});
assert.equal(__cachedDirectorySnapshot(9003, "."), null, "过期快照不能继续返回");

const frontendContext = {};
vm.createContext(frontendContext);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/app-sftp.js"), "utf8"), frontendContext);
assert.equal(frontendContext.joinRemotePath("/", "Users"), "/Users");
assert.equal(frontendContext.joinRemotePath("/Users", "junruo"), "/Users/junruo");
assert.equal(frontendContext.parentRemotePath("/"), "/");
assert.equal(frontendContext.parentRemotePath("/Users"), "/");
assert.equal(frontendContext.parentRemotePath("relative"), ".");

const permission = normalizeRemotePermissionRequest(["/srv/a b", "/srv/a b"], "640", true, "www", "www");
assert.deepEqual(permission, {paths:["/srv/a b"], mode:"640", recursive:true, owner:"www", group:"www"});
const permissionCommand = buildRemotePermissionCommand({paths:["/srv/a b", "/srv/o'k"], mode:"640", recursive:true, owner:"www", group:"www"});
assert.match(permissionCommand, /chown -R 'www:www' '\/srv\/a b' '\/srv\/o'\\''k'/);
assert.match(permissionCommand, /chmod -R 640 '\/srv\/a b' '\/srv\/o'\\''k'/);
assert.doesNotMatch(permissionCommand, /(?:^|\s)--(?:\s|$)/, "macOS/BSD chmod 和 chown 不支持 GNU 的 -- 参数");

const dashedRelativePermission = buildRemotePermissionCommand({paths:["-danger", "folder/file.txt"], mode:"600", recursive:false});
assert.match(dashedRelativePermission, /'\.\/-danger'/, "破折号开头的相对路径必须加上 .\/，避免被识别为命令参数");
assert.match(dashedRelativePermission, /chmod 600 '\.\/-danger' '\.\/folder\/file\.txt'/);
assert.doesNotMatch(dashedRelativePermission, /(?:^|\s)--(?:\s|$)/);

const ownerOnlyPermission = buildRemotePermissionCommand({paths:["/srv/app"], mode:"750", recursive:false, owner:"deploy"});
assert.match(ownerOnlyPermission, /chown 'deploy' '\/srv\/app'/);
assert.doesNotMatch(ownerOnlyPermission, /chgrp/);
assert.match(ownerOnlyPermission, /chmod 750 '\/srv\/app'/);

const groupOnlyPermission = buildRemotePermissionCommand({paths:["/srv/shared"], mode:"770", recursive:true, group:"staff"});
assert.match(groupOnlyPermission, /chgrp -R 'staff' '\/srv\/shared'/);
assert.doesNotMatch(groupOnlyPermission, /chown/);
assert.match(groupOnlyPermission, /chmod -R 770 '\/srv\/shared'/);
assert.doesNotMatch(groupOnlyPermission, /(?:^|\s)--(?:\s|$)/);
assert.throws(() => normalizeRemotePermissionRequest(["/"], "755", true), /不能对根目录/);
assert.throws(() => normalizeRemotePermissionRequest(["folder/.."], "755", true), /不能对根目录或当前目录/);
assert.throws(() => normalizeRemotePermissionRequest(["/srv/a"], "0755"), /三位八进制/);
assert.throws(() => normalizeRemotePermissionRequest(["/srv/a"], "755", false, "www;id"), /所有者格式无效/);

const createFile = buildRemoteCreateFileCommand("  folder\\nested/./new file.txt  ");
assert.equal(createFile.path, "folder/nested/new file.txt");
assert.match(createFile.command, /^if \[ -e 'folder\/nested\/new file\.txt' \] \|\| \[ -L 'folder\/nested\/new file\.txt' \]; then /);
assert.match(createFile.command, /'目标文件已存在' >&2; exit 1; fi; : > 'folder\/nested\/new file\.txt'$/);

const quotedCreateFile = buildRemoteCreateFileCommand("folder/o'k.txt");
assert.equal(quotedCreateFile.path, "folder/o'k.txt");
assert.match(quotedCreateFile.command, /'folder\/o'\\''k\.txt'/, "新建文件路径必须经过 shell 安全引用");
assert.equal((quotedCreateFile.command.match(/'folder\/o'\\''k\.txt'/g) || []).length, 3, "存在性检查和创建命令必须使用同一安全路径");

assert.throws(() => buildRemoteCreateFileCommand("/"), /新建文件路径无效/);
assert.throws(() => buildRemoteCreateFileCommand(".."), /新建文件路径无效/);
assert.throws(() => buildRemoteCreateFileCommand("../outside.txt"), /新建文件路径无效/);
assert.throws(() => buildRemoteCreateFileCommand("folder/../../outside.txt"), /新建文件路径无效/);
assert.throws(() => buildRemoteCreateFileCommand("folder/"), /文件名不能以斜杠结尾/);

const recycleId = "m1abcd23-0123456789abcdef";
const recycleDeletedAt = 1784567890123;
const recyclePath = "/srv/data/o'k 文件.txt";
const recycleCommand = buildRecycleRemotePathCommand(recyclePath, recycleId, recycleDeletedAt);
assert.match(recycleCommand, /\.tunneldesk-recycle-bin/);
assert.match(recycleCommand, /\$td_root\/items/);
assert.match(recycleCommand, /'\/srv\/data\/o'\\''k 文件\.txt'/, "回收站移动命令必须安全引用特殊路径");
assert.match(recycleCommand, new RegExp(Buffer.from(recyclePath, "utf8").toString("base64")));
assert.match(recycleCommand, new RegExp(String(recycleDeletedAt)));
assert.match(recycleCommand, /if mv .*payload/);

const parsedRecycleItems = parseRemoteRecycleItems([
  `m1abcd23-0123456789abcdef\t${Buffer.from("/srv/较早.txt").toString("base64")}\t100\tfile`,
  `m1abcd24-fedcba9876543210\t${Buffer.from("/srv/目录 空格").toString("base64")}\t200\tdir`
].join("\n"));
assert.equal(parsedRecycleItems.length, 2);
assert.equal(parsedRecycleItems[0].original_path, "/srv/目录 空格");
assert.equal(parsedRecycleItems[0].name, "目录 空格");
assert.equal(parsedRecycleItems[0].type, "dir");
assert.equal(parsedRecycleItems[1].deleted_at, 100);

const restoreCommand = buildRestoreRemoteRecycleCommand(recycleId, recyclePath);
assert.match(restoreCommand, /原路径已有同名项目，无法恢复/);
assert.match(restoreCommand, /mkdir -p '\/srv\/data'/);
assert.match(restoreCommand, /mv "\$td_item\/payload" '\/srv\/data\/o'\\''k 文件\.txt'/);
assert.match(buildListRemoteRecycleCommand(), /path\.b64/);
assert.match(buildDeleteRemoteRecycleCommand(recycleId), /rm -rf "\$td_item"/);
assert.match(buildClearRemoteRecycleCommand(), /rm -rf "\$td_root\/items"/);
assert.throws(() => buildRecycleRemotePathCommand("/", recycleId), /根目录或当前目录/);
assert.throws(() => buildRecycleRemotePathCommand("/home/user/.tunneldesk-recycle-bin/items", recycleId), /回收站目录/);
assert.throws(() => buildDeleteRemoteRecycleCommand("../../outside"), /项目编号无效/);
assert.throws(() => parseRemoteRecycleItems(`${recycleId}\tnot-base64!\t1\tfile`), /元数据已损坏/);

const singleArchive = normalizeCompressionRequest(["/srv/file.txt"], "/srv", "file-copy");
assert.equal(singleArchive.name, "file-copy.tar.gz");
assert.equal(singleArchive.output, "/srv/file-copy.tar.gz");
assert.match(singleArchive.command, /tar -czf/);
assert.match(singleArchive.command, /'\.\/file\.txt'/);
const multiArchive = normalizeCompressionRequest(["/srv/folder", "/srv/-danger"], "/srv", "bundle.tar.gz");
assert.equal(multiArchive.paths.length, 2);
assert.match(multiArchive.command, /'\.\/-danger'/);
assert.throws(() => normalizeCompressionRequest(["/srv/a", "/tmp/b"], "/srv", "bundle"), /同一目录/);
assert.throws(() => normalizeCompressionRequest(["/srv/a"], "/srv", "nested/bundle"), /不能包含路径/);
assert.throws(() => normalizeCompressionRequest(["/srv/a.tar.gz"], "/srv", "a.tar.gz"), /不能覆盖/);

assert.deepEqual(JSON.parse(JSON.stringify(frontendContext.permissionModeToChecks("755"))), {
  ownerRead:true, ownerWrite:true, ownerExecute:true,
  groupRead:true, groupWrite:false, groupExecute:true,
  publicRead:true, publicWrite:false, publicExecute:true
});
assert.equal(frontendContext.permissionChecksToMode({ownerRead:true,ownerWrite:true,ownerExecute:false,groupRead:true,groupWrite:false,groupExecute:false,publicRead:false,publicWrite:false,publicExecute:false}), "640");
assert.equal(frontendContext.normalizePermissionMode("888"), "");

console.log("SFTP pagination checks passed");
