import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_DRAFT_TOOLS,
  buildBoundSkillDraftPayload,
  validateBoundSkillDraftForm
} from '../../src/modules/agents/model/boundSkillDraft.js'

test('生成载荷去空格、去重并省略空字段', () => {
  const payload = buildBoundSkillDraftPayload({
    purpose: '  每周整理销售数据  ',
    triggers: ' ',
    inputsOutputs: 'CSV 表格 → 周报',
    tools: [' web_search ', 'web_search', '', 'mysql_query']
  })

  assert.deepEqual(payload, {
    purpose: '每周整理销售数据',
    inputs_outputs: 'CSV 表格 → 周报',
    tools: ['web_search', 'mysql_query']
  })
})

test('生成载荷限制工具数量', () => {
  const payload = buildBoundSkillDraftPayload({
    purpose: 'x',
    tools: Array.from({ length: MAX_DRAFT_TOOLS + 5 }, (_, index) => `tool_${index}`)
  })

  assert.equal(payload.tools.length, MAX_DRAFT_TOOLS)
})

test('表单校验拒绝空用途和超长字段', () => {
  assert.equal(validateBoundSkillDraftForm({ purpose: '   ' }), '请填写 Skill 用途')
  assert.equal(validateBoundSkillDraftForm({ purpose: 'x', triggers: 'y'.repeat(1001) }), '触发场景不能超过 1000 字')
  assert.equal(validateBoundSkillDraftForm({ purpose: 'x' }), '')
})
