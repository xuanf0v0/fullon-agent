# 从 Docker 后端走向客户端优先的架构方案

状态：proposed
类型：architecture
Owner：desktop/main.js

## 问题

当前桌面客户端复用 Docker Compose 中的 API、worker、PostgreSQL、Redis、MinIO、Milvus、Neo4j 和沙盒服务，工作区只能由渲染进程读取本地目录，Agent 看不到这些文件。产品希望：

1. 项目逐步脱离 Docker，以 Electron 客户端为主要运行形态。
2. Agent 能读取工作区中选择的本地文件。

两个目标的成本差异很大，需要分开决策。

## 提案

### 实现方案

Docker 承担当前架构的持久化、并发和隔离边界。移除它必须逐项替换并重做失败恢复语义。方案分为两条可独立验收的路线。

#### 形态 A：混合桌面（Phase 1 已实施）

- Electron 主进程启动只读本机文件代理，复用 `127.0.0.1:5175` 的 `/local-files/` 路由。
- 每用户 token 与当前授权根目录绑定；后端通过 `host.docker.internal:5175` 调用。
- 前端把 broker 地址、token 和文件夹名登记到后端 Redis，Agent 工具按运行时 uid 读取。
- 只读；文本单次最多 64 KiB，二进制只返回元数据；断开连接立即撤销。
- 后端继续由 Compose 或本地进程提供，Run/Turn、权限、checkpoint 和 worker 语义保持不变。

#### 形态 B：桌面单用户版（独立产品分叉）

- Electron 管理 Python sidecar 的启动、日志、端口、健康检查和重启。
- API 与 worker 合并为单进程，任务队列由 PostgreSQL/SQLite 持久化，移除 Redis/ARQ 依赖。
- PostgreSQL 内嵌便携版；MinIO 改为本地对象目录；Milvus/Neo4j 替换为 Windows 可用的嵌入式实现。
- Agent 文件工具直接访问授权目录；路径校验、符号链接防护和审计仍为硬要求。
- 支持单用户、本地模型或 API Key；多租户、多 worker、OIDC、集群能力在桌面版中缩减或移除。

#### 形态 C：纯客户端重写

Agent runtime、队列、持久化、检索全部改用 TypeScript，删除 Python 后端。功能对齐成本最高，且与现有 LangGraph/DeepAgents/工具生态脱节。该形态不推荐。

#### 阶段

Phase 1 已实施并验证，见 [Agent 读取桌面工作区本地文件](../implemented/2026-11-02-agent-local-space-access.md)。本记录保留 Phase 2–4 的决策空间。

1. **Phase 1**：实现本机文件代理与 Agent 工具，保留 Docker。验收后直接解决 Agent 读本地文件。
2. **Phase 2**：Electron 管理 Python sidecar，保留外部 PostgreSQL/Redis/MinIO/Milvus/Neo4j，去掉 Compose 启动依赖。
3. **Phase 3**：按风险从低到高替换 MinIO、Redis/ARQ、Milvus、Neo4j、沙盒。每步提供双实现、迁移脚本、回滚开关和真实链路测试。
4. **Phase 4**：合并进程、打包 sidecar、确定数据目录、备份、卸载、崩溃恢复和升级迁移合同。

#### 数据迁移

- PostgreSQL：便携版初始化，导入现有 dump，校验 schema 版本；保留原卷只读回滚点。
- MinIO：对象 key 不变迁移到本地目录，校验 checksum 后切换读取路径。
- Milvus：导出 collection 元数据并重建索引；embedding 成本需单独评估。
- Neo4j：导出节点/关系，按新图存储 schema 重建，回归图查询语义。
- 迁移必须可审计、可重试，禁止首次启动自动迁移后删除旧数据。

#### 安全与隔离

- Windows 沙盒无法等同容器隔离；需要独立威胁建模和逃逸测试。
- Electron broker 仅监听 loopback，使用 token、uid、根目录三重校验。
- Python sidecar 以当前用户运行，Agent 工具仍通过代理或受限进程与 sidecar 权限分离。
- 更新包和 sidecar 需要签名、校验和回滚；模型 Key 存 OS 凭据库。

## 替代方案

- **保留 Docker，只做本机文件代理**：满足 Agent 读本地文件，保留现有部署与多用户能力。这是当前已实施的 Phase 1。
- **把宿主机目录挂载进容器**：需要改 Compose 和 Docker Desktop 文件共享，换目录要重启，无法按用户隔离。
- **把文件复制到服务端工作区**：产生陈旧副本，违背工作区实时浏览的产品约束。
- **直接重写为纯客户端 Agent 运行时**：功能对齐和迁移成本最高，工具生态需要整体重建。
- **要求用户安装 WSL2 代替 Docker**：仍是虚拟化依赖，桌面安装与支持成本没有实质下降。

## 验收标准

| 验收主张 | 失败面 | 语义 Owner | 直接证据 / 命令 | 负向案例 | 当前结果 |
|---|---|---|---|---|---|
| Phase 1 Agent 可在授权根目录内读写文本 | token 错误、路径越界、断开后仍可读 | `backend/yuxi/modules/extensions/tools/builtin/local_space.py` | 真实 Electron + Compose 调用 `read_local_space_file` | 跨 uid、`..`、符号链接、断开后调用 | Passed |
| Phase 1 授权只存在临时 Redis 记录 | token 写入数据库或日志 | `backend/yuxi/modules/workspace/local_broker.py` | 注册 API + Redis `GET` + 日志检查 | 非本机 URL、弱 token、撤销后读取 | Passed |
| Phase 2 无 Compose 也能完成一条 Run | sidecar 崩溃后 Run 卡住 | `desktop/main.js` 与 sidecar supervisor | 停止 Compose，启动 sidecar，完成真实 Run | 进程退出、端口冲突、迁移失败 | Not run |
| Phase 3 每个替换保留真实语义 | 单元测试通过但 worker/恢复失败 | 对应 repository 与 service | 真实 PostgreSQL、worker、HTTP 回归 | 双写失败、回滚开关失效 | Not run |
| Phase 4 桌面升级可恢复数据 | 升级中断导致会话或索引不可用 | 安装器与迁移 Owner | 升级/回滚演练与备份恢复 | 断电、旧版本回滚、磁盘不足 | Not run |

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 功能缩水 | 知识库、图谱、多用户能力丢失 | 明确桌面版支持矩阵，不承诺全功能 |
| 数据迁移失败 | 会话、知识库、索引不可用 | 迁移预演、双写、备份、回滚 |
| 沙盒逃逸 | 本机文件或凭据泄露 | 独立威胁建模、最小权限、禁用高风险工具 |
| sidecar 崩溃 | Run 卡住或重复执行 | lease、恢复、幂等和启动自检 |
| 安装包体积和杀软误报 | 无法分发 | 分阶段裁剪依赖、签名与白名单沟通 |
| 端口或防火墙冲突 | 后端不可达 | 固定 loopback、冲突检测、清晰错误 |
| 索引重建成本 | 知识库上线延迟 | 后台重建、进度与回滚 |
