# 个人空间直接浏览本地文件夹

状态：implemented
类型：feature
Owner：frontend/src/modules/workspace/model/localFolderSync.js

## 问题

个人空间原先展示服务端用户工作区，用户希望进入个人空间后直接看到电脑上的真实文件夹，而不是先上传或导入副本。镜像方案需要扫描整棵目录、复制文件并处理覆盖与删除冲突；选中系统盘时还会遇到 `$RECYCLE.BIN` 等目录和单文件 100 MB 上限，无法满足“实时本地文件夹”的预期。

## 决策

### 实现方案

- 个人空间前端从服务端文件列表切换为 `LocalFolderBrowser`，通过浏览器 File System Access API 让用户选择本地目录，并用目录句柄实时列举当前层级。只读取当前目录，不递归、不扫描、不复制。
- 目录句柄和文件夹名按 `uid` 存在浏览器 IndexedDB（数据库 `yuxi-local-folder`，主键 `uid`），刷新页面后恢复；权限失效时显示重新授权，授权必须在用户手势中完成。
- 文件预览在浏览器内完成：图片生成 object URL，文本读取后展示，其他类型提供下载；不经过服务端，也不进入 Agent 上下文。
- `$RECYCLE.BIN`、`$Recycle.Bin` 与 `System Volume Information` 不展示（大小写无关）；其他目录按文件夹优先、名称自然排序展示。
- 设置页 Memory 等 `?open=` 单文件深链仍通过服务端预览弹窗打开，不恢复服务端目录浏览。
- 个人空间界面隐藏服务端的上传、搜索、创建目录和删除入口。服务端用户工作区及 Agent 工具保留，供 Agent 自己使用，但不再作为个人空间 UI 的展示源。
- Electron 客户端通过 preload 原生桥替换 `pickLocalFolder` 和目录读写适配层，浏览器组件与交互不变；见 [Electron 桌面客户端](./2026-11-02-electron-desktop-client.md)。

### 边界

Agent 运行在 Docker 内，无法读取浏览器目录句柄或桌面客户端的原生目录；网页与客户端都只提供本地浏览与预览，不承诺 Agent 实时读写。需要该能力时必须引入本机伴生服务或私有镜像同步。

## 替代方案

- 服务端镜像导入/导出：需要复制、覆盖和删除同步，受单文件大小与扫描成本限制，且用户明确要求不导入，拒绝。
- 仅上传文件：不是实时本地目录，拒绝。
- 本机伴生进程：可以让 Agent 实时读写，但需要安装、开机启动、端口和目录授权，当前 Electron 客户端尚未存在，暂缓。
- 后端挂载宿主磁盘：绕过现有工作区 `O_NOFOLLOW` 边界并暴露整块磁盘，拒绝。

## 后果

- 网页端只在 Chromium 内核且安全上下文中可用；Electron 客户端通过原生桥使用，不依赖 File System Access 权限弹窗。
- 浏览、预览不产生服务端副本，服务端个人工作区不会出现用户本地文件。
- 不提供本地文件搜索、上传、删除或编辑；大目录只加载当前层，切换目录时按需读取。
- 断开会删除浏览器中保存的句柄，不触碰本地文件；更换文件夹会覆盖当前连接。
- 多账号共用浏览器时按 `uid` 隔离句柄；退出登录不会自动删除，换账号读取的是各自记录。
- Agent 的 `AGENTS.md`、产物和会话文件仍保存在服务端个人工作区，与本地浏览互不影响。

## 验证

| 验收主张 | 失败面 | 语义 Owner | 直接证据 / 命令 | 负向案例 | 当前结果 |
|---|---|---|---|---|---|
| 只读取当前目录且过滤系统目录 | 递归扫描或误展示回收站 | `readLocalDirectory` | `node --test frontend/test/unit/localFolderSync.test.js`（5 passed） | `$Recycle.Bin` 中的文件不出现 | Passed |
| 目录句柄按用户恢复 | 刷新后丢失连接或串号 | IndexedDB `connections` | Chromium 刷新后仍展示 `demo-live` | 断开后连接记录为空 | Passed |
| 浏览反映本地最新内容 | 使用旧快照 | `loadDirectory` | Chromium 外部新增 `live-added.txt` 后点击刷新出现；离开再返回个人空间自动出现 | 返回前不存在 | Passed |
| 服务端单文件深链仍可预览 | 返回个人空间后深链失效 | `openFileByPath` / 预览弹窗 | Chromium 打开 `/workspace?open=/agents/MEMORY.md` 显示 MEMORY 内容 | 关闭弹窗后保留本地空间 | Passed |
| 关闭服务端预览后不串源 | 弹窗关闭后切知识库复活旧预览 | `closePreview` / `canInlinePreview` | `node --test test/unit/workspacePreviewLifecycle.test.js`（3 passed） | personal 宽屏关闭后切知识库不出现旧预览 | Passed |
| 预览不经过服务端 | 内容上传或预览失败 | `openPreview` | Chromium 打开 `nested.txt` 显示 `nested content` | 服务端工作区无对应文件 | Passed |
| 本地文件不进入服务端 | 镜像残留 | `LocalFolderBrowser` | 连接 `demo-live` 后服务端个人工作区未新增 `本地同步` | 不使用任何 workspace 上传接口 | Passed |
| 前端可构建 | 类型或模板错误 | `WorkspaceView.vue` | `npm run typecheck`、`npm run build`、eslint | 无 | Passed |

浏览器验证使用 OPFS 目录和覆盖 `showDirectoryPicker` 的测试桩，验证后已断开连接并删除测试目录。
