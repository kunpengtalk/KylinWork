<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Coins,
  Receipt,
  Timer,
  TrendingUp,
} from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'vue-sonner'
import { myUsage, myUsageStats } from '@/api/profile'
import type { UsageRecord, UsageStats } from '@/api/profile'
import LoginGate from '@/components/LoginGate.vue'

/**
 * 用量明细。
 * <p>
 * 数据来自 ai-relay 的 spend_logs。两点需要在界面上如实说明，避免误导：
 * <ol>
 *   <li>金额单位是<b>美元</b>，且与主链路扣减的「点数」不是同一套计量</li>
 *   <li>ai-relay 的时间范围筛选参数当前无效，故本页不提供时间筛选，
 *       避免给出「筛选了但没生效」的错误预期</li>
 * </ol>
 */
const records = ref<UsageRecord[]>([])
const stats = ref<UsageStats | null>(null)
const loading = ref(false)
const error = ref('')

const pageNum = ref(1)
const pageSize = ref(20)
const total = ref(0)

onMounted(load)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [page, st] = await Promise.all([
      myUsage(pageNum.value, pageSize.value),
      myUsageStats().catch(() => null),
    ])
    records.value = page.items
    total.value = page.total
    stats.value = st
  } catch (e) {
    error.value = (e as Error).message
    toast.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

function changePage(delta: number) {
  const next = pageNum.value + delta
  if (next < 1) return
  pageNum.value = next
  void load()
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

function formatSpend(v: number) {
  return `$${Number(v ?? 0).toFixed(6)}`
}

function formatTokens(n: number) {
  const v = Number(n ?? 0)
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(v)
}

function formatTime(t: string) {
  if (!t) return '—'
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? t : d.toLocaleString('zh-CN')
}

function statusVariant(status: number | null) {
  if (status === null) return 'secondary'
  return status >= 200 && status < 300 ? 'default' : 'destructive'
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <LoginGate>
      <div class="settings-pane mx-auto w-full max-w-5xl px-10 py-8">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 class="text-[22px] font-semibold tracking-tight">用量明细</h1>
            <p class="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">
              按你的账号维度统计的调用量与成本
            </p>
          </div>
          <Button variant="outline" size="sm" class="shrink-0" @click="load">刷新</Button>
        </div>

        <div class="mt-6 space-y-5">
          <div
            v-if="error"
            class="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            {{ error }}
          </div>

          <!-- 聚合卡片 -->
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader class="pb-1">
                <CardDescription class="flex items-center gap-1.5 text-xs">
                  <Activity class="size-3.5" />
                  总请求数
                </CardDescription>
                <CardTitle class="text-2xl">{{ stats?.totalRequests ?? '—' }}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader class="pb-1">
                <CardDescription class="flex items-center gap-1.5 text-xs">
                  <Coins class="size-3.5" />
                  累计花费（USD）
                </CardDescription>
                <CardTitle class="text-2xl">
                  {{ stats ? formatSpend(stats.totalSpend) : '—' }}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader class="pb-1">
                <CardDescription class="flex items-center gap-1.5 text-xs">
                  <Receipt class="size-3.5" />
                  Token 总量
                </CardDescription>
                <CardTitle class="text-2xl">
                  {{ stats ? formatTokens(stats.totalTokens) : '—' }}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader class="pb-1">
                <CardDescription class="flex items-center gap-1.5 text-xs">
                  <Timer class="size-3.5" />
                  平均延迟
                </CardDescription>
                <CardTitle class="text-2xl">{{ stats?.avgLatencyMs ?? '—' }} ms</CardTitle>
              </CardHeader>
            </Card>
          </div>

          <!-- 成功率 -->
          <Card v-if="stats">
            <CardContent class="flex flex-wrap items-center gap-4 p-4">
              <div class="flex items-center gap-2">
                <TrendingUp class="size-4 text-muted-foreground" />
                <span class="text-sm font-medium">成功率 {{ stats.successRate }}%</span>
              </div>
              <div class="flex flex-wrap gap-2">
                <Badge variant="default" class="font-normal">成功 {{ stats.successCount }}</Badge>
                <Badge variant="destructive" class="font-normal">失败 {{ stats.failureCount }}</Badge>
              </div>
              <p class="ml-auto text-xs text-muted-foreground">
                金额单位为美元，与密钥额度的「点数」不是同一套计量
              </p>
            </CardContent>
          </Card>

          <!-- 明细表 -->
          <Card>
            <CardHeader class="pb-3">
              <CardTitle class="text-sm">消费记录</CardTitle>
              <CardDescription class="text-xs">
                共 {{ total }} 条，按时间倒序展示
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div v-if="loading" class="space-y-2">
                <Skeleton v-for="i in 6" :key="i" class="h-10 w-full" />
              </div>

              <div
                v-else-if="!records.length"
                class="flex flex-col items-center justify-center gap-2 py-14 text-center"
              >
                <Receipt class="size-8 text-muted-foreground/50" />
                <p class="text-sm text-muted-foreground">暂无消费记录</p>
                <p class="text-xs text-muted-foreground">
                  使用 API Key 调用模型后，记录会异步写入此处
                </p>
              </div>

              <div v-else class="rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>模型</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead class="text-right">Token</TableHead>
                      <TableHead class="text-right">花费</TableHead>
                      <TableHead class="text-right">延迟</TableHead>
                      <TableHead class="text-right">状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow v-for="r in records" :key="r.requestId">
                      <TableCell class="whitespace-nowrap text-xs">
                        {{ formatTime(r.createdAt) }}
                      </TableCell>
                      <TableCell class="text-xs">
                        <div class="font-medium">{{ r.model || '—' }}</div>
                        <div v-if="r.provider" class="text-muted-foreground">{{ r.provider }}</div>
                      </TableCell>
                      <TableCell class="text-xs">{{ r.callType || '—' }}</TableCell>
                      <TableCell class="text-right text-xs">
                        {{ formatTokens(r.totalTokens) }}
                        <span class="block text-muted-foreground">
                          ↑{{ r.promptTokens }} ↓{{ r.completionTokens }}
                        </span>
                      </TableCell>
                      <TableCell class="whitespace-nowrap text-right text-xs">
                        {{ formatSpend(r.spend) }}
                      </TableCell>
                      <TableCell class="text-right text-xs">
                        {{ r.responseTimeMs != null ? `${r.responseTimeMs}ms` : '—' }}
                      </TableCell>
                      <TableCell class="text-right">
                        <Badge :variant="statusVariant(r.apiStatus)" class="font-normal">
                          {{ r.apiStatus ?? '—' }}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>

              <!-- 分页 -->
              <div v-if="records.length" class="mt-4 flex items-center justify-between gap-2">
                <span class="text-xs text-muted-foreground">
                  第 {{ pageNum }} / {{ totalPages }} 页
                </span>
                <div class="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    :disabled="pageNum <= 1 || loading"
                    @click="changePage(-1)"
                  >
                    <ChevronLeft class="size-4" />
                    上一页
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    :disabled="pageNum >= totalPages || loading"
                    @click="changePage(1)"
                  >
                    下一页
                    <ChevronRight class="size-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </LoginGate>
  </div>
</template>
