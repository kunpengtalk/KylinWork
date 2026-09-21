<script setup lang="ts">
/**
 * 单条消息：用户气泡 / 助手的身份行、工具调用、正文、产出、里程碑、提问卡、来源、操作条。
 *
 * 排版参照同类 Agent 产品（WorkBuddy / T3）：
 * - 助手答复先有「谁在答、答完了没、花了多久」一行，再进正文——用户不用猜这段是谁写的；
 * - 正文交给 vue-stream-markdown 渲染（表格、代码、图表、公式都有样式），
 *   以前用 `prose` 类但项目里根本没装 typography 插件，等于裸文本，表格连框线都没有；
 * - 底部把「产物 / 变更 / 来源」汇成一行入口，操作条常驻（复制 / 评价 / 重新生成 + 模型 + 时间）。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { Markdown } from 'vue-stream-markdown'
import 'vue-stream-markdown/index.css'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Link2,
  ListChecks,
  MoreHorizontal,
  RotateCcw,
  StickyNote,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  Volume2,
} from 'lucide-vue-next'
import type { Msg, OutFile, ToolCall } from './types'
import ToolCallLine from './ToolCallLine.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import { describeTool, formatDuration, KIND_TONE, metaOf } from './toolMeta'
import { fileMeta } from './fileIcon'
import { fileDownloadUrl } from '@/api/client'
import { formatSize, formatStamp } from '@/lib/time'
import { useIsDark } from '@/composables/useIsDark'

const props = defineProps<{
  msg: Msg
  /** 工作空间里的文件（含体积），文件卡上要标大小 */
  files?: OutFile[]
  /** 工作空间里累计的产物数 / 本轮之前改过的文件数，用于底部「查看所有…」入口 */
  artifactCount?: number
  changedCount?: number
}>()

const emit = defineEmits<{
  (e: 'feedback', verdict: 'up' | 'down'): void
  (e: 'note', text: string): void
  (e: 'answer', label: string): void
  (e: 'open-file', name: string): void
  (e: 'retry'): void
  (e: 'delete'): void
  (e: 'open-artifacts'): void
}>()

const isDark = useIsDark()

/** 本轮耗时：跑完才显示（「已完成 · 3m12s」） */
const duration = computed(() =>
  props.msg.startedAt && props.msg.endedAt && props.msg.endedAt > props.msg.startedAt
    ? formatDuration(props.msg.endedAt - props.msg.startedAt)
    : '',
)

const modelLabel = computed(() => String(props.msg.usage?.model || ''))

/** 进度卡头部的已完成计数：一眼看出还剩几项，比纯列清单有用 */
const milestoneDone = computed(() => (props.msg.milestones || []).filter((x) => x.done).length)

// ==================== 工具行的聚合与折叠 ====================
// 跑一个任务经常连着读五六个文件、搜三四次——一条一行会把答复推到屏幕外。
// 两招：连续的同类调用并成一行；整轮跑完后，超过 4 行的步骤折成一句「工作了 1 分 12 秒 · 9 步」。
interface ToolRow {
  key: string
  name: string
  items: ToolCall[]
}
const toolRows = computed<ToolRow[]>(() => {
  const rows: ToolRow[] = []
  for (const t of props.msg.tools) {
    const last = rows[rows.length - 1]
    const canMerge = last && last.name === t.name && !t.running && last.items.every((x) => !x.running)
    if (canMerge) last.items.push(t)
    else rows.push({ key: t.id, name: t.name, items: [t] })
  }
  return rows
})

const FOLD_MIN_ROWS = 4
/** 失败的步骤数：有失败就绝不折叠——出问题的那几步正是用户要去看的东西 */
const failedSteps = computed(() => props.msg.tools.filter((t) => t.isError).length)
/** 只折已完成的轮次：正在跑的步骤必须看得见，那是"它在动"的证据 */
const foldSteps = computed(() => props.msg.done && !failedSteps.value && toolRows.value.length > FOLD_MIN_ROWS)
const stepsOpen = ref(false)
/** 整轮到底跑了多久：首尾相减，不是各步耗时之和（并发那几步是叠在一起的，加起来会虚高） */
const stepDuration = computed(() => {
  const list = props.msg.tools
  const from = list[0]?.startedAt
  const to = list[list.length - 1]?.endedAt
  return from && to && to > from ? formatDuration(to - from) : ''
})
const stepSummary = computed(() => {
  const parts = [`${props.msg.tools.length} 步`]
  if (stepDuration.value) parts.push(stepDuration.value)
  if (failedSteps.value) parts.push(`失败 ${failedSteps.value}`)
  return parts.join(' · ')
})

/**
 * 复制完整执行记录：一条条点开再抄太折磨人。
 * 记的是「哪一步 / 花了多久 / 成没成 / 入参 / 输出」，拿去复盘或贴给别人都是完整的。
 */
function copySteps() {
  const lines = [`【KylinWork 执行记录】${stepSummary.value}`]
  props.msg.tools.forEach((t, i) => {
    const d = t.startedAt && t.endedAt ? formatDuration(t.endedAt - t.startedAt) : ''
    lines.push(
      '',
      `${i + 1}. ${describeTool(t.name, t.input, t.purpose)}（${t.name}${d ? ` · ${d}` : ''}${t.isError ? ' · 失败' : ''}）`,
    )
    if (t.input) lines.push(`   入参：${t.input.replace(/\s+/g, ' ')}`)
    if (t.diff?.length) lines.push(`   改动：\n${t.diff.map((l) => `   ${l.op} ${l.text}`).join('\n')}`)
    if (t.result) lines.push(`   ${t.isError ? '报错' : '结果'}：${t.result.replace(/\s+/g, ' ')}`)
  })
  navigator.clipboard
    .writeText(lines.join('\n'))
    .then(() => toast.success('执行记录已复制'))
    .catch(() => toast.error('复制失败'))
}
const aggOpen = ref<Set<string>>(new Set())
function toggleAgg(key: string) {
  const next = new Set(aggOpen.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  aggOpen.value = next
}
function isAggOpen(key: string) {
  return aggOpen.value.has(key)
}

/** 来源默认收起，底部只留个数——十几条链接铺在答复底下会盖过正文 */
const sourcesOpen = ref(false)
const sourceCount = computed(() => props.msg.sources?.length || 0)

/** 知识库引用：和联网来源一样默认收起，只报个数 */
const citationsOpen = ref(false)
const citationCount = computed(() => props.msg.citations?.length || 0)

/** 引用的类型图标：网页 / 笔记 / 文件 */
function citationIcon(c: { kind?: string }) {
  return c.kind === 'web' ? Link2 : c.kind === 'note' ? StickyNote : FileText
}

/** 「哪儿不对」的输入框：父组件把 fbNoteOpen 打开后这里自动聚焦 */
const note = ref('')
const noteInput = ref<HTMLInputElement | null>(null)
watch(
  () => props.msg.fbNoteOpen,
  (v) => {
    if (!v) return
    note.value = ''
    nextTick(() => noteInput.value?.focus())
  },
)
function submitNote() {
  emit('note', note.value)
}

function copyText() {
  const t = props.msg.text || ''
  if (!t) return
  navigator.clipboard
    .writeText(t)
    .then(() => toast.success('已复制'))
    .catch(() => toast.error('复制失败'))
}

/** 错误行：把状态码和详情拼成一行等宽小字（对齐参考版的 `502 | Trace ID` 那一行） */
const errSummary = computed(() => {
  const e = props.msg.error
  if (!e) return ''
  return [e.status ? `HTTP ${e.status}` : '', e.detail || ''].filter(Boolean).join(' · ')
})

/** 复制错误报告：用户拿去反馈时，说明/状态码/时间/耗时一次带全，不用回头截图 */
function copyError() {
  const e = props.msg.error
  if (!e) return
  const text = [
    '【KylinWork 错误报告】',
    `说明：${e.title}`,
    e.status ? `HTTP：${e.status}` : '',
    e.detail ? `详情：${e.detail}` : '',
    modelLabel.value ? `模型：${modelLabel.value}` : '',
    `时间：${formatStamp(props.msg.at) || '—'}`,
    `耗时：${duration.value || '—'}`,
  ]
    .filter(Boolean)
    .join('\n')
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success('错误信息已复制'))
    .catch(() => toast.error('复制失败'))
}

// ==================== 朗读（浏览器自带语音合成，不依赖外部服务） ====================
const speaking = ref(false)
function speak() {
  const t = String(props.msg.text || '').trim()
  const synth = window.speechSynthesis
  if (!t) return
  if (!synth) {
    toast.error('这台设备不支持语音朗读')
    return
  }
  if (speaking.value) {
    synth.cancel()
    speaking.value = false
    return
  }
  // markdown 记号不该被念出来：围栏、表格线、井号、强调符、链接目标
  const plain = t
    .replace(/```[\s\S]*?```/g, '（代码块）')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`>_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return
  const u = new SpeechSynthesisUtterance(plain)
  u.lang = 'zh-CN'
  u.onend = () => (speaking.value = false)
  u.onerror = () => (speaking.value = false)
  speaking.value = true
  synth.speak(u)
}
onUnmounted(() => {
  if (speaking.value) window.speechSynthesis?.cancel()
})

/** 「更多」菜单：低频但有用的操作，不跟常用按钮抢位置 */
const moreOpen = ref(false)
function pickMore(action: 'copy-md' | 'delete') {
  moreOpen.value = false
  if (action === 'copy-md') copyText()
  else emit('delete')
}

/** 长文件名保留尾部：`2026Q2/小米集团-持仓分析.md` 一眼要看到的是后半截 */
function baseName(p: string) {
  return p.slice(p.lastIndexOf('/') + 1)
}
function extOf(p: string) {
  const i = p.lastIndexOf('.')
  return i > 0 ? p.slice(i + 1).toUpperCase() : '文件'
}
/** 文件体积从工作空间列表里查：产出事件只给名字，体积要另外对一次 */
function sizeOf(name: string) {
  return formatSize(props.files?.find((f) => f.name === name)?.size)
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl" :class="msg.role === 'user' ? 'pb-4' : 'pb-2 group/assistant'">
    <!-- 用户：灰底气泡靠右，hover 才给复制/时间，平时不打扰 -->
    <div v-if="msg.role === 'user'" class="group flex flex-col items-end gap-1">
      <div class="relative max-w-[80%] rounded-2xl bg-muted p-3 text-sm leading-relaxed text-foreground">
        <span class="select-text whitespace-pre-wrap">{{ msg.text }}</span>
      </div>
      <div class="flex items-center gap-1 pe-1 text-[11px] text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <button class="rounded p-1 transition-colors hover:text-foreground" title="复制" @click="copyText">
          <Copy class="size-3" />
        </button>
        <span class="tabular-nums">{{ formatStamp(msg.at) }}</span>
      </div>
    </div>

    <!-- 助手 -->
    <div v-else class="flex flex-col gap-2">
      <!-- 身份行：谁在答 + 答完没有（跑了多久） -->
      <div class="flex h-6 items-center gap-2">
        <img src="/icon.png" alt="KylinWork" class="size-5 shrink-0 rounded-md" >
        <span class="text-[13px] font-medium">KylinWork</span>
        <span
          v-if="msg.done && msg.tools.length"
          class="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          <CheckCircle2 class="size-3 shrink-0 text-emerald-500" />
          已完成<span v-if="duration" class="tabular-nums"> · {{ duration }}</span>
        </span>
      </div>

      <!-- 思考过程：默认折叠，不跟正式答复抢版面 -->
      <ThinkingBlock v-if="msg.thinking" :text="msg.thinking" :streaming="!msg.done" />

      <!-- 工具调用：连续同类并成一行；整轮跑完后折成一句「执行过程 · N 步」 -->
      <div v-if="msg.tools.length" class="min-w-0">
        <!-- 折叠态：一句摘要，让人知道记录在、只是收着（下面一行就是展开区） -->
        <button
          v-if="foldSteps && !stepsOpen"
          type="button"
          class="flex max-w-full cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          @click="stepsOpen = true"
        >
          <ListChecks class="size-3.5 shrink-0" />
          <span class="shrink-0 font-medium">执行过程</span>
          <span class="shrink-0 tabular-nums">{{ stepSummary }}</span>
          <ChevronDown class="size-3 shrink-0" />
        </button>

        <template v-else>
          <!-- 展开态表头：步数 / 耗时 / 失败数 + 复制整份记录。
               只有一步时不摆表头，那一行工具自己就说清楚了 -->
          <div v-if="msg.tools.length > 1" class="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <ListChecks class="size-3.5 shrink-0" />
            <span class="shrink-0 font-medium">执行过程</span>
            <span class="min-w-0 truncate tabular-nums">{{ stepSummary }}</span>
            <span class="flex-1" />
            <button
              type="button"
              class="shrink-0 cursor-pointer rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
              title="复制完整执行记录"
              @click="copySteps"
            >
              <Copy class="size-3" />
            </button>
            <button
              v-if="foldSteps"
              type="button"
              class="shrink-0 cursor-pointer rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
              title="收起执行过程"
              @click="stepsOpen = false"
            >
              <ChevronDown class="size-3 rotate-180" />
            </button>
          </div>

          <div class="space-y-0.5 border-l border-border pl-2.5">
            <template v-for="row in toolRows" :key="row.key">
              <ToolCallLine v-if="row.items.length === 1" :tool="row.items[0]!" />
              <div v-else>
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 text-left text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                  @click="toggleAgg(row.key)"
                >
                  <component
                    :is="metaOf(row.name).icon"
                    class="size-3.5 shrink-0"
                    :class="row.items.some((x) => x.isError) ? 'text-destructive' : KIND_TONE[metaOf(row.name).kind]"
                  />
                  <span class="min-w-0 truncate">
                    {{ describeTool(row.name, row.items[0]?.input, row.items[0]?.purpose) }} × {{ row.items.length }}
                  </span>
                  <ChevronRight class="size-3 shrink-0 transition-transform" :class="isAggOpen(row.key) && 'rotate-90'" />
                </button>
                <div v-if="isAggOpen(row.key)" class="mt-0.5 space-y-0.5 border-l border-border pl-2.5">
                  <ToolCallLine v-for="t in row.items" :key="t.id" :tool="t" />
                </div>
              </div>
            </template>
          </div>
        </template>
      </div>

      <!-- 正文：markdown 全量渲染（标题/列表/表格/代码/图表都有样式） -->
      <div v-if="msg.text" class="kw-md">
        <Markdown :content="msg.text" :is-dark="isDark" :mode="msg.done ? 'static' : 'streaming'" />
      </div>

      <!-- 一个字都还没出来：brain 图标 + 一行字，别让用户对着空白页以为卡死 -->
      <div
        v-if="!msg.done && !msg.text && !msg.tools.length"
        class="flex min-h-6 w-fit max-w-full items-center gap-1.5 text-sm text-muted-foreground"
      >
        <Brain class="size-4 shrink-0 animate-pulse stroke-[1.8]" />
        <span class="min-w-0 flex-1 truncate">思考中…</span>
      </div>

      <!-- 本轮产出：文件卡（淡色图标块 + 名字 + 体积 + 图标操作），点卡片在右侧 Artifact 打开 -->
      <div v-if="msg.files?.length" class="flex flex-col gap-1.5">
        <div
          v-for="f in msg.files"
          :key="f"
          class="group/file flex w-full min-w-0 items-center gap-2.5 rounded-xl border border-border bg-background/60 p-2 transition-colors hover:border-primary/40"
        >
          <span class="flex size-9 shrink-0 items-center justify-center rounded-lg" :class="fileMeta(f).tint">
            <component :is="fileMeta(f).icon" class="size-4" :class="fileMeta(f).tone" />
          </span>
          <button
            type="button"
            class="flex min-w-0 flex-1 cursor-pointer flex-col items-start text-left"
            :title="`在右侧打开 ${f}`"
            @click="emit('open-file', f)"
          >
            <span class="block w-full truncate text-[13px] font-medium">{{ baseName(f) }}</span>
            <span class="block text-[11px] text-muted-foreground">
              {{ extOf(f) }}<template v-if="sizeOf(f)"> · {{ sizeOf(f) }}</template>
            </span>
          </button>
          <!-- 操作都用图标按钮：卡片右侧摆两个汉字按钮，字号比文件名还抢眼，喧宾夺主 -->
          <div class="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="在右侧预览"
              @click="emit('open-file', f)"
            >
              <ExternalLink class="size-4" />
            </button>
            <a
              :href="fileDownloadUrl(f)"
              class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="下载"
            >
              <Download class="size-4" />
            </a>
          </div>
        </div>
      </div>

      <!-- 失败：不再往正文里塞一行 ⚠️ 文本——结构化的一块，带得动重试/检测网络这些入口 -->
      <div
        v-if="msg.error"
        class="flex flex-col gap-1.5 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5"
      >
        <p class="flex items-start gap-2 text-sm text-foreground">
          <TriangleAlert class="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>{{ msg.error.title }}</span>
        </p>
        <p v-if="errSummary" class="ps-6 font-mono text-[11px] leading-4 text-muted-foreground">{{ errSummary }}</p>
        <div class="flex items-center gap-2 ps-6 text-xs">
          <button
            type="button"
            class="rounded-md border border-border px-2 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            @click="emit('retry')"
          >
            重试
          </button>
          <button
            type="button"
            class="rounded-md border border-border px-2 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            @click="copyError"
          >
            复制错误
          </button>
        </div>
      </div>

      <!-- 进度里程碑：带头部计数，待办用实心空心分明的圈，别弄成一片几乎看不见的淡影 -->
      <div v-if="msg.milestones?.length" class="rounded-xl border border-border bg-muted/30 px-3 py-2.5">
        <div class="mb-2 flex items-center gap-1.5">
          <ListChecks class="size-3.5 shrink-0 text-muted-foreground" />
          <p class="text-xs font-medium">进度</p>
          <p class="text-xs tabular-nums text-muted-foreground">{{ milestoneDone }}/{{ msg.milestones.length }}</p>
        </div>
        <ul class="space-y-1.5">
          <li v-for="(it, i) in msg.milestones" :key="i" class="flex items-start gap-2 text-xs">
            <CircleCheck v-if="it.done" class="mt-px size-3.5 shrink-0 text-emerald-500" />
            <Circle v-else class="mt-px size-3.5 shrink-0 text-muted-foreground/60" />
            <span :class="it.done ? 'text-muted-foreground' : 'text-foreground/80'">{{ it.text }}</span>
          </li>
        </ul>
      </div>

      <!-- 提问卡片 -->
      <div v-if="msg.ask" class="rounded-lg border border-border bg-muted/30 p-3">
        <p class="text-sm font-medium">{{ msg.ask.question }}</p>
        <div v-if="!msg.ask.answered" class="mt-2.5 flex flex-wrap gap-2">
          <Button
            v-for="o in msg.ask.options"
            :key="o.label"
            variant="outline"
            size="sm"
            class="h-auto flex-col items-start gap-0.5 py-1.5 text-left"
            @click="emit('answer', o.label)"
          >
            <span class="text-xs font-medium">{{ o.label }}</span>
            <span v-if="o.detail" class="text-[11px] text-muted-foreground">{{ o.detail }}</span>
          </Button>
        </div>
        <p v-else class="mt-2 text-xs text-muted-foreground">已选：{{ msg.ask.answered }}</p>
      </div>

      <!-- 知识来源：本轮从知识库命中的片段，默认收起 -->
      <div v-if="citationsOpen && citationCount" class="flex flex-wrap gap-1.5">
        <span
          v-for="c in msg.citations"
          :key="c.n"
          class="flex max-w-[22rem] items-center gap-1 truncate rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground"
          :title="`${c.kb_name} · ${c.doc_name}\n${c.snippet}`"
        >
          <component :is="citationIcon(c)" class="size-3 shrink-0" />
          <span class="font-mono text-primary">[{{ c.n }}]</span>
          <span class="truncate">{{ c.doc_name }}</span>
          <span class="shrink-0 text-muted-foreground/70">#{{ c.seq + 1 }}</span>
        </span>
      </div>

      <!-- 来源：默认只报个数，点开才铺链接 -->
      <div v-if="sourcesOpen && sourceCount" class="flex flex-wrap gap-1.5">
        <a
          v-for="(s, i) in msg.sources"
          :key="i"
          :href="s.url"
          target="_blank"
          rel="noreferrer"
          class="max-w-[18rem] truncate rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
        >
          {{ s.title || s.url }}
        </a>
      </div>

      <!-- 汇总入口：产物 / 变更 / 来源，参考版底部那一行 -->
      <div
        v-if="msg.done && ((artifactCount || 0) > 0 || (changedCount || 0) > 0 || sourceCount > 0 || citationCount > 0)"
        class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
      >
        <button
          v-if="artifactCount"
          type="button"
          class="flex items-center gap-0.5 transition-colors hover:text-foreground"
          @click="emit('open-artifacts')"
        >
          查看所有产物 ({{ artifactCount }})<ChevronRight class="size-3" />
        </button>
        <button
          v-if="changedCount"
          type="button"
          class="flex items-center gap-0.5 transition-colors hover:text-foreground"
          @click="emit('open-artifacts')"
        >
          查看所有变更 ({{ changedCount }})<ChevronRight class="size-3" />
        </button>
        <button
          v-if="citationCount"
          type="button"
          class="flex items-center gap-0.5 transition-colors hover:text-foreground"
          @click="citationsOpen = !citationsOpen"
        >
          知识来源 ({{ citationCount }})<ChevronRight class="size-3 transition-transform" :class="citationsOpen && 'rotate-90'" />
        </button>
        <button
          v-if="sourceCount"
          type="button"
          class="flex items-center gap-0.5 transition-colors hover:text-foreground"
          @click="sourcesOpen = !sourcesOpen"
        >
          来源 ({{ sourceCount }})<ChevronRight class="size-3 transition-transform" :class="sourcesOpen && 'rotate-90'" />
        </button>
      </div>

      <!-- 操作条：常驻（参考版就是常显），右侧是模型与时刻 -->
      <div v-if="msg.done" class="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <button class="rounded p-1 transition-colors hover:bg-accent hover:text-foreground" title="复制这条回复" @click="copyText">
          <Copy class="size-3.5" />
        </button>
        <button
          class="rounded p-1 transition-colors hover:bg-accent hover:text-foreground"
          :class="msg.fb === 'up' && 'text-primary'"
          title="这条有用"
          @click="emit('feedback', 'up')"
        >
          <ThumbsUp class="size-3.5" />
        </button>
        <button
          class="rounded p-1 transition-colors hover:bg-accent hover:text-foreground"
          :class="msg.fb === 'down' && 'text-destructive'"
          title="这条不对"
          @click="emit('feedback', 'down')"
        >
          <ThumbsDown class="size-3.5" />
        </button>
        <button
          v-if="msg.text"
          class="rounded p-1 transition-colors hover:bg-accent hover:text-foreground"
          :class="speaking && 'text-primary'"
          :title="speaking ? '停止朗读' : '朗读这条回复'"
          @click="speak"
        >
          <Volume2 class="size-3.5" />
        </button>
        <button class="rounded p-1 transition-colors hover:bg-accent hover:text-foreground" title="用同样的要求重做一遍" @click="emit('retry')">
          <RotateCcw class="size-3.5" />
        </button>
        <div class="relative">
          <button
            class="rounded p-1 transition-colors hover:bg-accent hover:text-foreground"
            :class="moreOpen && 'bg-accent text-foreground'"
            title="更多"
            @click="moreOpen = !moreOpen"
          >
            <MoreHorizontal class="size-3.5" />
          </button>
          <template v-if="moreOpen">
            <div class="fixed inset-0 z-40" @click="moreOpen = false" />
            <div class="absolute bottom-7 left-0 z-50 w-36 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-xl">
              <button
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                @click="pickMore('copy-md')"
              >
                复制 Markdown
              </button>
              <button
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-destructive transition-colors hover:bg-destructive/10"
                @click="pickMore('delete')"
              >
                删除这一轮
              </button>
            </div>
          </template>
        </div>

        <div v-if="msg.fbNoteOpen" class="ml-1 flex items-center gap-1">
          <input
            ref="noteInput"
            v-model="note"
            maxlength="200"
            placeholder="哪儿不对？一句话就行（可以不写）"
            class="h-7 w-56 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary"
            @keydown.enter="submitNote"
            @keydown.esc="msg.fbNoteOpen = false"
          >
          <Button variant="outline" size="sm" class="h-7 px-2 text-xs" @click="submitNote">记下</Button>
        </div>

        <div class="flex-1" />
        <Badge v-if="modelLabel" variant="outline" class="h-5 max-w-40 truncate px-1.5 text-[10px] font-normal text-muted-foreground">
          {{ modelLabel }}
        </Badge>
        <span class="tabular-nums text-[11px] text-muted-foreground/80">{{ formatStamp(msg.at) }}</span>
      </div>

      <!-- 用量：本次任务的 token 账（模型徽标在下面操作条右侧，跟参考版一致，不在这里重复一遍） -->
      <div v-if="msg.usage && msg.done" class="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span class="tabular-nums" title="输入 token">↑ {{ Number(msg.usage.prompt || 0).toLocaleString() }}</span>
        <span class="tabular-nums" title="输出 token">↓ {{ Number(msg.usage.completion || 0).toLocaleString() }}</span>
        <span v-if="Number(msg.usage.cached || 0)" class="tabular-nums text-muted-foreground/70" title="命中缓存的输入 token">
          · 缓存 {{ Number(msg.usage.cached).toLocaleString() }}
        </span>
      </div>
    </div>
  </div>
</template>
