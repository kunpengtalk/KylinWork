<script setup lang="ts">
/**
 * 任务运行条：后台在跑的时候，页面上必须有东西在动。
 *
 * 以前这行是「流光文字 + 一堆 · 分隔」拼起来的，问题有两个：
 * 1. 流光那段用的是 `color: transparent` 配 `currentColor` 渐变——currentColor 取到的
 *    就是 transparent，于是「工作中 3 秒」从来就没显示出来，只剩一个孤零零的「· 」挂在行首；
 * 2. 一行塞了计时、状态、工具数、空闲提醒，还都用 · 连起来，扫一眼读不出哪个是哪个。
 *
 * 现在改成：一个转动的指示器（最不会失效的"在动"信号）+ 正常的文字 + 停止按钮。
 * 计时、在干什么、token 账、工具数各占一段，用 · 分开但每段自带含义，不再是符号堆。
 */
import { computed } from 'vue'
import { Loader2, Square } from 'lucide-vue-next'

const props = defineProps<{
  running: boolean
  /** 已运行秒数（父组件每秒更新） */
  elapsed: number
  /** 当前在干什么，例如「读取 报告.md」/「等待模型响应」 */
  label: string
  phase: 'think' | 'tool' | 'write' | 'wrap'
  /** 已调用工具次数 */
  tools?: number
  /** 距上次有新输出过了多少秒；超过阈值提示"还在跑" */
  idle?: number
  /** 本轮 token 实时账（引擎每收到一条模型回复就播一次），没有就整段不显示 */
  usage?: Record<string, unknown>
}>()

const emit = defineEmits<{ (e: 'stop'): void }>()

const clock = computed(() => {
  const s = Math.max(0, Math.floor(props.elapsed))
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`
})
/** 光转圈不说人话等于没说：超过 15 秒没新东西，明确告诉用户"还活着，只是在等" */
const idleNote = computed(() => ((props.idle || 0) >= 15 ? `已 ${props.idle} 秒没有新输出，仍在运行` : ''))

/** 实时 token 账：只在真的有数（≥1 轮模型回复）时才出现，避免开跑就挂个 0 */
const tok = computed(() => {
  const u = props.usage
  if (!u) return ''
  const p = Number(u.prompt || 0)
  const c = Number(u.completion || 0)
  if (!p && !c) return ''
  return `↑ ${p.toLocaleString()} ↓ ${c.toLocaleString()}`
})
</script>

<template>
  <div
    v-if="running"
    class="flex min-h-7 w-fit max-w-full items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1 text-sm text-muted-foreground"
  >
    <Loader2 class="size-3.5 shrink-0 animate-spin" />
    <span class="shrink-0 tabular-nums">{{ clock }}</span>
    <span class="min-w-0 truncate">· {{ label }}</span>
    <span v-if="tok" class="shrink-0 tabular-nums" title="本轮已消耗的 token（实时）">· {{ tok }}</span>
    <span v-if="tools" class="shrink-0">· 已调 {{ tools }} 个工具</span>
    <span v-if="idleNote" class="min-w-0 truncate text-amber-600 dark:text-amber-400">· {{ idleNote }}</span>
    <button
      type="button"
      class="ms-0.5 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs transition-colors hover:bg-accent hover:text-foreground"
      title="停止任务"
      @click="emit('stop')"
    >
      <Square class="size-2.5" fill="currentColor" />
      停止
    </button>
  </div>
</template>
