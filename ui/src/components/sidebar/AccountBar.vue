<script setup lang="ts">
/**
 * 侧栏底部账号条 + 弹出菜单：账号信息、登录 / 退出、用量与密钥入口、
 * 外观切换、检查更新、本地头像。
 *
 * 从 AppSidebar 拆出来：这块连模板带逻辑近三百行，且只跟账号有关，
 * 侧栏本身只需要在跳转时收到一次 navigate（用来收起抽屉）。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import { usePlatformAuth } from '@/composables/usePlatformAuth'
import { checkUpdate } from '@/api/client'
import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CircleUserRound,
  Copy,
  Gauge,
  KeyRound,
  LogIn,
  LogOut,
  Palette,
  RefreshCw,
  Settings,
  Sparkles,
} from 'lucide-vue-next'

const emit = defineEmits<{ (e: 'navigate'): void }>()

/** 环境信息由侧栏传入：品牌行要用同一份，别各请求一次 */
const props = defineProps<{ env: { environment?: string; platform?: string } }>()

const router = useRouter()
const { loggedIn, platformName, token: platformToken, login, logout } = usePlatformAuth()

function go(to: string) {
  menuOpen.value = false
  emit('navigate')
  router.push(to)
}
function goSettings() {
  menuOpen.value = false
  emit('navigate')
  router.push('/client-settings/notifications')
}

// ---------- 弹出菜单 ----------
const menuOpen = ref(false)

const envLabel = computed(() => {
  const e = String(props.env?.environment || '')
  if (e.includes('uat') || e.includes('test')) return '测试环境'
  if (e.includes('prod')) return '生产环境'
  return e || ''
})

async function copyName() {
  try {
    await navigator.clipboard.writeText(platformName.value || '')
    toast.success('已复制账号名')
  } catch {
    /* 剪贴板不可用 */
  }
}

async function doLogin() {
  menuOpen.value = false
  localStorage.setItem('kylinwork.mode', 'online')
  await login()
}

async function doLogout() {
  if (!window.confirm('退出平台账号？本地模式不受影响。')) return
  logout()
  menuOpen.value = false
  toast.success('已退出')
}

async function onCheckUpdate() {
  try {
    const r = (await checkUpdate()) as { message?: string; hasUpdate?: boolean }
    toast.info(r?.message || (r?.hasUpdate ? '有新版本' : '已是最新版本'))
  } catch (e) {
    toast.error('检查更新失败：' + (e as Error).message)
  }
}

/** 菜单里的外观切换：与设置-外观 共用一份存储与 class（kylinwork.appearance / html.dark） */
const menuTheme = ref<'light' | 'dark'>(
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light',
)
function setMenuTheme(t: 'light' | 'dark') {
  menuTheme.value = t
  const root = document.documentElement
  root.classList.toggle('dark', t === 'dark')
  try {
    const saved = JSON.parse(localStorage.getItem('kylinwork.appearance') || '{}')
    localStorage.setItem('kylinwork.appearance', JSON.stringify({ ...saved, theme: t }))
  } catch {
    /* 忽略 */
  }
}

/** 打开网页端个人信息，并把本机登录态带上（需网页端支持 token 参数） */
function openWebProfile() {
  menuOpen.value = false
  const base = String(props.env?.platform || '')
  window.open(`${base}/#/profile?token=${encodeURIComponent(platformToken.value || '')}`, '_blank')
}

// ---------- 头像：默认用 logo；本地模式可上传（只存本机）；登录后暂用通用 logo ----------
const avatar = ref(localStorage.getItem('kylinwork.avatar') || '')
const avatarInput = ref<HTMLInputElement | null>(null)
const avatarSrc = computed(() => (!loggedIn.value && avatar.value ? avatar.value : '/icon.png'))

function onAvatarPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  const img = new Image()
  img.onload = () => {
    // 居中裁方 + 缩到 128，转 JPEG 存 localStorage（本地模式头像只存本机）
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const ctx = c.getContext('2d')
    if (!ctx) return
    const s = Math.min(img.width, img.height)
    ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128)
    const data = c.toDataURL('image/jpeg', 0.85)
    localStorage.setItem('kylinwork.avatar', data)
    avatar.value = data
    toast.success('头像已更新（保存在本机）')
  }
  img.onerror = () => toast.error('图片读取失败')
  img.src = URL.createObjectURL(f)
}

function resetAvatar() {
  localStorage.removeItem('kylinwork.avatar')
  avatar.value = ''
  toast.success('已恢复默认头像')
}
</script>

<template>
  <div class="relative border-t border-border/70 p-2">
    <div v-if="menuOpen" class="fixed inset-0 z-40" @click="menuOpen = false" />

    <!-- 弹出菜单 -->
    <div
      v-if="menuOpen"
      class="absolute bottom-full left-2 right-2 z-50 mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
    >
      <!-- 账号头 -->
      <div class="px-4 pb-3 pt-3.5">
        <div class="flex items-center gap-1.5">
          <img :src="avatarSrc" alt="" class="size-8 shrink-0 rounded-full border border-border bg-background object-cover" />
          <p class="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">
            {{ loggedIn ? platformName || '已登录' : '本地模式' }}
          </p>
          <button
            v-if="loggedIn && platformName"
            class="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            title="复制账号名"
            @click="copyName"
          >
            <Copy class="size-3.5" />
          </button>
        </div>
        <p class="mt-0.5 truncate text-xs text-muted-foreground">
          {{ loggedIn ? `平台账号${envLabel ? ' · ' + envLabel : ''}` : '登录后解锁模型、技能与密钥' }}
        </p>
      </div>

      <div class="border-t border-border/60 px-1.5 py-1.5">
        <button
          v-if="!loggedIn"
          class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[14px] transition-colors hover:bg-accent"
          @click="doLogin"
        >
          <LogIn class="size-4 text-muted-foreground" /> 登录平台
        </button>
        <template v-else>
          <div class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[14px]">
            <Sparkles class="size-4 text-muted-foreground" /> 平台模型
            <Badge variant="secondary" class="ml-auto text-[12px]">已认证</Badge>
          </div>
          <button
            class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[14px] transition-colors hover:bg-accent"
            @click="go('/client-settings/usage')"
          >
            <Gauge class="size-4 text-muted-foreground" /> 用量明细
            <ChevronRight class="ml-auto size-3.5 text-muted-foreground/60" />
          </button>
          <button
            class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[14px] transition-colors hover:bg-accent"
            @click="go('/client-settings/keys')"
          >
            <KeyRound class="size-4 text-muted-foreground" /> 获取密钥
            <ChevronRight class="ml-auto size-3.5 text-muted-foreground/60" />
          </button>
          <button
            class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[14px] transition-colors hover:bg-accent"
            title="打开网页端个人信息页，自动带上本机登录态"
            @click="openWebProfile"
          >
            <CircleUserRound class="size-4 text-muted-foreground" /> 个人信息（网页端）
            <ChevronRight class="ml-auto size-3.5 text-muted-foreground/60" />
          </button>
        </template>
      </div>

      <div class="border-t border-border/60 px-1.5 py-1.5">
        <button
          class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[14px] transition-colors hover:bg-accent"
          @click="goSettings"
        >
          <Settings class="size-4 text-muted-foreground" /> 设置
        </button>
        <div class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[14px]">
          <Palette class="size-4 text-muted-foreground" /> 外观
          <div class="ml-auto flex overflow-hidden rounded-md border border-border text-xs">
            <button
              class="px-2.5 py-1 transition-colors"
              :class="menuTheme === 'light' ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'"
              @click="setMenuTheme('light')"
            >
              浅色
            </button>
            <button
              class="px-2.5 py-1 transition-colors"
              :class="menuTheme === 'dark' ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'"
              @click="setMenuTheme('dark')"
            >
              深色
            </button>
          </div>
        </div>
        <button
          class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[14px] transition-colors hover:bg-accent"
          @click="go('/profile/keys/guide')"
        >
          <CircleHelp class="size-4 text-muted-foreground" /> 帮助与接入
        </button>
        <button
          class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[14px] transition-colors hover:bg-accent"
          @click="onCheckUpdate"
        >
          <RefreshCw class="size-4 text-muted-foreground" /> 检查更新
        </button>
      </div>

      <div v-if="loggedIn" class="border-t border-border/60 px-1.5 py-1.5">
        <button
          class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[14px] text-destructive transition-colors hover:bg-destructive/10"
          @click="doLogout"
        >
          <LogOut class="size-4" /> 退出登录
        </button>
      </div>

      <!-- 头像：本地模式可上传自定义头像（只存本机）；登录后暂用通用 logo -->
      <div v-if="!loggedIn" class="border-t border-border/60 px-1.5 py-1.5">
        <button
          class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[14px] transition-colors hover:bg-accent"
          @click="avatarInput?.click()"
        >
          <Copy class="size-4 text-muted-foreground" /> 更换头像
          <span class="ml-auto text-[12px] text-muted-foreground">保存在本机</span>
        </button>
        <button
          v-if="avatar"
          class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[14px] text-muted-foreground transition-colors hover:bg-accent"
          @click="resetAvatar"
        >
          <RefreshCw class="size-4" /> 恢复默认头像
        </button>
      </div>
    </div>
    <input ref="avatarInput" type="file" accept="image/*" class="hidden" @change="onAvatarPick" />

    <!-- 底部状态条：头像 + 账号名（未登录显示「本地模式」+ 登录按钮）+ 通知/帮助 -->
    <div class="flex items-center gap-0.5">
      <button
        class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
        :title="loggedIn ? '账号菜单' : '本地模式 · 点击登录或设置'"
        @click="menuOpen = !menuOpen"
      >
        <img :src="avatarSrc" alt="" class="size-6 shrink-0 rounded-full border border-border bg-background object-cover" />
        <p class="min-w-0 flex-1 truncate text-xs" :class="loggedIn ? 'text-muted-foreground' : 'font-medium text-foreground/80'">
          {{ loggedIn ? platformName || '已登录' : '本地模式' }}
        </p>
        <ChevronDown class="size-3.5 shrink-0 text-muted-foreground/60" :class="menuOpen ? 'rotate-180' : ''" />
      </button>
      <button
        v-if="!loggedIn"
        class="shrink-0 rounded-md bg-primary/90 px-2 py-1 text-[14px] font-medium text-primary-foreground transition-colors hover:bg-primary"
        title="登录平台，解锁模型、技能与密钥"
        @click="doLogin"
      >
        登录
      </button>
      <button
        class="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="帮助与接入"
        @click="go('/profile/keys/guide')"
      >
        <CircleHelp class="size-4" />
      </button>
    </div>
  </div>
</template>
