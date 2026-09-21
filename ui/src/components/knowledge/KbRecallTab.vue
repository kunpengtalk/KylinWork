<script setup lang="ts">
import { computed, ref } from 'vue'
import { FileText, FlaskConical, Loader2, Search } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { searchKnowledge, type KnowledgeBase, type KnowledgeHit } from '@/api/client'

/**
 * 召回测试：用一句真实问题验证「能不能召回到、排得对不对」。
 * <p>
 * topK / 阈值 / 重排这些不在这里调——它们属于这个库的配置，在「设置」里改，
 * 这里只负责跑一次真实检索给你看结果。
 */
const props = defineProps<{ base: KnowledgeBase }>()

const query = ref('')
const hits = ref<KnowledgeHit[] | null>(null)
const notes = ref<string[]>([])
const mode = ref('')
const model = ref('')
const testing = ref(false)

const canRun = computed(() => !!query.value.trim() && !testing.value)

async function run() {
  if (!canRun.value) return
  testing.value = true
  hits.value = null
  notes.value = []
  try {
    const d = await searchKnowledge({ query: query.value.trim(), ids: [props.base.id] })
    hits.value = d.hits || []
    notes.value = d.notes || []
    mode.value = d.mode || ''
    model.value = d.model || ''
  } catch (e) {
    notes.value = ['检索失败：' + (e as Error).message]
    hits.value = []
  } finally {
    testing.value = false
  }
}

/** 命中来自哪一路，和引擎的口径一致 */
function methodLabel(h: KnowledgeHit): string {
  if (h.matched === 'both') return '向量+关键词'
  if (h.matched === 'vector') return '向量'
  if (h.matched === 'keyword') return '关键词'
  return ''
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="border-b border-border/60 px-4 py-3">
      <div class="flex gap-2">
        <div class="relative flex-1">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="query" class="h-9 pl-8" placeholder="输入一个真实问题，看看能不能召回到相关内容…" @keyup.enter="run" />
        </div>
        <Button size="sm" class="h-9 shrink-0 gap-1.5" :disabled="!canRun" @click="run">
          <Loader2 v-if="testing" class="size-3.5 animate-spin" />
          <FlaskConical v-else class="size-3.5" /> 测试
        </Button>
      </div>
      <p v-if="hits && mode" class="mt-2 text-[11px] text-muted-foreground">
        检索方式：{{ mode }}<template v-if="model"> · {{ model }}</template>
      </p>
      <p
        v-for="(n, i) in notes"
        :key="i"
        class="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400"
      >
        {{ n }}
      </p>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      <div v-if="hits === null" class="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
        <FlaskConical class="size-8 opacity-40" />
        用真实问题做一次召回测试
        <span class="text-[11px]">结果按相关度排序，会标出命中来自向量还是关键词</span>
      </div>
      <p v-else-if="!hits.length" class="py-12 text-center text-sm text-muted-foreground">
        没有召回结果——换个问法，或确认资料已建好索引。
      </p>
      <div v-else class="space-y-2">
        <div v-for="(h, i) in hits" :key="i" class="rounded-lg border border-border bg-card/40 p-2.5">
          <p class="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span class="font-mono text-foreground/70">#{{ i + 1 }}</span>
            <FileText class="size-3 shrink-0" />
            <span class="min-w-0 truncate">{{ h.file }}<template v-if="h.heading"> › {{ h.heading }}</template></span>
            <span v-if="h.seq !== undefined" class="font-mono">分块 {{ (h.seq ?? 0) + 1 }}</span>
            <Badge v-if="methodLabel(h)" variant="outline" class="h-4 px-1 text-[10px]">{{ methodLabel(h) }}</Badge>
            <Badge v-if="h.reranked" variant="outline" class="h-4 px-1 text-[10px]">重排</Badge>
            <Badge v-if="h.merged && h.merged > 1" variant="outline" class="h-4 px-1 text-[10px]">合并 {{ h.merged }} 段</Badge>
            <span class="ml-auto flex items-center gap-1.5">
              <span class="inline-block h-1 w-16 overflow-hidden rounded-full bg-muted">
                <span class="block h-full rounded-full bg-primary" :style="{ width: Math.max(4, Math.round(h.score * 100)) + '%' }" />
              </span>
              <span class="font-mono">{{ h.score.toFixed(2) }}</span>
            </span>
          </p>
          <p class="mt-1 line-clamp-4 whitespace-pre-wrap text-xs text-foreground/80">{{ h.text }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
