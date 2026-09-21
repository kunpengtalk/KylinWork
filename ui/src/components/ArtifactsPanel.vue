<script setup lang="ts">
/**
 * 右侧 Artifact 面板（对齐 T3 的 RightPanelTabs + FilePreviewPanel）：
 *
 * - tab 制：「文件」列表常驻，点开的文件各占一个 tab，可切换、可关闭
 * - 文件视图 = T3 的 FilePreviewPanel：面包屑 + 渲染/源码切换 + 刷新/下载/本机打开，
 *   HTML 在沙箱 iframe 里直接渲染（就是浏览器预览），docx/xlsx/pptx/zip 走服务端拆包
 * - 「只看预览」最大化：列表收起，预览吃掉整个面板
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { CheckCircle2, Circle, Loader2 } from 'lucide-vue-next'
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  FolderOpen,
  Globe,
  Link2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelRight,
  RefreshCw,
  RotateCw,
  Sparkles,
  X,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from 'vue-sonner'
import {
  fileDownloadUrl,
  fileViewUrl,
  openFile as openNative,
  previewStatus,
  revealFile,
  startPreview,
  stopPreview,
  tidyFiles,
  type OutputFile,
  type PreviewState,
} from '@/api/client'
import { fileMeta } from '@/components/chat/fileIcon'
import MarkdownIt from 'markdown-it'

const props = defineProps<{
  files: OutputFile[]
  changed: string[]
  /** 面板最大化（占满主区之外的宽度） */
  maximized?: boolean
  /** 任务进度（PROGRESS.md 的勾选清单） */
  milestones?: { text: string; done: boolean }[]
  /** 本会话委派过的专家及完成状态 */
  agents?: { name: string; task: string; done: boolean }[]
  /** 成果文件夹名 */
  folder?: string
}>()
const emit = defineEmits<{ (e: 'refresh'): void; (e: 'close'): void; (e: 'maximize'): void }>()

// ==================== 拖宽（T3 的 PreviewPanelShell 可拖拽） ====================

const width = ref(440)
let dragFrom: { x: number; w: number } | null = null
function startResize(e: MouseEvent) {
  dragFrom = { x: e.clientX, w: width.value }
  const move = (ev: MouseEvent) => {
    if (!dragFrom) return
    width.value = Math.min(820, Math.max(280, dragFrom.w - (ev.clientX - dragFrom.x)))
  }
  const up = () => {
    dragFrom = null
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
const asideStyle = computed(() =>
  props.maximized ? undefined : { width: `${width.value}px`, minWidth: '280px', maxWidth: '820px' },
)

// ==================== tab 体系 ====================

const FILES_TAB = '__files__'
/** 三个信息分区的折叠状态 */
const secOpen = reactive({ progress: true, agents: true, folder: true })
/** 打开的文件 tab（顺序即排列顺序），active 指向 '__files__' 或文件名 */
const tabs = ref<string[]>([])
const active = ref<string>(FILES_TAB)

function openFileTab(name: string) {
  if (!name) return
  if (!tabs.value.includes(name)) tabs.value.push(name)
  active.value = name
  viewMode.value = 'render'
}
function closeTab(name: string) {
  const i = tabs.value.indexOf(name)
  tabs.value = tabs.value.filter((t) => t !== name)
  if (active.value === name) active.value = tabs.value[Math.min(i, tabs.value.length - 1)] || FILES_TAB
}

const selected = computed(() => (active.value === FILES_TAB ? '' : active.value))

// ==================== 文件列表 ====================

const flatFiles = computed(() =>
  [...(props.files || [])].sort(
    (a, b) => (b.mtime ? Date.parse(b.mtime) || 0 : 0) - (a.mtime ? Date.parse(a.mtime) || 0 : 0),
  ),
)

/** 根目录「可证明冗余」的重复副本（hash 逐字节相同），一键清进 .trash */
const dupCount = computed(() => (props.files || []).filter((f) => (f as { dup_of?: string }).dup_of).length)
const tidying = ref(false)
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

function baseName(n: string) {
  return String(n).slice(String(n).lastIndexOf('/') + 1)
}
function dirName(n: string) {
  const i = String(n).lastIndexOf('/')
  return i > 0 ? String(n).slice(0, i) : ''
}
function extOf(n: string) {
  const i = n.lastIndexOf('.')
  return i > 0 ? n.slice(i + 1).toLowerCase() : 'file'
}
function fmtSize(n: number) {
  if (!n || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
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

// ==================== 预览分类 ====================

const previewable = computed(() => /\.(html?|svg|md|txt|json|log|yml|yaml|xml|csv|tsv)$/i.test(selected.value))
const structured = computed(() => /\.(docx|xlsx|pptx|zip)$/i.test(selected.value))
const mediaKind = computed<'audio' | 'video' | 'image' | ''>(() => {
  const e = extOf(selected.value)
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(e)) return 'audio'
  if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'].includes(e)) return 'video'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'].includes(e)) return 'image'
  return ''
})
/** 渲染/源码切换只对文本类文件有意义 */
const codeCapable = computed(() => /\.(html?|svg|md|txt|json|log|yml|yaml|xml|csv|tsv|js|mjs|ts|css|py|sh|jsx|tsx|vue)$/i.test(selected.value))

/**
 * 浏览器式的地址栏只给「真网页」。
 * 它本来是从网页预览那儿搬来的，但一路挂到了 .md/.txt/.json 上——结果面板顶部有一半的高度
 * 在展示 `/engine-api/files/view/任务_xxx%2F档案.md` 这种接口路径，对读文档的人是纯噪音。
 */
const isWebPage = computed(() => /\.(html?|svg)$/i.test(selected.value))

const lanOpen = ref(false)
const starting = ref(false)
const iframeKey = ref(0)
function reloadPreview() {
  iframeKey.value++
}

const iframeSrc = computed(() =>
  (previewable.value || mediaKind.value === 'image') && preview.value.url
    ? preview.value.url + encodeURIComponent(selected.value)
    : '',
)

// ==================== 浏览器导航（对齐 Peak Code 截图：← → ⟳ + 地址栏） ====================

const frame = ref<HTMLIFrameElement | null>(null)
/** iframe 当前加载的地址：点文件时是 view URL，地址栏回车后可以变 */
const navSrc = ref('')
const urlInput = ref('')
/** 文件操作（下载/新窗口/本机打开…）的下拉开关 */
const fileMenuOpen = ref(false)

/** 地址栏给人看：接口前缀和百分号编码都抹掉，只留工作区里的相对路径 */
function displayAddr(src: string): string {
  const prefix = '/engine-api/files/view/'
  if (!src.startsWith(prefix)) return src
  try {
    return decodeURIComponent(src.slice(prefix.length))
  } catch {
    return src
  }
}

watch(selected, (name) => {
  navSrc.value = name ? fileViewUrl(name) : ''
  urlInput.value = name || ''
})

function goto(src: string) {
  navSrc.value = src
  urlInput.value = displayAddr(src)
  iframeKey.value++
}
/** 地址栏回车：纯文件名当工作区文件，完整 URL 直接访问 */
function navigate() {
  let u = urlInput.value.trim()
  if (!u) return
  if (!/^https?:\/\//i.test(u) && !u.startsWith('/')) u = fileViewUrl(u)
  goto(u)
}

/** 复制这个文件的可分享地址（预览服务开着就是局域网地址，否则是本地地址） */
async function copyFileLink() {
  const base = preview.value.url || window.location.origin
  try {
    await navigator.clipboard.writeText(base.replace(/\/+$/, '') + fileViewUrl(selected.value))
    toast.success('链接已复制')
  } catch {
    toast.error('复制失败')
  }
}
function frameBack() {
  try { frame.value?.contentWindow?.history.back() } catch { /* 跨源页面不给碰 */ }
}
function frameForward() {
  try { frame.value?.contentWindow?.history.forward() } catch { /* 同上 */ }
}

// ==================== 渲染 / 源码 ====================

const viewMode = ref<'render' | 'code'>('render')
const codeText = ref('')
const codeLoading = ref(false)
// ==================== Markdown：渲染成文档排版（源码看原文） ====================
//
// 这里原来挂的是 `prose prose-sm dark:prose-invert`，但项目从来没装过
// @tailwindcss/typography —— 这几个类名一个样式都没生效，而 Tailwind 的 preflight
// 又把标题字号、段落边距、表格框线全抹平了，于是 .md 预览就是一坨没有层级的裸文本
// （标题和正文一样大、表格连框线都没有）。现在换成自带的 .kw-doc 文档排版，见文件末尾的 <style>。

/**
 * `- [ ]` / `- [x]` 勾选清单。markdown-it 默认不认这个写法，
 * 而 PROGRESS.md 这类进度文件通篇都是它——不渲染就全变成带方括号的普通列表项。
 */
function taskListPlugin(md: MarkdownIt) {
  md.core.ruler.after('inline', 'kw_task_list', (state) => {
    const toks = state.tokens
    for (let i = 0; i < toks.length; i++) {
      if (toks[i]!.type !== 'list_item_open') continue
      // 结构固定是 list_item_open → paragraph_open → inline
      const inline = toks[i + 2]
      if (toks[i + 1]?.type !== 'paragraph_open' || inline?.type !== 'inline') continue
      const first = inline.children?.[0]
      if (!first || first.type !== 'text') continue
      const m = /^\[([ xX])\]\s+/.exec(first.content)
      if (!m) continue
      first.content = first.content.slice(m[0].length)
      const box = new state.Token('html_inline', '', 0)
      box.content = `<span class="kw-task${m[1]!.toLowerCase() === 'x' ? ' kw-task-done' : ''}"></span>`
      inline.children = [box, ...(inline.children || [])]
      toks[i]!.attrJoin('class', 'kw-task-item')
    }
    return true
  })
}

const mdRenderer = new MarkdownIt({ html: false, linkify: true, breaks: true })
  .use(taskListPlugin)
  .use(headingAnchorPlugin)

/** 标题的 GitHub 风格 slug：中文原样留着，标点去掉，空格并成 - */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * 给标题挂 id。生成的报告经常自带「目录」——里面的 `[第三章](#3-交付物)` 要是没有落点，
 * 点了就是纹丝不动，读者会以为面板坏了。同名标题（两章里各有一个「1. 现状」）追加序号，锚点不能撞。
 */
function headingAnchorPlugin(md: MarkdownIt) {
  const seen = new Map<string, number>()
  md.core.ruler.push('kw_heading_anchor', (state) => {
    seen.clear()
    const toks = state.tokens
    for (let i = 0; i < toks.length; i++) {
      if (toks[i]!.type !== 'heading_open') continue
      const text = (toks[i + 1]?.children || []).map((c) => c.content).join('')
      let id = slugify(text)
      if (!id) continue
      const n = (seen.get(id) || 0) + 1
      seen.set(id, n)
      if (n > 1) id = `${id}-${n}`
      toks[i]!.attrSet('id', id)
    }
    return true
  })
}

const isMarkdown = computed(() => /\.(md|markdown)$/i.test(selected.value))
const mdHtml = ref('')
const mdLoading = ref(false)
/** 渲染出来的文档容器：`#小节` 跳转要在这里面找落点 */
const docBody = ref<HTMLElement | null>(null)

/**
 * 渲染后的收尾：文档里的资源和链接都得改写成引擎的取文件地址。
 * 不改的话，`![](img/a.png)` 是裂图、`[附录](附录.md)` 点开是 404。
 * 相对链接不往外甩，留在面板里开新 tab——看文档的人不该为了翻一章跳去浏览器。
 */
function decorateDoc(html: string, dir: string): string {
  // markdown-it 会把 href 里的中文转成百分号编码，这里先还原成人能对得上的路径
  const abs = (p: string) => {
    let raw = p
    try {
      raw = decodeURIComponent(p)
    } catch {
      /* 不是合法的百分号编码就按原样用 */
    }
    return raw.startsWith('/') ? raw.slice(1) : dir ? `${dir}/${raw}` : raw
  }
  return html
    .replace(/<img src="(?!https?:|data:)([^"]+)"/g, (_m, p1: string) => `<img src="${esc(fileViewUrl(abs(p1)))}"`)
    .replace(/<a href="(?!https?:|#|mailto:|tel:)([^"]+)"/g, (_m, p1: string) => `<a data-doc="${esc(abs(p1))}" href="#"`)
    .replace(/<a href="(https?:[^"]+)"/g, '<a href="$1" target="_blank" rel="noreferrer noopener"')
    // 宽表要能横向滚，又不能把 table 本身改成 display:block（那样列宽会被压扁），
    // 所以补一层滚动容器——和 vue-stream-markdown 给自己表格包的那层是同一个意思
    .replace(/<table>/g, '<div class="kw-tablewrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
}

/**
 * 文档内的跳转：相对文件在面板里开 tab，`#小节` 就地滚过去。
 * 两条都不放给浏览器默认行为——相对路径会 404，`#` 还会把 hash 写进应用路由。
 */
function onDocClick(e: MouseEvent) {
  const a = (e.target as Element | null)?.closest?.('a')
  if (!a) return
  const doc = a.getAttribute('data-doc')
  if (doc) {
    e.preventDefault()
    openFileTab(doc)
    return
  }
  const href = a.getAttribute('href') || ''
  if (!href.startsWith('#') || href.length < 2) return
  e.preventDefault()
  let id = href.slice(1)
  try {
    id = decodeURIComponent(id)
  } catch {
    /* 同上 */
  }
  const target = docBody.value?.querySelector(`[id="${CSS.escape(id)}"]`)
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

watch([active, viewMode], async () => {
  mdHtml.value = ''
  if (viewMode.value !== 'render' || !isMarkdown.value || !selected.value) return
  const name = selected.value
  mdLoading.value = true
  try {
    const r = await fetch(fileViewUrl(name))
    if (!r.ok) return
    const html = decorateDoc(mdRenderer.render(await r.text()), dirName(name))
    // 等待期间用户可能已经切走了：晚到的结果不能盖掉当前那个文件
    if (selected.value === name) mdHtml.value = html
  } catch {
    /* 读不到就退回下面的 iframe 原文预览 */
  } finally {
    mdLoading.value = false
  }
})

const preview = ref<PreviewState>({})

watch(active, async () => {
  viewMode.value = 'render'
  codeText.value = ''
  reloadPreview()
})
watch(viewMode, (m) => {
  if (m === 'code' && !codeText.value && codeCapable.value && selected.value) void loadCode()
})
async function loadCode() {
  const name = selected.value
  if (!name) return
  codeLoading.value = true
  try {
    const r = await fetch(fileViewUrl(name))
    codeText.value = r.ok ? await r.text() : `读取失败（${r.status}）`
  } catch (e) {
    codeText.value = '读取失败：' + (e as Error).message
  } finally {
    codeLoading.value = false
  }
}

// ==================== 结构化预览（docx / xlsx / pptx / zip） ====================

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

watch(active, async () => {
  struct.value = null
  structError.value = ''
  activeSheet.value = 0
  if (!selected.value || !structured.value) return
  structLoading.value = true
  try {
    const r = await fetch(`/engine-api/files/preview/${encodeURIComponent(selected.value)}`)
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
function cellHtml(runs: DocRun[] | undefined): string {
  return runHtml(runs) || '&nbsp;'
}

// ==================== CSV/TSV 就地拆表 ====================

const csvRows = ref<string[][]>([])
const csvTruncated = ref(false)
watch(active, async (name) => {
  csvRows.value = []
  csvTruncated.value = false
  if (!name || name === FILES_TAB || !/\.(csv|tsv)$/i.test(name)) return
  try {
    const r = await fetch(fileViewUrl(name))
    if (!r.ok) return
    const text = (await r.text()).slice(0, 512 * 1024)
    csvTruncated.value = text.length >= 512 * 1024
    const first = text.split('\n')[0] || ''
    const counts = [',', '\t', ';'].map((s) => ({ s, n: first.split(s).length }))
    counts.sort((a, b) => b.n - a.n)
    const sep = /\.tsv$/i.test(name) ? '\t' : counts[0] && counts[0].n > 1 ? counts[0].s : ','
    // RFC4180：字段里带逗号 / 双写引号 / 换行都是常事，split(",") 会拆散架
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
          } else inQ = false
        } else cur += c
      } else if (c === '"') inQ = true
      else if (c === sep) {
        row.push(cur)
        cur = ''
      } else if (c === '\n') {
        row.push(cur)
        rows.push(row)
        row = []
        cur = ''
      } else cur += c
    }
    row.push(cur)
    rows.push(row)
    while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop()
    csvRows.value = rows
  } catch {
    /* 拆不出来就当普通文本 */
  }
})

// ==================== 预览服务（LAN 扫码看） ====================

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
    preview.value = preview.value.running ? await stopPreview() : await startPreview({ lan: lanOpen.value })
    toast.success(preview.value.running ? '预览服务已启动' : '预览服务已停止')
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

defineExpose({
  /** 对话里点产出 chip 直接打开对应 tab */
  open(name: string) {
    if (!name) return
    openFileTab(name)
  },
})
</script>

<template>
  <aside
    class="relative flex shrink-0 flex-col border-l border-border bg-background"
    :class="maximized ? 'min-w-0 flex-1' : ''"
    :style="asideStyle"
  >
    <!-- 左缘拖宽把手 -->
    <div
      v-if="!maximized"
      class="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-primary/30"
      @mousedown="startResize"
    ></div>
    <!-- tab 栏（T3 RightPanelTabs） -->
    <div class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
      <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <button
          type="button"
          data-active-tab="files"
          class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs"
          :class="active === FILES_TAB ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'"
          @click="active = FILES_TAB"
        >
          <FolderOpen class="size-3.5" /> 文件
          <Badge v-if="changed.length" variant="secondary" class="ml-0.5 text-[10px]">{{ changed.length }}</Badge>
        </button>
        <!-- 清掉重复副本：不能嵌在上面那个 button 里（button 套 button 是非法结构，
             浏览器会把内层拆出去，点一下「文件」tab 就顺手把文件清了） -->
        <Button
          v-if="dupCount > 0"
          variant="ghost"
          size="sm"
          class="h-6 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground"
          :disabled="tidying"
          title="把根目录里的重复副本搬进 .trash（捞得回来）"
          @click="handleTidy"
        >
          <Sparkles class="size-3" />清掉重复的 {{ dupCount }}
        </Button>
        <div
          v-for="t in tabs"
          :key="t"
          class="group/tab flex h-6 max-w-36 shrink-0 cursor-pointer items-center gap-0.5 rounded-md pl-1.5 pr-1 text-xs"
          :class="active === t ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'"
          @click="active = t"
        >
          <component :is="fileMeta(t).icon" class="size-3.5 shrink-0" :class="fileMeta(t).tone" />
          <span class="min-w-0 truncate">{{ baseName(t) }}</span>
          <button
            type="button"
            class="rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover/tab:opacity-100"
            title="关闭"
            @click.stop="closeTab(t)"
          >
            <X class="size-3" />
          </button>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-0.5">
        <button
          v-if="active !== FILES_TAB"
          type="button"
          class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          :title="maximized ? '恢复面板宽度' : '最大化面板'"
          @click="emit('maximize')"
        >
          <Maximize2 v-if="!maximized" class="size-3.5" />
          <Minimize2 v-else class="size-3.5" />
        </button>
        <button
          type="button"
          class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="收起面板"
          @click="emit('close')"
        >
          <PanelRight class="size-3.5" />
        </button>
      </div>
    </div>

    <!-- ══════════ 文件列表 ══════════ -->
    <template v-if="active === FILES_TAB">
      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        <!-- 进度 / Agents / 工作文件夹：三个信息块合成一张卡、用分隔线切开。
            以前是三个各自带边框的盒子摞起来，光边框和间距就吃掉半屏，文件反而被挤到底下看不见。 -->
        <div
          v-if="milestones?.length || agents?.length || folder || flatFiles.length"
          class="mb-2.5 divide-y divide-border/70 overflow-hidden rounded-lg border border-border"
        >
          <section v-if="milestones?.length">
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-2 text-left text-xs font-medium"
              @click="secOpen.progress = !secOpen.progress"
            >
              <ChevronRight class="size-3 shrink-0 transition-transform" :class="secOpen.progress && 'rotate-90'" />
              <span class="flex-1">进度</span>
              <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {{ milestones.filter((m) => m.done).length }}/{{ milestones.length }}
              </span>
            </button>
            <ul v-if="secOpen.progress" class="space-y-1 px-2.5 pb-2.5">
              <li v-for="(it, i) in milestones" :key="i" class="flex items-start gap-1.5 text-[11px]">
                <CheckCircle2 v-if="it.done" class="mt-0.5 size-3 shrink-0 text-emerald-500" />
                <Circle v-else class="mt-0.5 size-3 shrink-0 text-muted-foreground/40" />
                <span :class="it.done ? 'text-muted-foreground' : ''">{{ it.text }}</span>
              </li>
            </ul>
          </section>

          <!-- Agents：委派了谁、干完没有 -->
          <section v-if="agents?.length">
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-2 text-left text-xs font-medium"
              @click="secOpen.agents = !secOpen.agents"
            >
              <ChevronRight class="size-3 shrink-0 transition-transform" :class="secOpen.agents && 'rotate-90'" />
              <span class="flex-1">Agents</span>
              <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground">{{ agents.length }}</span>
            </button>
            <ul v-if="secOpen.agents" class="space-y-1 px-2.5 pb-2.5">
              <li v-for="(a, i) in agents" :key="i" class="flex items-center gap-1.5 text-[11px]">
                <CheckCircle2 v-if="a.done" class="size-3 shrink-0 text-emerald-500" />
                <Loader2 v-else class="size-3 shrink-0 animate-spin text-primary" />
                <span class="min-w-0 flex-1 truncate" :class="!a.done && 'text-muted-foreground'">{{ a.name }}</span>
                <span v-if="!a.done" class="shrink-0 text-[10px] text-muted-foreground">执行中</span>
              </li>
            </ul>
          </section>

          <!-- 工作文件夹：成果落在哪个文件夹一目了然 -->
          <section v-if="folder || flatFiles.length">
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-2 text-left text-xs font-medium"
              @click="secOpen.folder = !secOpen.folder"
            >
              <ChevronRight class="size-3 shrink-0 transition-transform" :class="secOpen.folder && 'rotate-90'" />
              <span class="flex-1">工作文件夹</span>
            </button>
            <p v-if="secOpen.folder" class="truncate px-2.5 pb-2.5 text-[11px] text-muted-foreground">
              <FolderOpen class="mr-1 inline size-3" />{{ folder || 'workspace' }}
            </p>
          </section>
        </div>

        <div v-if="!flatFiles.length" class="px-2 py-10 text-center text-xs text-muted-foreground">
          还没有成果文件
        </div>
        <ul v-else class="space-y-0.5">
          <li v-for="f in flatFiles" :key="f.name" class="group flex items-center gap-0.5">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors"
              :class="selected === f.name ? 'bg-accent' : 'hover:bg-accent/60'"
              :title="f.name"
              @click="openFileTab(f.name)"
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
              type="button"
              class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
              title="用本机程序打开"
              @click="openNative(f.name)"
            >
              <ExternalLink class="size-3" />
            </button>
            <button
              type="button"
              class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
              title="在访达中显示"
              @click="revealFile(f.name)"
            >
              <FolderOpen class="size-3" />
            </button>
          </li>
        </ul>
      </div>

      <!-- 预览服务（把工作目录当站点跑起来、手机扫码看）：收成底部一行。
           它原本是列表顶上的一条横幅 + 一个局域网勾选框，占掉两整行首屏位置，
           而这功能多数人一次都不点——留在底部，需要的人找得到，不需要的人当它不存在。 -->
      <div class="flex h-8 shrink-0 items-center gap-1.5 border-t border-border px-3 text-[11px] text-muted-foreground">
        <Globe class="size-3.5 shrink-0" :class="preview.running && 'text-emerald-500'" />
        <span class="min-w-0 flex-1 truncate">{{ preview.running ? '手机可扫码预览' : '手机扫码预览' }}</span>
        <template v-if="preview.running">
          <button class="rounded p-0.5 hover:bg-accent hover:text-foreground" title="复制链接" @click="copyLink">
            <Copy class="size-3" />
          </button>
          <button class="rounded p-0.5 hover:bg-accent hover:text-foreground" title="在浏览器打开" @click="openInBrowser">
            <ExternalLink class="size-3" />
          </button>
        </template>
        <label v-else class="flex shrink-0 cursor-pointer items-center gap-1" title="开启后同一局域网内的手机可以访问">
          <input v-model="lanOpen" type="checkbox" class="size-3 accent-primary" @change="refreshPreview" />
          局域网
        </label>
        <button
          type="button"
          class="shrink-0 cursor-pointer rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          :disabled="starting"
          @click="togglePreviewServer"
        >
          {{ preview.running ? '停止' : '启动' }}
        </button>
      </div>
    </template>

    <!-- ══════════ 文件预览 ══════════ -->
    <div v-else-if="selected" class="flex min-h-0 flex-1 flex-col">
      <!-- 面包屑 + 操作（T3 FilePreviewPanel 的 surface-subheader） -->
      <div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <div class="flex min-w-0 flex-1 items-center gap-1 text-xs">
          <component :is="fileMeta(selected).icon" class="size-3.5 shrink-0" :class="fileMeta(selected).tone" />
          <span v-if="dirName(selected)" class="shrink-0 truncate text-muted-foreground">{{ dirName(selected) }}</span>
          <ChevronRight v-if="dirName(selected)" class="size-3 shrink-0 text-muted-foreground/50" />
          <span class="min-w-0 truncate font-medium">{{ baseName(selected) }}</span>
        </div>
        <!-- 渲染 / 源码（T3 的 renderMarkdown Toggle） -->
        <div v-if="codeCapable" class="flex shrink-0 items-center rounded-md border border-border p-0.5">
          <button
            type="button"
            class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
            :class="viewMode === 'render' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'"
            @click="viewMode = 'render'"
          >
            <Eye class="size-3" />渲染
          </button>
          <button
            type="button"
            class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
            :class="viewMode === 'code' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'"
            @click="viewMode = 'code'"
          >
            <FileCode2 class="size-3" />源码
          </button>
        </div>
        <button
          type="button"
          class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="刷新"
          @click="reloadPreview(); viewMode === 'code' && loadCode()"
        >
          <RefreshCw class="size-3.5" />
        </button>
        <!-- 低频操作收进 ⋯：下载/新窗口/本机打开/访达 四个图标常驻，在 400px 的面板里
             比文件名还抢眼，而它们一天也用不上一次 -->
        <div class="relative shrink-0">
          <button
            type="button"
            class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            :class="fileMenuOpen && 'bg-accent text-foreground'"
            title="更多操作"
            @click="fileMenuOpen = !fileMenuOpen"
          >
            <MoreHorizontal class="size-3.5" />
          </button>
          <template v-if="fileMenuOpen">
            <div class="fixed inset-0 z-40" @click="fileMenuOpen = false" />
            <div class="absolute right-0 top-7 z-50 w-44 overflow-hidden rounded-lg border border-border bg-popover py-1 text-xs shadow-xl">
              <a
                :href="fileDownloadUrl(selected)"
                class="flex items-center gap-2 px-2.5 py-1.5 hover:bg-accent"
                @click="fileMenuOpen = false"
              >
                <Download class="size-3.5" />下载
              </a>
              <a
                :href="fileViewUrl(selected)"
                target="_blank"
                rel="noreferrer"
                class="flex items-center gap-2 px-2.5 py-1.5 hover:bg-accent"
                @click="fileMenuOpen = false"
              >
                <ExternalLink class="size-3.5" />新窗口打开
              </a>
              <button type="button" class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent" @click="openNative(selected); fileMenuOpen = false">
                <FolderOpen class="size-3.5" />用本机程序打开
              </button>
              <button type="button" class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent" @click="revealFile(selected); fileMenuOpen = false">
                <FolderOpen class="size-3.5" />在访达中显示
              </button>
              <button type="button" class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent" @click="copyFileLink(); fileMenuOpen = false">
                <Link2 class="size-3.5" />复制链接
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- 源码模式 -->
      <div v-if="viewMode === 'code'" class="min-h-0 flex-1 overflow-auto bg-muted/20">
        <div v-if="codeLoading" class="flex justify-center py-10 text-xs text-muted-foreground">读取中…</div>
        <pre
          v-else
          class="whitespace-pre-wrap break-words p-3 text-xs leading-5 text-foreground/90"
        >{{ codeText }}</pre>
      </div>

      <!-- 渲染模式 -->
      <div v-else class="flex min-h-0 flex-1 flex-col">
        <!-- 浏览器条：只给真网页（HTML/SVG）。md / json / txt 这些不该摆一排导航控件和接口地址 -->
        <div
          v-if="isWebPage && selected"
          class="flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-muted/30 px-2"
        >
          <div class="flex shrink-0 items-center gap-0.5">
            <button type="button" class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="后退" @click="frameBack">
              <ArrowLeft class="size-3.5" />
            </button>
            <button type="button" class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="前进" @click="frameForward">
              <ArrowRight class="size-3.5" />
            </button>
            <button type="button" class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="刷新" @click="iframeKey++">
              <RotateCw class="size-3.5" />
            </button>
          </div>
          <input
            v-model="urlInput"
            type="text"
            class="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground outline-none focus:border-primary"
            placeholder="输入文件名或网址，回车打开"
            @keydown.enter="navigate"
          />
        </div>
        <!-- 结构化：docx / xlsx / pptx / zip（服务端拆包） -->
        <div v-if="structured" class="min-h-0 flex-1 overflow-y-auto bg-background">
          <div v-if="structLoading" class="flex justify-center py-10 text-xs text-muted-foreground">拆包中…</div>
          <div v-else-if="structError" class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
            <p>{{ structError }}</p>
            <a :href="fileViewUrl(selected)" target="_blank" rel="noreferrer">
              <Button variant="outline" size="sm" class="gap-1">
                <ExternalLink class="size-3" /> 用本机程序打开
              </Button>
            </a>
          </div>
          <div v-else-if="struct" class="min-h-0 flex-1">
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
              </div>
            </div>

            <div v-else-if="struct.kind === 'doc'" class="space-y-1 p-3">
              <div v-for="(b, i) in struct.blocks" :key="i">
                <img v-if="b.t === 'img'" :src="b.src" class="max-w-full rounded border border-border" alt="" />
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

            <div v-else-if="struct.kind === 'slides'" class="space-y-2 p-2">
              <div v-for="sl in struct.slides" :key="sl.n" class="rounded-md border border-border">
                <p class="border-b border-border bg-muted/30 px-2.5 py-1 text-[11px] font-medium">第 {{ sl.n }} 页{{ sl.title ? ' · ' + sl.title : '' }}</p>
                <p v-if="sl.lines?.length" class="whitespace-pre-wrap px-2.5 py-1.5 text-xs leading-relaxed">{{ sl.lines.join('\n') }}</p>
                <p v-if="sl.notes" class="border-t border-border/60 bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">备注：{{ sl.notes }}</p>
              </div>
            </div>

            <div v-else>
              <ul class="divide-y divide-border/60 text-xs">
                <li v-for="e in struct.entries" :key="e.name" class="flex items-center gap-2 px-3 py-1">
                  <span class="min-w-0 flex-1 truncate">{{ e.name }}</span>
                  <span class="shrink-0 text-[10px] text-muted-foreground">{{ fmtSize(e.size ?? 0) }}</span>
                </li>
              </ul>
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

        <!-- Markdown：文档排版渲染（源码模式看原文） -->
        <div
          v-else-if="isMarkdown && (mdLoading || mdHtml)"
          class="min-h-0 flex-1 overflow-y-auto bg-background"
        >
          <p v-if="mdLoading && !mdHtml" class="px-5 py-10 text-center text-xs text-muted-foreground">正在排版…</p>
          <div v-else ref="docBody" class="kw-doc mx-auto max-w-3xl px-5 py-5" v-html="mdHtml" @click="onDocClick" />
        </div>

        <!-- 音视频：原生播放器 -->
        <video
          v-else-if="mediaKind === 'video'"
          :key="iframeKey"
          :src="fileViewUrl(selected)"
          controls
          class="min-h-0 w-full flex-1 bg-black"
        />
        <audio v-else-if="mediaKind === 'audio'" :key="iframeKey" :src="fileViewUrl(selected)" controls class="mt-2 w-full px-3" />

        <!-- HTML / SVG / MD / 图片 / 文本：浏览器式直接渲染，地址可导航 -->
        <iframe
          v-else-if="previewable && iframeSrc"
          ref="frame"
          :key="iframeKey"
          :src="navSrc || iframeSrc"
          sandbox="allow-scripts allow-forms allow-popups allow-modals"
          class="min-h-0 w-full flex-1 border-0 bg-white"
          title="预览"
        />
        <iframe
          v-else-if="previewable || mediaKind === 'image'"
          ref="frame"
          :key="iframeKey"
          :src="navSrc || fileViewUrl(selected)"
          sandbox="allow-scripts allow-forms allow-popups allow-modals"
          class="min-h-0 w-full flex-1 border-0 bg-white"
          title="预览"
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
    </div>

    <!-- 没有任何文件 tab（理论到不了：文件 tab 常驻） -->
    <div v-else class="flex flex-1 items-center justify-center text-xs text-muted-foreground">—</div>
  </aside>
</template>
