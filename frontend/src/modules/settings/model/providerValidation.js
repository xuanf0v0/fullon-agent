const PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,99}$/

/** 供应商表单的本地校验；返回可读错误，空串表示通过。 */
export const validateProviderForm = (form = {}, { existingIds = [], creating = false } = {}) => {
  const providerId = String(form.provider_id || '').trim()
  if (!PROVIDER_ID_RE.test(providerId)) {
    return 'Provider ID 只能包含字母、数字、下划线和中划线，长度 2-100'
  }
  if (creating && existingIds.includes(providerId)) {
    return `供应商 ${providerId} 已存在`
  }
  if (!String(form.display_name || '').trim()) return '请填写展示名称'
  if (!String(form.provider_type || '').trim()) return '请选择 Provider Type'
  if (!String(form.base_url || '').trim()) return '请填写 Base URL'
  return ''
}
