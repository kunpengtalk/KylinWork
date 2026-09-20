<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Archive, Check, RefreshCw, Sprout, X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'vue-sonner'
import {
  decideEvolveProposal,
  listEvolveState,
  retireEvolveRule,
  runEvolveReview,
  saveSettings,
  type EvolveState,
} from '@/api/client'

/**
 * 自进化：从历史任务里挖出反复踩的坑，变成候选规则，**永远要人点头才生效**。
 *
 * 后端口径（以前前端接错了两处）：
 * - 审批：POST /evolve/proposal/:id { decision: 'accept' | 'reject' }
 * - 复盘：POST /evolve/review（这是「再跑一轮」，不是审批）
 * - 下架：POST /evolve/rule/:id/retire
 * - 自动复盘开关存在 config.evolve，走 /settings 读写
 */
const state = ref<EvolveState>({})
const loading = ref(true)
const deciding = ref('')
const reviewing = ref(false)
const savingAuto = ref(false)

const auto = ref({ auto: false, hour: 3, days: 14 })

interface Proposal {
  id?: string
  kind?: string
  status?: string
  title?: string
  rule?: string
  text?: string
  why?: string
  /** retire_rule 提案里要换下的规则 id */
  retire?: string
  target?: string
  signal?: string
  at?: string
  decidedAt?: string
  reason?: string
}

const proposals = computed(() => (state.value.proposals || []) as Proposal[])
const pending = computed(() => proposals.value.filter((p) => (p.status || 'pending') === 'pending'))
const decided = computed(() => proposals.value.filter((p) => (p.status || 'pending') !== 'pending'))
const rules = computed(() => (state.value.rules || []) as Record<string, unknown>[])

const KIND_LABEL: Record<string, string> = { add_rule: '新增规则', retire_rule: '下架规则', unknown: '未分类' }

function fmtTime(v?: string): string {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

onMounted(async () => {
  await load()
  loading.value = false
})

async function load() {
  try {
    state.value = await listEvolveState()
    const a = (state.value.auto || {}) as Record<string, unknown>
    auto.value = {
      auto: a.auto === true,
      hour: Number(a.hour ?? 3),
      days: Number(a.days ?? 14),
    }
  } catch (e) {
    toast.error('读取自进化状态失败：' + (e as Error).message)
  }
}

async function decide(id: string, decision: 'accept' | 'reject') {
  deciding.value = id
  try {
    await decideEvolveProposal(id, decision)
    toast.success(decision === 'accept' ? '已采纳，下次任务生效' : '已否决')
    await load()
  } catch (e) {
    toast.error('操作失败：' + (e as Error).message)
  } finally {
    deciding.value = ''
  }
}

async function runReview() {
  reviewing.value = true
  try {
    const r = await runEvolveReview(auto.value.days)
    const added = (r.added || []).length
    const gated = (r.gated || []).length
    toast.success(`复盘完成：看了 ${r.turns ?? 0} 个回合，新增 ${added} 条候选${gated ? `，被闸门挡下 ${gated} 条` : ''}`)
    await load()
  } catch (e) {
    toast.error('复盘失败：' + (e as Error).message)
  } finally {
    reviewing.value = false
  }
}

async function retire(id: string) {
  const why = window.prompt('下架这条规则的原因（可留空）：') ?? null
  if (why === null) return
  try {
    await retireEvolveRule(id, why)
    toast.success('规则已下架')
    await load()
  } catch (e) {
    toast.error('下架失败：' + (e as Error).message)
  }
}

async function saveAuto() {
  savingAuto.value = true
  try {
    await saveSettings({ evolve: { auto: auto.value.auto, hour: auto.value.hour, days: auto.value.days } })
    toast.success(auto.value.auto ? `已开启自动复盘：每天 ${auto.value.hour}:00 左右` : '已关闭自动复盘')
  } catch (e) {
    toast.error('保存失败：' + (e as Error).message)
  } finally {
    savingAuto.value = false
  }
}
</script>

<template>
  <div class="settings-pane mx-auto w-full max-w-3xl space-y-6 px-10 py-8">
    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle class="flex items-center gap-2">
              <Sprout class="size-5" /> 自进化
            </CardTitle>
            <CardDescription class="mt-1">
              从跑过的任务里复盘出改进提案，<b>必须你点头才会生效</b>——不会自己悄悄改规则。
            </CardDescription>
          </div>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" class="gap-1.5" :disabled="loading" @click="load">
              <RefreshCw class="size-3.5" /> 刷新
            </Button>
            <Button size="sm" class="gap-1.5" :disabled="reviewing" @click="runReview">
              <Spinner v-if="reviewing" class="size-3.5" />
              <Sprout v-else class="size-3.5" />
              {{ reviewing ? '复盘中…' : '立即复盘一轮' }}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent class="space-y-5">
        <!-- 自动复盘：默认关（要调模型、花钱），开关存 config.evolve -->
        <div class="rounded-lg border border-border bg-muted/30 px-4 py-3">
          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="text-sm font-medium">每晚自动复盘</p>
              <p class="mt-0.5 text-[13px] text-muted-foreground">
                到点自动跑一轮复盘，提案仍然进待审列表，不会自动生效。
              </p>
            </div>
            <input v-model="auto.auto" type="checkbox" class="size-4 accent-primary" @change="saveAuto" />
          </div>
          <div v-if="auto.auto" class="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-3">
            <div class="space-y-1">
              <Label class="text-[13px]">每天几点</Label>
              <Input v-model.number="auto.hour" type="number" min="0" max="23" class="h-8 w-24" />
            </div>
            <div class="space-y-1">
              <Label class="text-[13px]">回看天数</Label>
              <Input v-model.number="auto.days" type="number" min="1" max="365" class="h-8 w-24" />
            </div>
            <Button size="sm" class="h-8" :disabled="savingAuto" @click="saveAuto">保存</Button>
          </div>
        </div>

        <div v-if="loading" class="flex justify-center py-10">
          <Spinner class="size-6 text-muted-foreground" />
        </div>

        <template v-else>
          <div>
            <p class="mb-2 text-sm font-medium">待审提案（{{ pending.length }}）</p>
            <div v-if="!pending.length" class="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
              没有待审的改进提案。点「立即复盘一轮」可以从最近的任务里挖挖看。
            </div>
            <ul v-else class="divide-y divide-border rounded-lg border border-border">
              <li v-for="p in pending" :key="String(p.id)" class="px-4 py-3">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <p class="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {{ p.title || p.rule || p.text || '改进提案' }}
                      <Badge variant="secondary" class="text-[12px]">{{ KIND_LABEL[p.kind || 'unknown'] || p.kind }}</Badge>
                      <Badge v-if="p.retire" variant="outline" class="text-[12px]">换下 {{ p.retire }}</Badge>
                    </p>
                    <p v-if="p.rule && p.rule !== p.title" class="mt-1 whitespace-pre-wrap rounded bg-muted/40 px-2 py-1 font-mono text-[13px]">{{ p.rule }}</p>
                    <p v-if="p.why" class="mt-1 text-[13px] text-muted-foreground">依据：{{ p.why }}</p>
                    <p class="mt-1 text-[13px] text-muted-foreground/70">
                      {{ fmtTime(p.at) }}
                      <span v-if="p.signal"> · 信号 {{ p.signal }}</span>
                    </p>
                  </div>
                  <div class="flex shrink-0 gap-1.5">
                    <Button variant="ghost" size="sm" class="gap-1" :disabled="deciding === String(p.id)" @click="decide(String(p.id), 'accept')">
                      <Check class="size-3.5" /> 采纳
                    </Button>
                    <Button variant="ghost" size="sm" class="gap-1 text-muted-foreground" :disabled="deciding === String(p.id)" @click="decide(String(p.id), 'reject')">
                      <X class="size-3.5" /> 否决
                    </Button>
                  </div>
                </div>
              </li>
            </ul>
          </div>

          <!-- 已生效规则 -->
          <div>
            <p class="mb-2 text-sm font-medium">已生效的规则（{{ rules.length }}）</p>
            <p class="mb-2 text-[13px] text-muted-foreground">这些已经进了系统提示词，每次任务都会带上。</p>
            <ul v-if="rules.length" class="divide-y divide-border rounded-lg border border-border">
              <li v-for="r in rules" :key="String(r.id)" class="flex items-start gap-3 px-4 py-2.5">
                <span class="min-w-0 flex-1 text-sm">{{ r.text }}</span>
                <Button variant="ghost" size="sm" class="h-7 shrink-0 gap-1 text-[13px] text-muted-foreground" @click="retire(String(r.id))">
                  <Archive class="size-3" /> 下架
                </Button>
              </li>
            </ul>
            <p v-else class="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
              还没有生效的规则
            </p>
          </div>

          <!-- 已决提案（留档，方便回看当初为什么否掉） -->
          <details v-if="decided.length" class="rounded-lg border border-border">
            <summary class="cursor-pointer px-4 py-2 text-[13px] text-muted-foreground select-none">已处理提案（{{ decided.length }}）</summary>
            <ul class="divide-y divide-border border-t border-border">
              <li v-for="p in decided" :key="String(p.id)" class="flex items-center gap-3 px-4 py-2 text-[13px]">
                <Badge variant="outline" class="shrink-0 text-[12px]">{{ p.status }}</Badge>
                <span class="min-w-0 flex-1 truncate">{{ p.title || p.rule || p.text }}</span>
                <span class="shrink-0 text-muted-foreground/70">{{ fmtTime(p.decidedAt || p.at) }}</span>
              </li>
            </ul>
          </details>
        </template>
      </CardContent>
    </Card>
  </div>
</template>
