<template>
  <BaseToolCall :tool-call="toolCall">
    <template #header>
      <div class="sep-header">
        <span class="note">删除文件</span>
        <span class="separator" v-if="filePath">|</span>
        <span class="description code">{{ filePath }}</span>
      </div>
    </template>
    <template #result> </template>
  </BaseToolCall>
</template>

<script setup>
import { computed } from 'vue'
import BaseToolCall from '../BaseToolCall.vue'
import { parseToolCallArgs } from '../toolRegistry'

const props = defineProps({
  toolCall: {
    type: Object,
    required: true
  }
})

const parsedArgs = computed(() => parseToolCallArgs(props.toolCall))
const filePath = computed(() => parsedArgs.value.path || '')
</script>
