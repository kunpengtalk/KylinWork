<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { FlaskConical, Play, RefreshCw } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'vue-sonner'
import { getEvalHistory, getEvalStatus, startEval } from '@/api/client'

/**
 * 回归评测：跑一批固定任务，看改动有没有把老能力搞坏。
 * 这是改引擎 (agent) 之后最有价值的一道保险。
 *
 * 后端口径：/eval/status → { running, model, startedAt, exit, lines }；
 * /eval/history → { runs: [{ at, model, score_pct, pass1_avg, tasks, full_pass, … }], baseline }。
 */
interface EvalStatus {
  running?: boolean
  model?: string
  startedAt?: number
  exit?: number | null
  lines?: string[]
}
interface EvalRun {
  at?: string
  model?: string
  model_id?: string
  score_pct?: number
  pass1_avg?: number
  tasks?: number
  full_pass?: number
  dir?: string
}
interface EvalHistory {
  runs?: EvalRun[]
  baseline?: { at?: string; model?: string; commit?: string } | null
}

const status = ref<EvalStatus | null>(null)
const runs = ref<EvalRun[]>([])
const baseline = ref<EvalHistory['baseline']>(null)
const loading = ref(true)
const showLog = ref(false)
let timer: number | undefined

const running = computed(() => !!status.value?.running)

async function load() {
  try {
    status.value = (await getEvalStatus()) as EvalStatus
  } catch {
    status.value = null
  }
  try {
    const h = ((await getEvalHistory()) as EvalHistory) || {}
    runs.value = h.runs || []
    baseline.value = h.baseline || null
  } catch {
    runs.value = []
  }
}

onMounted(async () => {
  await load()
  loading.value = false
  // 评测是子进程在跑：不轮询的话点完「跑一轮」界面就一直停在「空闲」
  timer = window.setInterval(() => {
    if (running.value && document.visibilityState === 'visible') void load()
  }, 3000)
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})

async function start() {
  try {
    await startEval()
    toast.success('评测已启动，跑完会自动刷新')
    await load()
  } catch (e) {
    toast.error('启动失败：' + (e as Error).message)
  }
}

function fmtTime(ms?: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
</script>

<template>
  <div class="settings-pane mx-auto w-full max-w-3xl space-y-6 px-10 py-8">
    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle class="flex items-center gap-2">
              <FlaskConical class="size-5" /> 回归评测
            </CardTitle>
            <CardDescription class="mt-1">
              跑一批固定任务验证老能力没坏。改动 Agent 引擎之后，先跑一遍再信。
            </CardDescription>
          </div>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" class="gap-1.5" :disabled="loading" @click="load">
              <RefreshCw class="size-3.5" /> 刷新
            </Button>
            <Button size="sm" class="gap-1.5" :disabled="running" @click="start">
              <Play class="size-3.5" /> {{ running ? '评测中…' : '跑一轮' }}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div v-if="loading" class="flex justify-center py-10">
          <Spinner class="size-6 text-muted-foreground" />
        </div>
        <div v-else class="space-y-2 text-sm">
          <p class="flex flex-wrap items-center gap-2">
            状态：
            <Badge :variant="running ? 'default' : 'secondary'">
              <Spinner v-if="running" class="mr-1 size-3" />
              {{ running ? '运行中' : '空闲' }}
            </Badge>
            <span v-if="status?.model" class="text-[13px] text-muted-foreground">模型：{{ status.model }}</span>
            <span v-if="running && status?.startedAt" class="text-[13px] text-muted-foreground">开始于 {{ fmtTime(status.startedAt) }}</span>
            <span v-else-if="status?.exit != null && status.exit !== 0" class="text-[13px] text-destructive">上轮退出码 {{ status.exit }}</span>
          </p>

          <div v-if="status?.lines?.length" class="pt-1">
            <button class="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground" @click="showLog = !showLog">
              {{ showLog ? '收起' : '展开' }}运行日志（{{ status.lines.length }} 行）
            </button>
            <pre v-if="showLog" class="mt-1.5 max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-[13px] leading-relaxed">{{ status.lines.join('\n') }}</pre>
          </div>
          <p v-else-if="!running" class="text-[13px] text-muted-foreground">还没跑过评测，点右上角「跑一轮」。</p>
        </div>
      </CardContent>
    </Card>

    <Card v-if="baseline">
      <CardContent class="pt-6 text-[13px] text-muted-foreground">
        对比基线：{{ baseline.model || '—' }} · {{ baseline.at || '—' }}
      </CardContent>
    </Card>

    <Card v-if="runs.length">
      <CardHeader>
        <CardTitle class="text-base">历史结果</CardTitle>
        <CardDescription>近 20 次跑批的通过率。</CardDescription>
      </CardHeader>
      <CardContent>
        <ul class="divide-y divide-border rounded-lg border border-border">
          <li v-for="(h, i) in runs.slice(0, 20)" :key="h.dir || i" class="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span class="min-w-0 flex-1 truncate">{{ h.model || h.model_id || h.dir || '—' }}</span>
            <span v-if="h.full_pass != null && h.tasks" class="shrink-0 text-[13px] text-muted-foreground">{{ h.full_pass }}/{{ h.tasks }}</span>
            <Badge v-if="h.pass1_avg != null" variant="secondary">{{ h.pass1_avg }}%</Badge>
            <span class="shrink-0 text-[13px] text-muted-foreground">{{ h.at || '' }}</span>
          </li>
        </ul>
      </CardContent>
    </Card>
  </div>
</template>
