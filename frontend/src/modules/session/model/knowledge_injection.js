import { documentApi } from '@/apis'
import { parseMentionText } from './mention_utils'

const KNOWLEDGE_FILE_TYPE = 'kb-file'
const DEFAULT_MAX_BYTES = 65536
// Public API 的单个 input_text 上限 32768 字符；注入块必须留在同一条消息预算内。
const MAX_MESSAGE_CHARS = 32768
const BLOCK_SEPARATOR = '\n\n'

/**
 * 提取消息里的知识库文件引用；token 值为 <kb_id>/<file_id>/<文件名>。
 * 同一文件多次引用只注入一次。
 */
export const parseKnowledgeFileRefs = (text = '') => {
  const seen = new Set()
  return parseMentionText(text)
    .filter((segment) => segment.kind === 'mention' && segment.type === KNOWLEDGE_FILE_TYPE)
    .map((segment) => {
      const [kbId, fileId, ...nameParts] = String(segment.value || '').split('/')
      if (!kbId || !fileId) return null
      const key = `${kbId}/${fileId}`
      if (seen.has(key)) return null
      seen.add(key)
      return { kbId, fileId, name: nameParts.join('/') || fileId }
    })
    .filter(Boolean)
}

/** 围栏长度始终大于正文中的反引号串，避免正文提前闭合代码块。 */
const fenceFor = (content) => {
  const runs = String(content || '').match(/`+/g) || []
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

export const buildInjectionBlock = ({ name, text, truncated = false }) => {
  const content = String(text ?? '')
  const fence = fenceFor(content)
  const lines = [`[知识库文件: ${name}]`, `${fence}markdown`, content, fence]
  if (truncated) lines.push('（内容已截断）')
  return lines.join('\n')
}

/** 把注入块压进剩余字符预算；放不下时按字符边界截断并标注。 */
const fitInjectionBlock = ({ name, text, truncated, budget }) => {
  let body = String(text ?? '')
  let cut = Boolean(truncated)
  let block = buildInjectionBlock({ name, text: body, truncated: cut })
  // 代理对按 UTF-16 计数；循环收敛，块头本身装不下时由调用方给出可读错误。
  for (let attempt = 0; block.length > budget && body.length > 0 && attempt < 3; attempt += 1) {
    const keep = Math.max(0, [...body].length - (block.length - budget) - 40)
    body = [...body].slice(0, keep).join('')
    cut = true
    block = buildInjectionBlock({ name, text: body, truncated: cut })
  }
  return block
}

/**
 * 把消息中的知识库文件引用解析为正文注入块。
 * 读取失败或没有正文时抛出可读错误，由发送方阻断本次发送。
 */
export const resolveKnowledgeInjection = async (
  text = '',
  { fetcher = documentApi.readText, maxBytes = DEFAULT_MAX_BYTES } = {}
) => {
  const refs = parseKnowledgeFileRefs(text)
  if (!refs.length) return text

  let result = String(text).trimEnd()
  for (const ref of refs) {
    let payload
    try {
      payload = await fetcher(ref.kbId, ref.fileId, maxBytes)
    } catch (error) {
      throw new Error(`无法引用知识库文件 ${ref.name}：${error?.message || '读取失败'}`, {
        cause: error
      })
    }
    if (!payload?.text) {
      throw new Error(`无法引用知识库文件 ${ref.name}：文件没有可用的解析正文`)
    }
    const budget = MAX_MESSAGE_CHARS - result.length - BLOCK_SEPARATOR.length
    if (budget <= 0) {
      throw new Error(`消息长度已达上限，无法引用知识库文件 ${ref.name}`)
    }
    const block = fitInjectionBlock({
      name: ref.name,
      text: payload.text,
      truncated: Boolean(payload.truncated),
      budget
    })
    if (block.length > budget) {
      throw new Error(`消息长度已达上限，无法引用知识库文件 ${ref.name}`)
    }
    result = `${result}${BLOCK_SEPARATOR}${block}`
  }
  return result
}
