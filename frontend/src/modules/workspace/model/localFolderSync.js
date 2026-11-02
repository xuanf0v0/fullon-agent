/**
 * 个人空间本地文件夹桥接。
 *
 * 浏览器通过 File System Access API 直接读取用户选择的目录，不再镜像到服务端。
 * Electron 客户端可以替换 pickLocalFolder / 读取实现，上层浏览器组件不变。
 */

const DB_NAME = 'yuxi-local-folder'
const DB_STORE = 'connections'
const SYSTEM_ENTRIES = new Set(['$recycle.bin', 'system volume information'])

export function supportsLocalFolder() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
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
  return (await withStore('readonly', (store) => store.get(String(uid)))) || null
}

export async function saveLocalFolderConnection(connection) {
  await withStore('readwrite', (store) => store.put(connection))
  return connection
}

export async function clearLocalFolderConnection(uid) {
  if (!uid) return
  await withStore('readwrite', (store) => store.delete(String(uid)))
}

export async function pickLocalFolder() {
  if (!supportsLocalFolder()) throw new Error('当前浏览器不支持读取本地文件夹，请使用 Chrome 或 Edge')
  return window.showDirectoryPicker({ id: 'yuxi-personal-space', mode: 'read' })
}

export async function queryLocalPermission(handle) {
  if (!handle?.queryPermission) return 'granted'
  return handle.queryPermission({ mode: 'read' })
}

export async function requestLocalPermission(handle) {
  if (!handle?.requestPermission) return 'granted'
  return handle.requestPermission({ mode: 'read' })
}

/** 实时读取目录，返回文件夹在前、文件在后的稳定顺序。 */
export async function readLocalDirectory(directoryHandle) {
  const entries = []
  for await (const [name, handle] of directoryHandle.entries()) {
    if (!isVisibleLocalEntry(name)) continue
    if (handle.kind === 'directory') {
      entries.push({ name, kind: 'directory', handle })
      continue
    }
    let metadata = {}
    try {
      const file = await handle.getFile()
      metadata = { size: file.size, lastModified: file.lastModified, type: file.type }
    } catch {
      // 文件可能在枚举后被删除或锁定；仍展示条目，避免整个目录读取失败
    }
    entries.push({ name, kind: 'file', handle, ...metadata })
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true })
  })
  return entries
}

/** 沿路径打开子目录；路径为面包屑里的相对段。 */
export async function openLocalDirectory(rootHandle, parts) {
  let directory = rootHandle
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part)
  }
  return directory
}
