# TunnelDesk

TunnelDesk 是一个适合 Termux、Linux、macOS 和 Windows 使用的 SSH 连接与端口转发 Web 管理器。项目使用 TypeScript + Node.js 标准库、Node 内置 SQLite 和系统 `ssh`。

## 项目定位和部署建议

TunnelDesk 的主要功能是集中管理 SSH 连接和 SSH 隧道转发，包括本地转发 `-L`、远程转发 `-R`、SOCKS5 动态代理 `-D`、Web 终端、SFTP 和批量命令。

不建议把 TunnelDesk 直接部署到公网。它可以操作 SSH、SFTP、端口转发、批量命令、密钥和数据库备份，公网暴露后的风险高于普通管理后台。推荐使用方式：

- 本机使用：默认监听 `127.0.0.1:8088`。
- 局域网使用：在“设置 > 启动与运行”选择全部 IPv4 网卡、指定网卡 IP 或多个地址，并设置 Web 密码；也可用 `TUNNELDESK_LAN=1` 或 `--host 0.0.0.0` 临时覆盖。
- 远程使用：优先通过 Tailscale、ZeroTier、WireGuard 等私有网络访问，不要直接暴露到公网。

默认安全策略是：本机访问不进行 Web 密码校验；使用 `0.0.0.0` 或从局域网设备访问时校验 Web 密码。Web 密码只保护 TunnelDesk 管理界面，不替代 SSH 登录认证；连接服务器仍然使用各 SSH 配置里的用户名、私钥和额外 SSH 参数。

Web 登录会按来源地址限制连续失败，达到阈值后短时锁定并返回 `Retry-After`；“设置 > 安全设置 > 会话管理”可配置登录会话有效期、最大活动会话数和过期清理间隔，默认分别为 12 小时、1000 个和 10 分钟。HTTPS Cookie 支持自动、始终和从不启用 `Secure` 三种模式；反向代理只有在显式启用并配置可信代理 IP 后，才会接受 `X-Forwarded-For` 和 `X-Forwarded-Proto`。

## 功能

- Web 界面创建、编辑、删除 SSH 连接
- 连接分组管理，支持重命名、长按拖动持久化排序，并可通过分组“更多”菜单上移或下移；桌面与移动端均可操作，滚动长列表时当前分组标题会固定在顶部
- 支持本地转发 `-L`
- 支持远程转发 `-R`
- 支持 SOCKS5 动态代理 `-D`
- 一个连接可配置多条转发，每条转发规则独立使用 `ssh` 进程，支持单条启停
- 支持转发规则编辑、转发模板、端口自动推荐和单条自动重连
- 支持数据库级转发模板，可跨浏览器和桌面端/Web 端共享，并批量应用到连接、分组或全部连接；首次运行内置 Web、MySQL、Redis、Memcached、SSH 和 SOCKS5 模板
- 支持连接启动时自动启用全部转发
- 支持恢复上次运行的转发，并对需要恢复的转发进行自动重连
- 支持连接搜索和健康检查；检查结果短时缓存，手动检查会强制刷新
- SSH 连接列表支持批量管理：可单选、按当前搜索结果全选、批量删除，以及统一修改分组、SSH 端口、密码或私钥；批量修改凭据不会读取或回显已保存密码
- 新增 SSH 连接时支持“保存并清空”，保存成功后恢复默认表单并聚焦名称输入框，方便连续录入；编辑已有连接时不显示该按钮
- SSH 连接支持设置排序值，默认均为 1；同一分组内数值越小越靠上，相同值按添加时间排列。新增/编辑、SSH config 导入和数据库恢复均可设置或保留排序值
- 支持本地端口占用诊断，显示占用进程并可确认后尝试关闭
- 支持大量连接列表的虚拟滚动渲染，减少展开大量服务器时的页面卡顿
- 支持转发失败中文诊断
- 支持正在转发服务入口，可设置服务名称、类型、备注，并复制或打开本地转发地址
- 单个 SSH 的转发规则列表支持全选、半选状态和批量删除数量提示
- 支持按服务器、服务类型和运行状态查看正在转发
- 支持 SFTP 文件管理，包含目录双击进入、跟随滚动的单一可点击面包屑、服务端分页与短时目录快照、搜索、排序、常用目录收藏、上传、下载、新建目录、新建文件、重命名、删除、右键菜单和常见文件类型图标
- 面包屑下方常驻收藏、新建目录、新建文件和上传操作，并与路径区一起跟随滚动；复制或移动项目后才显示粘贴与取消队列，避免无可粘贴内容时占用空间
- SFTP 文件表采用紧凑对齐布局并直接显示大小、修改时间、权限与所有者；空间不足时优先保留大小和修改时间，权限及低频操作会逐级收进详情和“更多”
- 恢复数据库时会始终列出全部连接及原验证方式：私钥连接显示原私钥名称，可从当前密钥目录、用户 `~/.ssh` 或上传文件重新绑定；密码连接显示备份是否包含密码，可保留、清除或设置新密码。未绑定私钥会清除旧机器路径并继续恢复；恢复完成后数据库句柄和页面数据会自动刷新
- SFTP 新建、重命名、删除、权限修改以及后台上传、复制、移动、压缩和解压完成后会静默同步目录，保留当前列表、勾选项和滚动位置，不再清空页面后跳回顶部
- SFTP 任务抽屉只保留进行中、暂停和失败记录，采用更紧凑的字号与间距；已完成和已取消任务集中到“历史记录”，目录变更仍由后台静默同步，无需从任务项手动刷新
- 通用设置可选择启用 SFTP 回收站，默认关闭；启用后删除会移入远端用户主目录下 TunnelDesk 专用回收站，可查看、恢复、永久删除或清空，关闭时删除仍为永久删除
- SFTP 目录浏览兼容 Linux、Termux 和 macOS 的远端命令差异，不依赖 GNU `find` 专有参数，也不依赖远端账户使用 Bash、csh/tcsh 等哪一种登录 Shell
- SFTP 工具栏可按连接切换并持久保存 UTF-8、GB18030/GBK、Big5、Shift_JIS、EUC-KR 或 ISO-8859-1 文件名编码；该设置只处理目录和路径字节，文本编辑器继续使用独立的内容编码
- SFTP 复制队列可切换到另一台 SSH 连接后直接执行跨主机流式复制，文件和目录通过两条 SSH 会话传输，不经过浏览器或本机临时文件；为避免复制后文件名乱码，源和目标连接需使用相同的文件名编码
- 同一连接的终端和 SFTP 工具栏提供双向快捷入口，可直接打开对应工作区标签
- 支持 SFTP 复制、移动、解压和压缩后台任务，可查看状态、失败信息并取消运行中的任务
- 支持单个文件、单个目录或同一目录下的多选项目压缩为一个 `.tar.gz`；压缩包名称冲突时不会覆盖原文件
- 支持单个或多选文件/目录设置三位八进制权限（例如 `755`），可分别勾选所有者、用户组和公共的读取/写入/执行权限；选择目录时可递归应用，也可按需填写所有者和用户组
- 权限修改兼容 Linux 与 macOS/BSD 的 `chmod`、`chown`/`chgrp` 参数差异，并在提交后立即显示执行进度；操作会等待远端返回真实结果，失败时保留弹窗和错误说明，不会把“已提交”误当作“已完成”
- 权限修改使用当前 SSH 账号执行，不会自动提权；远端账号没有对应权限时会返回明确错误，符号链接不参与权限递归修改
- 支持 SFTP 后台任务最近记录持久化，上传和下载显示实时速度、进度、失败原因，并支持暂停、继续、失败重试、取消和清理
- 支持 512 KB 以内、任意扩展名的普通文件以文本方式打开和编辑，可自动识别 UTF-8 BOM/UTF-8，并在无法按 UTF-8 解码时回退 GB18030；可手动切换 UTF-8、UTF-8 BOM、GB18030/GBK、Big5、Shift_JIS、EUC-KR、ISO-8859-1，保存时保持所选编码并可设为连接默认值，同时提供行数/大小统计、差异预览、原字节备份、`Ctrl+S`、超限和不可表示字符保护
- SFTP 文件夹大小可按需递归读取实际文件总字节数；最近访问目录会立即恢复列表、滚动和选择状态，再在后台静默刷新，缓存超时或超出上限后自动清理
- 支持设置活动栏；左侧操作区以固定纵向单列显示通用设置、安全设置、通知设置、启动与运行和关于。桌面端可收起整个操作区并记住状态，为工作区释放空间；通用设置包含数据存储、桌面端行为和 SFTP 回收站，安全设置集中管理 Web 认证、密码、Token 和配置加密
- “启动与运行”支持多选 `127.0.0.1`、全部 IPv4 网卡和检测到的网卡 IP，支持手动端口、占用检查、端口建议和重启生效提示；同页展示当前实际本机/LAN 访问地址
- 支持加密迁移包导出和恢复，用于跨机器迁移已启用配置加密的数据；新 `.tdbackup` 使用二进制头和数据库流，不再把整库转换为 JSON/Base64，恢复时只上传一次并使用 30 分钟单次令牌完成确认和正式恢复，旧版 `.tdbackup.json` 继续兼容
- 支持服务器标签，并可通过搜索按标签过滤
- SSH 连接支持私钥或密码登录；密码不会通过连接列表 API 回传，编辑已有密码连接时留空即可保留
- 支持批量命令执行，选择多个 SSH 后分服务器实时展示输出，并可导出 TXT 或 JSON 结果
- 支持批量命令模板管理，预设常用命令并在执行时快速选择
- 支持批量命令、SFTP 后台任务和转发异常的页面通知；桌面浏览器授权后可显示系统通知，并可在设置中静音或关闭提醒
- 支持单台服务器基础仪表盘，查看系统、运行时间、内存、磁盘和监听端口摘要
- 支持批量导入和导出 SSH config；导入导出活动栏分为“SSH config 导入导出”“数据库导入导出”和“配置快照”。引用私钥的连接不会自动采用同名文件，用户可逐连接绑定，也可保持未绑定并继续导入，之后再到连接设置补充
- 通用设置可在桌面端和 Web/Termux 模式查看并修改运行数据根目录；Web 目录浏览支持 Windows 多盘符及 macOS/Linux 根目录，保存后自动迁移并重启
- 活动栏图标统一按按钮中心线对齐，保持各入口在桌面端和移动端的视觉基线一致
- 支持配置版本快照，导入、数据库恢复和批量应用转发模板前自动备份，并可在导入导出页手动创建、回滚或删除
- 密钥列表同时读取用户 `~/.ssh` 和当前运行数据目录的 `.ssh`，同名密钥优先使用运行数据目录版本
- Web 上传密钥会保存到当前运行数据目录的 `.ssh/`
- 支持私钥权限检查和一键修复
- 支持 Web 终端，优先使用本地 PTY；macOS 本地 PTY失败时会继续尝试内置 SSH 远程 PTY。每个连接可持久保存 UTF-8、GB18030/GBK、Big5、Shift_JIS、EUC-KR 或 ISO-8859-1 编码，非 UTF-8 连接自动使用可保留原始字节的内置 SSH PTY
- 终端状态栏默认显示真实交互响应延迟，即从按键发送到远端首次返回内容的时间；可在通用设置关闭，不会额外发送探测命令。终端连接禁用小输入等待，逐字输入和回显更及时
- 终端工具栏提供独立的编码和字体图标下拉菜单，选择后自动保存、立即应用并把输入焦点还给终端，不会断开 SSH；内置系统等宽、Cascadia、JetBrains Mono、Consolas、Menlo/Monaco、DejaVu Sans Mono、Noto Sans Mono 等预设和自定义字体，并可设置行距、字重或一键恢复显示默认值；Ctrl + 鼠标滚轮可快速调整并保存字号
- 终端支持项目内右键菜单，可复制选中或全部输出、粘贴、全选、清屏、滚到底部、调整字体和重新连接
- 普通终端支持最近命令记录和快速再次发送
- 支持移动端全屏终端、底部命令输入栏和两行横向快捷键栏，包含 Esc、Tab、方向键、Ctrl 组合键和常用符号
- 连接、转发、SFTP、日志、批量命令和设置等页面使用统一的加载、空数据与错误状态
- Web UI 使用统一的按钮、输入框、选择框、复选框、文件选择、工具栏、列表、分页、弹窗和焦点样式，亮色与暗色主题不依赖系统原生控件外观
- 活动栏、移动底栏和高频操作使用随项目离线发布的 Lucide 图标；移动端底栏采用七个等宽纯图标入口并保留完整无障碍名称，连接、转发、SFTP、日志、批量命令和设置使用统一的操作层级与更多菜单
- 移动端自定义弹窗使用底部操作面板，长表单保存区保持可触达；桌面和移动 UI 可分别用 `npm run regression` 与 `npm run ui:smoke` 检查
- 支持按天保存系统日志、终端日志和批量执行日志；非 UTF-8 终端按连接编码写入可读日志，查看器会还原回车、退格和删除后的实际文本，并按 256 KB 分段读取；搜索由服务端逐行处理，不会一次加载完整大文件；可配置保留天数、单文件轮转上限、总容量上限和轮转份数
- 支持工作区标签持久化，刷新后恢复转发列表、编辑、导入导出、日志和批量命令等非终端标签
- 桌面端工作区标签支持右键关闭当前、其他、右侧或全部标签
- 启动后自动通过 GitHub Releases 检查最新正式版本；发现更新时除通知外，还会在“设置”活动栏和“关于”入口显示红点。用户可以忽略当前版本的提示弹窗和红点，关于页面仍可正常查看和下载；出现更高版本时会自动恢复提醒。更新卡片按新到旧显示最近两个正式版本的更新内容，并显示自动匹配的资源和下载进度，同时保留外部浏览器“查看 Release”。Windows 安装版和便携版会分别选择自己的文件，共用数据目录时也不会混用；macOS 和 Linux 会按系统及处理器选择。下载后会核对文件是否完整；安装版可打开安装包或下载目录，升级完成并启动新版本后会自动删除下载的安装包；便携版会提示关闭旧版本后手动替换，也可重新下载，不会静默安装或自动回滚
- SQLite 保存配置

## 环境准备

运行环境要求：

- Node.js `22` 或更高版本，推荐使用当前 LTS 或更新版本
- npm，通常会随 Node.js 一起安装
- OpenSSH 客户端，也就是命令行可以执行 `ssh`

可以先检查版本：

```sh
node -v
npm -v
ssh -V
```

### Termux 和 Linux 的区别

Termux 是 Android 上的 Linux-like 环境，但不是标准 Linux 发行版。对 TunnelDesk 来说，Termux 和 Linux 都可以运行 `node`、`ssh`、`./start.sh` 和 `./stop.sh`，也都可以通过浏览器访问 Web 管理界面。

主要区别：

- Termux 路径和普通 Linux 不同，例如 shell 通常在 `/data/data/com.termux/files/usr/bin/sh`
- Termux 没有传统 `systemd`
- Termux 默认没有桌面图形环境，不适合运行 Electron 桌面端
- Android 后台限制更严格，长期运行建议配合 Termux:Boot，并关闭电池优化限制
- `node-pty` 这类原生依赖需要本机编译；Termux 启动脚本会自动设置编译所需的 `npm_config_android_ndk_path`

推荐使用方式：

- Linux 桌面：可以使用 Web 模式，也可以打包/运行 Electron 桌面端
- Linux 服务器：推荐后台 Web 模式
- Termux：推荐后台 Web 模式，不建议运行 Electron 桌面端

Termux 或无图形 Linux 推荐：

```sh
TUNNELDESK_WEB_ONLY=1 ./start.sh
```

Termux：

```sh
pkg update
pkg install nodejs openssh
```

Linux/macOS：

```sh
npm install --include=dev
```

Windows 需要安装 Node.js 22+，并确保系统可以执行 `ssh.exe`。Windows 10/11 通常自带 OpenSSH 客户端，如果没有，可以在“可选功能”里安装 OpenSSH Client。

首次运行推荐直接使用项目启动脚本：

- Linux / Termux 使用 `./start.sh`
- Windows 使用 `start.bat`

启动脚本会自动执行必要步骤：

```sh
npm install --include=dev
npm run build
```

如果不使用启动脚本，而是手动执行 `npm start` 或 `node dist/server.js`，需要先执行：

```sh
npm install --include=dev
npm run build
```

`node-pty` 是 optional 依赖。安装时会自动尝试安装，失败不会阻断基础功能；Web 终端会按平台回退到内置 SSH 远程 PTY 或普通 SSH 子进程模式。桌面端打包时会将 `node-pty` 及其 `spawn-helper` 解包到 Electron 资源目录，并在 macOS/Linux 打包后校正辅助程序权限。macOS 运行时还会再次检查权限，避免 PTY 失败后方向键、Delete 和命令行编辑异常。Termux 下如果手动安装依赖，可以使用：

```sh
npm_config_android_ndk_path="$PREFIX" npm install --include=dev
```

## SSH 密钥

除用户自己的 `~/.ssh/` 外，项目还会读取当前运行数据目录下的 `.ssh/`：

```text
当前运行数据目录/.ssh/
```

可以手动放入私钥，也可以通过 Web 页面上传密钥。上传后的密钥会保存到当前运行数据目录的 `.ssh/`，并尽量自动设置为私钥可用权限。源码模式下运行数据目录就是项目目录；桌面安装版、便携版和自定义路径的实际位置见下方“桌面端数据路径”。

如果是 Windows，OpenSSH 对私钥权限比较严格；项目会尝试修正权限。如果仍提示 `UNPROTECTED PRIVATE KEY FILE`，请检查该私钥是否被其他用户组授予了读取权限。

Web 页面中可以对当前选择的私钥执行权限检查和一键修复。Windows 下会尽量移除不安全的用户组权限；Linux、macOS 和 Termux 下会尽量设置为 `0600`。

建议把 `.ssh/` 加入 Git 排除列表，避免私钥被提交。

## 启动

推荐直接运行启动脚本。脚本会优先尝试桌面端；如果没有图形环境、没有 Electron，或设置了 `TUNNELDESK_WEB_ONLY=1`，会自动回到后台 Web 服务模式。

Linux / Termux：

```sh
./start.sh
```

如果普通 Linux 无法直接执行 Termux shebang，可以使用：

```sh
sh start.sh
```

Windows 双击：

```bat
start.bat
```

强制只启动后台 Web 服务：

```sh
TUNNELDESK_WEB_ONLY=1 ./start.sh
```

Windows：

```bat
set TUNNELDESK_WEB_ONLY=1
start.bat
```

局域网访问模式：

```sh
TUNNELDESK_LAN=1 ./start.sh
```

Windows：

```bat
set "TUNNELDESK_LAN=1"
start.bat
```

Windows 也可以一行执行：

```bat
set "TUNNELDESK_LAN=1" && start.bat
```

`TUNNELDESK_LAN=1` 是兼容旧脚本的临时覆盖：它只把监听地址切到 `0.0.0.0`，端口仍使用设置页保存的端口，除非同时显式传入 `--port` 或 `TUNNEL_WEB_PORT`。启动后会输出本次实际检测到的局域网 IPv4 地址。

常用监听配置应在“设置 > 启动与运行”保存到 `data/runtime-settings.json`：可多选 `127.0.0.1`、全部 IPv4 网卡和具体网卡 IP，再填写端口并使用“检查占用”。保存不会中断当前服务，重启后才生效；CLI 参数优先于环境变量，环境变量优先于保存配置。可重复传入 `--host` 或使用逗号分隔多个地址，例如 `start.bat --host 127.0.0.1 --host 192.168.1.20 --port 8088`。

若本次启动的端口被其他程序占用，TunnelDesk 会将所有选中的地址作为一组，最多顺序尝试后续 20 个端口；成功后把实际端口写回保存配置。设置页和 `data/web.json` 都显示真实地址和端口。重复启动桌面版会唤起已有窗口；无界面服务已在运行时，启动脚本会直接提示已有服务和访问地址，不会删除现有状态文件。

建议在“设置”中设置 Web 密码。默认策略是：从非本机地址访问时要求密码，包含 `0.0.0.0` 和指定的局域网网卡 IP。也可以改为始终校验密码，或在明确确认风险后关闭局域网密码。

### 重置 Web 密码

TunnelDesk 不保存明文密码，只保存哈希，因此忘记密码后不能查看原密码，只能重置。

重置 Web 访问密码、访问 Token 和认证策略：

```sh
TUNNELDESK_RESET_WEB_ACCESS=1 ./start.sh
```

Windows：

```bat
set TUNNELDESK_RESET_WEB_ACCESS=1
start.bat
```

重置只会清空 Web 登录密码和访问 Token，并把认证策略恢复为“局域网访问时要求密码”。它不会删除配置加密的主密码元数据；如果已经启用配置加密，恢复后仍需要用原主密码解锁加密配置。

## 备份和配置加密

未启用配置加密时，可以继续使用“下载数据库备份”导出 `.db` 文件。下载前会明确询问是否包含 SSH 登录密码，默认推荐导出不含密码的备份；选择包含密码时请把备份文件按敏感凭据保管。

配置加密是高级可选项，普通个人或局域网自用场景通常不需要启用。启用时会自动加密现有和以后保存的私钥路径、额外 SSH 参数，不会加密私钥文件本身。

启用配置加密后，跨机器迁移请使用“下载加密迁移包”。迁移包下载入口只会在配置加密启用时显示。迁移包是 `.tdbackup.json` 文件，可在“导入导出 -> 数据库导入导出”中上传恢复。它包含完整 SQLite 数据库和解锁加密字段所需的加密元数据；数据库内的连接、转发规则、转发模板、标签等配置会一起迁移。迁移包不包含 SSH 私钥文件、Web 登录密码、访问 Token、浏览器本地收藏或日志。恢复后需要用原来的主密码解锁配置；Web 访问密码建议在新机器上重新设置。

配置加密会影响 SSH 连接的使用时机：启用后，私钥路径和额外 SSH 参数会加密保存。当前进程中已经解锁时，SSH 连接、终端、SFTP、转发和批量命令会正常读取解密后的配置；重启 TunnelDesk 后需要先在“设置”里用主密码解锁，否则依赖私钥或额外 SSH 参数的连接可能无法正常启动。关闭配置加密时需要输入主密码，TunnelDesk 会先把已加密字段解密回普通数据库字段；关闭后可以继续使用普通 `.db` 备份迁移。

访问 Token 是给脚本、curl 或第三方工具通过 Bearer Token 调用 API 使用的高级凭据。未设置 Token 时，这类外部 Token 调用不可用；Web 页面和本机访问仍按当前认证策略工作。只用浏览器 Web 页面或手机访问时，设置 Web 密码即可，Token 可以不设置。Token 由系统随机生成，只显示一次；重新生成后旧 Token 会失效。

后台 Web 服务启动成功后，脚本会读取 `data/web.url` 并尽量打开系统浏览器。如果不希望自动打开浏览器，可以设置：

```sh
TUNNELDESK_NO_BROWSER=1 ./start.sh
```

Windows：

```bat
set TUNNELDESK_NO_BROWSER=1
start.bat
```

启动脚本会输出当前模式：桌面端、强制 Web-only，或因为 Electron 不可用/无图形环境回退到 Web 模式；同时会提示 Web 日志位置，便于排查启动失败。开始使用页会继续展示实际 Web/LAN 地址、自动转发成功与失败数量和系统日志入口。

启动脚本会自动执行构建。首次 clone 后缺少依赖，或者 `package.json` / `package-lock.json` 相比上次安装发生变化时，脚本会自动执行依赖安装，不需要手动补跑 `npm install`：

```sh
npm install --include=dev
```

Termux 下 `start.sh` 会在安装依赖前自动设置 `npm_config_android_ndk_path="$PREFIX"`，让 `node-pty` 可以使用 Termux 的 `ndk-sysroot` 本机编译。

桌面端启动前，脚本还会检查 Electron 二进制是否已经下载；如果缺失，会先执行 Electron 下载步骤，再启动桌面端。默认下载失败时会尝试 `https://npmmirror.com/mirrors/electron/` 镜像；如果仍失败，会自动回退到后台 Web 模式。

如果只需要后台 Web 模式，可以设置 `TUNNELDESK_WEB_ONLY=1`，脚本仍会安装和构建 Web 所需依赖，但不会尝试启动 Electron 桌面端。

默认从 `127.0.0.1:8088` 启动。设置页保存的监听地址和端口用于下一次启动；如果端口被占用，服务会对整组监听地址自动尝试后续端口，最多 20 次。真实访问地址会写入：

```text
data/web.url
data/web.json
```

`web.url` 是本机首选访问地址；`web.json` 记录本次请求/实际监听地址、实际端口、回退次数和 LAN 地址。启动脚本和设置页都以这些本次实际结果展示访问地址。

如果需要局域网访问，可以启动时指定：

```sh
./start.sh --host 0.0.0.0 --port 8088
```

局域网监听仍应设置 Web 密码，只建议在可信网络中使用，不要直接暴露到公网。

启动后会尝试恢复上次仍处于运行状态的转发。手动停止某个连接转发后，该连接会从恢复列表中移除。

## 桌面端

桌面端基于 Electron，复用当前 Web 管理界面和 Node.js 后端能力。

桌面端支持单实例、托盘菜单、启动/停止全部转发、托盘转发状态展示和开机启动。手动双击程序、快捷方式或 `start.bat` 时会把主界面打开到前台；再次启动已运行的桌面版会直接唤起已有窗口，不会再创建第二个 Web 服务。数据路径、开机启动、最小化到托盘、开机静默和启动通知统一在“设置 > 通用设置”中管理，保存后会自动重启。它可以配合连接的“启动 TunnelDesk 时自动启用转发”实现开机后自动恢复常用转发。

正式安装的 Windows、macOS 和 Linux 桌面包默认把运行数据保存在 Electron 用户数据目录的 `runtime/` 下，覆盖安装或替换 `.app` 不会删除连接、转发和密钥。常见位置如下：

- Windows 安装版：`%APPDATA%\TunnelDesk\runtime\data` 和 `%APPDATA%\TunnelDesk\runtime\.ssh`
- macOS：`~/Library/Application Support/TunnelDesk/runtime/data` 和 `~/Library/Application Support/TunnelDesk/runtime/.ssh`
- Linux 桌面包：`~/.config/TunnelDesk/runtime/data` 和 `~/.config/TunnelDesk/runtime/.ssh`
- Windows 绿色便携版：便携 exe 所在目录的 `data/` 和 `.ssh/`
- 源码开发模式：项目目录的 `data/` 和 `.ssh/`

旧桌面版本若曾选择“程序所在文件夹”，新版会在启动后端前把安装目录中的旧数据迁移到稳定的用户数据目录，原目录保留不删除；目标目录已有数据时不会直接覆盖。仍可在桌面设置中选择安装目录之外的自定义数据根目录。

Web/Termux 模式也可在“设置 > 通用设置”中输入或浏览运行 TunnelDesk 主机上的绝对路径。Windows 可在目录弹窗中切换所有可访问盘符，macOS/Linux 从 `/` 开始浏览（macOS 外接卷通常位于 `/Volumes`）。远程局域网页面管理的是服务器文件系统，不是访问设备的磁盘；只有启用 Web 密码并登录时才允许远程浏览和修改，关闭局域网密码后仅本机可操作。保存时可复制现有 `data/` 与 `.ssh/`，目标已有数据库不会覆盖，完成后服务会自动按当前监听地址和端口重启。`TUNNELDESK_DATA_DIR` 与 `TUNNELDESK_SSH_DIR` 仍可在启动前分别覆盖目录。

开发模式启动桌面端：

```sh
npm run desktop
```

只运行已构建的桌面端：

```sh
npm run desktop:run
```

生成当前平台目录包：

```sh
npm run package
```

生成安装包：

```sh
npm run dist
```

`npm run dist` 会按当前系统生成对应平台的安装包。Electron 原生依赖和平台安装包建议在对应平台打包：Windows 打 Windows 包，Linux 打 Linux 包，macOS 打 macOS 包。

### Windows 打包和运行

在 Windows 上执行：

```bat
npm install
npm run dist -- --win nsis portable --x64
```

会输出到 `release/` 目录：

- NSIS 安装包：`TunnelDesk-<version>-windows-x64-installer.exe`
- 绿色便携版：`TunnelDesk-<version>-windows-x64-portable.exe`
- 目录包：`win-unpacked/TunnelDesk.exe`，可通过 `npm run package` 生成

NSIS 安装包使用向导式安装，安装时可以选择安装路径。这里的 `x64` 同时适用于 64 位 Intel 和 AMD 处理器；当前没有生成 32 位 `x86` Windows 包。

只生成目录包：

```bat
npm run package
```

### Linux 打包和运行

在 Linux 桌面环境上执行：

```sh
npm install
npm run dist -- --linux AppImage deb rpm --x64
```

会输出到 `release/` 目录：

- AppImage：`TunnelDesk-<version>-linux-x86_64.AppImage`
- Debian 包：`TunnelDesk-<version>-linux-amd64.deb`
- RPM 包：`TunnelDesk-<version>-linux-x86_64.rpm`

这三个名称中的 `x86_64` 与 `amd64` 都表示同一种 Intel/AMD 64 位架构，只是遵循各 Linux 包格式的常用写法；当前没有生成 Linux x86、ARM32 或 ARM64 桌面包。

运行 AppImage：

```sh
chmod +x release/*.AppImage
./release/*.AppImage
```

安装 deb：

```sh
sudo apt install ./release/*.deb
```

安装 rpm：

```sh
sudo rpm -i release/*.rpm
```

### macOS 打包和运行

在 macOS 上执行：

```sh
npm install
npm run dist -- --mac dmg zip --x64 --arm64
```

会输出到 `release/` 目录：

- Intel Mac DMG：`TunnelDesk-<version>-macos-x64.dmg`
- Apple Silicon DMG：`TunnelDesk-<version>-macos-arm64.dmg`
- Intel Mac ZIP：`TunnelDesk-<version>-macos-x64.zip`
- Apple Silicon ZIP：`TunnelDesk-<version>-macos-arm64.zip`

macOS 应用包使用 `desktop/assets/icon.icns` 作为 Finder 和 Dock 图标。本地打包钩子与 GitHub Actions 会检查每个 `.app` 的 `CFBundleIconFile` 和对应 ICNS 资源，避免回退为 Electron 默认图标。

首次打开时如果 macOS 安全策略拦截，可以在系统设置的“隐私与安全性”里允许打开。

### Linux / source 包

Linux/source 包适合普通 Linux、Linux 服务器和 Termux 使用。它不包含 Electron 桌面端安装器，解压后安装依赖并启动后台 Web 模式：

```sh
tar -xzf TunnelDesk-*-linux-source-noarch.tar.gz
cd tunneldesk
npm install --include=dev
TUNNELDESK_WEB_ONLY=1 ./start.sh
```

Termux 也使用同一个 Linux/source 包：

```sh
TUNNELDESK_WEB_ONLY=1 ./start.sh
```

说明：如果使用源码目录里的 `start.bat` 运行桌面端，实际启动的是开发模式 Electron 进程，Windows 任务栏和通知中心可能仍显示 Electron 图标或名称。正式安装包和便携版运行的是 `TunnelDesk.exe`，会使用 TD 图标；如果 Windows 已固定旧图标，取消固定后重新固定，或重启资源管理器清理任务栏图标缓存。

### GitHub Actions 自动发布

项目包含 GitHub Actions 发布流程：`.github/workflows/release.yml`。

维护者发布新版本时，需要把程序版本、发布说明和下一版草稿一起同步：

1. 执行 `npm version <版本号> --no-git-tag-version`，同时更新 `package.json` 和 `package-lock.json`。
2. 在 `docs/update.md` 定稿当前版本，并在文件顶部建立下一个版本的草稿；同步 `docs/Plan.md` 和 `docs/speak.md`。
3. 执行 `node scripts/release-notes.js <版本号>`，确认 `release-notes.md` 只包含当前版本内容。
4. 完成构建和回归检查后提交代码，再创建与程序版本一致的 `v<版本号>` 标签并推送。
5. 等待 `Build Releases` 全部成功，并核对 GitHub Release 说明及 Windows、Linux、macOS、Linux/source 附件。

这里的“下一版草稿”默认是 `docs/update.md` 中的 Release Notes 草稿，不是 GitHub Draft Release；只有需要提前在 GitHub 展示远端草稿时才单独创建。

触发方式：

```sh
git tag v1.0.0
git push origin v1.0.0
```

推送 `v*` 标签后，CI 会自动构建并上传到 GitHub Releases：

- Windows runner：x64 NSIS 安装包、x64 portable exe
- Ubuntu runner：x64 AppImage、deb、rpm（文件名按格式显示 `x86_64` 或 `amd64`）
- macOS runner：x64 与 arm64 的 dmg、zip
- Ubuntu runner：`noarch` Linux/source `tar.gz`，适用于普通 Linux 和 Termux 后台 Web 模式

所有可下载文件名都明确包含产品、版本、系统和架构；Windows 还会额外写明安装版或便携版，其他包类型由扩展名或 `source` 字段表示。GitHub Actions 在上传前会校验名称和 tag/程序版本，不符合规则会停止发布。架构标识对应关系如下：

| 文件名标识 | 实际含义 | 当前 CI 产物 |
| --- | --- | --- |
| `x64` / `amd64` / `x86_64` | Intel/AMD 64 位，同一种架构的不同常用名称 | Windows、Linux、Intel Mac |
| `x86` / `ia32` / `i386` / `i686` | Intel/AMD 32 位 | 暂未构建 |
| `arm64` / `aarch64` | 64 位 ARM；Mac 上即 Apple Silicon | Apple Silicon Mac |
| `arm` / `armv7l` / `armhf` | 32 位 ARM | 暂未构建 |
| `noarch` | 与 CPU 架构无关的源码包 | Linux/source |

因此使用 64 位 AMD Windows 电脑时应下载 `windows-x64`，不需要另找一个名为 `amd` 的包；M 系列 Mac 下载 `macos-arm64`，Intel Mac 下载 `macos-x64`。

也可以在 GitHub Actions 页面手动运行 `Build Releases`。手动运行会生成 workflow artifacts；只有 tag 触发时会自动上传到 GitHub Releases。

桌面端能力：

- 自动启动内置 Web 服务，并在端口被占用时递增端口
- 正式安装版、macOS 和 Linux 桌面包默认使用系统用户数据目录下的 `runtime/data` 与 `runtime/.ssh`，升级或替换应用本体不会覆盖运行数据
- Windows 绿色便携版使用便携 exe 所在目录的 `data/` 和 `.ssh/`；源码开发模式继续使用项目目录
- 首次进入桌面端会直接打开“设置 > 启动与运行”，可确认桌面端数据路径和启动行为
- 程序设置里可切换用户数据路径或安装目录之外的自定义路径；源码开发和 Windows 便携模式仍可使用程序所在文件夹
- 关闭窗口时默认最小化到托盘
- 桌面端标题栏只保留“开始”菜单，设置不再使用独立 Electron 弹窗
- 托盘菜单支持打开 TunnelDesk、浏览器打开、启动/停止全部转发；设置和数据库备份统一从程序界面进入
- 支持打开当前运行数据目录的 `.ssh` 目录和日志目录
- 支持导出日志
- 支持备份和恢复 SQLite 配置数据库；恢复时显示每个连接的原密钥名称，可绑定当前密钥目录、用户 `~/.ssh` 或新上传的私钥，不要求文件同名
- 支持开机自启开关
- 支持仅在开机自启时静默到托盘，手动启动始终显示主界面
- 支持单实例运行，重复打开桌面端会拉起已有窗口到前台，并提示 TunnelDesk 已在运行
- 支持 GitHub Releases 自动更新检查；只提醒并打开 Release 页面，不会自动下载或静默安装，可用 `TUNNELDESK_DISABLE_UPDATE_CHECK=1` 关闭启动检查
- 退出桌面端时会同步停止正在运行的 SSH 隧道

如果选择“用户数据路径”，桌面端会把数据保存到 Electron 用户数据目录；如果选择“自定义路径”，该目录下会创建 `data/` 和 `.ssh/`。不要把自定义路径放进 macOS `.app`、Linux AppImage 挂载目录或 Windows 安装目录，否则应用升级仍可能替换该位置。

### 自动检查更新如何比较

TunnelDesk 比较的是两项版本号：本机正在运行程序的 `package.json.version`，以及该 `package.json` 中 GitHub 仓库的最新正式 Release `tag_name`。比较前会去掉标签开头的 `v`，再按版本数字段比较，因此 `v1.10.0` 会正确高于 `v1.9.9`，不是按字符串或发布时间判断。

更新检查不比较安装包哈希、文件大小、提交记录或 Release 附件内容。只有 GitHub 的版本标签严格高于本机版本才提示更新；如果在同一个标签下替换附件，TunnelDesk 不会把它识别为一个新版本。

- 服务启动约 10 秒后检查一次；6 小时是检查结果的缓存有效期，不是每 6 小时循环轮询。
- 手动点击“设置 > 关于 > 检查更新”会跳过 6 小时缓存并向 GitHub 重新确认；请求仍使用 ETag，GitHub 返回未修改时复用已缓存的 Release 数据。
- 缓存只复用 GitHub 的最新 Release 信息，本机版本每次都从当前程序重新计算，覆盖安装升级后不会继续显示旧“当前版本”。
- draft 和 prerelease 不作为普通更新；同一个最新版本跨重启只进入一次通知中心。
- 发现新版本时，“设置”活动栏和“关于”入口会显示红点。打开“关于”后，本次程序会话内视为已读并隐藏；下次重新打开程序时若仍有更新可用，红点会再次出现。此状态只影响红点，不会把更新永久忽略。
- 检查只提供 Release 页面，不自动下载、校验或安装。`TUNNELDESK_DISABLE_UPDATE_CHECK=1` 只关闭启动检查，手动检查仍可使用。

## 前台调试

```sh
./start.sh --foreground
```

前台模式会直接运行 `node dist/server.js`，适合查看日志和调试。

## 停止

Linux / Termux：

```sh
./stop.sh
```

Windows 双击：

```bat
stop.bat
```

停止 Web 管理器时，会同步停止正在运行的 SSH 隧道转发，并清理 `data/web.pid` 和 `data/web.url`。`stop.sh` 和 `stop.bat` 会优先使用 PID 和 `/api/shutdown`，失败时再按程序名称和项目路径兜底清理进程。

## Windows 脚本说明

`start.bat` 双击运行时会短暂显示依赖安装、构建和启动状态；桌面端或 Web 后台启动成功后窗口会自动关闭，不会保留 npm/Electron 控制台。运行日志写入 `data/web.log`，桌面端错误另写入 `data/desktop-error.log`。`stop.bat` 默认停留窗口，方便查看停止结果。

如果在自动化脚本中调用，不希望暂停，可以设置：

```bat
set TUNNELDESK_NO_PAUSE=1
```

## 移动端 Web

手机浏览器会切换为单页移动布局，底部以等宽纯图标提供连接、正在转发、批量命令、导入导出、日志、设置和 GitHub 七个入口；视觉上不显示文字，按钮仍保留 `title` 与 `aria-label` 名称。

GitHub 图标链接到：

```text
https://github.com/zmide/tunneldesk
```

## Termux 开机启动示例

如果使用 Termux:Boot，可以创建：

```text
~/.termux/boot/start-tunneldesk.sh
```

内容示例：

```sh
#!/data/data/com.termux/files/usr/bin/sh
cd /data/data/com.termux/files/home/tunneldesk
setsid ./start.sh > data/web.log 2>&1 < /dev/null &
```

然后赋予执行权限：

```sh
chmod +x ~/.termux/boot/start-tunneldesk.sh
```

## 配置示例

本地转发：

```text
类型：本地转发 -L
SSH 用户：root
SSH 主机：example.com
本地监听地址：127.0.0.1
本地监听端口：8080
目标主机：127.0.0.1
目标端口：80
```

等价命令：

```sh
ssh -N -L 127.0.0.1:8080:127.0.0.1:80 root@example.com
```

SOCKS5：

```text
类型：SOCKS5 -D
本地监听地址：127.0.0.1
本地监听端口：1080
```

等价命令：

```sh
ssh -N -D 127.0.0.1:1080 root@example.com
```

## 文件说明

```text
src/                TypeScript 后端源码
dist/               TypeScript 编译输出
public/             Web 前端页面
.ssh/               源码模式下的 SSH 私钥目录；桌面安装版使用其运行数据目录
data/tunnels.db     SQLite 配置库，首次运行自动创建
data/logs/          系统日志和终端日志
data/forward-state.json
                    上次运行转发的恢复状态
data/web.pid        Web 服务 PID 文件
data/web.url        当前 Web 服务实际访问地址
data/web.json       本次实际监听地址、端口和 LAN 地址
data/runtime-settings.json  下次启动使用的监听地址与端口
```

## 安全说明

- SSH 密码会保存到本地 SQLite 配置库供终端、SFTP、批量命令和转发使用；连接列表 API 不会回传密码。建议优先使用私钥认证，需要保存密码时启用配置加密并保护 `data/` 目录。
- 私钥可以来自用户 `~/.ssh/` 或当前运行数据目录的 `.ssh/`，请自行保护设备和运行数据目录。
- 不要提交 `.ssh/`、`data/` 等本地运行数据。
- Web 服务默认只监听 `127.0.0.1`；可在“设置 > 启动与运行”保存多地址监听配置。
- 如果需要局域网访问，可选择 `0.0.0.0` 或具体网卡 IP；`--host`、`TUNNEL_WEB_HOST` 和 `TUNNELDESK_LAN=1` 只适合临时覆盖。
- 不要在公网直接暴露该 Web 服务。

## 开源许可

TunnelDesk 采用 [GNU General Public License v3.0](LICENSE) 开源，SPDX 标识为 `GPL-3.0-only`。完整许可条款以仓库根目录的 `LICENSE` 为准，Windows、Linux 和 macOS 桌面包也会随包携带该文件。运行程序后也可以进入“设置 > 关于”，点击“查看开源许可正文”直接阅读随当前程序提供的许可文件。
