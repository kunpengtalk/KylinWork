<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Download,
  ExternalLink,
  Eye,
  FolderOpen,
  FolderSearch,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Badge } from '@/components/ui/badge'
import { toast } from 'vue-sonner'
import {
  fileDownloadUrl,
  fileViewUrl,
  getSettings,
  listFiles,
  openFile,
  openWorkspace,
  pickFolder,
  revealFile,
  saveSettings,
  tidyFiles,
  type OutputFile,
} from '@/api/client'

/**
 * 成果文件。
 * <p>
 * 这是桌面客户端最要紧的一块：AI 干完活产出的 PPT / Word / Excel / 网页都落在本地工作目录，
 * 用户要能直接找到、打开、拖走——纯 Web 版没有本地文件系统，也就没有这一页。
 */
const files = ref<OutputFile[]>([])
const loading = ref(false)
const keyword = ref('')
const workspaceDir = ref('')

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return files.value
  return files.value.filter((f) => f.name.toLowerCase().includes(k))
})

onMounted(async () => {
  await load()
  try {
    const s = await getSettings()
    workspaceDir.value = String(s?.workspace_dir || '')
  } catch {
    // 读不到工作目录不影响列文件，只是少一行提示
  }
})

async function load() {
  loading.value = true
  try {
    files.value = await listFiles()
  } catch (e) {
    toast.error('读取成果文件失败：' + (e as Error).message)
  } finally {
    loading.value = false
  }
}

/** 调系统默认程序打开——这是「客户端」才做得到的事 */
async function handleOpen(name: string) {
  try {
    await openFile(name)
  } catch (e) {
    toast.error('打开失败：' + (e as Error).message)
  }
}

/** 在访达 / 资源管理器中选中该文件：用户要的往往不是看内容，是知道它在哪 */
async function handleReveal(name: string) {
  try {
    await revealFile(name)
  } catch (e) {
    toast.error('定位失败：' + (e as Error).message)
  }
}

async function handleOpenWorkspace() {
  try {
    await openWorkspace()
  } catch (e) {
    toast.error('打开工作目录失败：' + (e as Error).message)
  }
}

/** 换工作目录：弹系统文件夹选择框，选完落盘（否则只是弹了个框、目录根本没换） */
async function handlePickFolder() {
  try {
    const r = await pickFolder()
    const dir = r?.dir || r?.path
    if (!dir) return
    await saveSettings({ workspace_dir: dir, workspace_permanent: true })
    workspaceDir.value = dir
    toast.success('工作目录已切换到 ' + dir)
    await load()
  } catch (e) {
    toast.error('选择目录失败：' + (e as Error).message)
  }
}

async function handleTidy() {
  try {
    const r = (await tidyFiles()) as { removed?: number }
    toast.success(`已清理 ${r?.removed ?? 0} 项残留`)
    await load()
  } catch (e) {
    toast.error('清理失败：' + (e as Error).message)
  }
}

function fmtSize(n: number): string {
  if (!n || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}
</script>

<template>
  <div class="settings-pane mx-auto w-full max-w-5xl space-y-6 px-10 py-8">
    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle class="flex items-center gap-2">
              <FolderOpen class="size-5" />
              成果文件
            </CardTitle>
            <CardDescription class="mt-1">
              AI 产出的文件都在这里。可以直接用本机默认程序打开，也能定位到它在访达 / 资源管理器中的位置。
            </CardDescription>
          </div>
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" class="gap-1.5" @click="handleOpenWorkspace">
              <ExternalLink class="size-3.5" />
              打开工作目录
            </Button>
            <Button variant="outline" size="sm" class="gap-1.5" @click="handlePickFolder">
              <FolderSearch class="size-3.5" />
              换一个目录
            </Button>
            <Button variant="outline" size="sm" class="gap-1.5" @click="load" :disabled="loading">
              <RefreshCw class="size-3.5" :class="loading ? 'animate-spin' : ''" />
              刷新
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent class="space-y-4">
        <div v-if="workspaceDir" class="rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
          当前工作目录：<code class="font-mono">{{ workspaceDir }}</code>
        </div>

        <div class="relative">
          <Search class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="keyword" placeholder="按文件名筛选…" class="h-9 pl-9" />
        </div>

        <div v-if="loading && !files.length" class="flex justify-center py-12">
          <Spinner class="size-6 text-muted-foreground" />
        </div>

        <div
          v-else-if="!filtered.length"
          class="rounded-lg border border-dashed border-border py-12 text-center"
        >
          <Sparkles class="mx-auto size-8 text-muted-foreground/50" />
          <p class="mt-3 text-sm text-muted-foreground">
            {{ files.length ? '没有匹配的文件' : '还没有成果文件，去工作空间让 AI 干点活' }}
          </p>
        </div>

        <ul v-else class="divide-y divide-border rounded-lg border border-border">
          <li
            v-for="f in filtered"
            :key="f.name"
            class="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40"
          >
            <Badge variant="secondary" class="shrink-0 font-mono text-[12px] uppercase">
              {{ extOf(f.name) || 'file' }}
            </Badge>

            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium" :title="f.name">{{ f.name }}</p>
              <p class="mt-0.5 text-[13px] text-muted-foreground">
                {{ fmtSize(f.size) }} · {{ fmtTime(f.mtime) }}
              </p>
            </div>

            <div class="flex shrink-0 gap-1.5">
              <Button variant="ghost" size="icon" title="用本机程序打开" @click="handleOpen(f.name)">
                <FolderOpen class="size-4" />
              </Button>
              <Button variant="ghost" size="icon" title="在访达 / 资源管理器中显示" @click="handleReveal(f.name)">
                <FolderSearch class="size-4" />
              </Button>
              <a :href="fileViewUrl(f.name)" target="_blank" rel="noreferrer">
                <Button variant="ghost" size="icon" title="预览">
                  <Eye class="size-4" />
                </Button>
              </a>
              <a :href="fileDownloadUrl(f.name)">
                <Button variant="ghost" size="icon" title="下载">
                  <Download class="size-4" />
                </Button>
              </a>
            </div>
          </li>
        </ul>

        <div v-if="files.length" class="flex items-center justify-between text-[13px] text-muted-foreground">
          <span>共 {{ files.length }} 个文件</span>
          <Button variant="ghost" size="sm" @click="handleTidy">清理空目录与残留</Button>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
