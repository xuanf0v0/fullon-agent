const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { assertName, isInside, resolveWithin, writeWithin, deleteWithin } = require('../lib/local-files')

test('rejects traversal and absolute names', () => {
  for (const name of ['..', '.', '', 'a/b', 'a\\b', '/etc/passwd', 'C:\\Windows', 'note.txt:secret']) {
    assert.throws(() => assertName(name), /非法文件路径/)
  }
  assert.doesNotThrow(() => assertName('normal.txt'))
})

test('keeps resolved paths inside the root', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fullon-files-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'sub'))
  await fs.writeFile(path.join(root, 'sub', 'note.txt'), 'note')

  const resolved = await resolveWithin(root, ['sub', 'note.txt'])
  assert.equal(await fs.readFile(resolved.path, 'utf8'), 'note')
  assert.equal(isInside(await fs.realpath(root), resolved.path), true)
  await assert.rejects(() => resolveWithin(root, ['..']), /非法文件路径/)
  await assert.rejects(() => resolveWithin(root, ['sub', '..', '..']), /非法文件路径/)
  await assert.rejects(() => resolveWithin(root, ['missing.txt']), /ENOENT/)
})

test('rejects a symlink that escapes the root', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fullon-files-'))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fullon-outside-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
  try {
    await fs.symlink(outside, path.join(root, 'link'), 'junction')
  } catch (error) {
    t.skip(`symlink unavailable: ${error.code}`)
    return
  }
  await assert.rejects(() => resolveWithin(root, ['link', 'secret.txt']), /文件路径越界/)
})

test('write and delete refuse symlink segments and targets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fullon-files-'))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fullon-outside-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
  try {
    await fs.symlink(outside, path.join(root, 'link'), 'junction')
  } catch (error) {
    t.skip(`symlink unavailable: ${error.code}`)
    return
  }
  await assert.rejects(() => writeWithin(root, ['link', 'new.txt'], 'x'), /文件路径越界/)
  await assert.rejects(() => deleteWithin(root, ['link', 'secret.txt']), /文件路径越界/)
  await assert.rejects(() => deleteWithin(root, ['link']), /文件路径越界/)
})
