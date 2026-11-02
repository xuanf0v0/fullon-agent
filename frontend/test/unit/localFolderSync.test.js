import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildExportPlan,
  listLocalFilePaths,
  listRemoteFiles,
  relativeUnderRoot,
  remoteRootFor,
  removeLocalFiles,
  sanitizeFolderName,
  scanLocalFolder,
  writeRemoteFilesToLocal
} from '../../src/modules/workspace/model/localFolderSync.js'

function makeDirectory(name, children = new Map()) {
  return {
    kind: 'directory',
    name,
    children,
    async *entries() {
      for (const entry of this.children.entries()) yield entry
    },
    async getDirectoryHandle(childName, { create } = {}) {
      const existing = this.children.get(childName)
      if (existing) return existing
      if (!create) throw new DOMException('missing', 'NotFoundError')
      const directory = makeDirectory(childName)
      this.children.set(childName, directory)
      return directory
    },
    async getFileHandle(childName, { create } = {}) {
      const existing = this.children.get(childName)
      if (existing) return existing
      if (!create) throw new DOMException('missing', 'NotFoundError')
      const file = makeFile(childName, '')
      this.children.set(childName, file)
      return file
    },
    async removeEntry(childName) {
      if (!this.children.delete(childName)) throw new DOMException('missing', 'NotFoundError')
    }
  }
}

function makeFile(name, content) {
  return {
    kind: 'file',
    name,
    content,
    async getFile() {
      return { name, size: content.length, arrayBuffer: async () => content }
    },
    async createWritable() {
      return {
        chunks: [],
        async write(chunk) {
          this.chunks.push(chunk)
        },
        async close() {
          this.closed = true
        },
        async abort() {
          this.aborted = true
        }
      }
    }
  }
}

test('sanitizes folder names into one safe workspace component', () => {
  assert.equal(sanitizeFolderName('D:/项目\\demo'), 'D__项目_demo')
  assert.equal(sanitizeFolderName('  '), '本地文件夹')
  assert.equal(remoteRootFor('demo'), '本地同步/demo')
})

test('maps remote paths only inside the configured root', () => {
  assert.equal(relativeUnderRoot('本地同步/demo/a.txt', '本地同步/demo'), 'a.txt')
  assert.equal(relativeUnderRoot('/本地同步/demo/a.txt', '本地同步/demo'), 'a.txt')
  assert.equal(relativeUnderRoot('/本地同步/demo2/a.txt', '本地同步/demo'), null)
})

test('plan deletes only previously synced local files that disappeared remotely', () => {
  const plan = buildExportPlan({
    remotePaths: ['a.txt', 'c.txt'],
    manifest: ['a.txt', 'b.txt'],
    localPaths: ['a.txt', 'b.txt', 'untouched.txt', 'new-local.txt']
  })

  assert.deepEqual(plan.overwrites, ['a.txt'])
  assert.deepEqual(plan.deletions, ['b.txt'])
})

test('scans local directories and skips dependency folders', async () => {
  const root = makeDirectory('root')
  root.children.set('a.txt', makeFile('a.txt', 'abc'))
  const nested = makeDirectory('sub')
  nested.children.set('b.txt', makeFile('b.txt', 'defg'))
  root.children.set('sub', nested)
  const nodeModules = makeDirectory('node_modules')
  nodeModules.children.set('huge.js', makeFile('huge.js', 'x'.repeat(10)))
  root.children.set('node_modules', nodeModules)

  const entries = await scanLocalFolder(root)

  assert.deepEqual(
    entries.map((entry) => entry.relativePath).sort(),
    ['a.txt', 'sub/b.txt']
  )
})

test('writes remote files into nested local directories and lists paths', async () => {
  const root = makeDirectory('root')
  const written = []
  const files = [
    { relativePath: 'a.txt', remotePath: '本地同步/demo/a.txt' },
    { relativePath: 'sub/b.txt', remotePath: '本地同步/demo/sub/b.txt' }
  ]

  await writeRemoteFilesToLocal({
    rootHandle: root,
    files,
    loadBlob: async (remotePath) => {
      const text = remotePath.split('/').at(-1)
      written.push(text)
      return text
    }
  })

  assert.deepEqual(written, ['a.txt', 'b.txt'])
  assert.deepEqual((await listLocalFilePaths(root)).sort(), ['a.txt', 'sub/b.txt'])
})

test('removes local files and ignores already missing entries', async () => {
  const root = makeDirectory('root')
  root.children.set('a.txt', makeFile('a.txt', 'abc'))

  await removeLocalFiles({ rootHandle: root, relativePaths: ['a.txt', 'missing.txt'] })

  assert.equal(root.children.has('a.txt'), false)
})


test('walks remote directories without trusting recursive truncation', async () => {
  const pages = {
    '本地同步/demo': [
      { path: '/本地同步/demo/a.txt', is_dir: false, size: 1 },
      { path: '/本地同步/demo/sub/', is_dir: true }
    ],
    '本地同步/demo/sub': [{ path: '/本地同步/demo/sub/b.txt', is_dir: false, size: 2 }]
  }
  const calls = []
  const files = await listRemoteFiles({
    root: '本地同步/demo',
    fetchDirectory: async (path) => {
      calls.push(path)
      return { entries: pages[path] || [] }
    }
  })

  assert.deepEqual(calls, ['本地同步/demo', '本地同步/demo/sub'])
  assert.deepEqual(
    files.map((file) => file.relativePath),
    ['a.txt', 'sub/b.txt']
  )
})
