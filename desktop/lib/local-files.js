const fs = require('node:fs/promises')
const path = require('node:path')

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function assertName(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes(':') ||
    name.includes('\0')
  ) {
    throw new Error('非法文件路径')
  }
}

/** 逐段解析相对路径，并拒绝符号链接逃逸出授权根目录。 */
async function resolveWithin(root, parts) {
  if (!Array.isArray(parts)) throw new Error('非法文件路径')
  const rootReal = await fs.realpath(root)
  let current = rootReal
  for (const part of parts) {
    assertName(part)
    current = path.join(current, part)
    const linkStat = await fs.lstat(current)
    if (linkStat.isSymbolicLink()) {
      const real = await fs.realpath(current)
      if (!isInside(rootReal, real)) throw new Error('文件路径越界')
      current = real
    }
  }
  const real = await fs.realpath(current)
  if (!isInside(rootReal, real)) throw new Error('文件路径越界')
  return { path: real, stat: await fs.stat(real) }
}

module.exports = { samePath, isInside, assertName, resolveWithin }

/** 解析写入目标：逐段拒绝符号链接，必要时创建根目录内的父目录。 */
async function resolveForWrite(root, parts) {
  if (!Array.isArray(parts) || !parts.length) throw new Error('缺少文件路径')
  const rootReal = await fs.realpath(root)
  let current = rootReal
  for (const part of parts.slice(0, -1)) {
    assertName(part)
    const next = path.join(current, part)
    let stat
    try {
      stat = await fs.lstat(next)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await fs.mkdir(next, { mode: 0o700 })
      stat = await fs.lstat(next)
    }
    if (stat.isSymbolicLink()) throw new Error('文件路径越界')
    if (!stat.isDirectory()) throw new Error('父路径不是目录')
    current = next
  }
  assertName(parts.at(-1))
  const target = path.join(current, parts.at(-1))
  if (!isInside(rootReal, target)) throw new Error('文件路径越界')
  const parent = await fs.realpath(path.dirname(target))
  if (!isInside(rootReal, parent)) throw new Error('文件路径越界')
  return { target: path.join(parent, parts.at(-1)), rootReal }
}

/** 覆盖或创建 UTF-8 文本文件，拒绝目标符号链接和根目录外路径。 */
async function writeWithin(root, parts, content) {
  const { target } = await resolveForWrite(root, parts)
  let existing = null
  try {
    existing = await fs.lstat(target)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (existing?.isSymbolicLink()) throw new Error('文件路径越界')
  if (existing && !existing.isFile()) throw new Error('只能写入普通文件')
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0)
  const handle = await fs.open(target, flags, 0o600)
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) throw new Error('只能写入普通文件')
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }
  return { path: parts.join('/'), size: Buffer.byteLength(content, 'utf8') }
}

/** 删除普通文件或空目录；逐段拒绝符号链接，不递归删除。 */
async function deleteWithin(root, parts) {
  if (!Array.isArray(parts) || !parts.length) throw new Error('不能删除个人空间根目录')
  const rootReal = await fs.realpath(root)
  let current = rootReal
  for (const part of parts) {
    assertName(part)
    const next = path.join(current, part)
    const stat = await fs.lstat(next)
    if (stat.isSymbolicLink()) throw new Error('文件路径越界')
    if (part !== parts.at(-1) && !stat.isDirectory()) throw new Error('父路径不是目录')
    current = next
  }
  const stat = await fs.lstat(current)
  if (!isInside(rootReal, await fs.realpath(path.dirname(current)))) throw new Error('文件路径越界')
  if (stat.isDirectory()) {
    await fs.rmdir(current)
    return { path: parts.join('/'), kind: 'directory' }
  }
  await fs.unlink(current)
  return { path: parts.join('/'), kind: 'file' }
}

module.exports = { samePath, isInside, assertName, resolveWithin, resolveForWrite, writeWithin, deleteWithin }
