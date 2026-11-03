import { ref } from 'vue'

/** 个人工作区当前目录；只记录工作区页面的浏览位置，供其他入口同步。 */
export const personalWorkspacePath = ref('/')

/** 桌面本地工作区当前浏览目录（相对本地根目录）。 */
export const localWorkspacePath = ref('')

/** 规范化工作区路径，根目录保留为 `/`。 */
export function normalizeWorkspacePath(path) {
  const value = String(path || '/').replace(/^\/+|\/+$/g, '')
  return value ? `/${value}` : '/'
}

/** 更新个人工作区当前目录。 */
export function setPersonalWorkspacePath(path) {
  personalWorkspacePath.value = normalizeWorkspacePath(path)
}


/** 更新桌面本地工作区当前浏览目录。 */
export function setLocalWorkspacePath(path) {
  const value = String(path || '').replace(/^\/+|\/+$/g, '')
  localWorkspacePath.value = value
}
