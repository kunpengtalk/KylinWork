<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { FileText, Link2, StickyNote } from 'lucide-vue-next'
import { listKnowledgeChunks, type KnowledgeChunk, type KnowledgeDoc } from '@/api/client'

/**
 * 查看某个文档切出来的分块：每段的序号、标题路径、字数、有没有向量、正文预览。
 * 召回不对时，先看这里就能判断是「切得不对」还是「没召回过来」。
 */
const props = defineProps<{
  open: boolean
  kbId: string
  doc: KnowledgeDoc | null
}>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>()

const chunks = ref<KnowledgeChunk[]>([])
const loading = ref(false)
const error = ref('')

const kindIcon = computed(() => (props.doc?.kind === 'note' ? StickyNote : props.doc?.kind === 'web' ? Link2 : FileText))

watch(
  () => [props.open, props.doc?.id, props.kbId],
  async () => {
    if (!props.open || !props.doc) return
    loading.value = true
    error.value = ''
    chunks.value = []
    try {
      const d = await listKnowledgeChunks(props.kbId, props.doc.id)
      chunks.value = d.chunks || []
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <component :is="kindIcon" class="size-4 shrink-0 text-muted-foreground" />
          <span class="truncate">分块列表 · {{ doc?.name }}</span>
        </DialogTitle>
        <DialogDescription>共 {{ chunks.length }} 段。命中不好时先看这里：切得对不对、有没有向量。</DialogDescription>
      </DialogHeader>

      <div v-if="loading" class="flex justify-center py-10">
        <Spinner class="size-5 text-muted-foreground" />
      </div>
      <p v-else-if="error" class="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[12px] text-destructive">
        {{ error }}
      </p>
      <p v-else-if="!chunks.length" class="py-8 text-center text-sm text-muted-foreground">
        还没有分块——这份资料可能还在排队入库，或者本身没有可索引的文字。
      </p>
      <div v-else class="space-y-2">
        <div v-for="c in chunks" :key="c.seq" class="rounded-lg border border-border bg-card/40 p-2.5">
          <p class="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span class="font-mono text-foreground/70">#{{ c.seq + 1 }}</span>
            <span>{{ c.char_count }} 字</span>
            <Badge v-if="c.embedded" variant="secondary" class="text-[10px] text-emerald-600 dark:text-emerald-400">已向量化</Badge>
            <Badge v-else variant="secondary" class="text-[10px]">未向量化</Badge>
            <span v-if="c.heading" class="truncate">› {{ c.heading }}</span>
          </p>
          <p class="mt-1 line-clamp-4 whitespace-pre-wrap text-xs text-foreground/80">{{ c.text }}</p>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
