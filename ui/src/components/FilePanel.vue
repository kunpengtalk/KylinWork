<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  Copy,
  ExternalLink,
  FolderOpen,
  Globe,
  Maximize2,
  Minimize2,
  Play,
  RefreshCw,
  Sparkles,
  Square,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Download } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { fileMeta } from '@/components/chat/fileIcon'
import {
  fileDownloadUrl,
  fileViewUrl,
  openFile,
  previewStatus,
  revealFile,
  startPreview,
  stopPreview,
  tidyFiles,
  type OutputFile,
  type PreviewState,
} from '@/api/client'

/**
 * 成果文件面板（对齐 T3 右侧 Work 面板的定位）：
 * - 按「今天 / 昨天 / 过去 7 天 / 更早（按月）」分段列文件夹，段内折叠
 * - 根目录散件独立成可折叠分组（排最后），可一键清掉可证明的重复副本
 * - 点文件内嵌预览：HTML/SVG/Markdown 走本机静态服务；docx/xlsx/pptx/zip
 *   走服务端拆包的结构化预览；csv/tsv 前端就地拆表；图片/音视频原生渲染
 * - 预览服务可启停、可复制链接发给手机（LAN 模式）
 */
const props = defineProps<{
  files: OutputFile[]
  changed: string[]
}>()
const emit = defineEmits<{ (e: 'refresh'): void }>()

const selected = ref('')
const preview = ref<PreviewState>({})
const lanOpen = ref(false)
const starting = ref(false)
const tidying = ref(false)

// ==================== 时间分段（视图里分，磁盘不动） ====================

/** 按文件所在目录分层：{ folder: { files, latest } }，根目录散件单独一档 */
interface FileGroup {
  name: string // 顶层目录名，'' = 根目录散件
  files: OutputFile[]
  latest: number // 最近动过那个文件的 mtime（毫秒）
}

function groupFiles(list: OutputFile[]): { dirs: FileGroup[]; loose: FileGroup } {
  const map = new Map<string, OutputFile[]>()
  const loose: OutputFile[] = []
  for (const f of list) {
    const i = f.name.indexOf('/')
    if (i > 0) {
      const dir = f.name.slice(0, i)
      const arr = map.get(dir) || []
      arr.push(f)
      map.set(dir, arr)
    } else {
      loose.push(f)
    }
  }
  const dirs: FileGroup[] = []
  for (const [name, files] of map) {
    dirs.push({ name, files, latest: Math.max(...files.map((f) => new Date(f.mtime).getTime() || 0)) })
  }
  dirs.sort((a, b) => b.latest - a.latest)
  loose.sort((a, b) => b.mtime.localeCompare(a.mtime))
  return { dirs, loose: { name: '', files: loose, latest: Math.max(0, ...loose.map((f) => new Date(f.mtime).getTime() || 0)) } }
}

/** 相对时间：列表里给一句人话，不用用户自己去算"那是几天前" */
function relTime(ts: number): string {
  if (!ts) return ''
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

const groups = computed(() => groupFiles(props.files))
/** 根目录有没有「可证明冗余」的重复副本（hash 逐字节相同的那类） */
const dupCount = computed(() => groups.value.loose.files.filter((f) => f.dup_of).length)

async function handleTidy() {
  tidying.value = true
  try {
    const r = (await tidyFiles()) as { removed?: number }
    toast.success(`已清理 ${r?.removed ?? 0} 项残留到 .trash`)
    emit('refresh')
  } catch (e) {
    toast.error('清理失败：' + (e as Error).message)
  } finally {
    tidying.value = false
  }
}

// ==================== 预览服务（LAN 用） ====================

const previewable = computed(() => /\.(html?|svg|md|txt|json|log|yml|yaml|xml|csv|tsv)$/i.test(selected.value))
const structured = computed(() => /\.(docx|xlsx|pptx|zip)$/i.test(selected.value))
const mediaKind = computed<'audio' | 'video' | 'image' | ''>(() => {
  const e = extOf(selected.value)
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(e)) return 'audio'
  if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'].includes(e)) return 'video'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'].includes(e)) return 'image'
  return ''
})

const iframeSrc = computed(() =>
  (previewable.value || mediaKind.value === 'image') && preview.value.url
    ? preview.value.url + encodeURIComponent(selected.value)
    : '',
)

/** 结构化拆包：/files/preview/:name 只吐数据，前端统一 esc 后渲染 */
interface DocRun {
  s?: string
  text?: string
  b?: boolean
  i?: boolean
  u?: boolean
}
type PreviewData =
  | { kind: 'doc'; blocks: { t: string; lvl?: number; runs?: DocRun[]; src?: string; rows?: { runs: DocRun[] }[][] }[]; truncated?: boolean }
  | { kind: 'sheet'; sheets: { name: string; rows: string[][]; truncated?: boolean; totalRows?: number; totalCols?: number }[]; total?: number; truncated?: boolean }
  | { kind: 'slides'; slides: { n: number; title?: string; lines?: string[]; notes?: string }[]; total?: number; truncated?: boolean }
  | { kind: 'archive'; entries: { name: string; size?: number; packed?: number }[]; total?: number; bytes?: number; truncated?: boolean }
  | null

const struct = ref<PreviewData>(null)
const structLoading = ref(false)
const structError = ref('')

const activeSheet = ref(0)

watch(selected, async (name) => {
  struct.value = null
  structError.value = ''
  activeSheet.value = 0
  if (!name || !structured.value) return
  structLoading.value = true
  try {
    const r = await fetch(`/engine-api/files/preview/${encodeURIComponent(name)}`)
    if (!r.ok) {
      const j = await r.json().catch(() => null)
      throw new Error(j?.error || `预览失败（${r.status}）`)
    }
    struct.value = (await r.json()) as PreviewData
  } catch (e) {
    structError.value = (e as Error).message
  } finally {
    structLoading.value = false
  }
})

/** 所有动态文本的唯一转义点：结构化数据一律过这里再拼 HTML */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** runs → HTML：加粗/斜体/下划线，data:image 之外的图源一律不放行 */
function runHtml(runs: DocRun[] | undefined): string {
  if (!runs) return ''
  let out = ''
  for (const r of runs) {
    if (r.s === '\n') {
      out += '<br>'
      continue
    }
    let t = esc(r.text ?? '')
    if (r.b) t = `<strong>${t}</strong>`
    if (r.i) t = `<em>${t}</em>`
    if (r.u) t = `<u>${t}</u>`
    out += t
  }
  return out
}

/** docx 表格：一格一格拼，全部 esc */
function cellHtml(runs: DocRun[] | undefined): string {
  return runHtml(runs) || '&nbsp;'
}

/** CSV/TSV：按 RFC4180 拆，分隔符按首行嗅探 */
const csvRows = ref<string[][]>([])
const csvTruncated = ref(false)
const csvFileName = ref('')

watch(selected, async (name) => {
  csvRows.value = []
  csvTruncated.value = false
  csvFileName.value = ''
  if (!name || !/\.(csv|tsv)$/i.test(name)) return
  csvFileName.value = name
  try {
    const r = await fetch(fileViewUrl(name))
    if (!r.ok) return
    const text = (await r.text()).slice(0, 512 * 1024)
    csvTruncated.value = text.length >= 512 * 1024
    const sep = /\.tsv$/i.test(name) ? '\t' : detectSep(text)
    csvRows.value = parseCsv(text, sep)
  } catch {
    /* 拆不出来就当普通文本走 iframe */
  }
})

function detectSep(text: string): string {
  const first = text.split('\n')[0] || ''
  const counts = [',', '\t', ';'].map((s) => ({ s, n: first.split(s).length }))
  counts.sort((a, b) => b.n - a.n)
  return counts[0] && counts[0].n > 1 ? counts[0].s : ','
}

/** RFC4180：字段里带逗号 / 双写引号 / 换行都是常事，split(",") 会拆散架 */
function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQ = false
  const S = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (let i = 0; i < S.length; i++) {
    const c = S[i]
    if (inQ) {
      if (c === '"') {
        if (S[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQ = false
        }
      } else {
        cur += c
      }
    } else if (c === '"') {
      inQ = true
    } else if (c === sep) {
      row.push(cur)
      cur = ''
    } else if (c === '\n') {
      row.push(cur)
      rows.push(row)
      row = []
      cur = ''
    } else {
      cur += c
    }
  }
  row.push(cur)
  rows.push(row)
  // 全空行（文件尾的换行）不算数据
  while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop()
  return rows
}

// ==================== 预览服务启停 ====================

onMounted(async () => {
  try {
    preview.value = await previewStatus()
  } catch {
    /* 服务没起是常态 */
  }
})

async function refreshPreview() {
  try {
    preview.value = await previewStatus()
  } catch {
    /* 忽略 */
  }
}

async function togglePreviewServer() {
  starting.value = true
  try {
    if (preview.value.running) {
      preview.value = await stopPreview()
      toast.success('预览服务已停止')
    } else {
      preview.value = await startPreview({ lan: lanOpen.value })
      toast.success('预览服务已启动')
    }
  } catch (e) {
    toast.error('操作失败：' + (e as Error).message)
  } finally {
    starting.value = false
  }
}

function openInBrowser() {
  if (preview.value.url) window.open(preview.value.url, '_blank', 'noopener')
}

async function copyLink() {
  if (!preview.value.url) return
  try {
    await navigator.clipboard.writeText(
      (lanOpen.value && preview.value.lan_url ? preview.value.lan_url : preview.value.url) +
        encodeURIComponent(selected.value || ''),
    )
    toast.success('链接已复制')
  } catch {
    toast.error('复制失败')
  }
}

/** 扁平列表：最近改动的排最前——用户要找的永远是刚生成的那一个 */
const flatFiles = computed(() =>
  [...(props.files || [])].sort(
    (a, b) => (b.mtime ? Date.parse(b.mtime) || 0 : 0) - (a.mtime ? Date.parse(a.mtime) || 0 : 0),
  ),
)
function baseName(n: string) {
  return String(n).slice(String(n).lastIndexOf('/') + 1)
}
function dirName(n: string) {
  const i = String(n).lastIndexOf('/')
  return i > 0 ? String(n).slice(0, i) : ''
}
/** iframe 刷新：换 key 强制重载，不然改完 HTML 点刷新看到的还是旧渲染 */
const iframeKey = ref(0)
function reloadPreview() {
  iframeKey.value++
}

function select(name: string) {
  selected.value = selected.value === name ? '' : name
}

function extOf(name: string) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : 'file'
}

function fmtSize(n: number) {
  if (!n || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 只看预览：看 HTML 时列表是多余的，让预览吃掉整个右侧高度 */
const previewOnly = ref(false)

/** 供对话里点「产出文件 chip」直接打开：命中已存在的文件就选中并预览 */
function open(name: string) {
  if (!name) return
  selected.value = name
}

defineExpose({ refreshPreview, open })
</script>

<template>
  <aside class="flex w-[clamp(260px,22vw,340px)] shrink-0 flex-col border-l border-border bg-muted/20">
    <!-- 头部 -->
    <div class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      <FolderOpen class="size-4 shrink-0 text-muted-foreground" />
      <span class="flex-1 text-sm font-medium">成果文件</span>
      <Badge v-if="changed.length" variant="secondary" class="text-[10px]">{{ changed.length }} 新</Badge>
      <!-- 根目录里跟成果文件夹逐字节相同的副本：留着只会让同一个成果显示两遍 -->
      <Button
        v-if="dupCount > 0"
        variant="ghost"
        size="sm"
        class="h-6 gap-1 px-1.5 text-[10px] text-muted-foreground"
        :disabled="tidying"
        title="把根目录里的重复副本搬进 .trash（捞得回来）"
        @click="handleTidy"
      >
        <Sparkles class="size-3" />清掉重复的 {{ dupCount }}
      </Button>
      <Button
        v-if="selected"
        variant="ghost"
        size="icon"
        class="size-7"
        :title="previewOnly ? '显示文件列表' : '只看预览'"
        @click="previewOnly = !previewOnly"
      >
        <Maximize2 v-if="!previewOnly" class="size-3.5" />
        <Minimize2 v-else class="size-3.5" />
      </Button>
      <Button variant="ghost" size="icon" class="size-7" title="刷新" @click="emit('refresh'); refreshPreview()">
        <RefreshCw class="size-3.5" />
      </Button>
    </div>

    <!-- 预览服务条 -->
    <div class="flex items-center gap-1.5 border-b border-border px-3 py-2">
      <Globe class="size-3.5 shrink-0 text-muted-foreground" />
      <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        {{ preview.running ? '预览服务运行中' : '预览服务未启动' }}
      </span>
      <button
        v-if="preview.running"
        class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="复制链接"
        @click="copyLink"
      >
        <Copy class="size-3.5" />
      </button>
      <button
        v-if="preview.running"
        class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="在浏览器打开"
        @click="openInBrowser"
      >
        <ExternalLink class="size-3.5" />
      </button>
      <Button variant="ghost" size="sm" class="h-6 gap-1 px-1.5 text-[11px]" :disabled="starting" @click="togglePreviewServer">
        <Play v-if="!preview.running" class="size-3" />
        <Square v-else class="size-3" />
        {{ preview.running ? '停止' : '启动' }}
      </Button>
    </div>
    <label class="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
      <input v-model="lanOpen" type="checkbox" class="size-3 accent-primary" @change="refreshPreview">
      对局域网开放（手机扫码可看）
    </label>

    <!-- 文件列表：一行一个图标，最近改动的排最前 -->
    <div v-show="!previewOnly" class="max-h-[42%] shrink-0 overflow-y-auto border-b border-border p-2">
      <div v-if="!flatFiles.length" class="px-2 py-8 text-center text-xs text-muted-foreground">
        还没有成果文件
      </div>
      <ul v-else class="space-y-0.5">
        <li v-for="f in flatFiles" :key="f.name" class="group flex items-center gap-0.5">
          <button
            class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors"
            :class="selected === f.name ? 'bg-accent' : 'hover:bg-accent/60'"
            :title="f.name"
            @click="select(f.name)"
          >
            <component :is="fileMeta(f.name).icon" class="size-4 shrink-0" :class="fileMeta(f.name).tone" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-xs">{{ baseName(f.name) }}</span>
              <span class="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span v-if="dirName(f.name)" class="truncate">{{ dirName(f.name) }}</span>
                <span class="shrink-0">· {{ fmtSize(f.size) }} · {{ relTime(f.mtime ? Date.parse(f.mtime) : 0) }}</span>
              </span>
            </span>
            <Badge v-if="changed.includes(f.name)" variant="secondary" class="shrink-0 text-[10px]">新</Badge>
          </button>
          <button
            class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
            title="用本机程序打开"
            @click="openFile(f.name)"
          >
            <ExternalLink class="size-3" />
          </button>
          <button
            class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
            title="在访达中显示"
            @click="revealFile(f.name)"
          >
            <FolderOpen class="size-3" />
          </button>
        </li>
      </ul>
    </div>

    <!-- 实时预览 -->
    <div v-if="selected" class="flex min-h-0 flex-1 flex-col">
      <!-- 浏览器条：文件名 + 刷新 / 新窗口 / 下载，HTML 就在下面这块里直接渲染 -->
      <div class="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1.5">
        <span class="flex shrink-0 gap-1">
          <span class="size-2 rounded-full bg-red-400/70"></span>
          <span class="size-2 rounded-full bg-amber-400/70"></span>
          <span class="size-2 rounded-full bg-emerald-400/70"></span>
        </span>
        <span class="min-w-0 flex-1 truncate rounded bg-background px-2 py-0.5 text-[11px] text-muted-foreground" :title="selected">
          {{ selected }}
        </span>
        <button class="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="刷新" @click="reloadPreview">
          <RefreshCw class="size-3.5" />
        </button>
        <a
          :href="fileViewUrl(selected)"
          target="_blank"
          rel="noreferrer"
          class="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="新窗口打开"
        >
          <ExternalLink class="size-3.5" />
        </a>
        <a
          :href="fileDownloadUrl(selected)"
          class="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="下载"
        >
          <Download class="size-3.5" />
        </a>
      </div>

      <!-- 结构化预览：docx / xlsx / pptx / zip（服务端拆包，前端只拼 esc 过的数据） -->
      <div v-if="structured" class="min-h-0 flex-1 overflow-y-auto bg-background">
        <div v-if="structLoading" class="flex justify-center py-8 text-xs text-muted-foreground">拆包中…</div>
        <div v-else-if="structError" class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
          <p>{{ structError }}</p>
          <a :href="fileViewUrl(selected)" target="_blank" rel="noreferrer">
            <Button variant="outline" size="sm" class="gap-1">
              <ExternalLink class="size-3" /> 用本机程序打开
            </Button>
          </a>
        </div>
        <div v-else-if="struct" class="min-h-0 flex-1">
          <!-- xlsx：工作表页签 + 表格 -->
          <div v-if="struct.kind === 'sheet'">
            <div v-if="struct.sheets.length > 1" class="flex flex-wrap gap-1 border-b border-border bg-muted/30 px-2 py-1.5">
              <button
                v-for="(s, i) in struct.sheets"
                :key="s.name"
                class="rounded px-2 py-0.5 text-[11px] transition-colors"
                :class="activeSheet === i ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'"
                @click="activeSheet = i"
              >
                {{ s.name }}
              </button>
            </div>
            <div class="overflow-auto p-2">
              <table class="w-full border-collapse text-xs">
                <tbody>
                  <tr v-for="(row, ri) in struct.sheets[activeSheet]?.rows || []" :key="ri">
                    <td
                      v-for="(cell, ci) in row"
                      :key="ci"
                      class="max-w-[16rem] truncate border border-border px-2 py-0.5"
                      :class="ri === 0 ? 'bg-muted/50 font-medium' : ''"
                    >{{ cell }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-if="struct.sheets[activeSheet]?.truncated" class="mt-1 text-[10px] text-muted-foreground">
                只显示了前 {{ struct.sheets[activeSheet]?.rows.length }} 行 / {{ (struct.sheets[activeSheet]?.rows[0] || []).length }} 列
              </p>
            </div>
          </div>

          <!-- docx：段落 / 标题 / 图片 / 表格 -->
          <div v-else-if="struct.kind === 'doc'" class="space-y-1 p-3">
            <div v-for="(b, i) in struct.blocks" :key="i">
              <img v-if="b.t === 'img'" :src="b.src" class="max-w-full rounded border border-border" :alt="'插图 ' + (i + 1)">
              <table v-else-if="b.t === 'tbl'" class="w-full border-collapse text-xs">
                <tbody>
                  <tr v-for="(row, ri) in b.rows || []" :key="ri">
                    <td
                      v-for="(cell, ci) in row"
                      :key="ci"
                      class="border border-border px-2 py-0.5 align-top"
                      v-html="cellHtml(cell.runs)"
                    />
                  </tr>
                </tbody>
              </table>
              <ul v-else-if="b.t === 'li'" class="list-disc pl-4 [&_li]:my-0.5">
                <li v-html="runHtml(b.runs)" />
              </ul>
              <p
                v-else
                class="text-sm leading-relaxed"
                :class="
                  b.t === 'h' && b.lvl === 1 ? 'text-base font-bold' :
                  b.t === 'h' && b.lvl === 2 ? 'text-[15px] font-semibold' :
                  b.t === 'h' ? 'text-sm font-semibold' : ''
                "
                v-html="runHtml(b.runs)"
              />
            </div>
            <p v-if="struct.truncated" class="text-[10px] text-muted-foreground">内容较多，只显示了开头部分</p>
          </div>

          <!-- pptx：一页一卡 -->
          <div v-else-if="struct.kind === 'slides'" class="space-y-2 p-2">
            <div v-for="s in struct.slides" :key="s.n" class="rounded-md border border-border">
              <p class="border-b border-border bg-muted/30 px-2.5 py-1 text-[11px] font-medium">第 {{ s.n }} 页{{ s.title ? ' · ' + s.title : '' }}</p>
              <p v-if="s.lines?.length" class="whitespace-pre-wrap px-2.5 py-1.5 text-xs leading-relaxed">{{ s.lines.join('\n') }}</p>
              <p v-if="s.notes" class="border-t border-border/60 bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">备注：{{ s.notes }}</p>
            </div>
            <p v-if="struct.truncated" class="text-[10px] text-muted-foreground">只显示了前 {{ struct.slides.length }} 页</p>
          </div>

          <!-- zip：清单 -->
          <div v-else>
            <ul class="divide-y divide-border/60 text-xs">
              <li v-for="e in struct.entries" :key="e.name" class="flex items-center gap-2 px-3 py-1">
                <span class="min-w-0 flex-1 truncate">{{ e.name }}</span>
                <span class="shrink-0 text-[10px] text-muted-foreground">{{ fmtSize(e.size ?? 0) }}</span>
              </li>
            </ul>
            <p class="px-3 py-1 text-[10px] text-muted-foreground">共 {{ struct.total }} 个文件{{ struct.truncated ? '，只显示前 500' : '' }}</p>
          </div>
        </div>
      </div>

      <!-- CSV/TSV：前端就地拆表 -->
      <div v-else-if="csvRows.length" class="min-h-0 flex-1 overflow-auto bg-background">
        <table class="w-full border-collapse text-xs">
          <tbody>
            <tr v-for="(row, ri) in csvRows" :key="ri">
              <td
                v-for="(cell, ci) in row"
                :key="ci"
                class="max-w-[14rem] truncate border border-border px-1.5 py-0.5"
                :class="ri === 0 ? 'bg-muted/50 font-medium' : ''"
              >{{ cell }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="csvTruncated" class="px-2 py-1 text-[10px] text-muted-foreground">文件较大，只显示了开头</p>
      </div>

      <!-- 音视频：原生播放器 -->
      <video
        v-else-if="mediaKind === 'video'"
        :src="fileViewUrl(selected)"
        controls
        class="min-h-0 w-full flex-1 bg-black"
      />
      <audio v-else-if="mediaKind === 'audio'" :src="fileViewUrl(selected)" controls class="mt-2 w-full px-3" />

      <!-- 其它：iframe（HTML/SVG/MD/图片/文本…）。沙箱照 T3：让页面跑脚本，但隔绝本应用会话与存储 -->
      <iframe
        v-else-if="previewable && iframeSrc"
        :key="iframeKey"
        :src="iframeSrc"
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        class="min-h-0 w-full flex-1 border-0 bg-white"
        title="实时预览"
      />
      <iframe
        v-else-if="previewable || mediaKind === 'image'"
        :key="iframeKey"
        :src="fileViewUrl(selected)"
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        class="min-h-0 w-full flex-1 border-0 bg-white"
        title="实时预览"
      />
      <div v-else class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
        该格式不支持内嵌预览
        <a :href="fileViewUrl(selected)" target="_blank" rel="noreferrer">
          <Button variant="outline" size="sm" class="gap-1">
            <ExternalLink class="size-3" /> 新窗口打开
          </Button>
        </a>
      </div>
    </div>
  </aside>
</template>
