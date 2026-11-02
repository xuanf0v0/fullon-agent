<template>
  <a-modal
    :open="open"
    title="本地文件夹"
    width="640px"
    :footer="null"
    @cancel="close"
  >
    <div v-if="!supported" class="local-folder-empty">
      当前浏览器不支持读取本地文件夹，请使用 Chrome 或 Edge。
    </div>
    <template v-else>
      <div v-if="connection" class="local-folder-status">
        <div class="local-folder-name">{{ connection.folderName }}</div>
        <div class="local-folder-meta">
          同步到个人空间 <code>{{ connection.remoteRoot }}</code>
        </div>
        <div class="local-folder-meta">
          最近同步：{{ lastSyncedLabel }} · 已记录 {{ connection.manifest?.length || 0 }} 个文件
        </div>
      </div>
      <div v-else class="local-folder-empty">
        选择一个本地文件夹。导入后 Agent 和网页修改个人空间副本，点「保存到本地」才写回磁盘。
      </div>

      <a-alert
        v-if="permission && permission !== 'granted'"
        class="local-folder-alert"
        type="warning"
        show-icon
        message="本地文件夹权限已失效，需要重新授权后才能继续同步。"
      />
      <a-alert v-if="error" class="local-folder-alert" type="error" show-icon :message="error" />
      <div v-if="progress" class="local-folder-progress">{{ progress }}</div>

      <div class="local-folder-actions">
        <a-button
          v-if="!connection"
          type="primary"
          :loading="busy"
          @click="connect"
        >
          选择本地文件夹
        </a-button>
        <template v-else>
          <a-button
            v-if="permission !== 'granted'"
            type="primary"
            :loading="busy"
            @click="reauthorize"
          >
            重新授权
          </a-button>
          <a-button :disabled="busy || permission !== 'granted'" :loading="busy" @click="importLocal">
            导入到个人空间
          </a-button>
          <a-button :disabled="busy || permission !== 'granted'" :loading="busy" @click="exportLocal">
            保存到本地
          </a-button>
          <a-button :disabled="busy" danger @click="disconnect">断开</a-button>
        </template>
      </div>

      <p class="local-folder-hint">
        Agent 修改的是个人空间副本。保存到本地会覆盖同名文件；从个人空间消失的文件会在确认后从本地删除。
      </p>
    </template>
  </a-modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { buildFolderUploadBatches } from '../model/workspaceFolderUpload'
import {
  buildExportPlan,
  clearLocalFolderConnection,
  listLocalFilePaths,
  listRemoteFiles,
  loadLocalFolderConnection,
  pickLocalFolder,
  queryLocalPermission,
  remoteRootFor,
  removeLocalFiles,
  requestLocalPermission,
  saveLocalFolderConnection,
  scanLocalFolder,
  supportsLocalFolder,
  writeRemoteFilesToLocal
} from '../model/localFolderSync'
import {
  deleteWorkspacePath,
  downloadWorkspaceFile,
  getWorkspaceTree,
  uploadWorkspaceFiles
} from '@/apis/workspace_api'

const props = defineProps({
  open: { type: Boolean, default: false },
  uid: { type: String, default: '' }
})
const emit = defineEmits(['update:open', 'synced'])

const supported = supportsLocalFolder()
const connection = ref(null)
const permission = ref('')
const busy = ref(false)
const error = ref('')
const progress = ref('')

const lastSyncedLabel = computed(() => {
  const value = connection.value?.lastSyncedAt
  if (!value) return '尚未同步'
  return new Date(value).toLocaleString()
})

const formatBytes = (bytes) => {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(1)} ${units[index]}`
}

const close = () => emit('update:open', false)

const confirmAction = (options) =>
  new Promise((resolve) => {
    Modal.confirm({
      ...options,
      onOk: () => resolve(true),
      onCancel: () => resolve(false)
    })
  })

async function loadConnection() {
  error.value = ''
  connection.value = null
  if (!props.uid) return
  connection.value = await loadLocalFolderConnection(props.uid)
  permission.value = connection.value ? await queryLocalPermission(connection.value.handle) : ''
}

watch(
  () => [props.open, props.uid],
  ([isOpen]) => {
    if (!isOpen) return
    loadConnection().catch((err) => {
      error.value = err?.message || '读取本地文件夹配置失败'
    })
  },
  { immediate: true }
)

const persist = async (patch = {}) => {
  connection.value = await saveLocalFolderConnection({
    ...connection.value,
    ...patch,
    uid: String(props.uid)
  })
}

async function ensurePermission() {
  if (!connection.value) throw new Error('请先选择本地文件夹')
  if (permission.value === 'granted') return
  permission.value = await requestLocalPermission(connection.value.handle)
  if (permission.value !== 'granted') throw new Error('未获得本地文件夹读写权限')
}

async function connect() {
  if (!props.uid) return
  busy.value = true
  error.value = ''
  try {
    const handle = await pickLocalFolder()
    permission.value = await requestLocalPermission(handle)
    if (permission.value !== 'granted') throw new Error('未获得本地文件夹读写权限')
    await persist({
      folderName: handle.name,
      remoteRoot: remoteRootFor(handle.name),
      handle,
      manifest: [],
      lastSyncedAt: null
    })
    message.success(`已连接本地文件夹：${handle.name}`)
    emit('synced')
  } catch (err) {
    if (err?.name !== 'AbortError') error.value = err?.message || '连接本地文件夹失败'
  } finally {
    busy.value = false
  }
}

async function reauthorize() {
  busy.value = true
  error.value = ''
  try {
    await ensurePermission()
    emit('synced')
    message.success('本地文件夹权限已恢复')
  } catch (err) {
    error.value = err?.message || '授权失败'
  } finally {
    busy.value = false
  }
}

async function importLocal() {
  busy.value = true
  error.value = ''
  progress.value = '正在读取本地文件夹...'
  try {
    await ensurePermission()
    const entries = await scanLocalFolder(connection.value.handle)
    if (!entries.length) throw new Error('本地文件夹为空')
    const totalBytes = entries.reduce((sum, entry) => sum + (entry.file.size || 0), 0)
    const confirmed = await confirmAction({
      title: '导入到个人空间',
      content: `将 ${entries.length} 个文件（${formatBytes(totalBytes)}）导入到 ${connection.value.remoteRoot}，同名文件会被覆盖。`,
      okText: '导入'
    })
    if (!confirmed) return

    progress.value = '正在检查同名文件...'
    const remoteFiles = await listRemoteFiles({
      root: connection.value.remoteRoot,
      fetchDirectory: getWorkspaceTree
    })
    const existing = new Set(remoteFiles.map((file) => file.relativePath))
    const conflicts = entries.filter((entry) => existing.has(entry.relativePath))
    for (const entry of conflicts) {
      await deleteWorkspacePath(`${connection.value.remoteRoot}/${entry.relativePath}`)
    }

    const batches = buildFolderUploadBatches(entries)
    let uploaded = 0
    for (const batch of batches) {
      progress.value = `正在上传 ${uploaded + 1}-${uploaded + batch.length} / ${entries.length}...`
      await uploadWorkspaceFiles(
        '/',
        batch.map((entry) => entry.file),
        batch.map((entry) => `${connection.value.remoteRoot}/${entry.relativePath}`)
      )
      uploaded += batch.length
    }

    await persist({
      manifest: entries.map((entry) => entry.relativePath),
      lastSyncedAt: Date.now()
    })
    progress.value = ''
    message.success(`已导入 ${entries.length} 个文件到个人空间`)
    emit('synced')
  } catch (err) {
    error.value = err?.message || '导入失败'
  } finally {
    busy.value = false
    progress.value = ''
  }
}

async function exportLocal() {
  busy.value = true
  error.value = ''
  progress.value = '正在读取个人空间文件列表...'
  try {
    await ensurePermission()
    const remoteFiles = await listRemoteFiles({
      root: connection.value.remoteRoot,
      fetchDirectory: getWorkspaceTree
    })
    if (!remoteFiles.length) throw new Error('个人空间中还没有可保存的文件，请先导入')

    progress.value = '正在检查本地文件...'
    const localPaths = await listLocalFilePaths(connection.value.handle)
    const plan = buildExportPlan({
      remotePaths: remoteFiles.map((file) => file.relativePath),
      manifest: connection.value.manifest || [],
      localPaths
    })
    const deletionPreview = plan.deletions.slice(0, 8).join('、')
    const confirmed = await confirmAction({
      title: '保存到本地',
      content: `将写入 ${remoteFiles.length} 个文件，覆盖 ${plan.overwrites.length} 个本地文件；确认后还会从本地删除 ${plan.deletions.length} 个已从个人空间消失的文件${
        plan.deletions.length ? `（${deletionPreview}${plan.deletions.length > 8 ? ' 等' : ''}）` : ''
      }。`,
      okText: '保存'
    })
    if (!confirmed) return

    await writeRemoteFilesToLocal({
      rootHandle: connection.value.handle,
      files: remoteFiles,
      loadBlob: async (remotePath) => (await downloadWorkspaceFile(remotePath)).blob(),
      onProgress: (done, total) => {
        progress.value = `正在写入本地 ${done} / ${total}...`
      }
    })
    if (plan.deletions.length) {
      progress.value = `正在删除 ${plan.deletions.length} 个本地文件...`
      await removeLocalFiles({
        rootHandle: connection.value.handle,
        relativePaths: plan.deletions
      })
    }

    await persist({
      manifest: remoteFiles.map((file) => file.relativePath),
      lastSyncedAt: Date.now()
    })
    message.success(`已保存 ${remoteFiles.length} 个文件到本地`)
  } catch (err) {
    error.value = err?.message || '保存到本地失败'
  } finally {
    busy.value = false
    progress.value = ''
  }
}

async function disconnect() {
  const confirmed = await confirmAction({
    title: '断开本地文件夹',
    content: '只解除浏览器与本地目录的关联，不会删除本地或个人空间中的文件。',
    okText: '断开'
  })
  if (!confirmed) return
  await clearLocalFolderConnection(props.uid)
  connection.value = null
  permission.value = ''
  emit('synced')
  emit('update:open', false)
}
</script>

<style scoped>
.local-folder-empty {
  color: var(--gray-700);
  line-height: 1.7;
}
.local-folder-status {
  padding: 12px;
  border: 1px solid var(--gray-150);
  border-radius: 8px;
  background: var(--gray-10);
}
.local-folder-name {
  font-weight: 600;
}
.local-folder-meta {
  margin-top: 4px;
  color: var(--gray-700);
  font-size: 13px;
}
.local-folder-meta code {
  font-size: 12px;
}
.local-folder-alert,
.local-folder-progress {
  margin-top: 12px;
}
.local-folder-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
.local-folder-hint {
  margin: 16px 0 0;
  color: var(--gray-700);
  font-size: 12px;
  line-height: 1.6;
}
</style>
