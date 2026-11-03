<template>
  <div class="local-project-picker">
    <div v-if="loading" class="local-project-state"><a-spin /></div>
    <div v-else-if="error" class="local-project-state error">{{ error }}</div>
    <div v-else-if="!supported" class="local-project-state">
      本地项目仅支持桌面客户端；请先连接工作区本地文件夹。
    </div>
    <template v-else>
      <div class="local-project-breadcrumb" aria-label="本地项目目录">
        <button type="button" class="crumb" @click="openPath([])">{{ folderName || '工作区' }}</button>
        <template v-for="(part, index) in parts" :key="`${part}-${index}`">
          <span class="separator">/</span>
          <button type="button" class="crumb current" @click="openPath(parts.slice(0, index + 1))">
            {{ part }}
          </button>
        </template>
      </div>
      <div class="local-project-list" role="listbox" aria-label="选择本地项目目录">
        <button
          v-for="entry in directories"
          :key="entry.name"
          type="button"
          class="local-project-entry"
          @click="openPath([...parts, entry.name])"
        >
          <Folder :size="15" aria-hidden="true" />
          <span>{{ entry.name }}</span>
        </button>
        <div v-if="!loading && !directories.length" class="local-project-empty">当前目录没有子文件夹</div>
      </div>
      <div class="local-project-footer">
        <span class="local-project-path">{{ currentPath || '工作区根目录' }}</span>
        <a-button size="small" type="primary" :disabled="!currentPath" @click="selectCurrent">
          选择当前目录
        </a-button>
      </div>
      <small v-if="!currentPath" class="local-project-hint">请进入一个子目录作为项目目录。</small>
    </template>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { Folder } from '@lucide/vue'
import { useUserStore } from '@/modules/identity'
import {
  loadLocalFolderConnection,
  queryLocalPermission,
  readLocalDirectory,
  localWorkspacePath
} from '@/modules/workspace'

const props = defineProps({
  active: { type: Boolean, default: false },
  modelValue: { type: String, default: '' },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['loading-change', 'select', 'update:modelValue'])
const userStore = useUserStore()
const connection = ref(null)
const parts = ref([])
const entries = ref([])
const loading = ref(false)
const error = ref('')
let loadSeq = 0
const supported = computed(
  () => connection.value?.kind === 'desktop' && typeof window !== 'undefined' && Boolean(window.fullonDesktop)
)
const folderName = computed(() => connection.value?.folderName || '')
const directories = computed(() => entries.value.filter((entry) => entry.kind === 'directory'))
const currentPath = computed(() => parts.value.join('/'))

function parsePath(value) {
  return String(value || '')
    .split('/')
    .filter(Boolean)
}

async function loadDirectory(nextParts = parts.value) {
  if (!connection.value) return
  const seq = ++loadSeq
  loading.value = true
  emit('loading-change', true)
  error.value = ''
  try {
    const nextEntries = await readLocalDirectory(connection.value, nextParts)
    if (seq !== loadSeq) return
    entries.value = nextEntries
    parts.value = nextParts
    emit('update:modelValue', nextParts.join('/'))
  } catch (err) {
    if (seq !== loadSeq) return
    error.value = err?.message || '读取本地工作区失败'
  } finally {
    if (seq === loadSeq) {
      loading.value = false
      emit('loading-change', false)
    }
  }
}

async function restore() {
  if (!props.active || !userStore.uid) return
  loading.value = true
  error.value = ''
  try {
    const saved = await loadLocalFolderConnection(userStore.uid)
    if (saved?.kind !== 'desktop' || !window.fullonDesktop) {
      connection.value = null
      error.value = '请先在桌面工作区连接本地文件夹。'
      return
    }
    const permission = await queryLocalPermission(saved)
    if (permission !== 'granted') {
      connection.value = null
      error.value = '本地工作区未授权，请重新连接文件夹。'
      return
    }
    connection.value = saved
    await loadDirectory(parsePath(props.modelValue || localWorkspacePath.value))
  } catch (err) {
    connection.value = null
    error.value = err?.message || '读取本地工作区失败'
  } finally {
    loading.value = false
  }
}

function openPath(nextParts) {
  if (props.disabled) return
  void loadDirectory(nextParts)
}

function selectCurrent() {
  if (props.disabled || !currentPath.value) return
  emit('update:modelValue', currentPath.value)
  emit('select', currentPath.value)
}

watch(() => props.active, (active) => {
  if (active) void restore()
}, { immediate: true })
</script>

<style scoped>
.local-project-picker { border: 1px solid var(--gray-200); border-radius: 8px; overflow: hidden; }
.local-project-state { padding: 24px; color: var(--gray-500); text-align: center; font-size: 13px; }
.local-project-state.error { color: var(--error); }
.local-project-breadcrumb { display: flex; align-items: center; gap: 4px; padding: 8px 10px; border-bottom: 1px solid var(--gray-100); overflow-x: auto; }
.crumb { border: 0; background: transparent; color: var(--gray-700); cursor: pointer; padding: 2px 4px; white-space: nowrap; }
.crumb.current { color: var(--gray-500); }
.separator { color: var(--gray-300); }
.local-project-list { min-height: 120px; max-height: 220px; overflow-y: auto; padding: 6px; }
.local-project-entry { width: 100%; display: flex; align-items: center; gap: 8px; border: 0; background: transparent; color: var(--gray-700); padding: 7px 8px; border-radius: 6px; cursor: pointer; text-align: left; }
.local-project-entry:hover { background: var(--gray-50); }
.local-project-empty { padding: 18px; color: var(--gray-400); font-size: 13px; text-align: center; }
.local-project-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border-top: 1px solid var(--gray-100); }
.local-project-path { color: var(--gray-500); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.local-project-hint { display: block; padding: 0 10px 8px; color: var(--gray-400); font-size: 12px; }
</style>
