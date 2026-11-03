/**
 * 工作区本地文件夹桥接。
 *
 * Electron 客户端走 preload 暴露的只读桥；浏览器回退到 File System Access API。
 * 上层只保存连接描述，不直接接触 Node 路径或目录句柄细节。
 */

const DB_NAME = 'yuxi-local-folder'
const DB_STORE = 'connections'
const SYSTEM_ENTRIES = new Set(['$recycle.bin', 'system volume information'])
const MAX_TEXT_BYTES = 200_000
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024
const TEXT_EXTENSIONS =
  /\.(md|txt|json|js|mjs|cjs|ts|tsx|vue|py|css|html?|ya?ml|toml|ini|log|csv|sh|bat|ps1|xml)$/i
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i

function desktopBridge() {
  if (typeof window === 'undefined') return null
  return window.fullonDesktop?.isDesktop ? window.fullonDesktop : null
}

export function supportsLocalFolder() {
  return Boolean(desktopBridge() || (typeof window !== 'undefined' && window.showDirectoryPicker))
}

export function isVisibleLocalEntry(name) {
  return !SYSTEM_ENTRIES.has(String(name).toLowerCase())
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DB_STORE, { keyPath: 'uid' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore(mode, action) {
  const db = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, mode)
      const request = action(transaction.objectStore(DB_STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

export async function loadLocalFolderConnection(uid) {
  if (!uid || typeof indexedDB === 'undefined') return null
  const saved = (await withStore('readonly', (store) => store.get(String(uid)))) || null
  if (saved && !saved.kind) return { ...saved, kind: 'browser' }
  return saved
}

export async function saveLocalFolderConnection(connection) {
  await withStore('readwrite', (store) => store.put(connection))
  return connection
}

export async function clearLocalFolderConnection(uid) {
  if (!uid) return
  await withStore('readwrite', (store) => store.delete(String(uid)))
}

/** 桌面端返回路径描述，浏览器端返回目录句柄；取消时返回 null。 */
export async function pickLocalFolder(uid) {
  const bridge = desktopBridge()
  if (bridge) {
    const selected = await bridge.chooseFolder(String(uid))
    if (!selected) return null
    return { uid: String(uid), kind: 'desktop', rootPath: selected.path, folderName: selected.name }
  }
  if (!supportsLocalFolder()) throw new Error('当前浏览器不支持读取本地文件夹，请使用 Chrome 或 Edge')
  const handle = await window.showDirectoryPicker({ id: 'yuxi-personal-space', mode: 'read' })
  return { kind: 'browser', handle, folderName: handle.name }
}

export async function localFolderBrokerInfo(connection) {
  if (connection?.kind !== 'desktop') return null
  return desktopBridge()?.getBrokerInfo?.() || null
}

export async function queryLocalPermission(connection) {
  if (connection?.kind === 'desktop') return 'granted'
  if (!connection?.handle?.queryPermission) return 'granted'
  return connection.handle.queryPermission({ mode: 'read' })
}

export async function requestLocalPermission(connection) {
  if (connection?.kind === 'desktop') return 'granted'
  if (!connection?.handle?.requestPermission) return 'granted'
  return connection.handle.requestPermission({ mode: 'read' })
}

/** 断开时让桌面主进程同时撤销授权根目录。 */
export async function forgetLocalFolder(connection) {
  if (connection?.kind !== 'desktop') return
  await desktopBridge()?.forgetRoot(String(connection.uid))
}

async function openBrowserDirectory(rootHandle, parts) {
  let directory = rootHandle
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part)
  }
  return directory
}

async function readBrowserDirectory(handle) {
  const entries = []
  for await (const [name, entry] of handle.entries()) {
    if (!isVisibleLocalEntry(name)) continue
    if (entry.kind === 'directory') {
      entries.push({ name, kind: 'directory', handle: entry })
      continue
    }
    let metadata = {}
    try {
      const file = await entry.getFile()
      metadata = { size: file.size, lastModified: file.lastModified, type: file.type }
    } catch {
      // 文件可能在枚举后被删除或锁定；仍展示条目，避免整个目录读取失败。
    }
    entries.push({ name, kind: 'file', handle: entry, ...metadata })
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true })
  })
  return entries
}

/** 实时读取一层目录，不递归；桌面端由主进程做授权校验。 */
export async function readLocalDirectory(connection, parts = []) {
  const pathParts = [...parts]
  if (connection?.kind === 'desktop') {
    return desktopBridge().listDirectory(String(connection.uid), connection.rootPath, pathParts)
  }
  if (!connection?.handle) throw new Error('本地文件夹未授权，请重新选择')
  const directory = await openBrowserDirectory(connection.handle, pathParts)
  return readBrowserDirectory(directory)
}

/** 读取文件用于预览；浏览器端 object URL 由调用方负责释放。 */
export async function readLocalFile(connection, parts, entryHandle) {
  if (connection?.kind === 'desktop') {
    const result = await desktopBridge().readFile(String(connection.uid), connection.rootPath, [...parts])
    if (result.kind === 'text') return { kind: 'text', text: result.text, size: result.size }
    if (result.kind === 'too-large') return { kind: 'binary', tooLarge: true, size: result.size }
    if (result.kind === 'image') {
      return { kind: 'image', url: result.dataUrl, isImage: true, isObjectUrl: false, size: result.size }
    }
    return { kind: 'binary', url: result.dataUrl, isImage: false, isObjectUrl: false, size: result.size }
  }

  if (!entryHandle) throw new Error('读取文件失败')
  const file = await entryHandle.getFile()
  const name = parts.at(-1) || file.name
  const isText = TEXT_EXTENSIONS.test(name) || file.type.startsWith('text/')
  if (isText) {
    return { kind: 'text', text: await file.slice(0, MAX_TEXT_BYTES).text(), size: file.size }
  }
  if (file.size > MAX_PREVIEW_BYTES) return { kind: 'binary', tooLarge: true, size: file.size }
  const isImage = IMAGE_EXTENSIONS.test(name) || file.type.startsWith('image/')
  return {
    kind: isImage ? 'image' : 'binary',
    url: URL.createObjectURL(file),
    isImage,
    isObjectUrl: true,
    size: file.size
  }
}
