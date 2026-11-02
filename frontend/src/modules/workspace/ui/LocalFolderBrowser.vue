<template>
  <section class="local-browser">
    <a-alert v-if="error" type="error" show-icon :message="error" class="local-browser-alert" />
    <div v-if="!supported" class="local-browser-empty">
      当前浏览器不支持读取本地文件夹，请使用 Chrome 或 Edge。
    </div>

    <div v-else-if="!connection" class="local-browser-empty">
      <HardDrive :size="40" />
      <h2>连接本地文件夹</h2>
      <p>个人空间直接读取你电脑上的目录，不导入、不复制；每次进入或刷新都读取本地最新内容。</p>
      <a-button type="primary" :loading="busy" @click="connect">选择本地文件夹</a-button>
      <p class="local-browser-hint">
        {{
          isDesktop
            ? '连接后 Agent 可在你授权范围内读写这些文件；写删默认需要你审批，文件不会复制到服务端。'
            : '浏览器模式仅支持浏览与预览；让 Agent 读取请使用桌面客户端。'
        }}
      </p>
    </div>

    <template v-else>
      <header class="local-browser-header">
        <div class="local-browser-title">
          <HardDrive :size="18" />
          <strong>{{ connection.folderName || '本地文件夹' }}</strong>
          <span
            v-if="connection.kind === 'desktop'"
            class="local-browser-agent"
            :class="{ connected: agentAccess }"
            :title="agentAccess ? 'Agent 可在授权范围内读写，写删默认需要审批' : 'Agent 本地访问未连接'"
          >
            {{ agentAccess ? 'Agent 可读写' : 'Agent 未连接' }}
          </span>
        </div>
        <div class="local-browser-actions">
          <a-button size="small" :loading="busy" @click="refresh">
            <template #icon><RefreshCw :size="14" /></template>
            刷新
          </a-button>
          <a-button size="small" @click="connect">更换文件夹</a-button>
          <a-button size="small" danger @click="disconnect">断开</a-button>
        </div>
      </header>

      <a-alert
        v-if="permission !== 'granted'"
        type="warning"
        show-icon
        message="本地文件夹权限已失效，需要重新授权。"
        class="local-browser-alert"
      >
        <template #action>
          <a-button size="small" type="primary" :loading="busy" @click="reauthorize">重新授权</a-button>
        </template>
      </a-alert>

      <nav class="local-browser-breadcrumb" aria-label="本地路径">
        <button type="button" @click="navigate([])">
          {{ connection.folderName || '根目录' }}
        </button>
        <template v-for="(part, index) in parts" :key="`${part}-${index}`">
          <ChevronRight :size="14" />
          <button type="button" @click="navigate(parts.slice(0, index + 1))">{{ part }}</button>
        </template>
      </nav>

      <div class="local-browser-body">
        <div class="local-browser-list" :class="{ 'has-preview': preview }">
          <div v-if="loading" class="local-browser-state">正在读取目录...</div>
          <div v-else-if="!entries.length" class="local-browser-state">这个文件夹是空的。</div>
          <button
            v-for="entry in entries"
            v-else
            :key="entry.name"
            type="button"
            class="local-browser-row"
            @click="entry.kind === 'directory' ? navigate([...parts, entry.name]) : openPreview(entry)"
          >
            <FileTypeIcon :name="entry.name" :is-dir="entry.kind === 'directory'" :size="18" />
            <span class="local-browser-name" :title="entry.name">{{ entry.name }}</span>
            <span class="local-browser-meta">
              <template v-if="entry.kind === 'file'">
                {{ formatSize(entry.size) }} · {{ formatTime(entry.lastModified) }}
              </template>
            </span>
          </button>
        </div>

        <aside v-if="preview" class="local-browser-preview">
          <header>
            <span :title="preview.name">{{ preview.name }}</span>
            <a-button size="small" type="text" @click="closePreview">关闭</a-button>
          </header>
          <div v-if="preview.loading" class="local-browser-state">正在读取文件...</div>
          <img v-else-if="preview.url && preview.isImage" :src="preview.url" :alt="preview.name" />
          <pre v-else-if="preview.text !== null">{{ preview.text }}</pre>
          <div v-else class="local-browser-state">
            {{ preview.message || '该文件不支持预览。' }}
            <a v-if="preview.url" :href="preview.url" :download="preview.name">下载</a>
          </div>
        </aside>
      </div>
    </template>
  </section>
</template>

<script setup>
import { onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronRight, HardDrive, RefreshCw } from '@lucide/vue'
import FileTypeIcon from '@/shared/ui/FileTypeIcon.vue'
import {
  clearLocalFolderConnection,
  forgetLocalFolder,
  localFolderBrokerInfo,
  loadLocalFolderConnection,
  pickLocalFolder,
  queryLocalPermission,
  readLocalDirectory,
  readLocalFile,
  requestLocalPermission,
  saveLocalFolderConnection,
  supportsLocalFolder
} from '../model/localFolderSync'
import {
  registerLocalFolderBroker,
  unregisterLocalFolderBroker
} from '@/apis/workspace_api'

const props = defineProps({
  uid: { type: String, default: '' }
})

const supported = supportsLocalFolder()
const isDesktop = Boolean(window.fullonDesktop?.isDesktop)
const connection = ref(null)
const permission = ref('')
const entries = ref([])
const parts = ref([])
const preview = ref(null)
const loading = ref(false)
const busy = ref(false)
const agentAccess = ref(false)
const error = ref('')
let previewUrl = ''
let loadSeq = 0
let previewSeq = 0
let restoreSeq = 0

const formatSize = (bytes) => {
  if (bytes === undefined || bytes === null) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`
}
const formatTime = (timestamp) => (timestamp ? new Date(timestamp).toLocaleString() : '-')

function releasePreviewUrl() {
  if (previewUrl) URL.revokeObjectURL(previewUrl)
  previewUrl = ''
}

function closePreview() {
  previewSeq += 1
  preview.value = null
  releasePreviewUrl()
}

async function loadDirectory() {
  if (!connection.value || permission.value !== 'granted') return
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  try {
    const nextEntries = await readLocalDirectory(connection.value, parts.value)
    if (seq !== loadSeq) return
    entries.value = nextEntries
  } catch (err) {
    if (seq !== loadSeq) return
    entries.value = []
    if (
      err?.name === 'NotAllowedError' ||
      err?.name === 'SecurityError' ||
      (connection.value?.kind === 'desktop' && /未授权/.test(err?.message || ''))
    ) {
      permission.value = 'prompt'
    }
    error.value = err?.message || '读取本地目录失败'
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

async function refresh() {
  await loadDirectory()
}

async function navigate(nextParts) {
  parts.value = nextParts
  closePreview()
  await loadDirectory()
}

async function openPreview(entry) {
  closePreview()
  const seq = previewSeq
  preview.value = { name: entry.name, loading: true, text: null, url: '', isImage: false }
  try {
    const file = await readLocalFile(connection.value, [...parts.value, entry.name], entry.handle)
    if (seq !== previewSeq) {
      if (file.isObjectUrl && file.url) URL.revokeObjectURL(file.url)
      return
    }
    if (file.isObjectUrl && file.url) previewUrl = file.url
    preview.value = {
      name: entry.name,
      loading: false,
      isImage: Boolean(file.isImage),
      url: file.url || '',
      text: file.kind === 'text' ? file.text : null,
      message: file.tooLarge ? '文件超过 20 MB，无法预览。' : '',
      size: file.size
    }
  } catch (err) {
    if (seq !== previewSeq) return
    preview.value = { name: entry.name, loading: false, text: err?.message || '读取文件失败', url: '', isImage: false }
  }
}

async function syncAgentAccess() {
  agentAccess.value = false
  if (connection.value?.kind !== 'desktop') return
  const info = await localFolderBrokerInfo(connection.value)
  if (!info?.urls?.length || !info.token) throw new Error('桌面文件代理未启动')
  await registerLocalFolderBroker(info.urls, info.token, connection.value.folderName || '本地文件夹')
  agentAccess.value = true
}

async function connect() {
  if (!props.uid) return
  restoreSeq += 1
  busy.value = true
  error.value = ''
  try {
    const selected = await pickLocalFolder(props.uid)
    if (!selected) return
    connection.value = await saveLocalFolderConnection({ uid: String(props.uid), ...selected })
    permission.value = await requestLocalPermission(connection.value)
    if (permission.value !== 'granted') throw new Error('未获得本地文件夹读取权限')
    parts.value = []
    closePreview()
    await loadDirectory()
    try {
      await syncAgentAccess()
    } catch (err) {
      error.value = err?.message || 'Agent 本地访问登记失败'
    }
  } catch (err) {
    if (err?.name !== 'AbortError') error.value = err?.message || '连接本地文件夹失败'
  } finally {
    busy.value = false
  }
}

async function reauthorize() {
  if (connection.value?.kind === 'desktop') {
    await connect()
    return
  }
  busy.value = true
  error.value = ''
  try {
    permission.value = await requestLocalPermission(connection.value)
    if (permission.value === 'granted') await loadDirectory()
  } catch (err) {
    error.value = err?.message || '授权失败'
  } finally {
    busy.value = false
  }
}

async function disconnect() {
  loadSeq += 1
  loading.value = false
  let failure = ''
  try {
    await unregisterLocalFolderBroker()
  } catch (err) {
    failure = err?.message || '撤销 Agent 本地访问失败'
  }
  try {
    await forgetLocalFolder(connection.value)
  } catch (err) {
    failure ||= err?.message || '撤销本地文件夹授权失败'
  }
  try {
    await clearLocalFolderConnection(props.uid)
  } catch (err) {
    failure ||= err?.message || '清除本地文件夹记录失败'
  }
  if (failure) error.value = failure
  connection.value = null
  permission.value = ''
  agentAccess.value = false
  entries.value = []
  parts.value = []
  closePreview()
}

async function restore() {
  const seq = ++restoreSeq
  const saved = await loadLocalFolderConnection(props.uid)
  if (seq !== restoreSeq) return
  connection.value = saved
  agentAccess.value = false
  if (!connection.value) return
  permission.value = await queryLocalPermission(connection.value)
  if (seq === restoreSeq && permission.value === 'granted') {
    await loadDirectory()
    try {
      await syncAgentAccess()
    } catch (err) {
      if (seq === restoreSeq) error.value = err?.message || 'Agent 本地访问登记失败'
    }
  }
}

const handleFocus = () => {
  if (permission.value === 'granted') refresh()
}

onMounted(() => {
  restore().catch((err) => {
    error.value = err?.message || '读取本地文件夹配置失败'
  })
  window.addEventListener('focus', handleFocus)
})

onActivated(() => {
  if (connection.value && permission.value === 'granted') refresh()
})

watch(
  () => props.uid,
  async (uid, previousUid) => {
    const previous = connection.value
    if (
      previous?.kind === 'desktop' &&
      (!uid || String(previous.uid) !== String(uid))
    ) {
      try {
        await forgetLocalFolder(previous)
      } catch {
        // 账号切换时以清空界面为准；主进程授权也会校验 uid。
      }
    }
    connection.value = null
    permission.value = ''
    agentAccess.value = false
    parts.value = []
    entries.value = []
    closePreview()
    if (!uid || String(previousUid) === String(uid)) return
    restore().catch((err) => {
      error.value = err?.message || '读取本地文件夹配置失败'
    })
  }
)

onBeforeUnmount(() => {
  window.removeEventListener('focus', handleFocus)
  releasePreviewUrl()
})
</script>

<style scoped>
.local-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 16px 20px 0;
}
.local-browser-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  max-width: 520px;
  margin: 12vh auto 0;
  color: var(--gray-700);
  line-height: 1.7;
}
.local-browser-empty h2 {
  margin: 0;
  color: var(--gray-1000);
  font-size: 20px;
}
.local-browser-hint {
  font-size: 12px;
}
.local-browser-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.local-browser-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
}
.local-browser-agent {
  padding: 1px 7px;
  border: 1px solid var(--gray-200);
  border-radius: 999px;
  color: var(--gray-600);
  font-size: 11px;
  font-weight: 400;
}
.local-browser-agent.connected {
  border-color: var(--success);
  color: var(--success);
}
.local-browser-actions {
  display: flex;
  gap: 8px;
}
.local-browser-alert {
  margin-top: 12px;
}
.local-browser-breadcrumb {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin: 14px 0 8px;
  color: var(--gray-700);
  font-size: 13px;
}
.local-browser-breadcrumb button {
  padding: 2px 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.local-browser-breadcrumb button:hover {
  background: var(--gray-50);
  color: var(--gray-1000);
}
.local-browser-body {
  display: flex;
  gap: 16px;
  min-height: 0;
  flex: 1;
}
.local-browser-list {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding-bottom: 16px;
}
.local-browser-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--gray-1000);
  text-align: left;
  cursor: pointer;
}
.local-browser-row:hover {
  background: var(--gray-50);
}
.local-browser-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.local-browser-meta {
  color: var(--gray-600);
  font-size: 12px;
  white-space: nowrap;
}
.local-browser-state {
  padding: 24px 10px;
  color: var(--gray-600);
  font-size: 13px;
}
.local-browser-preview {
  width: min(46%, 620px);
  min-width: 320px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--gray-150);
  border-radius: 8px;
  overflow: hidden;
}
.local-browser-preview header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--gray-150);
  font-size: 13px;
}
.local-browser-preview header span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.local-browser-preview img {
  max-width: 100%;
  max-height: 60vh;
  object-fit: contain;
  margin: 12px auto;
}
.local-browser-preview pre {
  margin: 0;
  padding: 12px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.local-browser-list.has-preview .local-browser-row {
  padding-right: 4px;
}
</style>
