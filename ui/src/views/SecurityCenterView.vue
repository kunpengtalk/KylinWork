<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ShieldCheck, ScrollText, Ban } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'vue-sonner'
import {
  listApprovals,
  listAudit,
  listSecurityModes,
  resolveApproval,
  setSecurityMode,
  type Approval,
} from '@/api/client'

/**
 * 安全中心：审批闸门 / 审计日志 / 权限档位。
 * agent 手里有 shell，所以这些必须是真的拦——每条危险命令都会在这等你点。
 */
const approvals = ref<Approval[]>([])
const audit = ref<Record<string, unknown>[]>([])
const modes = ref<{ name?: string; label?: string; description?: string }[]>([])
const current = ref('')
const loading = ref(true)

onMounted(async () => {
  await load()
  loading.value = false
})

async function load() {
  // 注意：/security/approvals 返回的是 { items, mode, session_allow }，不是数组——
  // 以前当数组用，待审批永远渲染不出来，危险命令卡在后台没人能放行
  try {
    const r = await listApprovals()
    approvals.value = r?.items || []
  } catch { approvals.value = [] }
  try { audit.value = (await listAudit(100)) as Record<string, unknown>[] } catch { audit.value = [] }
  try {
    const m = await listSecurityModes()
    const data = m as { modes?: unknown; current?: string }
    modes.value = normalizeModes(data?.modes)
    current.value = data?.current || ''
  } catch { modes.value = [] }
}

/** 权限档位：新后端给数组，老后端给 {plan:{label,desc}} 对象——两种都认，别让页面空白 */
function normalizeModes(raw: unknown): { name?: string; label?: string; description?: string }[] {
  if (Array.isArray(raw)) return raw as { name?: string; label?: string; description?: string }[]
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, { label?: string; desc?: string; description?: string }>).map(([name, v]) => ({
      name,
      label: v?.label,
      description: v?.description || v?.desc,
    }))
  }
  return []
}

async function decide(id: string, action: 'allow' | 'deny') {
  try {
    await resolveApproval(id, action)
    toast.success(action === 'allow' ? '已允许' : '已拒绝')
    await load()
  } catch (e) {
    toast.error('操作失败：' + (e as Error).message)
  }
}

async function setMode(name: string) {
  try {
    await setSecurityMode(name)
    current.value = name
    toast.success('权限档位已切换')
  } catch (e) {
    toast.error('切换失败：' + (e as Error).message)
  }
}

function fmtTime(v: unknown): string {
  if (!v) return '—'
  const d = new Date(String(v))
  if (Number.isNaN(d.getTime())) return String(v)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="settings-pane mx-auto w-full max-w-4xl space-y-6 px-10 py-8">
      <div>
        <h1 class="flex items-center gap-2.5 text-[22px] font-semibold tracking-tight">
          <ShieldCheck class="size-6" /> 安全中心
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          命令审批闸门、审计日志、权限档位——都是真拦，不是摆着看的开关。
        </p>
      </div>

      <div v-if="loading" class="flex justify-center py-16">
        <Spinner class="size-6 text-muted-foreground" />
      </div>

      <template v-else>
        <!-- 待审批 -->
        <Card>
          <CardHeader>
            <CardTitle class="text-base">待审批</CardTitle>
            <CardDescription>agent 请求执行的危险动作会卡在这里，等你点头。</CardDescription>
          </CardHeader>
          <CardContent>
            <div v-if="!approvals.length" class="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
              没有待审批的动作
            </div>
            <ul v-else class="space-y-2">
              <li v-for="a in approvals" :key="String(a.id)" class="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <p class="text-sm font-medium">
                  {{ (a as Record<string, any>).kind || '危险动作' }}
                  <Badge v-if="(a as Record<string, any>).source" variant="secondary" class="ml-1 text-[12px]">
                    {{ (a as Record<string, any>).source }}
                  </Badge>
                </p>
                <pre class="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[13px]">{{ (a as Record<string, any>).text || (a as Record<string, any>).detail || '' }}</pre>
                <div class="mt-2 flex gap-2">
                  <Button size="sm" @click="decide(String(a.id), 'allow')">允许</Button>
                  <Button size="sm" variant="outline" @click="decide(String(a.id), 'deny')">拒绝</Button>
                </div>
              </li>
            </ul>
          </CardContent>
        </Card>

        <!-- 权限档位 -->
        <Card>
          <CardHeader>
            <CardTitle class="text-base">权限档位</CardTitle>
          </CardHeader>
          <CardContent class="space-y-2">
            <div
              v-for="m in modes"
              :key="String(m.name)"
              class="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5"
            >
              <div>
                <p class="flex items-center gap-2 text-sm font-medium">
                  {{ m.label || m.name }}
                  <Badge v-if="current === m.name" variant="secondary">当前</Badge>
                </p>
                <p class="mt-0.5 text-[13px] text-muted-foreground">{{ m.description }}</p>
              </div>
              <Button variant="outline" size="sm" :disabled="current === m.name" @click="setMode(String(m.name))">
                {{ current === m.name ? '使用中' : '切换' }}
              </Button>
            </div>
          </CardContent>
        </Card>

        <!-- 审计日志 -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2 text-base">
              <ScrollText class="size-4" /> 审计日志
            </CardTitle>
            <CardDescription>每一次敏感操作都有据可查（近 100 条）。</CardDescription>
          </CardHeader>
          <CardContent>
            <div v-if="!audit.length" class="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
              暂无审计记录
            </div>
            <ul v-else class="divide-y divide-border rounded-lg border border-border">
              <li v-for="(a, i) in audit" :key="i" class="flex items-center gap-3 px-4 py-2 text-[13px]">
                <Badge :variant="(a as Record<string, any>).action === '拒绝' ? 'destructive' : 'secondary'" class="shrink-0 text-[12px]">
                  {{ (a as Record<string, any>).type || '操作' }}
                </Badge>
                <span class="shrink-0 text-muted-foreground/80">{{ (a as Record<string, any>).action || '' }}</span>
                <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ (a as Record<string, any>).text || '' }}</span>
                <span class="shrink-0 text-muted-foreground/70">{{ fmtTime((a as Record<string, any>).ts) }}</span>
              </li>
            </ul>
          </CardContent>
        </Card>

        <p class="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Ban class="size-3" />
          文件黑名单、URL 白名单在本地 config.json 的 security 段配置
        </p>
      </template>
    </div>
  </div>
</template>
