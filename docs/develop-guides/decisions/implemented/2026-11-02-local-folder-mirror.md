# 个人空间连接本地文件夹

状态：implemented
类型：feature
Owner：`frontend/src/modules/workspace/model/localFolderSync.js`

其他事实 Owner：`frontend/src/modules/workspace/ui/LocalFolderDialog.vue`（授权、导入、导出交互）、`frontend/src/pages/WorkspaceView.vue`（入口与首次授权提示）。

## 问题

个人空间是服务端按用户隔离的工作区，不是浏览器所在电脑的磁盘。浏览器沙箱无法把任意本地目录直接交给 Docker 中的 Agent；同时多用户部署不能开放宿主机目录。

## 决策

### 实现方案

- 使用 File System Access API 让用户选择本地目录并授予读写权限；目录句柄与同步清单按 `uid` 存入 IndexedDB，只有当前登录用户能恢复。
- 首次进入个人空间自动弹出一次说明；已有连接但权限失效时显示横幅，点击后重新授权。`showDirectoryPicker` 必须由用户点击触发，无法在页面加载时静默调用。
- **导入到个人空间**：递归读取本地文件（跳过 `.git`、`.venv`、`node_modules`、`__pycache__`，上限 2000 个文件 / 512 MB / 单文件 100 MB），确认后按 `个人空间/本地同步/<目录名>/` 结构上传；同名文件先删除再上传，Agent 与网页随后操作服务端副本。
- **保存到本地**：逐目录读取服务端文件列表（递归 tree 接口会按目录静默截断，不能用于删除判断），写回用户选择的目录；覆盖前确认；仅删除「清单中记录过、且已从个人空间消失」的本地文件，并在确认框列出待删项。同步清单只在该目录的 IndexedDB 记录中，不上传服务端。
- 浏览器句柄能力封装在 `localFolderSync.js`；Electron 客户端可用主进程文件系统实现替换 `pickLocalFolder` 与读写函数，导入/导出流程不变。

## 替代方案

- 宿主机目录 bind mount：实现简单，但所有请求共享同一宿主路径，无法满足多用户隔离，且要求改 Compose。
- 本机伴生进程：可让 Agent 真正实时读写本地文件，但引入新进程、端口、token 与防火墙配置；留作 Electron 客户端方案。
- 仅浏览器本地文件管理器：网页可读写本地文件，但 Agent 完全不可见，不满足「Agent 也能修改」。

## 后果

- 不是实时双向同步：Agent/网页修改服务端副本后，必须点「保存到本地」才写回磁盘；页面关闭时无法同步。
- 导入会覆盖个人空间同名文件；批次中途失败可能留下部分文件，重试会继续覆盖。
- 远程文件列举按目录逐次请求，目录很多时会增加请求数。
- 只支持 Chromium 系浏览器（Chrome/Edge）；Safari/Firefox 显示不支持提示。
- 本地目录的权限与句柄属于当前浏览器配置；换浏览器或清除站点数据后需要重新选择。
- 删除本地文件前必须确认；从未同步过的本地新文件不会被导出流程删除。
- 目录名会做安全字符替换；不同本地目录若同名会共用同一个 `本地同步/<目录名>` 服务端目录。

## 验证

| 验收主张 | 失败面 | 语义 Owner | 直接证据 / 命令 | 负向案例 | 当前结果 |
|---|---|---|---|---|---|
| 本地目录扫描与路径映射 | 目录迭代或前缀判断错误导致漏文件/误删 | `localFolderSync.js` | `node --test test/unit/localFolderSync.test.js`（7 passed：扫描跳过依赖目录、前导斜杠、逐目录远程列举、覆盖/删除计划、嵌套写入、缺失文件删除） | `demo2` 前缀不匹配；未同步本地文件不进入删除计划 | Passed |
| 前端构建与类型 | 组件/模块编译错误 | `LocalFolderDialog.vue`、`WorkspaceView.vue` | `npx eslint ... --max-warnings=0`、`npm run typecheck`、`npm run build` | 无 | Passed |
| 浏览器授权与入口 | 进入个人空间不提示或重复弹窗 | `WorkspaceView.vue` | Chromium：清除 session 标记后首次打开自动弹窗，关闭后再次访问不再弹窗；无控制台错误 | 已连接且已授权时不弹窗 | Passed |
| 导入、Agent 修改、导出、删除 | 导出 JSON 信封而非原文；删除不确认 | `LocalFolderDialog.vue` | Chromium + OPFS 真实目录句柄：导入 2 文件；再次导入覆盖同名文件；API 改写 a.txt 后导出，本地内容为 `agent-v4`；服务端删除 `sub/b.txt` 后导出，确认框列出该文件，确认后本地返回 NotFoundError | 未同步文件不被删除；取消确认不写入 | Passed |
