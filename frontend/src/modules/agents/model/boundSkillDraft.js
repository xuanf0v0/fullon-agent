export const MAX_DRAFT_TOOLS = 20

/** 把生成表单整理为接口载荷，空字段不发送。 */
export const buildBoundSkillDraftPayload = (form = {}) => {
  const tools = Array.from(
    new Set(
      (form.tools || [])
        .map((item) => String(item).trim())
        .filter(Boolean)
    )
  ).slice(0, MAX_DRAFT_TOOLS)
  const payload = { purpose: String(form.purpose || '').trim() }
  const triggers = String(form.triggers || '').trim()
  const inputsOutputs = String(form.inputsOutputs || '').trim()
  if (triggers) payload.triggers = triggers
  if (inputsOutputs) payload.inputs_outputs = inputsOutputs
  if (tools.length) payload.tools = tools
  return payload
}

/** 校验生成表单；返回可读错误，空串表示通过。 */
export const validateBoundSkillDraftForm = (form = {}) => {
  const purpose = String(form.purpose || '').trim()
  if (!purpose) return '请填写 Skill 用途'
  if (purpose.length > 2000) return '用途不能超过 2000 字'
  if (String(form.triggers || '').trim().length > 1000) return '触发场景不能超过 1000 字'
  if (String(form.inputsOutputs || '').trim().length > 1000) return '输入与输出不能超过 1000 字'
  return ''
}
