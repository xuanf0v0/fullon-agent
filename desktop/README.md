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

## 本地文件夹

个人空间通过 preload 暴露的只读桥选择本地目录。主进程只允许访问当前登录用户选中目录内的相对路径，拒绝 `..`、绝对路径和符号链接逃逸；断开连接会撤销授权，切换账号后主进程按 uid 拒绝旧授权。文件内容和真实路径不会上传到后端。

Agent 运行在 Docker 内，仍无法读取桌面客户端选择的目录。

## 打包

```bash
pnpm --dir desktop pack   # release/win-unpacked
pnpm --dir desktop dist   # release/fullon-0.8.0-beta.5-win.zip
```

当前默认产出可解压运行的 portable zip；`pnpm --dir desktop dist:nsis` 保留 NSIS 安装包目标，但部分 Windows 环境会因进程 Job 限制失败。未签名产物会触发 SmartScreen；正式分发需要代码签名证书。

如果 Electron/NSIS 下载受限，可在构建前设置 `ELECTRON_BUILDER_BINARIES_MIRROR`，例如 `https://npmmirror.com/mirrors/electron-builder-binaries/`。
