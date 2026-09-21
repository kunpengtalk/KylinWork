<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import {
  Check,
  FileText,
  FolderUp,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  StickyNote,
  Trash2,
  Upload,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'vue-sonner'
import {
  addKnowledgeNote,
  addKnowledgeWeb,
  deleteKnowledgeDoc,
  embedMissingKnowledge,
  listKnowledgeDocs,
  reindexKnowledge,
  retryKnowledgeDoc,
  uploadKnowledgeFile,
  type KnowledgeBase,
  type KnowledgeDoc,
} from '@/api/client'
import KbChunksDialog from './KbChunksDialog.vue'

/**
 * 数据源：往库里加资料（文件 / 目录 / 笔记 / 网页），并看每份的入库状态。
 * <p>
 * 入库是后台排队跑的，上传立刻返回；这里靠轮询把「排队中 / 建索引中 / 失败」显示出来，
 * 队列跑空后再收尾刷一次状态与统计。
 */
const props = defineProps<{ base: KnowledgeBase }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const docs = ref<KnowledgeDoc[]>([])
const loading = ref(true)
const uploading = ref(false)
const reindexing = ref(false)
const backfilling = ref(false)

const fileInput = ref<HTMLInputElement | null>(null)
const folderInput = ref<HTMLInputElement | null>(null)

// 添加笔记 / 网页
const noteOpen = ref(false)
const noteTitle = ref('')
const noteContent = ref('')
const webOpen = ref(false)
const webUrl = ref('')
const adding = ref(false)

// 删除确认
const pendingDelete = ref<KnowledgeDoc | null>(null)
const deleting = ref(false)

// 查看分块
const chunksOpen = ref(false)
const chunksDoc = ref<KnowledgeDoc | null>(null)

const embeddingOn = computed(() => !!props.base.embedding_model)
const missingVectors = computed(() => docs.value.reduce((n, d) => n + Math.max(0, d.chunks - d.embedded), 0))
const busyCount = computed(() => docs.value.filter((d) => d.status === 'queued' || d.status === 'running').length)

let pollTimer: number | undefined
onUnmounted(stopPolling)

watch(
  () => props.base.id,
  () => {
    stopPolling()
    void load()
  },
  { immediate: true },
)

async function load(quiet = false) {
  if (!quiet) loading.value = true
  try {
    const d = await listKnowledgeDocs(props.base.id)
    docs.value = d.docs || []
    if (busyCount.value) startPolling()
  } catch (e) {
    if (!quiet) toast.error('读取资料失败：' + (e as Error).message)
  } finally {
    loading.value = false
  }
}

/** 队列里还有任务就每 1.5s 刷一次，跑完再收尾刷一次并通知父级刷新统计 */
function startPolling() {
  if (pollTimer) return
  pollTimer = window.setInterval(async () => {
    try {
      const d = await listKnowledgeDocs(props.base.id)
      docs.value = d.docs || []
    } catch {
      // 引擎重启时读不到，下一轮再说
    }
    if (!busyCount.value) {
      stopPolling()
      emit('changed')
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

async function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const list = Array.from(input.files || [])
  input.value = ''
  if (!list.length) return
  uploading.value = true
  const failed: string[] = []
  let ok = 0
  for (const f of list) {
    try {
      await uploadKnowledgeFile(props.base.id, f)
      ok += 1
    } catch (err) {
      failed.push(`${f.webkitRelativePath || f.name}（${(err as Error).message}）`)
    }
  }
  uploading.value = false
  await load(true)
  emit('changed')
  if (ok) {
    toast.success(`已上传 ${ok} 个文件，正在后台建索引`)
    startPolling()
  }
  if (failed.length) toast.error('部分失败：' + failed.join('；'))
}

async function submitNote() {
  if (!noteContent.value.trim()) return
  adding.value = true
  try {
    await addKnowledgeNote(props.base.id, { title: noteTitle.value.trim(), content: noteContent.value })
    noteOpen.value = false
    noteTitle.value = ''
    noteContent.value = ''
    await load(true)
    emit('changed')
    startPolling()
    toast.success('笔记已加入，正在后台建索引')
  } catch (e) {
    toast.error('添加笔记失败：' + (e as Error).message)
  } finally {
    adding.value = false
  }
}

async function submitWeb() {
  if (!/^https?:\/\//i.test(webUrl.value.trim())) return
  adding.value = true
  try {
    await addKnowledgeWeb(props.base.id, webUrl.value.trim())
    webOpen.value = false
    webUrl.value = ''
    await load(true)
    emit('changed')
    startPolling()
    toast.success('网页已抓取，正在后台建索引')
  } catch (e) {
    toast.error('添加网页失败：' + (e as Error).message)
  } finally {
    adding.value = false
  }
}

async function reindexAll() {
  reindexing.value = true
  try {
    const r = await reindexKnowledge(props.base.id)
    toast.success(`已排入队列：${r.queued} 份资料`)
    await load(true)
    startPolling()
  } catch (e) {
    toast.error('重建失败：' + (e as Error).message)
  } finally {
    reindexing.value = false
  }
}

async function backfill() {
  backfilling.value = true
  try {
    const r = await embedMissingKnowledge(props.base.id)
    toast.success(r.queued ? `已排入队列：${r.queued} 份资料` : '没有需要补齐向量的资料')
    await load(true)
    startPolling()
  } catch (e) {
    toast.error('补齐失败：' + (e as Error).message)
  } finally {
    backfilling.value = false
  }
}

async function retryDoc(d: KnowledgeDoc) {
  try {
    await retryKnowledgeDoc(props.base.id, d.id)
    toast.success(`已重新排队：${d.name}`)
    await load(true)
    startPolling()
  } catch (e) {
    toast.error('重试失败：' + (e as Error).message)
  }
}

async function reindexDoc(d: KnowledgeDoc) {
  try {
    await reindexKnowledge(props.base.id, d.id)
    toast.success(`已重新处理：${d.name}`)
    await load(true)
    startPolling()
  } catch (e) {
    toast.error('重新处理失败：' + (e as Error).message)
  }
}

async function confirmDelete() {
  const d = pendingDelete.value
  if (!d) return
  deleting.value = true
  try {
    await deleteKnowledgeDoc(props.base.id, d.id)
    pendingDelete.value = null
    await load(true)
    emit('changed')
    toast.success('已删除')
  } catch (e) {
    toast.error('删除失败：' + (e as Error).message)
  } finally {
    deleting.value = false
  }
}

function openChunks(d: KnowledgeDoc) {
  chunksDoc.value = d
  chunksOpen.value = true
}

function docIcon(d: KnowledgeDoc) {
  return d.kind === 'note' ? StickyNote : d.kind === 'web' ? Link2 : FileText
}

/** 状态标签：入库是异步的，「排队中 / 建索引中 / 失败」都得让人看得见 */
function badge(d: KnowledgeDoc): { label: string; tone: 'busy' | 'ok' | 'warn' | 'idle' } {
  if (d.status === 'queued') return { label: '排队中', tone: 'busy' }
  if (d.status === 'running') return { label: '建索引中', tone: 'busy' }
  // 已经切出分块 = 资料进去了、关键词能搜到；只是向量没算上，别标成「入库失败」
  if (!d.indexed) return { label: d.status === 'error' || d.error ? '入库失败' : '未建索引', tone: d.status === 'error' || d.error ? 'warn' : 'idle' }
  if (d.stale) return { label: `${d.chunks} 段 · 向量已失效`, tone: 'warn' }
  if (embeddingOn.value && d.chunks && d.embedded < d.chunks) return { label: `${d.chunks} 段 · 未向量化`, tone: 'warn' }
  return { label: `${d.chunks} 段`, tone: 'ok' }
}

function fmtSize(n: number): string {
  if (!n || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- 工具条 -->
    <div class="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
      <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="uploading" @click="fileInput?.click()">
        <Loader2 v-if="uploading" class="size-3.5 animate-spin" />
        <Upload v-else class="size-3.5" /> 添加文件
      </Button>
      <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="uploading" @click="folderInput?.click()">
        <FolderUp class="size-3.5" /> 导入目录
      </Button>
      <Button variant="outline" size="sm" class="h-8 gap-1.5" @click="noteOpen = true">
        <StickyNote class="size-3.5" /> 添加笔记
      </Button>
      <Button variant="outline" size="sm" class="h-8 gap-1.5" @click="webOpen = true">
        <Link2 class="size-3.5" /> 添加网页
      </Button>
      <div class="ml-auto flex items-center gap-2">
        <Button
          v-if="embeddingOn"
          variant="ghost"
          size="sm"
          class="h-8 gap-1.5 text-muted-foreground"
          :disabled="backfilling || !missingVectors"
          :title="missingVectors ? `有 ${missingVectors} 段还没有向量` : '所有分块都已向量化'"
          @click="backfill"
        >
          <Loader2 v-if="backfilling" class="size-3.5 animate-spin" />
          <Plus v-else class="size-3.5" /> 补齐向量
        </Button>
        <Button variant="ghost" size="sm" class="h-8 gap-1.5 text-muted-foreground" :disabled="reindexing" @click="reindexAll">
          <RefreshCw class="size-3.5" :class="reindexing ? 'animate-spin' : ''" /> 重建索引
        </Button>
      </div>
      <input ref="fileInput" type="file" multiple class="hidden" @change="onPickFiles($event)">
      <input ref="folderInput" type="file" webkitdirectory multiple class="hidden" @change="onPickFiles">
    </div>

    <p v-if="busyCount" class="border-b border-border/60 bg-muted/40 px-4 py-1.5 text-[11px] text-muted-foreground">
      后台入库中：{{ busyCount }} 份资料正在处理，完成后自动刷新。
    </p>

    <!-- 文档列表 -->
    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      <div v-if="loading" class="flex justify-center py-10">
        <Spinner class="size-5 text-muted-foreground" />
      </div>
      <div v-else-if="!docs.length" class="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
        还没有资料。用上面的「添加文件 / 导入目录 / 添加笔记 / 添加网页」加进来。
      </div>
      <ul v-else class="divide-y divide-border rounded-lg border border-border">
        <li v-for="d in docs" :key="d.id" class="group flex items-center gap-3 px-4 py-2.5">
          <component :is="docIcon(d)" class="size-4 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm">
              {{ d.name }}
              <span v-if="d.kind === 'note'" class="ml-1 text-[10px] text-muted-foreground">笔记</span>
              <span v-else-if="d.kind === 'web'" class="ml-1 text-[10px] text-muted-foreground">网页</span>
            </p>
            <div class="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>分块 {{ d.embedded }}/{{ d.chunks }}</span>
              <span v-if="embeddingOn && d.chunks" class="inline-block h-1 w-20 overflow-hidden rounded-full bg-muted">
                <span
                  class="block h-full rounded-full"
                  :class="d.embedded >= d.chunks ? 'bg-emerald-500' : 'bg-primary'"
                  :style="{ width: Math.round((d.embedded / d.chunks) * 100) + '%' }"
                />
              </span>
              <span v-if="d.kind === 'file'">{{ fmtSize(d.size) }}</span>
            </div>
            <p v-if="d.error" class="mt-0.5 truncate text-[11px] text-amber-600 dark:text-amber-400" :title="d.error">{{ d.error }}</p>
            <p v-else-if="d.status === 'queued' && (d.attempts || 0) > 0" class="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
              第 {{ d.attempts }} 次尝试，失败会自动退避重试
            </p>
          </div>

          <Badge
            variant="secondary"
            class="shrink-0 gap-1 text-[10px]"
            :class="badge(d).tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : badge(d).tone === 'busy' ? 'text-muted-foreground' : badge(d).tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : ''"
          >
            <Loader2 v-if="badge(d).tone === 'busy'" class="size-2.5 animate-spin" />
            <Check v-else-if="badge(d).tone === 'ok'" class="size-2.5" />
            {{ badge(d).label }}
          </Badge>

          <span class="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <Button variant="ghost" size="icon" class="size-7" title="查看分块" :disabled="!d.chunks" @click="openChunks(d)">
              <FileText class="size-3.5" />
            </Button>
            <Button v-if="d.status === 'error'" variant="ghost" size="icon" class="size-7" title="重试入库" @click="retryDoc(d)">
              <RefreshCw class="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" class="size-7" title="重新处理" @click="reindexDoc(d)">
              <RefreshCw class="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" class="size-7 text-muted-foreground hover:text-destructive" title="删除" @click="pendingDelete = d">
              <Trash2 class="size-3.5" />
            </Button>
          </span>
        </li>
      </ul>
    </div>

    <!-- 添加笔记 -->
    <Dialog v-model:open="noteOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加笔记</DialogTitle>
          <DialogDescription>粘贴一段文字，作为这个库的资料。</DialogDescription>
        </DialogHeader>
        <div class="space-y-3 py-1">
          <div class="space-y-1.5">
            <Label class="text-[13px]">标题</Label>
            <Input v-model="noteTitle" class="h-9" placeholder="例如：退款政策要点" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[13px]">内容</Label>
            <Textarea v-model="noteContent" rows="8" class="resize-none font-mono text-xs" placeholder="支持 Markdown，## 标题会被识别成章节" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" @click="noteOpen = false">取消</Button>
          <Button :disabled="adding || !noteContent.trim()" class="gap-1.5" @click="submitNote">
            <Spinner v-if="adding" class="size-3.5" /> 添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 添加网页 -->
    <Dialog v-model:open="webOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加网页</DialogTitle>
          <DialogDescription>由引擎抓取正文后入库，适合文档页、公告页。</DialogDescription>
        </DialogHeader>
        <div class="space-y-1.5 py-1">
          <Label class="text-[13px]">网址</Label>
          <Input v-model="webUrl" class="h-9" placeholder="https://…" @keyup.enter="submitWeb" />
        </div>
        <DialogFooter>
          <Button variant="ghost" @click="webOpen = false">取消</Button>
          <Button :disabled="adding || !/^https?:\/\//i.test(webUrl.trim())" class="gap-1.5" @click="submitWeb">
            <Spinner v-if="adding" class="size-3.5" /> 抓取并入库
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 删除确认 -->
    <Dialog :open="!!pendingDelete" @update:open="(v) => !v && (pendingDelete = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除资料</DialogTitle>
          <DialogDescription>确定删除「{{ pendingDelete?.name }}」？它的分块与向量会一并清除，不可恢复。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="pendingDelete = null">取消</Button>
          <Button variant="destructive" :disabled="deleting" class="gap-1.5" @click="confirmDelete">
            <Spinner v-if="deleting" class="size-3.5" /> 删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <KbChunksDialog v-model:open="chunksOpen" :kb-id="base.id" :doc="chunksDoc" />
  </div>
</template>
