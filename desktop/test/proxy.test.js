const assert = require('node:assert/strict')
const test = require('node:test')

const { parseRequestPath, buildProxyTarget } = require('../lib/proxy')

test('protocol-relative request paths cannot change the proxy origin', () => {
  const local = 'http://127.0.0.1:5175'
  const parsed = parseRequestPath('//evil.example/api/users', local)
  assert.equal(parsed.pathname, '/api/users')
  assert.equal(buildProxyTarget(parsed.requestPath, 'http://127.0.0.1:5050').origin, 'http://127.0.0.1:5050')
})

test('proxy rewrites minio paths without leaving the configured origin', () => {
  const parsed = parseRequestPath('/minio/public/a.png?x=1', 'http://127.0.0.1:5175')
  const target = buildProxyTarget(parsed.requestPath, 'http://127.0.0.1:9000', (value) =>
    value.replace(/^\/minio/, '')
  )
  assert.equal(target.origin, 'http://127.0.0.1:9000')
  assert.equal(target.pathname, '/public/a.png')
  assert.equal(target.search, '?x=1')
})

test('encoded traversal stays a path on the configured origin', () => {
  const parsed = parseRequestPath('/%2e%2e/api/x', 'http://127.0.0.1:5175')
  assert.equal(buildProxyTarget(parsed.requestPath, 'http://127.0.0.1:5050').origin, 'http://127.0.0.1:5050')
})

test('triple-slash and absolute request lines stay on the configured origin', () => {
  for (const raw of ['///evil.example/api/x', 'http://evil.example/api/x']) {
    const parsed = parseRequestPath(raw, 'http://127.0.0.1:5175')
    const target = buildProxyTarget(parsed.requestPath, 'http://127.0.0.1:5050')
    assert.equal(target.origin, 'http://127.0.0.1:5050')
    assert.equal(target.pathname, '/api/x')
  }
})
