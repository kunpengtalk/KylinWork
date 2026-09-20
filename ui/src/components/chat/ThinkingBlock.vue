<script setup lang="ts">
/**
 * 模型的思考过程。设计对齐业界同类 Agent 产品的 reasoning-block：
 * 默认折叠成一行「思考中… / 已思考完」，展开才看全文。
 * 思考内容是给自己看的推演，不该和正式答复抢版面。
 */
import { ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

const props = defineProps<{ text: string; streaming?: boolean }>()
const open = ref(false)
</script>

<template>
  <div v-if="props.text" class="min-w-0">
    <button
      type="button"
      class="flex cursor-pointer items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span :class="props.streaming && 'animate-pulse'">{{ props.streaming ? '深度思考中…' : '深度思考' }}</span>
      <ChevronDown class="size-3.5 text-muted-foreground/70 transition-transform duration-150" :class="open && 'rotate-180'" />
    </button>
    <pre
      v-if="open"
      class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2.5 text-xs leading-5 text-muted-foreground"
    >{{ props.text }}</pre>
  </div>
</template>
