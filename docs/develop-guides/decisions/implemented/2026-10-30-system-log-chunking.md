# 系统日志分块加载

状态：implemented
类型：feature
Owner：backend/yuxi/api/routers/system.py

其他事实 Owner：`frontend/src/modules/settings/ui/DebugComponent.vue`（分块渲染与加载更多）、`frontend/src/apis/system_api.js`（HTTP 参数）。

## 问题

系统日志页每次自动刷新都重新渲染最多 1000 行，浏览器里行数一多就卡顿；后端每次请求还要逐行扫描整个日志文件，文件变大后请求变慢。

## 决策

### 实现方案

- `GET /api/system/logs` 新增 `limit`（默认 200，范围 1–1000），先按 `levels` 过滤，再取尾部 `limit` 行；响应新增 `has_more` 表示窗口内是否还有更早的匹配行。
- 后端只读取文件末尾 4 MiB（最多 20000 行）作为候选窗口，不再扫描完整文件；窗口外更早的日志不返回。
- 前端首次请求 200 行；`has_more` 为真且未到 1000 时显示「加载更早日志」，每次增加 200 行并重新请求。
- 加载更多时若用户已向上滚动，先记录首个可见行及其相对视口位置；更新后用旧、新日志数组做连续后缀对齐，把该行映射到新下标并按视口偏移还原，避免重复行与前后插入导致跳动。跟随最新日志时仍滚到底部。自动刷新沿用当前 `limit`；关闭面板或清空日志时重置分块状态并恢复为 200。
- 复制与下载在导出时重新请求 1000 行并按当前过滤条件筛选，避免只导出已加载的分块。

## 替代方案

- 仅前端切片渲染：DOM 变小，但后端仍扫描整文件，请求耗时随文件增长。
- `offset` 分页：需要稳定行号，日志持续追加时边界不清，且前端要合并多页与自动刷新。
- 流式/SSE 增量推送：需要新的连接生命周期与断线补偿，超出当前诊断面板需求。
- 保留整文件扫描再取 1000 行：继续为超大文件付全量 I/O。

## 后果

- 只能看到最近 4 MiB 内的日志；更早内容需另行下载或查看日志文件。
- 级别过滤发生在窗口内，稀有级别若不在最近 4 MiB 中则不会出现。
- 默认响应从最多 1000 行降到 200 行，自动刷新流量和渲染量随之下降。

## 验证

| 验收主张 | 失败面 | 语义 Owner | 直接证据 / 命令 | 负向案例 | 当前结果 |
|---|---|---|---|---|---|
| 尾部窗口读取与 limit 截取 | 整文件扫描或返回超限 | `backend/yuxi/api/routers/system.py` | `pytest test/unit/routers/test_system_router.py`（8 passed）；窗口缩至 4 KiB 后首行不再是文件首行 | `limit=0` 与 `limit=1001` 返回 422；过滤先于截取 | Passed |
| 真实 HTTP 与进程日志归属 | 返回 worker 日志或漏掉末尾标记 | `test_system_router_api.py` | `pytest test/integration/api/test_system_router_api.py`（4 passed, 12 skipped） | 非管理员无权限；worker 标记不出现 | Passed |
| 前端分块与滚动保持 | 加载更多后视图跳动 | `DebugComponent.vue` | Chromium：200 行 → 两次加载至 600 行；自动刷新关闭后在 200 行处滚动，向日志追加 5 行与锚点完全相同的文本，再加载至 400 行：原锚点视口偏移 -16.0 → -15.9px，重复行落在下方；自动刷新后仍保持当前分块；清空后面板为空且按钮隐藏，刷新恢复 200 行；关闭再打开恢复 200 行 | 无更早匹配行时 `has_more=false`，按钮隐藏 | Passed |
| 复制/下载补齐到 1000 行 | 只导出当前分块 | `DebugComponent.vue` | Chromium：加载 400 行时复制，剪贴板 1000 行且包含新增日志 | 接口失败时回退当前内容并提示 | Passed |
| 前端静态检查 | 编译或类型错误 | `system_api.js` / `DebugComponent.vue` | `npx eslint … --max-warnings=0`、`npm run typecheck`、`npm run build` | 无 | Passed |
