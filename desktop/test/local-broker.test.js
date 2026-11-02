const assert = require('node:assert/strict')
const http = require('node:http')
const test = require('node:test')

const { handleBrokerRequest } = require('../lib/local-broker')

const TOKEN = 'a'.repeat(32)

async function startBroker(t, options = {}) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    handleBrokerRequest(request, response, {
      pathname: url.pathname,
      searchParams: url.searchParams,
      token: options.token || TOKEN,
      getRoot: options.getRoot || (() => 'C:\\docs'),
      listDirectory: options.listDirectory || (async () => []),
      readFile: options.readFile || (async () => ({ kind: 'text', text: '', size: 0 }))
    }).then((handled) => {
      if (!handled) {
        response.writeHead(404)
        response.end()
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

test('rejects requests without the broker token', async (t) => {
  const base = await startBroker(t)
  const response = await fetch(`${base}/local-files/list`)
  assert.equal(response.status, 401)
})

test('lists one directory and returns the folder name only', async (t) => {
  const base = await startBroker(t, {
    listDirectory: async (root, parts) => {
      assert.equal(root, 'C:\\docs')
      assert.deepEqual(parts, ['sub'])
      return [{ name: 'note.md', kind: 'file', size: 4 }]
    }
  })
  const response = await fetch(`${base}/local-files/list?path=sub`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    folder: 'docs',
    path: 'sub',
    entries: [{ name: 'note.md', kind: 'file', size: 4 }],
    truncated: false
  })
})

test('returns text and strips binary bodies', async (t) => {
  const base = await startBroker(t, {
    readFile: async (root, parts) => {
      if (parts.at(-1) === 'note.md') {
        return { kind: 'text', text: 'hello', size: 5 }
      }
      return { kind: 'image', dataUrl: 'data:image/png;base64,secret', mime: 'image/png', size: 9 }
    }
  })
  const text = await fetch(`${base}/local-files/read?path=note.md`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  })
  assert.deepEqual(await text.json(), {
    folder: 'docs',
    path: 'note.md',
    kind: 'text',
    text: 'hello',
    size: 5,
    truncated: false
  })
  const image = await fetch(`${base}/local-files/read?path=note.png`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  })
  const body = await image.json()
  assert.equal(body.kind, 'image')
  assert.equal(body.dataUrl, undefined)
  assert.equal(body.mime, 'image/png')
})

test('rejects traversal and absolute paths before touching the filesystem', async (t) => {
  const base = await startBroker(t)
  for (const value of ['../secret', 'a/../../secret', 'C:/Windows/win.ini', 'a\\b']) {
    const response = await fetch(`${base}/local-files/read?path=${encodeURIComponent(value)}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    assert.equal(response.status, 400, value)
  }
})

test('returns 503 when no folder is connected', async (t) => {
  const base = await startBroker(t, { getRoot: () => '' })
  const response = await fetch(`${base}/local-files/list`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  })
  assert.equal(response.status, 503)
})
