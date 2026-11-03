const { timingSafeEqual } = require('node:crypto')
const path = require('node:path')

const MAX_TEXT_BYTES = 64 * 1024
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_ENTRIES = 500

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  response.end(JSON.stringify(body))
}

function authorized(request, token) {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const actual = Buffer.from(header.slice(7), 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function pathParts(value) {
  const raw = String(value || '').trim()
  if (!raw) return []
  if (raw.includes('\\') || raw.startsWith('/')) throw new Error('非法文件路径')
  const parts = raw.split('/').filter(Boolean)
  for (const part of parts) {
    if (part === '.' || part === '..' || part.includes(':') || part.includes('\0')) {
      throw new Error('非法文件路径')
    }
  }
  return parts
}

async function handleList({ root, parts, listDirectory }) {
  const entries = await listDirectory(root, parts)
  return {
    path: parts.join('/'),
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_WRITE_BYTES + 64 * 1024) {
        reject(new Error('request_too_large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid_json'))
      }
    })
    request.on('error', reject)
  })
}

function requireString(value, name) {
  if (typeof value !== 'string') throw new Error(`missing_${name}`)
  return value
}

async function handleRead({ root, parts, readFile }) {
  if (!parts.length) throw new Error('缺少文件路径')
  const result = await readFile(root, parts)
  if (result.kind === 'text') {
    const text = String(result.text || '')
    return {
      path: parts.join('/'),
      kind: 'text',
      size: result.size,
      text: text.slice(0, MAX_TEXT_BYTES),
      truncated: text.length > MAX_TEXT_BYTES
    }
  }
  return {
    path: parts.join('/'),
    kind: result.kind === 'image' ? 'image' : 'binary',
    size: result.size,
    mime: result.mime || 'application/octet-stream',
    message: '二进制文件不返回内容，仅提供元数据'
  }
}

/**
 * 处理桌面客户端的只读文件代理请求；返回 false 表示不是该路由。
 * 调用方只允许本机及 Docker host-gateway 访问，token 按应用进程生成。
 */
async function handleBrokerRequest(
  request,
  response,
  { pathname, searchParams, token, getRoot, listDirectory, readFile, writeFile, deletePath }
) {
  const readRoute = pathname === '/local-files/list' || pathname === '/local-files/read'
  const writeRoute = pathname === '/local-files/write' || pathname === '/local-files/delete'
  if (!readRoute && !writeRoute) return false
  if (readRoute && request.method !== 'GET') {
    sendJson(response, 405, { error: 'method_not_allowed' })
    return true
  }
  if (writeRoute && request.method !== 'POST') {
    sendJson(response, 405, { error: 'method_not_allowed' })
    return true
  }
  if (!authorized(request, token)) {
    sendJson(response, 401, { error: 'unauthorized' })
    return true
  }
  const root = getRoot()
  if (!root) {
    sendJson(response, 503, { error: 'not_connected', message: '请在工作区连接本地文件夹' })
    return true
  }
  try {
    let result
    if (pathname === '/local-files/list') {
      result = await handleList({ root, parts: pathParts(searchParams.get('path')), listDirectory })
    } else if (pathname === '/local-files/read') {
      result = await handleRead({ root, parts: pathParts(searchParams.get('path')), readFile })
    } else {
      const body = await readJsonBody(request)
      const parts = pathParts(requireString(body.path, 'path'))
      if (pathname === '/local-files/write') {
        const content = requireString(body.content, 'content')
        if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) throw new Error('content_too_large')
        result = await writeFile(root, parts, content)
      } else {
        result = await deletePath(root, parts)
      }
    }
    sendJson(response, 200, { ...result, folder: path.basename(root) || '本地文件夹' })
  } catch (error) {
    const status = error && error.code === 'ENOENT' ? 404 : 400
    sendJson(response, status, { error: status === 404 ? 'not_found' : 'invalid_request' })
  }
  return true
}

module.exports = { handleBrokerRequest }
