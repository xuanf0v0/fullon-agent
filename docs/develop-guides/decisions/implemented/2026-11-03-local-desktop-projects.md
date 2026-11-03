# 桌面本地工作区 Project

状态：implemented
类型：architecture
Owner：backend/yuxi/modules/workspace/services/projects.py

## 问题

工作区页面可以浏览桌面本地文件夹，但新建 Project 的目录选择器只读取服务端工作区。两者显示的不是同一个来源：用户在桌面工作区选择 `D:\...` 后，新建项目仍显示服务端 `agents` 等目录，Project Workdir 也只接受服务端相对路径。

## 决策

新增 `directory_mode='local'` 的桌面本地 Project：

1. Project 保存 `local_root`（相对于当前桌面工作区根目录，不能是根目录），同时分配一个服务端影子 Workdir，用于会话元数据、上传附件和现有运行链路。
2. 新建项目弹窗检测桌面本地工作区连接；可用时默认显示“本地工作区”目录选择器，并允许切回服务端工作区。
3. 本地 Project 的 Agent 运行时携带 `local_project_root`。`list/read/write/delete_local_space_file` 工具在该前缀下调用桌面文件代理，不能越过 Project 目录。
4. 本地 Project 的系统提示要求使用本地工具操作项目文件；服务端影子 Workdir 不作为本地项目文件来源。
5. business Schema 升至 v3，新增 `local_root`、扩展目录模式约束，并提供可审计迁移脚本。
6. 本地目录必须由桌面客户端连接；浏览器模式和远程后端不能创建可用的本地 Project。

## 替代方案

- **只改选择器文案**：显示与服务端 Project 实际目录仍不一致，用户会误以为文件在本地。
- **把本地目录挂载进容器**：需要 Docker Desktop 文件共享和 Compose 变更，换目录要重启，也无法按用户隔离。
- **镜像本地目录到服务端**：会产生陈旧副本，违背工作区实时语义。
- **只允许服务端 Project**：保持现状，但无法满足桌面工作区与项目目录一致。

## 后果

- 本地 Project 仅在 Electron 桌面客户端且有本地工作区授权时可用。
- 项目文件走本地代理；附件、交付物和服务端影子目录仍走现有链路，不能把两者混为同一目录。
- 本地目录按“当前授权根目录 + 相对本地路径”解释；更换授权根目录可能导致项目文件不可达，需要重新选择或处理。
- 根目录不能直接作为 Project 目录，避免把整个工作区误设为项目边界。
- 服务端 Project 语义保持不变；本地 Project 不改变 Run/Turn、FIFO、审批和权限边界。

## 验证

- 迁移：`local_projects` 审计/转换，business v2→v3，约束和 `local_root` 列存在。
- 服务：本地 Project 创建、影子 Workdir 分配、幂等创建意图、绑定 `local_root`。
- 工具：带 `local_project_root` 时列表、读取、写入、删除均限制在项目前缀，返回路径仍相对项目目录；无前缀时保持全局工作区行为；越界路径和删除根目录在请求前失败。
- 前端：桌面工作区连接后显示本地/服务端来源切换；目录选择默认同步当前本地工作区路径；桌面重启后首次打开项目弹窗会重新登记本地代理授权。
- 真实 Electron + Docker：创建本地 Project、选择 `D:\fullon-local-project-smoke`、项目记录 `local_root` 正确、Agent 工具可读取项目内文件；SPA 从本地工作区 `D:\agent` 进入会话后，新建项目本地选择器默认显示 `agent`。
