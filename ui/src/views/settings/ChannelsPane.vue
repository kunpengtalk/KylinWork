<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { CheckCircle2, Loader2, MessageCircle, Plug, QrCode, RefreshCw, Unplug } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { toast } from 'vue-sonner'
import { getSettings, saveSettings } from '@/api/client'
import { imStatus, imTest, wechatDisconnect, wechatQrcode, wechatQrcodeStatus } from '@/api/engine'

/**
 * 设置 → 频道：把客户端接入微信 / 飞书 / QQ / 企微 等 IM，
 * 在那些 App 里直接跟本机引擎对话。
 * <p>
 * - 微信（个人号）：扫码即连，引擎走 iLink 长轮询，无需公网
 * - 飞书 / QQ：填应用凭证，长连接（无需公网）
 * - 企微自建应用 / 公众号：微信回调制，需要公网 HTTPS
 * 全部能力来自本机引擎（im.js），这里只是把它暴露成界面。
 */

const st = ref<Record<string, any>>({})
const loading = ref(true)

/** 回调地址展示用端口：跟页面实际被服务的端口走，而不是写死 3800 */
const callbackPort = computed(() => window.location.port || '3800')

async function refresh() {
  try {
    st.value = (await imStatus()) as Record<string, any>
  } catch {
    /* 读不到就显示未连接 */
  }
}

// ---------- 通用状态徽章：各频道 status() 字段不一，防御性读取 ----------
function stateOf(raw: unknown): { on: boolean; text: string } {
  const s = (raw || {}) as Record<string, any>
  // 微信(iLink)/QQ 的 status() 把连接态放在 state 字段（off|connecting|connected|failed）。
  // 之前没认这个字段，扫码明明成功了、后端长轮询都在跑，徽章却永远显示"未连接"。
  if (s.state === 'connected') return { on: true, text: '已连接' }
  if (s.state === 'connecting') return { on: false, text: '连接中…' }
  if (s.state === 'failed') return { on: false, text: s.error ? '连接失败：' + s.error : '连接失败' }
  const on = Boolean(s.connected || s.enabled || s.running || s.ws?.connected || s.ws === 'connected')
  if (on) return { on: true, text: '已连接' }
  if (s.configured === false) return { on: false, text: '未配置' }
  if (Object.keys(s).length === 0) return { on: false, text: '未配置' }
  return { on: false, text: '已配置 · 未连接' }
}

// ---------- 微信扫码 ----------
const qr = ref({ open: false, image: '', qrcode: '' })
const wxStarting = ref(false)
let polling = false
let pollTimer: number | undefined

async function startWechatScan() {
  wxStarting.value = true
  try {
    const r = await wechatQrcode()
    qr.value = { open: true, image: r.image || '', qrcode: r.qrcode || '' }
    void pollStatus()
  } catch (e) {
    toast.error('获取二维码失败：' + (e as Error).message)
  } finally {
    wxStarting.value = false
  }
}

async function pollStatus() {
  if (polling) return
  polling = true
  while (qr.value.open && qr.value.qrcode) {
    try {
      const r = await wechatQrcodeStatus(qr.value.qrcode)
      if (r.status === 'confirmed') {
        toast.success('微信已接入，现在可以在微信里直接对话了')
        qr.value = { open: false, image: '', qrcode: '' }
        await refresh()
        break
      }
      if (r.status === 'expired') {
        toast.info('二维码已过期，请重新扫码')
        qr.value = { open: false, image: '', qrcode: '' }
        break
      }
      // wait / scanning：继续轮（服务端是长轮询，返回即代表该轮结束）
    } catch {
      break
    }
  }
  polling = false
}

function cancelScan() {
  qr.value = { open: false, image: '', qrcode: '' }
}

async function disconnectWechat() {
  if (!window.confirm('断开微信接入？断开后微信里将不再收到回复。')) return
  try {
    await wechatDisconnect()
    toast.success('微信已断开')
    await refresh()
  } catch (e) {
    toast.error('断开失败：' + (e as Error).message)
  }
}

// ---------- 飞书 / QQ / 企微 / 公众号 配置表单 ----------
const feishu = ref({ app_id: '', app_secret: '' })
const qq = ref({ app_id: '', app_secret: '' })
const wecomApp = ref({ corp_id: '', agent_id: '', secret: '', token: '', aes_key: '' })
const wechatMp = ref({ app_id: '', app_secret: '', token: '', aes_key: '' })

async function saveChannel(ch: 'feishu' | 'qq' | 'wecom_app' | 'wechat_mp', payload: Record<string, string>) {
  try {
    await saveSettings({ im: { [ch]: payload } })
    toast.success('配置已保存')
    await refresh()
  } catch (e) {
    toast.error('保存失败：' + (e as Error).message)
  }
}

async function testChannel(ch: 'feishu' | 'qq' | 'wechat', which?: 'wecom' | 'mp') {
  try {
    const r = await imTest(ch, which)
    const label =
      ch === 'feishu' ? '飞书连接成功'
      : ch === 'qq' ? 'QQ 连接成功'
      : which === 'mp' ? '公众号凭证有效'
      : which === 'wecom' ? '企业微信凭证有效'
      : '微信连接正常'
    if (r.ok) toast.success(label)
    else toast.error(r.error || '连接失败')
    await refresh()
  } catch (e) {
    toast.error('测试失败：' + (e as Error).message)
  }
}

onMounted(async () => {
  loading.value = true
  await refresh()
  // 状态轻轮询：扫码成功、长连接建立都发生在后台，不轮的话用户会一直看着"未连接"
  // （页面切到后台时暂停，不白耗引擎）
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void refresh()
  }, 5000)
  // 回填已保存的配置（app_secret 不回显，避免掩盖「已配置」状态）
  try {
    const s = (await getSettings()) as { im?: Record<string, any> }
    const im = s?.im || {}
    if (im.feishu) feishu.value = { ...feishu.value, app_id: String(im.feishu.app_id || '') }
    if (im.qq) qq.value = { ...qq.value, app_id: String(im.qq.app_id || '') }
    if (im.wecom_app) wecomApp.value = { ...wecomApp.value, corp_id: String(im.wecom_app.corp_id || '') }
    if (im.wechat_mp) wechatMp.value = { ...wechatMp.value, app_id: String(im.wechat_mp.app_id || '') }
  } catch {
    /* 忽略 */
  }
  loading.value = false
})

onBeforeUnmount(() => {
  qr.value.open = false // 停掉轮询
  if (pollTimer) window.clearInterval(pollTimer)
})

const wechatState = computed(() => stateOf(st.value.wechat_ilink))
const feishuState = computed(() => {
  const raw = st.value.feishu || {}
  const ws = raw.ws
  const on = Boolean(ws?.connected || ws === true || ws === 'connected')
  if (on) return { on: true, text: '已连接（长连接）' }
  if (raw.configured) return { on: false, text: '已配置 · 未连接' }
  return { on: false, text: '未配置' }
})
const qqState = computed(() => stateOf(st.value.qq))
const wecomState = computed(() => stateOf(st.value.wecom_app))
const mpState = computed(() => stateOf(st.value.wechat_mp))
</script>

<template>
  <div v-if="loading" class="flex justify-center py-8">
    <Loader2 class="size-6 animate-spin text-muted-foreground" />
  </div>

  <div v-else class="space-y-4">
    <!-- ==================== 微信（个人号，扫码接入） ==================== -->
    <div class="rounded-xl border border-border bg-background">
      <div class="flex items-center gap-2 border-b border-border px-5 py-3">
        <MessageCircle class="size-4 text-emerald-600" />
        <p class="flex-1 text-sm font-medium">微信 · 个人号</p>
        <Badge :variant="wechatState.on ? 'default' : 'secondary'" class="text-[12px]">{{ wechatState.text }}</Badge>
      </div>
      <div class="px-5 py-4">
        <p class="text-[13px] leading-relaxed text-muted-foreground">
          手机扫码登录后，在微信里给接入的账号发消息，就能直接跟本机引擎对话——不需要公网地址。
        </p>

        <!-- 扫码中 -->
        <div v-if="qr.open" class="mt-4 flex flex-col items-center gap-3 rounded-lg border border-border bg-muted/30 p-4">
          <img v-if="qr.image" :src="qr.image" alt="微信登录二维码" class="size-48 rounded-lg bg-white p-1" />
          <div v-else class="flex size-48 items-center justify-center rounded-lg bg-white">
            <Loader2 class="size-5 animate-spin text-muted-foreground" />
          </div>
          <p class="text-[13px] text-muted-foreground">用微信扫一扫，登录后自动回到这里</p>
          <Button variant="ghost" size="sm" class="h-7 text-[13px]" @click="cancelScan">取消</Button>
        </div>

        <!-- 操作区 -->
        <div v-else class="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" class="gap-1.5" :disabled="wxStarting" @click="startWechatScan">
            <Loader2 v-if="wxStarting" class="size-3.5 animate-spin" />
            <QrCode v-else class="size-3.5" />
            {{ wechatState.on ? '重新扫码更换账号' : '扫码接入微信' }}
          </Button>
          <Button v-if="wechatState.on" variant="outline" size="sm" class="gap-1.5" @click="disconnectWechat">
            <Unplug class="size-3.5" /> 断开
          </Button>
          <Button variant="ghost" size="sm" class="gap-1.5" @click="testChannel('wechat')">
            <RefreshCw class="size-3.5" /> 连接测试
          </Button>
        </div>
      </div>
    </div>

    <!-- ==================== 飞书 ==================== -->
    <div class="rounded-xl border border-border bg-background">
      <div class="flex items-center gap-2 border-b border-border px-5 py-3">
        <MessageCircle class="size-4 text-sky-600" />
        <p class="flex-1 text-sm font-medium">飞书</p>
        <Badge :variant="feishuState.on ? 'default' : 'secondary'" class="text-[12px]">{{ feishuState.text }}</Badge>
      </div>
      <div class="space-y-3 px-5 py-4">
        <p class="text-[13px] leading-relaxed text-muted-foreground">
          在飞书开放平台创建企业自建应用，拿 App ID / App Secret 填进来；长连接模式，无需公网。
        </p>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label class="text-[13px]">App ID</Label>
            <Input v-model="feishu.app_id" class="h-8" placeholder="cli_xxx" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[13px]">App Secret</Label>
            <Input v-model="feishu.app_secret" type="password" class="h-8" placeholder="已配置则留空保持不变" />
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button size="sm" class="h-8" @click="saveChannel('feishu', { app_id: feishu.app_id, app_secret: feishu.app_secret })">保存</Button>
          <Button variant="outline" size="sm" class="h-8 gap-1.5" @click="testChannel('feishu')">
            <Plug class="size-3.5" /> 测试并连接
          </Button>
        </div>
      </div>
    </div>

    <!-- ==================== QQ ==================== -->
    <div class="rounded-xl border border-border bg-background">
      <div class="flex items-center gap-2 border-b border-border px-5 py-3">
        <MessageCircle class="size-4 text-blue-500" />
        <p class="flex-1 text-sm font-medium">QQ 机器人</p>
        <Badge :variant="qqState.on ? 'default' : 'secondary'" class="text-[12px]">{{ qqState.text }}</Badge>
      </div>
      <div class="space-y-3 px-5 py-4">
        <p class="text-[13px] leading-relaxed text-muted-foreground">填 QQ 机器人（官方开放平台）的 App ID / App Secret，长连接模式。</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label class="text-[13px]">App ID</Label>
            <Input v-model="qq.app_id" class="h-8" placeholder="QQ 机器人 App ID" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[13px]">App Secret</Label>
            <Input v-model="qq.app_secret" type="password" class="h-8" placeholder="已配置则留空保持不变" />
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button size="sm" class="h-8" @click="saveChannel('qq', { app_id: qq.app_id, app_secret: qq.app_secret })">保存</Button>
          <Button variant="outline" size="sm" class="h-8 gap-1.5" @click="testChannel('qq')">
            <Plug class="size-3.5" /> 测试并连接
          </Button>
        </div>
      </div>
    </div>

    <!-- ==================== 企业微信自建应用 ==================== -->
    <div class="rounded-xl border border-border bg-background">
      <div class="flex items-center gap-2 border-b border-border px-5 py-3">
        <MessageCircle class="size-4 text-indigo-500" />
        <p class="flex-1 text-sm font-medium">企业微信 · 自建应用</p>
        <Badge :variant="wecomState.on ? 'default' : 'secondary'" class="text-[12px]">{{ wecomState.text }}</Badge>
      </div>
      <div class="space-y-3 px-5 py-4">
        <p class="text-[13px] leading-relaxed text-muted-foreground">
          回调模式：需要公网 HTTPS。回调地址填
          <code class="rounded bg-muted px-1 font-mono text-[13px]">http://&lt;你的地址&gt;:{{ callbackPort }}/im/wecom/events</code>。
        </p>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label class="text-[13px]">Corp ID</Label>
            <Input v-model="wecomApp.corp_id" class="h-8" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[13px]">Agent ID</Label>
            <Input v-model="wecomApp.agent_id" class="h-8" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[13px]">Secret</Label>
            <Input v-model="wecomApp.secret" type="password" class="h-8" placeholder="已配置则留空保持不变" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[13px]">Token / AES Key</Label>
            <div class="flex gap-2">
              <Input v-model="wecomApp.token" class="h-8" placeholder="Token" />
              <Input v-model="wecomApp.aes_key" class="h-8" placeholder="AES Key" />
            </div>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button size="sm" class="h-8" @click="saveChannel('wecom_app', { ...wecomApp })">保存</Button>
          <Button variant="outline" size="sm" class="h-8 gap-1.5" @click="testChannel('wechat', 'wecom')">
            <Plug class="size-3.5" /> 测试凭证
          </Button>
        </div>
      </div>
    </div>

    <!-- ==================== 微信公众号 ==================== -->
    <div class="rounded-xl border border-border bg-background">
      <div class="flex items-center gap-2 border-b border-border px-5 py-3">
        <MessageCircle class="size-4 text-emerald-500" />
        <p class="flex-1 text-sm font-medium">微信公众号</p>
        <Badge :variant="mpState.on ? 'default' : 'secondary'" class="text-[12px]">{{ mpState.text }}</Badge>
      </div>
      <div class="space-y-3 px-5 py-4">
        <p class="text-[13px] leading-relaxed text-muted-foreground">
          回调模式：需要公网 HTTPS。回调地址填
          <code class="rounded bg-muted px-1 font-mono text-[13px]">http://&lt;你的地址&gt;:{{ callbackPort }}/im/mp/events</code>。
        </p>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label class="text-[13px]">App ID</Label>
            <Input v-model="wechatMp.app_id" class="h-8" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[13px]">App Secret</Label>
            <Input v-model="wechatMp.app_secret" type="password" class="h-8" placeholder="已配置则留空保持不变" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[13px]">Token / AES Key</Label>
            <div class="flex gap-2">
              <Input v-model="wechatMp.token" class="h-8" placeholder="Token" />
              <Input v-model="wechatMp.aes_key" class="h-8" placeholder="AES Key" />
            </div>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button size="sm" class="h-8" @click="saveChannel('wechat_mp', { ...wechatMp })">保存</Button>
          <Button variant="outline" size="sm" class="h-8 gap-1.5" @click="testChannel('wechat', 'mp')">
            <Plug class="size-3.5" /> 测试凭证
          </Button>
        </div>
      </div>
    </div>

    <p class="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <CheckCircle2 class="size-3.5" />
      接入后在这些 App 里发的消息，与本机对话共享同一个引擎：专家、技能、连接器、工作空间全部可用。
    </p>
  </div>
</template>
