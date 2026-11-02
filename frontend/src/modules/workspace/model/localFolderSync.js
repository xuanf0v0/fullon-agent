/**
 * 个人空间的本地文件夹桥接。
 *
 * 浏览器通过 File System Access API 读写用户选择的目录，再把内容镜像到该用户私有的
 * 个人空间，Agent 和网页修改的是服务端副本。Electron 客户端可以替换这里的
 * pickLocalFolder/读写实现，上层同步流程不变。
 */

export const LOCAL_SYNC_ROOT = '本地同步'
export const LOCAL_SYNC_MAX_FILES = 2000
export const LOCAL_SYNC_MAX_BYTES = 512 * 1024 * 1024
export const LOCAL_SYNC_MAX_FILE_BYTES = 100 * 1024 * 1024
const LOCAL_SYNC_SKIP_DIRS = new Set(['.git', '.venv', 'node_modules', '__pycache__'])
const DB_NAME = 'yuxi-local-folder'
const DB_STORE = 'connections'

export function supportsLocalFolder() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

export function sanitizeFolderName(name) {
  const normalized = String(name || '')
    .split('')
    .filter((char) => char.charCodeAt(0) >= 32)
    .join('')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+$/, '')
    .trim()
  return normalized || '本地文件夹'
}

export function remoteRootFor(folderName) {
  return `${LOCAL_SYNC_ROOT}/${sanitizeFolderName(folderName)}`
}

export function relativeUnderRoot(path, root) {
  const normalizedPath = `/${String(path || '').replace(/^\/+/, '')}`
  const normalizedRoot = `/${String(root || '').replace(/^\/+/, '').replace(/\/+$/, '')}`
  const prefix = `${normalizedRoot}/`
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : null
}

/** 导出前计算覆盖与删除候选；只删除上次同步过、如今在服务端消失的本地文件。 */
export function buildExportPlan({ remotePaths, manifest, localPaths }) {
  const remote = remotePaths || []
  const remoteSet = new Set(remote)
  const localSet = new Set(localPaths || [])
  return {
    overwrites: remote.filter((path) => localSet.has(path)),
    deletions: (manifest || []).filter((path) => !remoteSet.has(path) && localSet.has(path))
  }
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
      const store = transaction.objectStore(DB_STORE)
      const request = action(store)
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
  return window.showDirectoryPicker({ id: 'yuxi-personal-space', mode: 'readwrite' })
}

export async function queryLocalPermission(handle) {
  if (!handle?.queryPermission) return 'granted'
  return handle.queryPermission({ mode: 'readwrite' })
}

export async function requestLocalPermission(handle) {
  if (!handle?.requestPermission) return 'granted'
  return handle.requestPermission({ mode: 'readwrite' })
}

/** 递归读取本地目录；跳过依赖/缓存目录，并在上传前拒绝超限内容。 */
export async function scanLocalFolder(rootHandle) {
  const files = []
  let totalBytes = 0

  const walk = async (directoryHandle, prefix) => {
    for await (const [name, handle] of directoryHandle.entries()) {
      const relativePath = prefix ? `${prefix}/${name}` : name
      if (handle.kind === 'directory') {
        if (LOCAL_SYNC_SKIP_DIRS.has(name)) continue
        await walk(handle, relativePath)
        continue
      }
      const file = await handle.getFile()
      if (file.size > LOCAL_SYNC_MAX_FILE_BYTES) {
        throw new Error(`${relativePath} 超过 100 MB，无法导入`)
      }
      totalBytes += file.size
      if (files.length + 1 > LOCAL_SYNC_MAX_FILES) {
        throw new Error(`文件数量超过 ${LOCAL_SYNC_MAX_FILES}，请缩小目录范围`)
      }
      if (totalBytes > LOCAL_SYNC_MAX_BYTES) {
        throw new Error('文件夹总大小超过 512 MB，请缩小目录范围')
      }
      files.push({ file, relativePath })
    }
  }

  await walk(rootHandle, '')
  return files
}

async function ensureLocalDirectory(rootHandle, parts) {
  let directory = rootHandle
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part, { create: true })
  }
  return directory
}

/** 只枚举本地文件路径，用于保存到本地前的覆盖/删除判断。 */
export async function listLocalFilePaths(rootHandle) {
  const paths = []
  const walk = async (directoryHandle, prefix) => {
    for await (const [name, handle] of directoryHandle.entries()) {
      const relativePath = prefix ? `${prefix}/${name}` : name
      if (handle.kind === 'directory') {
        if (LOCAL_SYNC_SKIP_DIRS.has(name)) continue
        await walk(handle, relativePath)
      } else {
        paths.push(relativePath)
      }
    }
  }
  await walk(rootHandle, '')
  return paths
}

/** 把个人空间文件写回本地目录；调用方负责覆盖/删除确认。 */
export async function writeRemoteFilesToLocal({ rootHandle, files, loadBlob, onProgress }) {
  for (const [index, file] of files.entries()) {
    const parts = file.relativePath.split('/')
    const directory = await ensureLocalDirectory(rootHandle, parts.slice(0, -1))
    const fileHandle = await directory.getFileHandle(parts.at(-1), { create: true })
    const writable = await fileHandle.createWritable()
    try {
      await writable.write(await loadBlob(file.remotePath))
      await writable.close()
    } catch (error) {
      await writable.abort().catch(() => {})
      throw error
    }
    onProgress?.(index + 1, files.length)
  }
}

export async function removeLocalFiles({ rootHandle, relativePaths }) {
  for (const relativePath of relativePaths) {
    const parts = relativePath.split('/')
    const directory = await ensureLocalDirectory(rootHandle, parts.slice(0, -1))
    try {
      await directory.removeEntry(parts.at(-1))
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error
    }
  }
}

/**
 * 逐目录列举远程文件，避免递归 tree 接口按目录静默截断后误判删除。
 * fetchDirectory(path) 需返回 { entries } 的完整单层列表。
 */
export async function listRemoteFiles({ root, fetchDirectory }) {
  const files = []
  const pending = [root]
  while (pending.length) {
    const directory = pending.shift()
    const { entries } = await fetchDirectory(directory)
    for (const entry of entries || []) {
      if (entry.is_dir) {
        pending.push(entry.path.replace(/^\/+/, '').replace(/\/+$/, ''))
        continue
      }
      const relativePath = relativeUnderRoot(entry.path, root)
      if (relativePath) {
        files.push({ relativePath, remotePath: entry.path, size: entry.size || 0 })
      }
    }
  }
  return files
}
