import test from 'node:test'
import assert from 'node:assert/strict'

import { validateProviderForm } from '../../src/modules/settings/model/providerValidation.js'

const valid = {
  provider_id: 'zy',
  display_name: 'zy',
  provider_type: 'openai',
  base_url: 'https://api.zhiyaoapi.top'
}

test('合法表单通过校验', () => {
  assert.equal(validateProviderForm(valid, { creating: true }), '')
})

test('Provider ID 规则与重复检查', () => {
  assert.match(validateProviderForm({ ...valid, provider_id: 'z' }, { creating: true }), /长度 2-100/)
  assert.match(validateProviderForm({ ...valid, provider_id: 'zy.api' }, { creating: true }), /只能包含/)
  assert.match(
    validateProviderForm(valid, { creating: true, existingIds: ['zy'] }),
    /供应商 zy 已存在/
  )
  assert.equal(validateProviderForm(valid, { creating: false, existingIds: ['zy'] }), '')
})

test('必填字段缺失时返回具体原因', () => {
  assert.equal(validateProviderForm({ ...valid, display_name: ' ' }, { creating: true }), '请填写展示名称')
  assert.equal(validateProviderForm({ ...valid, provider_type: '' }, { creating: true }), '请选择 Provider Type')
  assert.equal(validateProviderForm({ ...valid, base_url: '' }, { creating: true }), '请填写 Base URL')
})
