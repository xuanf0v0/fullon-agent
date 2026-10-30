import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { compileScript, parse } from 'vue/compiler-sfc'
import { computed, reactive, ref, watch } from 'vue'

test('保存专属 Skill 成功后关闭弹窗并通知刷新', async () => {
  const source = (
    await fs.readFile(
      new URL('../../src/modules/agents/ui/AgentSkillDraftModal.vue', import.meta.url),
      'utf8'
    )
  ).replace(/\r\n/g, '\n')
  const executable = compileScript(parse(source).descriptor, { id: 'skill-draft-modal' }).content
    .replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
    .replace('export default', 'return')
  const events = []
  const calls = []
  const deps = {
    computed,
    reactive,
    ref,
    watch,
    MarkdownPreview: {},
    message: {
      success: (value) => events.push(['success', value]),
      error: (value) => events.push(['error', value]),
      warning: (value) => events.push(['warning', value])
    },
    agentApi: {
      createAgentBoundSkill: async (...args) => {
        calls.push(args)
        return { skill: { slug: 'self-1' } }
      }
    }
  }
  const component = new Function(...Object.keys(deps), executable)(...Object.values(deps))
  const api = component.setup(
    { open: true, mode: 'existing', agentSlug: 'bound', agentName: '绑定' },
    { expose() {}, emit: (event, value) => events.push([event, value]) }
  )
  api.draft.value = { content: '---\nslug: x\n---\n', name: 'x' }

  await api.saveDraft()

  assert.deepEqual(calls[0], ['bound', { content: '---\nslug: x\n---\n' }])
  assert.ok(events.some(([event]) => event === 'saved'), '保存成功后应通知面板刷新')
  assert.ok(
    events.some(([event, value]) => event === 'update:open' && value === false),
    '保存成功后必须关闭弹窗'
  )
})
