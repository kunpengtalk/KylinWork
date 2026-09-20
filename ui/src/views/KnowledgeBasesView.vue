<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  Check,
  Database,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Upload,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'vue-sonner'
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  deleteKnowledgeFile,
  knowledgeQueue,
  listKnowledgeBases,
  listKnowledgeFiles,
  reindexKnowledge,
  retryKnowledgeFile,
  searchKnowledge,
  updateKnowledgeBase,
  uploadKnowledgeFile,
  type KnowledgeBase,
  type KnowledgeFile,
  type KnowledgeHit,
  type KnowledgeQueue,
} from '@/api/client'

/**
 * 知识库：建多个库、往库里传资料、给资料建索引。
 * 这里只管数据；embedding / rerank 模型去 设置 → 知识库 配。
 * 对话里勾选某个库，问答时引擎会先去库里检索再回答。
 * <p>
 * 入库（抽正文 / 分块 / 向量化）在引擎后台排队跑，上传是立刻返回的，
 * 所以这里靠轮询队列状态把「排队中 / 建索引中 / 失败」显示出来。
 */
const router = useRouter()

const bases = ref<KnowledgeBase[]>([])
const activeId = ref('')
const files = ref<KnowledgeFile[]>([])
const loading = ref(true)
const loadingFiles = ref(false)
const uploading = ref(false)
const reindexing = ref(false)
const embeddingReady = ref(false)
const embeddingModel = ref('')
const embeddingSource = ref<'selected' | 'shared' | 'none'>('none')
const rerankReady = ref(false)
const queue = ref<KnowledgeQueue>({ queued: 0, running: 0, ready: 0, failed: 0 })
const busyCount = computed(() => queue.value.queued + queue.value.running)

const draftName = ref('')
const creating = ref(false)
const renaming = ref<string | null>(null)
const renameDraft = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

// 检索预览
const testQuery = ref('')
const testHits = ref<KnowledgeHit[] | null>(null)
const testInfo = ref<{ mode: string; model: string; notes: string[] } | null>(null)
const testing = ref(false)

const activeBase = computed(() => bases.value.find((b) => b.id === activeId.value) || null)

let pollTimer: number | undefined

onMounted(async () => {
  await loadBases()
  loading.value = false
  if (busyCount.value) startPolling()
})
onUnmounted(stopPolling)

/**
 * 入库在引擎后台跑，前端只能轮询：队列里还有任务就每 1.5s 刷新一次，
 * 全部跑完再收尾刷一次（把分块数、失效标记、错误都带回来）然后停表。
 */
function startPolling() {
  if (pollTimer) return
  pollTimer = window.setInterval(async () => {
    try {
      queue.value = await knowledgeQueue()
    } catch {
      // 引擎正重启时读不到，下一轮再说
    }
    await loadFiles(true)
    if (!busyCount.value) {
      stopPolling()
      await loadBases()
      toast.success('资料已建好索引')
    }
  }, 1500)
}
function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
}

async function loadBases() {
  try {
    const d = await listKnowledgeBases()
    bases.value = d.bases || []
    embeddingReady.value = !!d.embedding?.configured
    embeddingModel.value = String(d.embedding?.model || '')
    embeddingSource.value = (d.embedding?.source as 'selected' | 'shared' | 'none') || 'none'
    rerankReady.value = !!d.rerank?.configured
    if (d.queue) queue.value = d.queue
    if (!activeId.value || !bases.value.some((b) => b.id === activeId.value)) {
      activeId.value = bases.value[0]?.id || ''
    }
    if (activeId.value) await loadFiles()
    else files.value = []
  } catch (e) {
    toast.error('读取知识库失败：' + (e as Error).message)
  }
}

async function loadFiles(quiet = false) {
  if (!activeId.value) return
  if (!quiet) loadingFiles.value = true
  try {
    const d = await listKnowledgeFiles(activeId.value)
    files.value = d.files || []
  } catch (e) {
    if (!quiet) toast.error('读取库内文件失败：' + (e as Error).message)
  } finally {
    loadingFiles.value = false
  }
}

async function createBase() {
  const name = draftName.value.trim()
  if (!name) return
  creating.value = true
  try {
    const r = await createKnowledgeBase({ name })
    draftName.value = ''
    await loadBases()
    activeId.value = r.base.id
    await loadFiles()
    toast.success(`已创建知识库「${r.base.name}」`)
  } catch (e) {
    toast.error('创建失败：' + (e as Error).message)
  } finally {
    creating.value = false
  }
}

async function pickBase(id: string) {
  if (activeId.value === id) return
  activeId.value = id
  testHits.value = null
  testInfo.value = null
  await loadFiles()
}

async function saveRename(b: KnowledgeBase) {
  const name = renameDraft.value.trim()
  renaming.value = null
  if (!name || name === b.name) return
  try {
    await updateKnowledgeBase(b.id, { name })
    await loadBases()
    toast.success('已重命名')
  } catch (e) {
    toast.error('重命名失败：' + (e as Error).message)
  }
}

async function removeBase(b: KnowledgeBase) {
  if (!window.confirm(`删除知识库「${b.name}」及其中的全部资料？此操作不可恢复。`)) return
  try {
    await deleteKnowledgeBase(b.id)
    if (activeId.value === b.id) activeId.value = ''
    await loadBases()
    toast.success('已删除')
  } catch (e) {
    toast.error('删除失败：' + (e as Error).message)
  }
}

async function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const list = Array.from(input.files || [])
  if (!list.length || !activeId.value) return
  uploading.value = true
  const failed: string[] = []
  let okCount = 0
  for (const f of list) {
    try {
      await uploadKnowledgeFile(activeId.value, f)
      okCount += 1
    } catch (err) {
      failed.push(`${f.name}（${(err as Error).message}）`)
    }
  }
  input.value = ''
  uploading.value = false
  await loadBases()
  await loadFiles(true)
  queue.value = await knowledgeQueue().catch(() => queue.value)
  if (okCount) {
    // 入库是后台跑的，这里只说「已排队」，成没成看下面每个文件的状态
    toast.success(`已上传 ${okCount} 个文件，正在后台建索引`)
    startPolling()
  }
  if (failed.length) toast.error('部分有问题：' + failed.join('；'))
}

async function removeFile(f: KnowledgeFile) {
  if (!window.confirm(`删除资料「${f.name}」？`)) return
  try {
    await deleteKnowledgeFile(activeId.value, f.name)
    await loadBases()
    toast.success('已删除')
  } catch (e) {
    toast.error('删除失败：' + (e as Error).message)
  }
}

async function reindexAll() {
  if (!activeId.value) return
  reindexing.value = true
  try {
    const r = await reindexKnowledge(activeId.value)
    queue.value = r.status || queue.value
    toast.success(`已排入队列：${r.queued ?? 0} 个文件`)
    startPolling()
  } catch (e) {
    toast.error('重建失败：' + (e as Error).message)
  } finally {
    reindexing.value = false
  }
}

/** 入库失败三次后引擎会停下不再试，这里给个手动重试 */
async function retryFile(f: KnowledgeFile) {
  if (!activeId.value) return
  try {
    const r = await retryKnowledgeFile(activeId.value, f.name)
    queue.value = r.status || queue.value
    toast.success(`已重新排队：${f.name}`)
    startPolling()
  } catch (e) {
    toast.error('重试失败：' + (e as Error).message)
  }
}

async function runTest() {
  const q = testQuery.value.trim()
  if (!q || !activeId.value) return
  testing.value = true
  testHits.value = null
  testInfo.value = null
  try {
    const d = await searchKnowledge({ query: q, ids: [activeId.value], top_k: 5 })
    testHits.value = d.hits || []
    testInfo.value = { mode: d.mode || '', model: d.model || '', notes: d.notes || [] }
  } catch (e) {
    toast.error('检索失败：' + (e as Error).message)
  } finally {
    testing.value = false
  }
}

/** 文件状态标签：后台入库是异步的，「排队中 / 建索引中 / 失败」都得让人看得见 */
function fileBadge(f: KnowledgeFile): { label: string; tone: 'busy' | 'ok' | 'warn' | 'idle' } {
  if (f.status === 'queued') return { label: '排队中', tone: 'busy' }
  if (f.status === 'running') return { label: '建索引中', tone: 'busy' }
  if (f.status === 'error' || f.error) return { label: '建索引失败', tone: 'warn' }
  if (!f.indexed) return { label: '未建索引', tone: 'idle' }
  if (f.stale) return { label: `${f.chunks} 段 · 向量已失效`, tone: 'warn' }
  return { label: `${f.chunks} 段${f.vectorized ? ' · 向量' : ''}`, tone: 'ok' }
}

/** 命中的来源标记，跟引擎那边的 matched 口径一致 */
function matchLabel(h: KnowledgeHit): string {
  if (h.reranked) return '已重排'
  if (h.matched === 'both') return '向量+关键词'
  if (h.matched === 'vector') return '向量'
  if (h.matched === 'keyword') return '关键词'
  return ''
}

function fmtSize(n: number): string {
  if (!n || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 顶栏 -->
    <header class="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 px-4">
      <Database class="size-4 shrink-0 text-muted-foreground" />
      <h2 class="text-sm font-medium">知识库</h2>
      <p class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        建库、上传资料；对话里勾选后，引擎会先检索再回答
      </p>
      <Button variant="ghost" size="sm" class="h-7 gap-1.5 text-xs text-muted-foreground" @click="router.push('/client-settings/knowledge')">
        <Settings2 class="size-3.5" /> 检索配置
      </Button>
    </header>

    <div v-if="loading" class="flex flex-1 items-center justify-center">
      <Spinner class="size-6 text-muted-foreground" />
    </div>

    <div v-else class="flex min-h-0 flex-1">
      <!-- 左：库列表 -->
      <aside class="flex w-72 shrink-0 flex-col border-r border-border/70 bg-[#fafafa] dark:bg-card/40">
        <div class="border-b border-border/60 p-3">
          <div class="flex gap-2">
            <Input v-model="draftName" class="h-9" placeholder="新建知识库名称…" @keyup.enter="createBase" />
            <Button size="sm" class="h-9 shrink-0 gap-1" :disabled="creating || !draftName.trim()" @click="createBase">
              <Plus class="size-3.5" /> 新建
            </Button>
          </div>
        </div>
        <ul class="min-h-0 flex-1 overflow-y-auto p-2">
          <p v-if="!bases.length" class="px-2 py-6 text-center text-xs text-muted-foreground">
            还没有知识库，在上面新建一个
          </p>
          <li v-for="b in bases" :key="b.id" class="group relative">
            <button
              class="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors"
              :class="activeId === b.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'"
              @click="pickBase(b.id)"
            >
              <Database class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1">
                <template v-if="renaming === b.id">
                  <input
                    v-model="renameDraft"
                    class="w-full rounded border border-border bg-background px-1.5 py-0.5 text-[13px] outline-none"
                    @click.stop
                    @keyup.enter="saveRename(b)"
                    @keyup.esc="renaming = null"
                    @blur="saveRename(b)"
                  >
                </template>
                <template v-else>
                  <span class="block truncate text-[13px] font-medium">{{ b.name }}</span>
                  <span class="mt-0.5 block text-[11px] text-muted-foreground">
                    {{ b.file_count || 0 }} 个文件 · {{ b.chunk_count || 0 }} 段
                    <template v-if="b.indexed_files"> · 已向量化</template>
                  </span>
                </template>
              </span>
              <span class="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button class="rounded p-1 text-muted-foreground hover:text-foreground" title="重命名" @click.stop="renaming = b.id; renameDraft = b.name">
                  <Settings2 class="size-3" />
                </button>
                <button class="rounded p-1 text-muted-foreground hover:text-destructive" title="删除知识库" @click.stop="removeBase(b)">
                  <Trash2 class="size-3" />
                </button>
              </span>
            </button>
          </li>
        </ul>
      </aside>

      <!-- 右：库详情 -->
      <section class="flex min-w-0 flex-1 flex-col">
        <div v-if="!activeBase" class="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <Database class="size-8 opacity-40" />
          左侧选一个知识库，或新建一个开始上传资料
        </div>

        <template v-else>
          <div class="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{{ activeBase.name }}</p>
              <p class="mt-0.5 text-[11px] text-muted-foreground">
                <template v-if="embeddingReady">向量召回：{{ embeddingModel || '已启用' }}<span v-if="embeddingSource === 'shared'" class="text-muted-foreground/70">（与长期记忆共用，去「检索配置」可单独指定）</span><span v-else-if="embeddingSource === 'selected'" class="text-muted-foreground/70">（检索配置里选的）</span></template>
                <template v-else>未配 embedding，当前按关键词检索（去「检索配置」配一条可提升效果）</template>
                <template v-if="rerankReady"> · 已启用重排</template>
                · 向量与关键词混合召回（RRF 融合）
              </p>
              <p v-if="activeBase.stale_files" class="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                有 {{ activeBase.stale_files }} 个文件的向量是换模型之前算的，本次检索已跳过它们的语义召回——点「重建索引」重算即可恢复。
              </p>
              <p v-if="busyCount" class="mt-1 text-[11px] text-muted-foreground">
                后台入库中：{{ queue.running }} 个在建索引<template v-if="queue.queued">，{{ queue.queued }} 个排队</template>
              </p>
            </div>
            <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="uploading" @click="fileInput?.click()">
              <Loader2 v-if="uploading" class="size-3.5 animate-spin" />
              <Upload v-else class="size-3.5" /> 上传资料
            </Button>
            <Button variant="ghost" size="sm" class="h-8 gap-1.5 text-muted-foreground" :disabled="reindexing" @click="reindexAll">
              <RefreshCw class="size-3.5" :class="reindexing ? 'animate-spin' : ''" /> 重建索引
            </Button>
            <input ref="fileInput" type="file" multiple class="hidden" @change="onPickFiles">
          </div>

          <!-- 检索预览 -->
          <div class="border-b border-border/60 px-4 py-3">
            <div class="flex gap-2">
              <Input v-model="testQuery" class="h-9" placeholder="输入一句话，测试检索能否召回到相关内容…" @keyup.enter="runTest" />
              <Button size="sm" class="h-9 shrink-0 gap-1.5" :disabled="testing || !testQuery.trim()" @click="runTest">
                <Loader2 v-if="testing" class="size-3.5 animate-spin" />
                <Search v-else class="size-3.5" /> 测试检索
              </Button>
            </div>
            <div v-if="testHits" class="mt-2 space-y-1.5">
              <p v-if="testInfo" class="text-[11px] text-muted-foreground">
                检索方式：{{ testInfo.mode }}<template v-if="testInfo.model"> · {{ testInfo.model }}</template>
                <template v-for="n in testInfo.notes" :key="n"> · {{ n }}</template>
              </p>
              <p v-if="!testHits.length" class="text-xs text-muted-foreground">没有召回到内容——换个说法，或确认文件已建索引。</p>
              <div v-for="(h, i) in testHits" :key="i" class="rounded-lg border border-border bg-card/40 p-2.5">
                <p class="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <FileText class="size-3 shrink-0" />
                  <span class="truncate">{{ h.file }}<template v-if="h.heading"> › {{ h.heading }}</template></span>
                  <Badge v-if="h.merged && h.merged > 1" variant="outline" class="shrink-0 text-[10px]">合并 {{ h.merged }} 段</Badge>
                  <Badge v-if="matchLabel(h)" variant="outline" class="shrink-0 text-[10px]">{{ matchLabel(h) }}</Badge>
                  <Badge variant="secondary" class="ml-auto shrink-0 text-[10px]">相关度 {{ h.score }}</Badge>
                </p>
                <p class="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-foreground/80">{{ h.text }}</p>
              </div>
            </div>
          </div>

          <!-- 文件列表 -->
          <div class="min-h-0 flex-1 overflow-y-auto p-4">
            <div v-if="loadingFiles" class="flex justify-center py-10">
              <Spinner class="size-5 text-muted-foreground" />
            </div>
            <div v-else-if="!files.length" class="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
              还没有资料，点右上角「上传资料」
            </div>
            <ul v-else class="divide-y divide-border rounded-lg border border-border">
              <li v-for="f in files" :key="f.name" class="flex items-center gap-3 px-4 py-2.5">
                <FileText class="size-4 shrink-0 text-muted-foreground" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm">{{ f.name }}</p>
                  <p v-if="f.error" class="mt-0.5 truncate text-[11px] text-amber-600 dark:text-amber-400" :title="f.error">{{ f.error }}</p>
                </div>
                <Badge
                  variant="secondary"
                  class="shrink-0 gap-1 text-[10px]"
                  :class="fileBadge(f).tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : fileBadge(f).tone === 'busy' ? 'text-muted-foreground' : ''"
                >
                  <Loader2 v-if="fileBadge(f).tone === 'busy'" class="size-2.5 animate-spin" />
                  <Check v-else-if="fileBadge(f).tone === 'ok'" class="size-2.5" />
                  {{ fileBadge(f).label }}
                </Badge>
                <Badge variant="secondary" class="shrink-0 text-[10px]">{{ fmtSize(f.size) }}</Badge>
                <Button v-if="f.status === 'error'" variant="ghost" size="icon" title="重试入库" @click="retryFile(f)">
                  <RefreshCw class="size-4" />
                </Button>
                <Button variant="ghost" size="icon" title="删除" @click="removeFile(f)">
                  <Trash2 class="size-4" />
                </Button>
              </li>
            </ul>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>
