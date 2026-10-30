# fullon 品牌与两项 harness 能力移植

状态：implemented
类型：feature
Owner：backend/yuxi/modules/schedules/service.py

其他事实 Owner：`backend/yuxi/modules/knowledge/manager.py`（文件文本只读）、`backend/yuxi/modules/system/static/info.template.yaml`（品牌默认值）、`frontend/src/modules/session/model/knowledge_injection.js`（消息注入）。

## 问题

fork（`deepseek-harness-master`）中的自建能力需要落到 Yuxi。核对后多数能力（技能、MCP、技能广场、Agent 创作、cron 定时任务、知识库 RAG）Yuxi 已有且更完整；真实缺口是品牌仍为「语析/Yuxi」、定时任务没有一次性绝对时间模式、聊天无法把知识库文件文本直接注入本轮消息。

## 决策

- **品牌**：`info.template.yaml` 的 `branding.name/logo` 与 `footer.copyright` 为 fullon；`frontend/index.html` 标题与 favicon 指向 `frontend/public/fullon-mark.png`（模块级 PNG）；前端三处兜底名、CLI 授权页文案、问候示例与 discovery 产品名同步。品牌仍由既有 YAML + public 资源拥有，没有运行时品牌服务。
- **一次性任务**：`scheduled_agent_jobs` 增加 `schedule_kind('cron'|'once')` 与 `run_at`，`cron_expression` 可空，CHECK 约束保证两种形状互斥。`next_run_at` 仍是唯一调度事实（once = run_at）。worker 领取 once 任务时，在同一事务把 `enabled` 置 False；若已有进行中的运行，则不消费任务、把 `next_run_at` 顺延 30 秒重试。`dispatch_scheduled_run` 仅对删除的任务或停用的周期任务取消投递，已领取的一次性触发继续投递，因此恢复任务也能感知到停用前的领取。校验在 service 层拒绝过去时间、无时区时间、空内容与形状混用；执行方式创建后不可切换。数据库无 Alembic：business 版本升到 2，新增幂等迁移脚本。
- **知识库文件注入**：新增只读 `GET /api/knowledge/knowledge-bases/{kb_id}/documents/{doc_id}/text`（管理员读取权限、文档型库门禁、默认 64 KiB 字节上限、UTF-8 边界截断），复用文件解析后的 Markdown；`open_file_content`/`find_file_content` 与新读取共用同一加载路径。聊天侧沿用现有 `@` token：新增 `kb-file` 类型，候选来自当前选中知识库的文件名搜索；发送前把 token 解析为文件文本，组装为带动态围栏的注入块追加到用户消息。整条消息受 Public API 32768 字符上限约束，按剩余预算截断并标注；读取或权限失败时阻断发送并恢复原始草稿。消息文本即模型可见内容，没有隐藏字段。

## 替代方案

- 新建 harness 式平面文件库：会复制上传、权限、清理与存储边界，并与知识库并存形成两套文件事实；不采用。
- 用 cron 模拟一次性：cron 无年份且会重复，需要伪状态；不采用。
- 启动时把过期一次性任务标记 `missed`：Yuxi API 与 worker 进程分离，无法可靠识别停机窗口，且会丢弃用户任务；改为到期补跑。
- 服务端解析 `@` token 并注入：需要改消息协议与前端展示，与现有 token 仅文本的契约冲突；维持客户端注入（与 harness 一致）。
- 独立移植技能广场、MCP 管理器、agent-reach provider、账号控制台：Yuxi 已有等价或更完整机制；不采用。

## 后果

- 一次性任务在 worker 长时间停机后会延迟执行而不是丢弃；用户无法通过停用取消已领取但尚未投递的一次性触发，删除任务仍可取消。
- 注入内容会出现在聊天气泡与会话历史中，大文件占用上下文；由 64 KiB 读取上限与 32768 字符消息预算控制。
- 知识库 HTTP 读接口要求管理员权限，文件候选只在管理员可见的知识库范围内出现。
- 旧数据库必须以 business v2 迁移启动；版本不匹配时 app-init 明确失败，不会静默回退。
- 前端 `@` 菜单新增的异步文件搜索只覆盖当前 Agent 已选知识库；非文档型知识库没有候选。

## 验证

| 验收主张 | 失败面 | 语义 Owner | 直接证据 / 命令 | 负向案例 | 当前结果 |
|---|---|---|---|---|---|
| 默认真实模板中的品牌为 fullon + PNG 图标 | 页面仍显示语析/Yuxi | `backend/yuxi/modules/system/static/info.template.yaml` | `pytest test/unit/routers/test_system_router.py`（读取真实模板断言 name/logo/copyright） | discovery 或 footer 残留旧名 | Passed |
| 一次性任务创建、校验、领取后停用、重复运行顺延 | 重复触发/不触发/丢失 | `backend/yuxi/modules/schedules/service.py` | `pytest test/unit/services/test_scheduled_agent_service.py test/unit/routers/test_scheduled_agent_router.py`（33 passed） | 过去时间、无时区、形状混用、进行中的运行 | Passed |
| 一次性任务到点新建会话并发送首条消息 | 触发被误取消 | `backend/yuxi/modules/schedules/service.py` | `_dispatch_cancelled` 单测覆盖删除/停用/once 组合；真实 worker+API 链路 `Not run`（未启动完整栈） | 停用的 cron 触发被投递、领取后的 once 被取消 | Not run |
| 一次性任务数据库形状与约束 | 混用形状写入/旧行迁移失败 | `backend/yuxi/migrations/one_shot_schedules.py` | 真实 PostgreSQL：集成测试 `test_once_job_claim_disables_after_first_run_and_rejects_cron_shape`；迁移 smoke：全新基线 v2 → 模拟 v1 → `--apply` 两次 → v2 且约束恢复 | once + cron_expression 同时写入被 CHECK 拒绝 | Passed |
| 既有 cron 任务行为不变 | 既有任务停发或重复 | `backend/yuxi/modules/schedules/service.py` | 真实 PostgreSQL：`pytest test/integration/services/test_scheduled_agent_repository.py`（5 passed） | once 约束拒绝 cron 行 | Passed |
| 知识库正文接口截断、未解析拒绝、权限门禁 | 空注入/超长返回/越权 | `backend/yuxi/modules/knowledge/manager.py` | `pytest test/unit/knowledge/test_document_text_injection.py test/unit/routers/test_knowledge_documents_router.py`（UTF-8 边界 7 字节截断、ValueError→400） | 未解析文件、folder、非文档库 | Passed |
| 聊天引用解析、去重、注入预算、失败阻断 | 超长 422/静默空注入 | `frontend/src/modules/session/model/knowledge_injection.js` | `node --test frontend/test/unit/knowledge_injection.test.js`（10 passed，含 32768 字符预算与块头装不下的可读错误） | 读取失败、空正文、超预算 | Passed |
| 发送/重试草稿恢复 | 注入文本回填输入框 | `frontend/src/modules/session/ui/SessionWorkspace.vue` | `node --test frontend/test/unit/threadCreation.test.js test/unit/widgetSubmission.test.js`（28 passed，含重试复用注入文本） | 首条创建失败恢复、重试后 4xx | Passed |
| 真实页面品牌与 @ 知识库文件发送 | 展示或链路与单测不一致 | 前端页面 + API | 浏览器验证 `Not run`（未启动完整栈） | 无知识库选择时出现空分组 | Not run |
| 仓库工程契约 | 决策/文档/路径不一致 | `scripts/verify_engineering_contracts.py` | `python scripts/verify_engineering_contracts.py` | 决策记录 Owner/矩阵非法 | Passed |
| 后端 unit 全量 | 破坏既有行为 | 全仓库 | `pytest test/unit -m "not slow"`（Linux 容器，真实依赖；3486 passed / 12 skipped） | 既有定时任务/知识库回归 | Passed |
| 前端 unit 全量 | 破坏既有行为 | 全仓库 | `pnpm run test:unit`：受影响用例与新用例通过；其余 source-slice 用例在本 Windows CRLF 检出下失败（未改动文件，环境限制） | 无 | Not run |

环境说明：本机无完整 compose 栈（无 `.env`、无预构建镜像），后端 unit 在 `python3.12-bookworm-slim` 容器内使用同一依赖清单执行；真实 PostgreSQL 使用一次性 `postgres:16` 容器。前端 lint、build 通过。
