# Electron 桌面客户端

状态：implemented
类型：architecture
Owner：desktop/main.js

## 问题

网页端的个人空间依赖浏览器 File System Access API，只能在 Chromium 中使用，且每次会话都可能要求重新授权。用户希望有可安装的桌面客户端，直接读取本地文件夹；现有后端由 Docker Compose 提供，桌面端不应复制一套 PostgreSQL/Milvus/Redis 运行环境。

## 决策

### 实现方案

新增独立 `desktop/` Electron 应用：

- 主进程启动仅监听 `127.0.0.1:5175` 的静态文件服务器，并把 `/api`、`/minio/public/` 反向代理到现有 Yuxi 后端；渲染进程加载该源，因此前端现有相对路径、SSE 和鉴权头无需改写。代理固定目标 origin、校验 Host、拒绝协议相对路径，端口可用 `FULLON_DESKTOP_PORT` 覆盖。
- 后端地址默认 `http://127.0.0.1:5050`，可由 `FULLON_SERVER_URL` 或用户数据目录的 `config.json` 覆盖；MinIO 地址同理（默认 `http://127.0.0.1:9000`）。
- preload 通过 `contextBridge` 暴露 `window.fullonDesktop`：选择目录、列出目录、读取文件、忘记目录。渲染进程不获得 Node/文件系统权限，`contextIsolation`、`sandbox` 开启。IPC 校验发送帧，授权根目录同时绑定当前 `uid`。
- 原生目录是本机文件事实源：选择后主进程把真实路径写入授权根目录，IPC 只接受该根目录内的相对路径，并逐段校验、`realpath` 防符号链接逃逸。
- 前端 `localFolderSync` 检测到桌面桥时存储 `{kind:'desktop', rootPath}` 而不是目录句柄；浏览、预览、刷新继续由 `LocalFolderBrowser` 驱动，浏览器端保留 File System Access 回退。
- 断开连接同时清理 IndexedDB 记录和主进程授权根目录；账号切换时渲染进程撤销旧授权，主进程也拒绝其他 uid。
- 导航只允许本机窗口源，`will-navigate`/`will-redirect` 拦截外部跳转；Electron fuses 关闭 RunAsNode、Node CLI inspect 和 NODE_OPTIONS，仅从 asar 加载。
- 打包使用 electron-builder；Windows 默认输出 portable zip 与 `win-unpacked` 目录。构建使用本地 Electron 分发目录并跳过 exe 签名/资源编辑，避免 Windows 缺少符号链接权限时下载 winCodeSign 失败。NSIS 目标保留为可选脚本，但当前环境会因进程 Job 限制失败。

### Agent 边界

桌面桥只服务渲染进程。Docker 内的 Agent 仍无法读取本地目录；若后续需要 Agent 读写，必须另建带每用户 token 的本机服务，并让后端显式调用，不能把 Electron IPC 暴露成网络接口。

## 替代方案

- 打包 Python 后端与数据库：体积、升级和运维成本高，且用户已有 Docker 后端，拒绝。
- 直接 `file://` 加载前端：相对 `/api`、SSE、跨域和 SPA 路由均失效，拒绝。
- 渲染进程开启 `nodeIntegration` 直接读盘：任何前端脚本都能访问整个磁盘，拒绝。
- Electron 内嵌浏览器 File System Access：仍需浏览器权限模型，不能解决客户端诉求，拒绝。

## 后果

- 客户端要求后端可访问；默认本机 Docker Compose，远程服务器需配置地址。
- 本机代理只绑定 loopback，鉴权仍由 Yuxi 后端执行；同一 Windows 用户下的其他进程仍可读本地文件，原生目录授权不是操作系统沙盒。
- 当前未签名，Windows SmartScreen 会提示；正式分发需要代码签名证书。
- 渲染进程只读预览，不提供本地文件删除或编辑。
- 未内置浏览器 File System Access 的句柄迁移：网页连接和桌面连接分别保存在各自源的 IndexedDB 中。

## 验证

| 验收主张 | 失败面 | 语义 Owner | 直接证据 / 命令 | 负向案例 | 当前结果 |
|---|---|---|---|---|---|
| 客户端可启动并加载现有前端 | 静态资源或 SPA 路由失败 | `desktop/main.js` | 启动 `release/win-unpacked/fullon.exe` 后加载 `/workspace` | 后端不可达时请求报错而非空白页 | Passed |
| API 经本机代理工作 | 登录失败 | `proxyRequest` | Electron 内登录 `user`，调用 `/api/auth/me` 成功 | 直连 `file://` 不可用 | Passed |
| 原生目录只读浏览与预览 | 路径逃逸或越权读盘 | `resolveWithin` | 真实 IPC 列出测试目录、预览文本与图片；`pnpm --dir desktop test` 7 passed | `..`、绝对路径、越界符号链接被拒绝；代理 `//host` 不改变 origin | Passed |
| 前端保留浏览器回退 | 网页端无法连接目录 | `localFolderSync` | `node --test frontend/test/unit/localFolderSync.test.js` 5 passed | 无桌面桥时仍走 File System Access | Passed |
| 授权跟随登录用户 | 换账号仍读旧目录 | `allowedRootUid` / IPC | 主进程比对 uid，渲染进程切换 uid 时撤销 | 错误 uid 调用被拒绝 | Passed |
| 刷新反映本地变化 | 使用旧快照 | `readLocalDirectory` | 外部新增 `live.txt` 后点击刷新出现 | 刷新前不存在 | Passed |
| 可打包 Windows 客户端 | 构建缺文件或无法启动 | `electronDist` / `files` | `release/fullon-0.8.0-beta.5-win.zip` 生成并启动 unpacked 产物 | 缺少 `lib/` 时启动失败已修复；NSIS 在本机因 Job 限制失败，未作为已验证产物 | Passed |

Electron 45.2.1 + electron-builder 26.0.12；`signAndEditExecutable=false` 会保留默认 exe 图标/版本资源，安装包文件名和产品名仍为 fullon。
