import assert from 'node:assert/strict'
import test from 'node:test'

import {
  forgetLocalFolder,
  isVisibleLocalEntry,
  pickLocalFolder,
  queryLocalPermission,
  readLocalDirectory,
  readLocalFile,
  supportsLocalFolder
} from '../../src/modules/workspace/model/localFolderSync.js'

function directory(name, children = []) {
  return {
    name,
    kind: 'directory',
    getDirectoryHandle: async (childName) => {
      const child = children.find((item) => item.name === childName)
      if (!child || child.kind !== 'directory') throw new Error(`missing ${childName}`)
      return child
    },
    entries: async function* () {
      for (const child of children) yield [child.name, child]
    }
  }
}

function file(name, size = 0, text = '') {
  return {
    name,
    kind: 'file',
    getFile: async () => ({
      name,
      size,
      lastModified: 1700000000000,
      type: 'text/plain',
      slice: () => ({ text: async () => text })
    })
  }
}

test('skips recycle bin and system volume entries', () => {
  assert.equal(isVisibleLocalEntry('$RECYCLE.BIN'), false)
  assert.equal(isVisibleLocalEntry('$Recycle.Bin'), false)
  assert.equal(isVisibleLocalEntry('System Volume Information'), false)
  assert.equal(isVisibleLocalEntry('.git'), true)
  assert.equal(isVisibleLocalEntry('src'), true)
})

test('reads one browser directory without recursing and sorts folders first', async () => {
  const root = directory('root', [
    file('b.txt', 10),
    directory('z-folder'),
    file('a.txt', 5),
    directory('a-folder', [file('nested.txt', 1)]),
    directory('$Recycle.Bin', [file('deleted.pdb', 100)])
  ])
  const entries = await readLocalDirectory({ kind: 'browser', handle: root })
  assert.deepEqual(
    entries.map((item) => `${item.kind}:${item.name}`),
    ['directory:a-folder', 'directory:z-folder', 'file:a.txt', 'file:b.txt']
  )
  assert.equal(entries[2].size, 5)
  assert.equal(entries[2].lastModified, 1700000000000)
})

test('opens nested browser directory handles from path parts', async () => {
  const target = directory('deep', [file('note.txt', 4, 'note')])
  const root = directory('root', [directory('mid', [target])])
  const entries = await readLocalDirectory({ kind: 'browser', handle: root }, ['mid', 'deep'])
  assert.deepEqual(entries.map((item) => item.name), ['note.txt'])
})

test('browser text preview is truncated by the adapter', async () => {
  const fileHandle = file('note.md', 4, 'text')
  const result = await readLocalFile(
    { kind: 'browser', handle: directory('root') },
    ['note.md'],
    fileHandle
  )
  assert.deepEqual(result, { kind: 'text', text: 'text', size: 4 })
})

test('desktop bridge forwards only relative parts and forgets the root', async (t) => {
  const calls = []
  const previousWindow = globalThis.window
  globalThis.window = {
    fullonDesktop: {
      isDesktop: true,
      chooseFolder: async (uid) => { calls.push(['choose', uid]); return { path: 'C:\\docs', name: 'docs' } },
      listDirectory: async (uid, root, parts) => {
        calls.push(['list', uid, root, parts])
        return [{ name: 'note.md', kind: 'file', size: 4 }]
      },
      readFile: async (uid, root, parts) => {
        calls.push(['read', uid, root, parts])
        return { kind: 'text', text: 'note', size: 4 }
      },
      forgetRoot: async (uid) => { calls.push(['forget', uid]) }
    }
  }
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  })

  assert.equal(supportsLocalFolder(), true)
  const connection = await pickLocalFolder('user')
  assert.deepEqual(connection, { uid: 'user', kind: 'desktop', rootPath: 'C:\\docs', folderName: 'docs' })
  assert.equal(await queryLocalPermission(connection), 'granted')
  assert.deepEqual(await readLocalDirectory(connection, ['sub']), [
    { name: 'note.md', kind: 'file', size: 4 }
  ])
  assert.deepEqual(await readLocalFile(connection, ['sub', 'note.md']), {
    kind: 'text',
    text: 'note',
    size: 4
  })
  await forgetLocalFolder(connection)
  assert.deepEqual(calls, [
    ['choose', 'user'],
    ['list', 'user', 'C:\\docs', ['sub']],
    ['read', 'user', 'C:\\docs', ['sub', 'note.md']],
    ['forget', 'user']
  ])
})
