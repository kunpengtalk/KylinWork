<script setup lang="ts">
/**
 * 单条工具调用（对齐 T3 的 PlainWorkEntryRow）：
 * 6×6 的图标槽 + 一句话 + 耗时，失败标红；点开在行下方就地展开入参/结果，
 * 详情区带左缩进（ms-7）跟图标对齐，底色 muted/40 不抢正文。
 */
import { computed, ref } from 'vue'
import { ChevronDown, Loader2, X } from 'lucide-vue-next'
import type { ToolCall } from './types'
import { describeTool, formatDuration, KIND_TONE, liveHint, metaOf } from './toolMeta'

const props = defineProps<{ tool: ToolCall }>()
const open = ref(false)

const meta = computed(() => metaOf(props.tool.name))
const sentence = computed(() => describeTool(props.tool.name, props.tool.input, props.tool.purpose))
const duration = computed(() =>
  props.tool.running ? '' : formatDuration(props.tool.endedAt && props.tool.startedAt ? props.tool.endedAt - props.tool.startedAt : undefined),
)
/** 跑的时候在行下面跟一句现在进行时：页面静止不等于卡死，但用户看不见这句话就会这么以为 */
const live = computed(() => {
  if (!props.tool.running) return ''
  const hint = liveHint(props.tool.name, props.tool.input, props.tool.purpose)
  // 只在它确实说了新东西时才占一行：模型给的 purpose 常常就是「读取 xxx.md」，
  // 而实时说明是「正在读取 xxx.md」——同一件事说两遍，看着像界面出错。
  // 比之前先把"正在/中…"这类时态词和空白抹掉，一样就不显示。
  const norm = (s: string) => s.replace(/正在|中…|…/g, '').replace(/\s+/g, '')
  return hint && !norm(sentence.value).includes(norm(hint)) ? hint : ''
})
</script>

<template>
  <div
    class="flex min-w-0 flex-col rounded-md px-0.5 py-0.5 transition-colors"
    :class="tool.name.startsWith('delegate') && 'mb-1 rounded-lg border border-border bg-muted/30 px-2 py-1.5'"
  >
    <button
      type="button"
      class="flex w-full cursor-pointer select-none items-center gap-1.5 rounded-md py-0.5 text-left text-sm leading-relaxed transition-colors duration-150 hover:bg-accent/20"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span
        class="flex size-6 shrink-0 items-center justify-center"
        :class="tool.isError ? 'text-destructive' : 'text-muted-foreground'"
      >
        <Loader2 v-if="tool.running" class="size-4 shrink-0 animate-spin stroke-[1.8]" />
        <component
          :is="meta.icon"
          v-else
          class="size-4 shrink-0 stroke-[1.8]"
          :class="tool.isError ? 'text-destructive' : KIND_TONE[meta.kind]"
        />
      </span>
      <span class="min-w-0 flex-1 truncate" :class="tool.isError ? 'text-destructive' : 'text-muted-foreground'">
        <code v-if="tool.name === 'run_shell'" class="font-mono text-[12px]">$ {{ sentence }}</code>
        <template v-else>{{ sentence }}</template>
        <span v-if="tool.expert" class="text-muted-foreground/70"> · {{ tool.expert }}</span>
      </span>
      <X v-if="tool.isError" class="size-3 shrink-0 text-destructive" />
      <span v-if="duration" class="shrink-0 text-xs tabular-nums text-muted-foreground/70">{{ duration }}</span>
      <span class="flex size-4 shrink-0 items-center justify-center">
        <ChevronDown
          class="size-3 shrink-0 text-muted-foreground opacity-70 transition-transform duration-200"
          :class="open && 'rotate-180'"
        />
      </span>
    </button>

    <!-- 正在跑：行下面跟一句灰字「现在在干嘛」，把"还在动"这件事摆在明面上 -->
    <p v-if="live" class="ms-7.5 truncate text-xs leading-5 text-muted-foreground/70">{{ live }}</p>

    <div v-if="open" class="mt-1 ms-7 flex cursor-default flex-col gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs" @click.stop>
      <div class="font-mono text-[11px] text-muted-foreground">{{ tool.name }} · {{ tool.id }}</div>
      <!-- 行级 diff 优先：写文件/改文件看「改了哪几行」比看整段结果直观得多（+绿 -红） -->
      <div v-if="tool.diff?.length" class="min-w-0 overflow-hidden rounded-md border border-border bg-background">
        <pre class="max-h-72 overflow-auto font-mono text-[11px] leading-5"><span
  v-for="(l, i) in tool.diff"
  :key="i"
  class="block px-2"
  :class="l.op === '+' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : l.op === '-' ? 'bg-red-500/10 text-red-700 dark:text-red-300' : 'opacity-60'"
>{{ l.op === '+' ? '+' : l.op === '-' ? '-' : ' ' }} {{ l.text }}</span></pre>
      </div>
      <div v-if="tool.input && !tool.diff?.length" class="min-w-0">
        <p class="mb-1 text-[11px] text-muted-foreground">入参</p>
        <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words">{{ tool.input }}</pre>
      </div>
      <div v-if="tool.result && !tool.diff?.length" class="min-w-0">
        <p class="mb-1 text-[11px] text-muted-foreground">{{ tool.isError ? '报错' : '结果' }}</p>
        <pre
          class="max-h-60 overflow-auto whitespace-pre-wrap break-words"
          :class="tool.isError ? 'text-destructive' : 'opacity-80'"
        >{{ tool.result }}</pre>
      </div>
      <p v-if="!tool.result && tool.running" class="text-[11px] text-muted-foreground">执行中…</p>
    </div>
  </div>
</template>
