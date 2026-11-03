# Agent 读写桌面工作区本地文件

状态：implemented
类型：architecture
Owner：desktop/lib/local-broker.js

## 问题

工作区已经能在 Electron 渲染进程里实时浏览本地文件夹，但 Agent 运行在 Docker 后端，无法访问用户电脑上的目录。用户还需要 Agent 能创建、覆盖和删除工作区中的文件。直接让后端挂载宿主机路径需要重新配置 Compose、无法按用户隔离，也不能实时跟随用户更换文件夹。

## 决策

### 实现方案

Electron 主进程拥有代理与根目录校验；`backend/yuxi/modules/workspace/local_broker.py` 拥有 Redis 授权的归一化与生命周期；`backend/yuxi/modules/extensions/tools/builtin/local_space.py` 拥有 Agent 工具到代理的调用链。前端只负责在连接/恢复时登记，断开时撤销。


在 Electron 主进程内增加本机文件代理，后端通过短期授权登记调用；写删默认经过人工审批：

1. Electron 复用 `127.0.0.1:5175` 本地服务，提供 `GET /local-files/list`、`GET /local-files/read`、`POST /local-files/write`、`POST /local-files/delete`。
2. 代理只服务当前 `allowedRoot`，请求必须携带应用启动时生成的随机 Bearer token；Host 只放行 loopback，`/local-files/` 额外放行 Docker 主机网关。
3. 前端连接/恢复桌面文件夹后，通过 `PUT /api/workspace/local-folder/broker` 登记 `{urls, token, folder_name}`；断开时 `DELETE` 撤销。
4. 授权保存在 Redis（`yuxi:local-broker:<uid>`，TTL 12 小时），不写业务数据库；它描述临时客户端能力，重启或断开后应失效。
5. 四个基础 Agent 工具 `list_local_space_files`、`read_local_space_file`、`write_local_space_file`、`delete_local_space_path` 按运行时 `uid` 读取授权，依次尝试 loopback 与 `host.docker.internal` 地址。
6. 写删工具由 `HumanInTheLoopMiddleware` 在默认审批模式下拦截；审批通过后才调用代理。
7. 代理只返回相对路径、文件名和受限内容；不返回真实绝对路径，二进制不返回数据体，token 不进入 Agent 上下文或日志。

## 替代方案

- **把宿主机目录挂载进容器**：需要改 Compose 和 Docker Desktop 文件共享，换目录要重启，无法按用户隔离。
- **把文件复制到服务端工作区**：违背工作区“不导入、不复制”的产品约束，也会产生陈旧副本。
- **让后端直接读宿主机绝对路径**：Docker 与远程后端不可达，且绕过桌面授权边界。
- **暴露 Electron IPC 为网络接口**：会扩大攻击面；当前只暴露固定文件 HTTP 路由和 token。

## 后果

- Agent 能在用户明确选择的桌面文件夹中读取、创建/覆盖 UTF-8 文本文件、删除普通文件或空目录，不能递归删除、写二进制或访问其他目录。
- 写删默认需要用户审批；`always_trust` 模式会跳过审批，需要用户明确选择。
- 依赖桌面客户端运行、Docker 能访问 `host.docker.internal`；远程后端和浏览器模式不支持。
- 授权是临时能力：应用重启会轮换 token，旧授权自然失效；用户需要重新进入工作区以续期。
- Redis 不可用时工具明确返回未连接，不静默降级为其他文件来源。
- 文件内容可能包含提示注入；工具描述和系统边界将其视为不可信数据。
- 写入会创建缺失的父目录并覆盖已有文件；单次最多 1 MiB，删除非空目录会失败。

## 验证

- `desktop/test/local-broker.test.js`：token 拒绝、目录列表、文本/二进制语义、路径穿越、未连接、写入/覆盖/删除、超限写入、非空目录删除。
- `desktop/test/local-files.test.js`：写入/删除拒绝符号链接逃逸。
- `backend/test/unit/workspace/test_local_broker.py`：URL/令牌校验、工具路径校验、地址回退、撤销错误、写入 POST 载荷、审批登记、运行时装配。
- `frontend/test/unit/localFolderSync.test.js`：桌面桥 broker 信息透传。
- 真实 Electron + Docker：用户登录后连接临时目录，UI 显示“Agent 可读写”；后端通过 `host.docker.internal` 列出、写入、读回并删除文件；断开后立即返回未连接。
