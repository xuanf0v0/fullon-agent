const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const http = require('node:http')
const https = require('node:https')
const path = require('node:path')
const { URL } = require('node:url')
const { samePath, isInside, resolveWithin } = require('./lib/local-files')
const { parseRequestPath, buildProxyTarget } = require('./lib/proxy')
const { handleBrokerRequest } = require('./lib/local-broker')

const DEFAULT_CONFIG = {
  serverUrl: 'http://127.0.0.1:5050',
  minioUrl: 'http://127.0.0.1:9000',
  allowedRoot: '',
  allowedRootUid: ''
}
const LOCAL_PORT = Number(process.env.FULLON_DESKTOP_PORT || 5175)
const MAX_TEXT_BYTES = 200_000
const MAX_FILE_BYTES = 20 * 1024 * 1024
const SYSTEM_ENTRIES = new Set(['$recycle.bin', 'system volume information'])
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.py', '.css',
  '.html', '.htm', '.yml', '.yaml', '.toml', '.ini', '.log', '.csv', '.sh', '.bat', '.ps1', '.xml'
])
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp']
])
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
}

let mainWindow = null
let localServer = null
let config = { ...DEFAULT_CONFIG }
let allowedRoot = ''
let allowedRootUid = ''
let brokerToken = crypto.randomBytes(32).toString('hex')

function configFile() {
  return path.join(app.getPath('userData'), 'config.json')
}

function normalizeUrl(value, fallback) {
  try {
    const url = new URL(String(value || fallback))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback
    return url.origin
  } catch {
    return fallback
  }
}

async function loadConfig() {
  config = { ...DEFAULT_CONFIG }
  try {
    const saved = JSON.parse(await fs.readFile(configFile(), 'utf8'))
    config = { ...config, ...saved }
  } catch {
    // 首次启动或配置损坏时回到默认本地后端。
  }
  config.serverUrl = normalizeUrl(process.env.FULLON_SERVER_URL || config.serverUrl, DEFAULT_CONFIG.serverUrl)
  config.minioUrl = normalizeUrl(process.env.FULLON_MINIO_URL || config.minioUrl, DEFAULT_CONFIG.minioUrl)
  if (config.allowedRoot && config.allowedRootUid) {
    try {
      allowedRoot = await fs.realpath(config.allowedRoot)
      allowedRootUid = String(config.allowedRootUid)
    } catch {
      allowedRoot = ''
      allowedRootUid = ''
      config.allowedRoot = ''
      config.allowedRootUid = ''
    }
  } else {
    allowedRoot = ''
    allowedRootUid = ''
  }
}

async function saveConfig() {
  await fs.mkdir(path.dirname(configFile()), { recursive: true })
  await fs.writeFile(configFile(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

async function authorizedRoot(uid, root) {
  if (!allowedRoot || !allowedRootUid || String(uid) !== allowedRootUid || !root) {
    throw new Error('本地文件夹未授权，请重新选择')
  }
  const real = await fs.realpath(root)
  if (!samePath(real, allowedRoot)) throw new Error('本地文件夹未授权，请重新选择')
  return real
}

async function setAllowedRoot(root, uid) {
  if (!uid) throw new Error('请先登录')
  const real = await fs.realpath(root)
  const stat = await fs.stat(real)
  if (!stat.isDirectory()) throw new Error('请选择文件夹')
  allowedRoot = real
  allowedRootUid = String(uid)
  brokerToken = crypto.randomBytes(32).toString('hex')
  config.allowedRoot = real
  config.allowedRootUid = allowedRootUid
  await saveConfig()
  return real
}

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

async function listDirectory(uid, root, parts) {
  const { path: directory } = await resolveWithin(await authorizedRoot(uid, root), parts)
  const dirents = await fs.readdir(directory, { withFileTypes: true })
  const entries = []
  for (const dirent of dirents) {
    const name = dirent.name
    if (SYSTEM_ENTRIES.has(name.toLowerCase())) continue
    if (dirent.isSymbolicLink()) continue
    const entryPath = path.join(directory, name)
    try {
      const stat = await fs.lstat(entryPath)
      if (stat.isDirectory()) {
        entries.push({ name, kind: 'directory' })
      } else if (stat.isFile()) {
        entries.push({ name, kind: 'file', size: stat.size, lastModified: stat.mtimeMs })
      }
    } catch {
      // 枚举后被删除或锁定的条目跳过，不影响其余目录。
    }
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true })
  })
  return entries
}

async function readFile(uid, root, parts) {
  const { path: filePath, stat } = await resolveWithin(await authorizedRoot(uid, root), parts)
  if (!stat.isFile()) throw new Error('只能预览文件')
  const extension = path.extname(filePath).toLowerCase()
  const handle = await fs.open(filePath, 'r')
  try {
    const opened = await handle.stat()
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('文件路径越界')
    if (TEXT_EXTENSIONS.has(extension)) {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_TEXT_BYTES))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return { kind: 'text', text: buffer.subarray(0, bytesRead).toString('utf8'), size: stat.size }
    }
    if (stat.size > MAX_FILE_BYTES) return { kind: 'too-large', size: stat.size }
    const data = await handle.readFile()
    const mime = IMAGE_TYPES.get(extension) || 'application/octet-stream'
    return {
      kind: IMAGE_TYPES.has(extension) ? 'image' : 'binary',
      dataUrl: `data:${mime};base64,${data.toString('base64')}`,
      mime,
      size: stat.size
    }
  } finally {
    await handle.close()
  }
}

function assertSender(event) {
  if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('未授权的调用来源')
  }
}

function registerIpc() {
  ipcMain.handle('fullon:choose-folder', async (event, uid) => {
    assertSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择个人空间本地文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const root = await setAllowedRoot(result.filePaths[0], uid)
    return { path: root, name: path.basename(root) || root }
  })

  ipcMain.handle('fullon:broker-info', (event) => {
    assertSender(event)
    if (!allowedRoot || !allowedRootUid) return null
    return {
      token: brokerToken,
      folderName: path.basename(allowedRoot) || '本地文件夹',
      urls: [
        `http://127.0.0.1:${LOCAL_PORT}`,
        `http://host.docker.internal:${LOCAL_PORT}`
      ]
    }
  })

  ipcMain.handle('fullon:list-directory', (event, uid, root, parts) => {
    assertSender(event)
    return listDirectory(uid, root, parts)
  })
  ipcMain.handle('fullon:read-file', (event, uid, root, parts) => {
    assertSender(event)
    return readFile(uid, root, parts)
  })
  ipcMain.handle('fullon:forget-root', async (event, uid) => {
    assertSender(event)
    if (!allowedRootUid || String(uid) !== allowedRootUid) return true
    allowedRoot = ''
    allowedRootUid = ''
    brokerToken = crypto.randomBytes(32).toString('hex')
    config.allowedRoot = ''
    config.allowedRootUid = ''
    await saveConfig()
    return true
  })
}

function rewriteMinioPath(requestUrl) {
  return requestUrl.replace(/^\/minio/, '')
}

function proxyRequest(request, response, baseUrl, rewrite, requestPath) {
  let target
  try {
    target = buildProxyTarget(requestPath, baseUrl, rewrite)
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('无效的请求地址')
    return
  }
  const transport = target.protocol === 'https:' ? https : http
  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...request.headers, host: target.host }
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    }
  )
  upstream.on('error', (error) => {
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    }
    response.end(`后端连接失败：${error.message}`)
  })
  request.on('aborted', () => upstream.destroy())
  request.pipe(upstream)
}

async function serveStatic(request, response, pathname) {
  const root = process.env.FULLON_RENDERER_DIR || path.join(__dirname, 'renderer')
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    response.writeHead(400)
    response.end('Bad Request')
    return
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  let filePath = path.resolve(root, relative)
  if (!isInside(root, filePath)) {
    response.writeHead(403)
    response.end('Forbidden')
    return
  }
  let stat = null
  try {
    stat = await fs.stat(filePath)
  } catch {
    stat = null
  }
  if (!stat || !stat.isFile()) {
    if (request.headers.accept?.includes('text/html')) {
      filePath = path.join(root, 'index.html')
      try {
        stat = await fs.stat(filePath)
      } catch {
        stat = null
      }
    }
  }
  if (!stat || !stat.isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not Found')
    return
  }
  response.writeHead(200, {
    'content-type': mimeFor(filePath),
    'content-length': stat.size,
    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=3600'
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  response.end(await fs.readFile(filePath))
}

function createLocalServer() {
  const server = http.createServer((request, response) => {
    let requestUrl
    try {
      requestUrl = parseRequestPath(request.url, `http://127.0.0.1:${LOCAL_PORT}`)
    } catch {
      response.writeHead(400)
      response.end('Bad Request')
      return
    }
    const { pathname, requestPath } = requestUrl
    const allowDockerHost = pathname.startsWith('/local-files/')
    let localHost
    try {
      localHost = new URL(`http://${request.headers.host}`).host
    } catch {
      localHost = ''
    }
    const loopbackHost = new URL(`http://127.0.0.1:${LOCAL_PORT}`).host
    const dockerHost = `host.docker.internal:${LOCAL_PORT}`
    if (localHost !== loopbackHost && !(allowDockerHost && localHost === dockerHost)) {
      response.writeHead(403)
      response.end('Forbidden')
      return
    }
    if (pathname === '/local-files/list' || pathname === '/local-files/read') {
      handleBrokerRequest(request, response, {
        pathname,
        searchParams: new URL(request.url, `http://127.0.0.1:${LOCAL_PORT}`).searchParams,
        token: brokerToken,
        getRoot: () => allowedRoot,
        listDirectory: (root, parts) => listDirectory(allowedRootUid, root, parts),
        readFile: (root, parts) => readFile(allowedRootUid, root, parts)
      }).catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end('Internal Server Error')
      })
      return
    }
    if (pathname.startsWith('/api')) {
      proxyRequest(request, response, config.serverUrl, null, requestPath)
      return
    }
    if (pathname.startsWith('/minio/public/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405)
        response.end('Method Not Allowed')
        return
      }
      proxyRequest(request, response, config.minioUrl, rewriteMinioPath, requestPath)
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405)
      response.end('Method Not Allowed')
      return
    }
    serveStatic(request, response, pathname).catch((error) => {
      if (!response.headersSent) response.writeHead(500)
      response.end(error.message)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(LOCAL_PORT, '127.0.0.1', () => resolve(server))
  })
}

function isLocalUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.hostname === '127.0.0.1' && parsed.port === String(LOCAL_PORT)
  } catch {
    return false
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: '#ffffff',
    title: 'fullon',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  const guardNavigation = (event, url) => {
    if (process.env.FULLON_DEV_URL && url.startsWith(process.env.FULLON_DEV_URL)) return
    if (isLocalUrl(url)) return
    event.preventDefault()
    if (url.startsWith('https://')) shell.openExternal(url)
  }
  mainWindow.webContents.on('will-navigate', guardNavigation)
  mainWindow.webContents.on('will-redirect', guardNavigation)
  const target = process.env.FULLON_DEV_URL || `http://127.0.0.1:${LOCAL_PORT}/`
  await mainWindow.loadURL(target)
  if (process.env.FULLON_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' })
}

function createMenu() {
  const template = [
    {
      label: '文件',
      submenu: [{ label: '退出', role: 'quit' }]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '后端地址',
          click: () =>
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '后端地址',
              message: config.serverUrl,
              detail: `配置文件：${configFile()}\n可通过 FULLON_SERVER_URL 环境变量覆盖。`
            })
        },
        { type: 'separator' },
        { label: '开发者工具', role: 'toggleDevTools', visible: !!process.env.FULLON_DEVTOOLS }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app
    .whenReady()
    .then(async () => {
      await loadConfig()
      localServer = await createLocalServer()
      registerIpc()
      const allowedPermissions = new Set(['clipboard-sanitized-write', 'fullscreen'])
      session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) =>
        callback(allowedPermissions.has(permission))
      )
      session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
        allowedPermissions.has(permission)
      )
      await createWindow()
      createMenu()
    })
    .catch((error) => {
      dialog.showErrorBox('fullon 启动失败', `${error.message}\n\n请检查端口 ${LOCAL_PORT} 是否被占用。`)
      app.quit()
    })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    localServer?.close()
  })
}
