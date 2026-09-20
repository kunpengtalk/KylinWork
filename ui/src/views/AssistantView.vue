<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowUp, Bot, Loader2, MessageSquare, Radio } from 'lucide-vue-next'
import AppShell from '@/layouts/AppShell.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getSettings } from '@/api/client'
import { imLocalSend, imLog, imProgress, imStatus, modelKey, parseModelKey, type ModelChannel } from '@/api/engine'
import { toast } from 'vue-sonner'

/**
 * 助理：本地 + IM 的全部会话流进同一条历史。
 * 左侧聊天就是本地通道（直接下任务，走本机引擎），
 * 飞书 / 微信里 @机器人 的对话也会出现在这里；重启不丢。
 */

interface LogEntry {
  ts?: string
  channel?: string
  dir?: 'in' | 'out' | 'error' | string
  text?: string
}

const channels = ref<Record<string, Record<string, unknown>>>({})
const log = ref<LogEntry[]>([])
const progress = ref<Record<string, { text?: string; channel?: string }>>({})
/** 模型下拉的选项：把渠道摊平成「渠道 · 模型」逐项可选 */
const modelOptions = ref<{ key: string; label: string }[]>([])
/** 选中的复合键「渠道::模型」（空 = 跟随全局默认） */
const modelName = ref('')
const input = ref('')
const sending = ref(false)
const scrollEl = ref<HTMLElement | null>(null)

// ---------- 频道状态 ----------

const CHANNEL_META: [string, string][] = [
  ['feishu', '飞书'],
  ['qq', 'QQ'],
  ['wechat_ilink', '微信'],
  ['wecom_app', '企业微信'],
  ['wechat_mp', '公众号'],
  ['dingtalk', '钉钉'],
  ['wecom', '企微群推'],
  ['webhook', 'Webhook'],
]

/** 各频道 status 字段不统一，防御性读取连接位。微信(iLink)/QQ 把连接态放在
 *  state 字段（off|connecting|connected|failed）——之前没认它，微信明明连着这里却显示"未连" */
function isOn(raw: unknown): boolean {
  const s = (raw || {}) as Record<string, unknown>
  if (s.state === 'connected') return true
  if (s.connected === true) return true
  if (s.ws && (s.ws as Record<string, unknown>).connected === true) return true
  if (s.ws === 'connected') return true
  if (s.running === true) return true
  return false
}
function isConfigured(raw: unknown): boolean {
  const s = (raw || {}) as Record<string, unknown>
  if (s.configured === true) return true
  if (Object.keys(s).length > 0 && s.configured !== false) return true
  return false
}

const channelState = computed(() =>
  CHANNEL_META.map(([key, label]) => {
    const raw = channels.value[key]
    const on = isOn(raw)
    const configured = isConfigured(raw)
    return { key, label, on, configured }
  }),
)

// ---------- 轮询 ----------

let logTimer = 0
let statusTimer = 0
let progressTimer = 0

async function refreshStatus() {
  try {
    channels.value = (await imStatus()) as Record<string, Record<string, unknown>>
  } catch {
    /* 引擎没起来就不刷 */
  }
}

async function refreshLog() {
  try {
    const data = (await imLog()) as LogEntry[]
    const prevLen = log.value.length
    // 后端 /im/log 返回的是"最新在前"（环形缓冲 reversed 出来的），聊天流要按时间
    // 正序渲染——原样摆上去就是整条消息流倒挂，最新的一直贴着顶，越聊越乱
    log.value = [...data].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
    // 新消息进来（含自己刚发的）就滚到底
    if (data.length > prevLen) scrollToBottom()
  } catch {
    /* 忽略 */
  }
}

async function refreshProgress() {
  try {
    progress.value = (await imProgress()) as Record<string, { text?: string; channel?: string }>
  } catch {
    /* 忽略 */
  }
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    const el = scrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

// ---------- 发送（本地通道） ----------

async function send() {
  const text = input.value.trim()
  if (!text || sending.value) return
  input.value = ''
  sending.value = true
  // 本地通道同步执行：看完进度等回复
  try {
    const picked = modelName.value ? parseModelKey(modelName.value) : null
    await imLocalSend(text, picked?.name || undefined, picked?.modelId || undefined)
    await refreshLog()
    scrollToBottom()
  } catch (e) {
    toast.error('发送失败：' + (e as Error).message)
  } finally {
    sending.value = false
  }
}

function fmtTime(ts?: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function onInputKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}

const runningCount = computed(() => Object.keys(progress.value).length)

onMounted(async () => {
  await Promise.all([refreshStatus(), refreshLog(), refreshProgress()])
  try {
    const s = await getSettings()
    modelOptions.value = ((s.models as ModelChannel[]) || []).flatMap((ch) => {
      const ids = ch.models && ch.models.length ? ch.models : ch.model ? [ch.model] : []
      return ids.map((id) => ({ key: modelKey(ch.name, id), label: `${ch.name} · ${id}` }))
    })
  } catch {
    /* 读不到就不给选择器 */
  }
  logTimer = window.setInterval(refreshLog, 5000)
  statusTimer = window.setInterval(refreshStatus, 15000)
  progressTimer = window.setInterval(refreshProgress, 3000)
  scrollToBottom()
})

onBeforeUnmount(() => {
  window.clearInterval(logTimer)
  window.clearInterval(statusTimer)
  window.clearInterval(progressTimer)
})
</script>

<template>
  <AppShell>
    <template #default>
      <div class="flex h-full min-h-0 flex-col">
        <!-- 头部：标题 + 频道状态 -->
        <header class="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/60 px-4">
          <Bot class="size-5 shrink-0 text-primary" />
          <div class="min-w-0">
            <h1 class="text-sm font-semibold leading-tight">助理</h1>
            <p class="truncate text-[11px] text-muted-foreground">
              本地与 IM 的对话都在这里，重启不丢
            </p>
          </div>
          <div class="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            <Badge
              v-for="c in channelState"
              :key="c.key"
              variant="secondary"
              class="text-[10px] font-normal"
              :class="c.on ? 'text-emerald-700 dark:text-emerald-400' : c.configured ? '' : 'opacity-50'"
            >
              <span class="mr-1 inline-block size-1.5 rounded-full" :class="c.on ? 'bg-emerald-500' : 'bg-muted-foreground/40'" />
              {{ c.label }}{{ c.on ? '' : c.configured ? '·未连' : '' }}
            </Badge>
          </div>
        </header>

        <!-- 会话流 -->
        <div ref="scrollEl" class="min-h-0 flex-1 overflow-y-auto">
          <div v-if="!log.length" class="flex h-full flex-col items-center justify-center gap-2 text-center">
            <MessageSquare class="size-8 text-muted-foreground/40" />
            <p class="text-sm text-muted-foreground">还没有会话。在这里直接下任务，或去 设置 → 频道 接入飞书 / 微信。</p>
          </div>
          <div v-else class="mx-auto w-full max-w-3xl space-y-3 px-4 py-5">
            <div
              v-for="(e, i) in log"
              :key="i"
              class="flex"
              :class="e.dir === 'out' ? 'justify-end' : 'justify-start'"
            >
              <div
                class="max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed"
                :class="
                  e.dir === 'error'
                    ? 'rounded-br-sm bg-red-500/10 text-red-700 dark:text-red-400'
                    : e.dir === 'out'
                      ? 'rounded-br-sm bg-primary px-4 text-primary-foreground'
                      : 'rounded-bl-sm bg-muted px-4'
                "
              >
                <p class="whitespace-pre-wrap break-words">{{ e.text || '(空)' }}</p>
                <p class="mt-1 text-[10px] opacity-60">
                  {{ e.dir === 'in' ? (e.channel === 'local' ? '本机 · 我' : `来自 ${e.channel}`) : e.dir === 'out' ? 'KylinWork' : '出错' }}
                  <span v-if="e.ts"> · {{ fmtTime(e.ts) }}</span>
                </p>
              </div>
            </div>

            <!-- 运行中任务进度 -->
            <div v-if="runningCount" class="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 class="size-3.5 shrink-0 animate-spin" />
              <span class="truncate">{{ Object.values(progress)[0]?.text || '任务进行中…' }}</span>
            </div>
          </div>
        </div>

        <!-- 输入区：模型 + 文本 + 发送（走本地通道） -->
        <div class="shrink-0 border-t border-border bg-background px-4 py-3">
          <div class="mx-auto w-full max-w-3xl">
            <div class="flex items-end gap-2 rounded-2xl border border-border bg-background p-2 shadow-sm">
              <select v-model="modelName" class="h-8 shrink-0 cursor-pointer rounded-md border-0 bg-transparent px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent" title="模型">
                <option value="">默认模型</option>
                <option v-for="m in modelOptions" :key="m.key" :value="m.key">{{ m.label }}</option>
              </select>
              <textarea
                v-model="input"
                rows="1"
                class="min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
                placeholder="给助理的任务（本地通道，立刻执行）…"
                @keydown="onInputKey"
              />
              <Button class="h-9 shrink-0 gap-1 px-3" :disabled="sending || !input.trim()" @click="send">
                <Loader2 v-if="sending" class="size-3.5 animate-spin" />
                <ArrowUp v-else class="size-3.5" />
                发送
              </Button>
            </div>
            <p class="mt-1.5 flex items-center gap-1 px-1 text-[11px] text-muted-foreground/70">
              <Radio class="size-3" />
              任务在本机执行，长时间任务请留在本页等结果
            </p>
          </div>
        </div>
      </div>
    </template>
  </AppShell>
</template>
