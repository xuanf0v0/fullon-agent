<script setup>
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { BookOpen, Plus, RefreshCw, Sparkles } from '@lucide/vue'
import { agentApi } from '@/apis/agent_api'
import { skillApi } from '@/apis/skill_api'
import MarkdownPreview from '@/modules/workspace/ui/MarkdownPreview.vue'
import {
  buildBoundSkillDraftPayload,
  validateBoundSkillDraftForm
} from '@/modules/agents/model/boundSkillDraft'

const props = defineProps({ agentSlug: { type: String, required: true } })
const emit = defineEmits(['navigate', 'busy'])
const binding = ref(null)
const content = ref('')
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const fileInput = ref(null)
const generateOpen = ref(false)
const generating = ref(false)
const savingDraft = ref(false)
const draft = ref(null)
const draftForm = reactive({
  purpose: '',
  triggers: '',
  inputsOutputs: '',
  tools: []
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    binding.value = await agentApi.getAgentBoundSkill(props.agentSlug)
    await loadPreview()
  } catch (cause) {
    error.value = cause.message || '加载专属 Skill 失败'
  } finally {
    loading.value = false
  }
}

async function loadPreview() {
  content.value = ''
  if (binding.value?.skill) {
    const result = await skillApi.getSkillFile(binding.value.skill.slug, 'SKILL.md')
    content.value = result.data.content
  }
}

async function create() {
  if (saving.value) return
  saving.value = true
  emit('busy', true)
  try {
    binding.value = await agentApi.createAgentBoundSkill(props.agentSlug)
    await load()
    message.success('已创建操作指南')
  } catch (cause) {
    message.error(cause.message || '创建失败')
  } finally {
    saving.value = false
    emit('busy', false)
  }
}

async function upload(file) {
  if (saving.value) return
  saving.value = true
  emit('busy', true)
  try {
    binding.value = await agentApi.uploadAgentBoundSkill(
      props.agentSlug,
      file
    )
    await load()
    message.success('专属 Skill 已导入')
  } catch (cause) {
    message.error(cause.message || '上传失败；请刷新后重试')
  } finally {
    saving.value = false
    emit('busy', false)
  }
}

function selectPackage(event) {
  if (saving.value) return
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (!file.name.toLowerCase().endsWith('.zip') || file.size > 10 * 1024 * 1024) {
    message.error('请选择不超过 10 MiB 的 ZIP 文件')
    return
  }
  upload(file)
}

function openDetail() {
  if (saving.value || loading.value || !binding.value?.skill) return
  emit('navigate', {
    name: 'ExtensionSkillDetail',
    params: { slug: binding.value.skill.slug },
    query: { agent: props.agentSlug }
  })
}

function openGenerate() {
  draft.value = null
  generateOpen.value = true
}

function closeGenerate() {
  if (generating.value || savingDraft.value) return
  generateOpen.value = false
}

async function generateDraft() {
  const invalid = validateBoundSkillDraftForm(draftForm)
  if (invalid) {
    message.warning(invalid)
    return
  }
  generating.value = true
  try {
    draft.value = await agentApi.generateAgentBoundSkill(
      props.agentSlug,
      buildBoundSkillDraftPayload(draftForm)
    )
  } catch (cause) {
    message.error(
      cause.status === 502
        ? '生成失败：请确认快速模型可用后重试'
        : cause.message || '生成失败，请稍后重试'
    )
  } finally {
    generating.value = false
  }
}

async function saveDraft() {
  if (!draft.value || savingDraft.value) return
  savingDraft.value = true
  emit('busy', true)
  try {
    binding.value = await agentApi.createAgentBoundSkill(props.agentSlug, {
      content: draft.value.content
    })
    generateOpen.value = false
    draft.value = null
    await load()
    message.success('专属 Skill 已保存')
  } catch (cause) {
    message.error(cause.message || '保存失败；请刷新后重试')
  } finally {
    savingDraft.value = false
    emit('busy', false)
  }
}

function regenerate() {
  draft.value = null
}

onMounted(load)
</script>

<template>
  <section class="bound-skill-panel">
    <header class="bound-skill-header">
      <div>
        <h3>专属 Skill</h3>
        <p>操作流程与资源，运行时自动加载。</p>
      </div>
      <div v-if="binding?.skill && !error" class="header-actions">
        <a-button type="text" :disabled="saving || loading" @click="load">
          <template #icon><RefreshCw :size="14" /></template>
          刷新
        </a-button>
        <a-button :disabled="saving || loading" @click="openDetail">{{ binding.can_manage ? '编辑 Skill' : '查看文件' }}</a-button>
      </div>
    </header>
    <div v-if="loading" class="skill-loading"><a-spin aria-label="加载专属 Skill" /></div>
    <a-alert v-else-if="error" type="error" :message="error" show-icon>
      <template #action><a-button size="small" @click="load">重试</a-button></template>
    </a-alert>
    <template v-else>
      <div v-if="binding?.skill" class="bound-skill-preview" aria-label="专属 Skill 内容预览">
        <div class="preview-content"><MarkdownPreview :content="content" compact /></div>
      </div>
      <div v-else class="skill-empty">
        <BookOpen :size="28" :stroke-width="1.4" class="empty-icon" aria-hidden="true" />
        <p>尚未添加专属 Skill</p>
        <div v-if="binding?.can_manage" class="empty-actions">
          <a-button type="primary" :disabled="saving" @click="openGenerate">
            <template #icon><Sparkles :size="14" /></template>
            AI 生成
          </a-button>
          <a-button :loading="saving" @click="create">
            <template #icon><Plus :size="14" /></template>
            创建模板
          </a-button>
          <a-button type="text" :disabled="saving" @click="fileInput.click()">导入 ZIP</a-button>
        </div>
      </div>
      <input v-if="binding?.can_manage && !binding.skill" ref="fileInput" type="file" accept=".zip" hidden @change="selectPackage" />
    </template>

    <a-modal
      v-model:open="generateOpen"
      title="AI 生成专属 Skill"
      :width="760"
      :footer="null"
      :closable="!generating && !savingDraft"
      :mask-closable="!generating && !savingDraft"
      :keyboard="!generating && !savingDraft"
      @cancel="closeGenerate"
    >
      <p class="draft-hint">
        描述用途后生成草稿；草稿不会自动保存，确认内容后再保存为专属 Skill。
      </p>
      <div class="draft-form">
        <label>用途 <span class="required">*</span></label>
        <a-textarea
          v-model:value="draftForm.purpose"
          :rows="3"
          :maxlength="2000"
          show-count
          placeholder="例如：每周把销售 CSV 汇总成带图表的周报"
        />
        <label>触发场景</label>
        <a-textarea
          v-model:value="draftForm.triggers"
          :rows="2"
          :maxlength="1000"
          placeholder="例如：用户提到周报、销售汇总、环比"
        />
        <label>输入与输出</label>
        <a-textarea
          v-model:value="draftForm.inputsOutputs"
          :rows="2"
          :maxlength="1000"
          placeholder="例如：输入 CSV 文件，输出 Markdown 周报和图表"
        />
        <label>依赖工具</label>
        <a-select
          v-model:value="draftForm.tools"
          mode="tags"
          :max-tag-count="6"
          :token-separators="[',', '，']"
          placeholder="可选，如 web_search、mysql_query"
        />
      </div>
      <div v-if="draft" class="draft-preview" aria-label="Skill 草稿预览">
        <MarkdownPreview :content="draft.content" compact />
      </div>
      <div class="draft-actions">
        <template v-if="!draft">
          <a-button :disabled="generating" @click="closeGenerate">取消</a-button>
          <a-button type="primary" :loading="generating" @click="generateDraft">生成草稿</a-button>
        </template>
        <template v-else>
          <a-button :disabled="savingDraft" @click="regenerate">重新生成</a-button>
          <a-button type="primary" :loading="savingDraft" @click="saveDraft">保存为专属 Skill</a-button>
        </template>
      </div>
    </a-modal>
  </section>
</template>

<style scoped lang="less">
.bound-skill-panel {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.bound-skill-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h3 {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}
p {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}
.header-actions,
.empty-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
:deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 13px;
  box-shadow: none;
}
.skill-loading {
  padding: 64px 0;
  text-align: center;
}
.skill-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 56px 16px 64px;
  border-top: 1px solid var(--gray-100);

  .empty-icon {
    margin-bottom: 16px;
    color: var(--gray-400);
  }
  .empty-actions {
    margin-top: 20px;
  }
}
.bound-skill-preview {
  overflow-wrap: anywhere;
}
.draft-hint {
  margin: 0 0 16px;
  font-size: 13px;
}
.draft-form {
  display: flex;
  flex-direction: column;
  gap: 10px;

  label {
    font-size: 13px;
    color: var(--color-text);
  }

  .required {
    color: var(--color-error-700);
  }
}
.draft-preview {
  max-height: 46vh;
  overflow: auto;
  padding: 16px;
  border: 1px solid var(--gray-100);
  border-radius: 8px;
}
.draft-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
@media (max-width: 600px) {
  .bound-skill-header {
    align-items: flex-start;
    flex-wrap: wrap;
  }
}
</style>
