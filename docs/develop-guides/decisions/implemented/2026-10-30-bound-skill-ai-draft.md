# 专属 Skill 的 AI 草稿生成

状态：implemented
类型：feature
Owner：backend/yuxi/modules/extensions/skills/generation.py

其他事实 Owner：`backend/yuxi/modules/extensions/skills/bound.py`（首次发布与幂等）、`backend/yuxi/api/routers/agents/management.py`（HTTP 契约）、`frontend/src/modules/agents/ui/AgentBoundSkillPanel.vue`（表单、预览与确认）、`frontend/src/modules/agents/model/boundSkillDraft.js`（载荷整理与表单校验）。

## 问题

不会写 `SKILL.md` 的用户目前只能创建空模板或上传 ZIP。需要在不放松 Agent 管理权限、首次发布限制和版本历史的前提下，由 AI 生成可审阅的草稿，并让用户在保存前检查内容。

## 决策

### 实现方案

- **生成**：新增 `POST /api/agent/{slug}/self-skill/generate`，请求为用途、触发场景、输入输出和可引用工具。service 先校验 Agent 管理权限；已有绑定直接 409；读取系统 `fast_model`，在一次 60 秒有界调用内生成，`max_retries=0`。
- **校验**：模型输出剥离 `<think>` 和包裹整个文件的外层围栏，必须包含 `slug/name/description` frontmatter；拒绝 `tool_dependencies/mcp_dependencies/skill_dependencies`；正文不超过 64 KiB、描述不超过 500 字。生成结果只返回 `content/slug/name/description`，不落盘。
- **保存**：复用 `POST /api/agent/{slug}/self-skill`，新增可选 `content`。`create_agent_bound_skill` 在既有 Agent 行锁、唯一绑定和首次发布语义内写入草稿，并再次调用同一校验；已存在绑定时幂等返回且不覆盖。
- **前端**：专属 Skill 空状态增加「AI 生成」，表单 → 生成草稿 → Markdown 预览 → 保存。草稿不保存时可重新生成；保存失败保留预览供重试。手工「创建模板」和 ZIP 导入保留。
- **信任边界**：生成文本和客户端提交的 `content` 都不可信；写路径以 `normalize_skill_draft` 和 `commit_skill_content` 的解析、预算和依赖校验为准。草稿不能声明依赖，工具名只作为写作提示。

## 替代方案

- 前端先创建空模板再 `PUT /content`：两步之间会发布一个空 Skill，第二步失败留下脏绑定；不采用。
- 让 Agent 通过工具直接创建或覆盖专属 Skill：需要新的写权限入口、覆盖规则和更多负向测试，收益不足以抵消风险；暂不采用。
- 允许模型声明工具/技能依赖：可能引用不存在或用户无权使用的工具；草稿只描述用法，依赖由用户保存后显式配置。
- 在保留态 Skill 上直接 AI 重写：会绕过 revision 与历史版本的审阅节奏；当前要求先删除或走编辑入口。

## 后果

- 生成质量取决于 `fast_model`；模型不可用、超时或输出不合格时返回 502 且不产生绑定，用户可重试。
- 生成调用不属于 Agent Run，不产生 Turn/Run 事件，也不写入会话历史。
- 已有专属 Skill 不支持 AI 重写，避免覆盖既有内容与版本历史。
- 草稿不能自动启用工具依赖；模型只能引用用户在表单里列出的工具名。

## 验证

| 验收主张 | 失败面 | 语义 Owner | 直接证据 / 命令 | 负向案例 | 当前结果 |
|---|---|---|---|---|---|
| 草稿生成、格式校验与错误映射 | 模型输出直接落盘或异常泄露 | `backend/yuxi/modules/extensions/skills/generation.py` | `pytest test/unit/services/skills/test_skill_draft_generation.py test/unit/routers/test_agent_management.py`（10 passed） | 缺 frontmatter、声明依赖、超 64 KiB、模型异常、已绑定 | Passed |
| 草稿随创建保存且不覆盖既有绑定 | 二次提交覆盖专属内容 | `backend/yuxi/modules/extensions/skills/bound.py` | 真实 HTTP + PostgreSQL：`pytest test/integration/api/test_agent_bound_skill.py -k draft` | 非法草稿 422 且不留下绑定；已绑定幂等返回原内容 | Passed |
| 前端表单载荷与校验 | 空用途或超长字段发出请求 | `frontend/src/modules/agents/model/boundSkillDraft.js` | `node --test test/unit/boundSkillDraft.test.js`（3 passed） | 空用途、超 1000 字字段、重复工具 | Passed |
| 面板可构建与交互接线 | 模板编译失败或按钮不可用 | `AgentBoundSkillPanel.vue` | `pnpm run lint:check`、`pnpm run build`；`node --test test/unit/agentBoundSkillPanel.test.js test/unit/agentPermissionRepair.test.js`（22 passed） | 无 | Passed（本机工作树为 CRLF，证据在规范化行尾后取得） |
| 真实模型生成 | 占位 Key 下 401 | `fast_model` 配置 | `Not run`：当前部署使用占位 Key，真实生成需有效模型凭据 | 模型不可用时 502 | Not run |
| 仓库工程契约 | 决策/路径不一致 | `scripts/verify_engineering_contracts.py` | `python scripts/verify_engineering_contracts.py` | 决策记录 Owner 非法 | Passed |
