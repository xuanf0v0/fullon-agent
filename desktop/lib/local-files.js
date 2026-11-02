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
