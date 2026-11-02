import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isVisibleLocalEntry,
  openLocalDirectory,
  readLocalDirectory
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

function file(name, size = 0) {
  return {
    name,
    kind: 'file',
    getFile: async () => ({ name, size, lastModified: 1700000000000, type: '', text: async () => '' })
  }
}

test('skips recycle bin and system volume entries', () => {
  assert.equal(isVisibleLocalEntry('$RECYCLE.BIN'), false)
  assert.equal(isVisibleLocalEntry('$Recycle.Bin'), false)
  assert.equal(isVisibleLocalEntry('System Volume Information'), false)
  assert.equal(isVisibleLocalEntry('.git'), true)
  assert.equal(isVisibleLocalEntry('src'), true)
})

test('reads one directory without recursing and sorts folders first', async () => {
  const root = directory('root', [
    file('b.txt', 10),
    directory('z-folder'),
    file('a.txt', 5),
    directory('a-folder', [file('nested.txt', 1)]),
    directory('$Recycle.Bin', [file('deleted.pdb', 100)])
  ])
  const entries = await readLocalDirectory(root)
  assert.deepEqual(
    entries.map((item) => `${item.kind}:${item.name}`),
    ['directory:a-folder', 'directory:z-folder', 'file:a.txt', 'file:b.txt']
  )
  assert.equal(entries[2].size, 5)
  assert.equal(entries[2].lastModified, 1700000000000)
})

test('opens nested directory handles from path parts', async () => {
  const target = directory('deep')
  const mid = directory('mid', [target])
  const root = directory('root', [mid])
  assert.equal(await openLocalDirectory(root, ['mid', 'deep']), target)
})
