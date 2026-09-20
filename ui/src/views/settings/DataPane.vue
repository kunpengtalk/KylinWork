<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { HardDriveDownload, Loader2, RefreshCw, RotateCcw, Trash2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { toast } from 'vue-sonner'
import {
  checkUpdate,
  clearCache,
  createBackup,
  deleteBackup,
  getCacheStats,
  listBackups,
  restoreBackup,
  restartApp,
  type Backup,
  type CacheStats,
} from '@/api/client'

/** 设置 → 备份与缓存 */
const caches = ref<CacheStats>({})
const backups = ref<Backup[]>([])
/** 备份覆盖哪些内容（后端告诉我们） */
const covers = ref<string[]>([])
const loading = ref(true)
/** 有请求在飞：按钮禁用，避免连点造成备份/恢复互相打架 */
const busy = ref(false)
const loadError = ref('')

function fmtSize(n: number): string {
  if (!n || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtTime(v?: string): string {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 拉备份列表：后端返回 { list, covers }，不是数组 */
async function refreshBackups() {
  const r = await listBackups()
  backups.value = r?.list || []
  if (r?.covers?.length) covers.value = r.covers
}

/** 统一跑一个会改状态的操作：置忙、报错、复位 */
async function run(label: string, fn: () => Promise<void>) {
  busy.value = true
  try {
    await fn()
  } catch (e) {
    toast.error(`${label}失败：` + (e as Error).message)
  } finally {
    busy.value = false
  }
}

async function handleClearCache() {
  await run('清理', async () => {
    await clearCache()
    caches.value = await getCacheStats()
    toast.success('缓存已清理')
  })
}

async function handleBackup() {
  await run('备份', async () => {
    await createBackup()
    await refreshBackups()
    toast.success('备份已创建')
  })
}

async function handleRestore(name: string) {
  if (!window.confirm(`恢复到备份「${name}」？当前数据会被覆盖，恢复后需要重启客户端。`)) return
  await run('恢复', async () => {
    await restoreBackup(name)
    toast.success('已恢复，正在重启…')
    setTimeout(() => {
      void restartApp()
    }, 1200)
  })
}

async function handleDeleteBackup(name: string) {
  if (!window.confirm(`删除备份「${name}」？`)) return
  await run('删除', async () => {
    await deleteBackup(name)
    await refreshBackups()
    toast.success('已删除')
  })
}

async function handleCheckUpdate() {
  await run('检查更新', async () => {
    const r = (await checkUpdate()) as { message?: string; hasUpdate?: boolean }
    toast.info(r?.message || (r?.hasUpdate ? '有新版本' : '已是最新版本'))
  })
}

onMounted(async () => {
  try {
    caches.value = await getCacheStats()
    await refreshBackups()
    loadError.value = ''
  } catch (e) {
    // 引擎没起来时别装作「暂无备份」：如实说读不到，用户才知道要去看引擎
    loadError.value = (e as Error).message
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="space-y-3">
    <div v-if="loading" class="flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-5 py-8 text-sm text-muted-foreground">
      <Loader2 class="size-4 animate-spin" /> 读取中…
    </div>
    <div v-else-if="loadError" class="rounded-xl border border-destructive/40 bg-destructive/5 px-5 py-4 text-sm text-destructive">
      读不到备份与缓存信息：{{ loadError }}（本机引擎可能没在运行）
    </div>
    <template v-else>
    <div class="rounded-xl border border-border bg-background px-5 py-4">
      <p class="text-sm font-medium">备份</p>
      <p class="mt-0.5 text-[13px] text-muted-foreground">
        配置、账号、会话、技能打成一个包；恢复后自动重启。
        <span v-if="covers.length">包含：{{ covers.join('、') }}（工作空间的成果文件不在内）</span>
      </p>
      <div class="mt-3 flex flex-wrap gap-2">
        <Button size="sm" class="gap-1.5" :disabled="busy" @click="handleBackup">
          <Loader2 v-if="busy" class="size-3.5 animate-spin" />
          <HardDriveDownload v-else class="size-3.5" /> 立即备份
        </Button>
        <Button variant="outline" size="sm" class="gap-1.5" :disabled="busy" @click="handleCheckUpdate">
          <RefreshCw class="size-3.5" /> 检查更新
        </Button>
      </div>
      <div v-if="backups.length" class="mt-4 divide-y divide-border rounded-lg border border-border">
        <div v-for="b in backups" :key="b.name" class="flex items-center gap-3 px-3 py-2">
          <div class="min-w-0 flex-1">
            <p class="truncate text-[13px] font-medium">{{ b.name }}</p>
            <p class="text-[13px] text-muted-foreground">{{ fmtSize(b.size) }}<span v-if="b.at"> · {{ fmtTime(b.at) }}</span></p>
          </div>
          <Button variant="ghost" size="sm" class="h-7 gap-1 text-[13px]" :disabled="busy" @click="handleRestore(b.name)">
            <RotateCcw class="size-3" /> 恢复
          </Button>
          <Button variant="ghost" size="icon" class="size-7" :disabled="busy" @click="handleDeleteBackup(b.name)">
            <Trash2 class="size-3.5" />
          </Button>
        </div>
      </div>
      <p v-else class="mt-3 text-[13px] text-muted-foreground">还没有备份</p>
    </div>

    <div class="rounded-xl border border-border bg-background px-5 py-4">
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium">缓存</p>
          <p class="mt-0.5 text-[13px] text-muted-foreground">
            <template v-if="caches.total != null">
              共 {{ fmtSize(Number(caches.total)) }}（界面 {{ fmtSize(Number(caches.ui) || 0) }} · 临时 {{ fmtSize(Number(caches.tmp) || 0) }}）
            </template>
            <template v-else>暂无统计</template>
          </p>
        </div>
        <Button variant="outline" size="sm" :disabled="busy" @click="handleClearCache">清理</Button>
      </div>
    </div>
    </template>
  </div>
</template>
