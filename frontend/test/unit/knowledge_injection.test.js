import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createTestServer } from '../helpers/createTestServer.js'

let injection
let mentionUtils
let tokenUtils
let server

before(async () => {
  server = await createTestServer({
    root: fileURLToPath(new URL('../..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom'
  })
  injection = await server.ssrLoadModule('/src/modules/session/model/knowledge_injection.js')
  mentionUtils = await server.ssrLoadModule('/src/modules/session/model/mention_utils.js')
  tokenUtils = await server.ssrLoadModule('/src/modules/session/model/mention_token.js')
})

after(async () => {
  await server?.close()
})

test('知识库文件 token 解析为 kb/file/文件名并按文件去重', () => {
  const token = tokenUtils.formatMentionToken('kb-file', 'kb_a/file_1/季度报告.md')
  const text = `${token} 与 ${token} 的差异`

  assert.deepEqual(injection.parseKnowledgeFileRefs(text), [
    { kbId: 'kb_a', fileId: 'file_1', name: '季度报告.md' }
  ])
  assert.deepEqual(injection.parseKnowledgeFileRefs('没有引用'), [])
})

test('kb-file token 在历史消息里展示文件名', () => {
  assert.equal(mentionUtils.getMentionDisplayLabel('kb-file', 'kb_a/file_1/报告.md'), '报告.md')
})

test('注入块围栏长于正文反引号并标注截断', () => {
  const block = injection.buildInjectionBlock({
    name: 'a.md',
    text: '```js\nconst a = 1\n```',
    truncated: true
  })

  assert.ok(block.startsWith('[知识库文件: a.md]'))
  assert.ok(block.includes('````markdown'))
  assert.ok(block.endsWith('（内容已截断）'))
})

test('发送前读取正文并追加到消息末尾', async () => {
  const token = tokenUtils.formatMentionToken('kb-file', 'kb_a/file_1/a.md')
  const calls = []
  const text = await injection.resolveKnowledgeInjection(`请总结 ${token}`, {
    fetcher: async (kbId, fileId) => {
      calls.push([kbId, fileId])
      return { text: '正文内容', truncated: false }
    }
  })

  assert.deepEqual(calls, [['kb_a', 'file_1']])
  assert.ok(text.startsWith('请总结 '))
  assert.ok(text.includes('[知识库文件: a.md]\n```markdown\n正文内容\n```'))
})

test('读取失败阻断发送并带出文件名与原因', async () => {
  await assert.rejects(
    injection.resolveKnowledgeInjection('@kb-file:"kb_a/file_1/a.md"', {
      fetcher: async () => {
        throw new Error('文件没有解析后的 Markdown 内容')
      }
    }),
    /a\.md.*文件没有解析后的 Markdown 内容/
  )
})

test('正文为空同样阻断发送', async () => {
  await assert.rejects(
    injection.resolveKnowledgeInjection('@kb-file:"kb_a/file_1/a.md"', {
      fetcher: async () => ({ text: '', truncated: false })
    }),
    /没有可用的解析正文/
  )
})

test('没有引用时不调用读取', async () => {
  let calls = 0
  const text = await injection.resolveKnowledgeInjection('普通消息', {
    fetcher: async () => {
      calls += 1
    }
  })

  assert.equal(text, '普通消息')
  assert.equal(calls, 0)
})

test('注入块受单条消息 32768 字符预算约束', async () => {
  const token = tokenUtils.formatMentionToken('kb-file', 'kb_a/file_1/big.md')
  const prefix = '长'.repeat(32000)

  const text = await injection.resolveKnowledgeInjection(`${prefix} ${token}`, {
    fetcher: async () => ({ text: '正文'.repeat(5000), truncated: false })
  })

  assert.ok(text.length <= 32768, `实际长度 ${text.length}`)
  assert.ok(text.endsWith('（内容已截断）'))
})

test('消息本身已接近上限时拒绝追加引用', async () => {
  const token = tokenUtils.formatMentionToken('kb-file', 'kb_a/file_1/a.md')

  await assert.rejects(
    injection.resolveKnowledgeInjection(`${'a'.repeat(32760)} ${token}`, {
      fetcher: async () => ({ text: '正文', truncated: false })
    }),
    /消息长度已达上限/
  )
})

test('剩余预算装不下块头时给出可读错误而不是超长发送', async () => {
  const token = tokenUtils.formatMentionToken('kb-file', 'kb_a/file_1/a.md')
  // token 已占满预算，剩余不足块头与围栏。
  const prefix = 'a'.repeat(32768 - token.length - 8)

  await assert.rejects(
    injection.resolveKnowledgeInjection(`${prefix} ${token}`, {
      fetcher: async () => ({ text: '正文', truncated: false })
    }),
    /消息长度已达上限/
  )
})
