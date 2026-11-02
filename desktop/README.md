# fullon 桌面客户端

Electron 客户端复用现有 Yuxi 后端，不内置 PostgreSQL、Redis、Milvus 或 worker。

## 开发运行

1. 启动后端：在仓库根目录执行 `docker compose up -d`，默认 API 为 `http://127.0.0.1:5050`。
2. 安装并构建：

```bash
pnpm --dir desktop install
pnpm --dir desktop build:renderer
pnpm --dir desktop start
```

`build:renderer` 会先构建 `frontend/dist`，再复制到 `desktop/renderer`。修改前端后需要重新执行。

## 后端地址

默认读取 `http://127.0.0.1:5050` 与 `http://127.0.0.1:9000`。可在启动前设置：

```bash
FULLON_SERVER_URL=http://192.168.1.10:5050
FULLON_MINIO_URL=http://192.168.1.10:9000
```

也可以编辑用户数据目录下的 `config.json`：

- Windows：`%APPDATA%\fullon-desktop\config.json`
- macOS：`~/Library/Application Support/fullon-desktop/config.json`
- Linux：`~/.config/fullon-desktop/config.json`

渲染进程通过本机 `127.0.0.1:5175` 的静态/反向代理访问后端，保持现有相对路径、SSE 与鉴权头。端口可用 `FULLON_DESKTOP_PORT` 覆盖；改变端口会切换浏览器源，需要重新登录。

## 本地文件夹与 Agent 访问

个人空间通过 preload 暴露的只读桥选择本地目录。主进程只允许访问当前登录用户选中目录内的相对路径，拒绝 `..`、绝对路径、Windows 冒号名称和符号链接逃逸；断开连接会撤销授权，切换账号后主进程按 uid 拒绝旧授权。文件内容和真实路径不会因浏览而上传到后端。

桌面客户端同时在本机 `127.0.0.1:5175` 暴露只读 `/local-files/` 代理，权限由每次启动生成的随机 token 和当前授权根目录共同约束。连接本地文件夹后，前端把 token、代理地址和文件夹名登记到 `PUT /api/workspace/local-folder/broker`，后端 Agent 工具 `list_local_space_files`、`read_local_space_file` 才能读取：

- 仅本机或 Docker 主机网关可访问代理；后端通过 `host.docker.internal:5175` 调用。
- 只读；文本单次最多 64 KiB，二进制只返回元数据，不递归扫描。
- 文件内容作为不可信工具结果进入上下文，不能改变系统指令。
- token 不写入 Agent 消息、事件、日志或错误详情。
- 断开文件夹会删除后端 Redis 授权；应用关闭后迁移到本机的旧授权会因 token 轮换失效。
- 浏览器模式和远程后端（`FULLON_SERVER_URL` 不在本机）无法使用此能力；后端必须能访问桌面主机的 `host.docker.internal`。
- 授权登记在 Redis 中保存 12 小时，桌面端重新进入个人空间会续期。

## 打包

```bash
pnpm --dir desktop pack   # release/win-unpacked
pnpm --dir desktop dist   # release/fullon-0.8.0-beta.5-win.zip
```

当前默认产出可解压运行的 portable zip；`pnpm --dir desktop dist:nsis` 保留 NSIS 安装包目标，但部分 Windows 环境会因进程 Job 限制失败。未签名产物会触发 SmartScreen；正式分发需要代码签名证书。

如果 Electron/NSIS 下载受限，可在构建前设置 `ELECTRON_BUILDER_BINARIES_MIRROR`，例如 `https://npmmirror.com/mirrors/electron-builder-binaries/`。
