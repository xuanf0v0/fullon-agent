<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { agentApi } from '@/apis/agent_api'
import MarkdownPreview from '@/modules/workspace/ui/MarkdownPreview.vue'
import {
  buildBoundSkillDraftPayload,
  validateBoundSkillDraftForm
} from '@/modules/agents/model/boundSkillDraft'

const props = defineProps({
  open: { type: Boolean, default: false },
  mode: { type: String, default: 'existing' },
  agentSlug: { type: String, default: '' },
  agentName: { type: String, default: '' }
})
const emit = defineEmits(['update:open', 'saved', 'use-draft', 'busy'])
const generating = ref(false)
const saving = ref(false)
const draft = ref(null)
const form = reactive({ purpose: '', triggers: '', inputsOutputs: '', tools: [] })
const busy = computed(() => generating.value || saving.value)
const isNew = computed(() => props.mode === 'new')

watch(
  () => props.open,
  (value) => {
    if (value) draft.value = null
  }
)

/** 关闭弹窗；请求进行中时保持打开，避免结果被丢弃。 */
const close = () => {
  if (!busy.value) emit('update:open', false)
}

const onOpenChange = (value) => {
  if (!value && busy.value) return
  emit('update:open', value)
}

const generateDraft = async () => {
  const invalid = validateBoundSkillDraftForm(form)
  if (invalid) {
    message.warning(invalid)
    return
  }
  if (isNew.value && !props.agentName.trim()) {
    message.warning('请先填写智能体名称')
    return
  }
  generating.value = true
  try {
    const payload = buildBoundSkillDraftPayload(form)
    draft.value = isNew.value
      ? await agentApi.generateNewAgentSkillDraft({
          agent_name: props.agentName.trim(),
          ...payload
        })
      : await agentApi.generateAgentBoundSkill(props.agentSlug, payload)
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

const useDraft = () => {
  if (!draft.value) return
  emit('use-draft', draft.value)
  close()
}

const saveDraft = async () => {
  if (!draft.value || saving.value) return
  saving.value = true
  emit('busy', true)
  try {
    await agentApi.createAgentBoundSkill(props.agentSlug, { content: draft.value.content })
    emit('saved')
    emit('update:open', false)
    message.success('专属 Skill 已保存')
  } catch (cause) {
    message.error(cause.message || '保存失败；请刷新后重试')
  } finally {
    saving.value = false
    emit('busy', false)
  }
}
</script>

<template>
  <a-modal
    :open="open"
    title="AI 生成专属 Skill"
    :width="760"
    :footer="null"
    :closable="!busy"
    :mask-closable="!busy"
    :keyboard="!busy"
    @update:open="onOpenChange"
  >
    <p class="draft-hint">
      描述用途后生成草稿；草稿不会自动保存，确认内容后{{
        isNew ? '随智能体创建一并保存' : '再保存为专属 Skill'
      }}。
    </p>
    <div class="draft-form">
      <label>用途 <span class="required">*</span></label>
      <a-textarea
        v-model:value="form.purpose"
        :rows="3"
        :maxlength="2000"
        show-count
        placeholder="例如：每周把销售 CSV 汇总成带图表的周报"
      />
      <label>触发场景</label>
      <a-textarea
        v-model:value="form.triggers"
        :rows="2"
        :maxlength="1000"
        placeholder="例如：用户提到周报、销售汇总、环比"
      />
      <label>输入与输出</label>
      <a-textarea
        v-model:value="form.inputsOutputs"
        :rows="2"
        :maxlength="1000"
        placeholder="例如：输入 CSV 文件，输出 Markdown 周报和图表"
      />
      <label>依赖工具</label>
      <a-select
        v-model:value="form.tools"
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
        <a-button :disabled="generating" @click="close">取消</a-button>
        <a-button type="primary" :loading="generating" @click="generateDraft">生成草稿</a-button>
      </template>
      <template v-else>
        <a-button :disabled="saving" @click="draft = null">重新生成</a-button>
        <a-button v-if="isNew" type="primary" @click="useDraft">使用此草稿</a-button>
        <a-button v-else type="primary" :loading="saving" @click="saveDraft">保存为专属 Skill</a-button>
      </template>
    </div>
  </a-modal>
</template>

<style scoped lang="less">
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
</style>
