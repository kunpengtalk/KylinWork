<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { KeyRound, LayoutDashboard, LogIn, LogOut, Puzzle, RefreshCw, Sparkles, User } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'vue-sonner'
import { usePlatformAuth } from '@/composables/usePlatformAuth'
import { getInfo } from '@/api/client'
import { listPlatformModels, listPlatformSkills, type PlatformModel } from '@/api/platform'

/**
 * 云端账号（登录后才有内容的一页）。
 * 全部本地渲染，不跳网页：
 * - 未登录：显示「未登录」状态卡 + 登录按钮
 * - 已登录：账号信息 + 有权限的平台模型 + 云端技能（技能市场）数量
 *   + 获取密钥 / 用量明细 / 我的技能 三个本地页面的入口
 */
const { userName, loggedIn, token: platformToken, login, logout } = usePlatformAuth()

/**
 * 个人信息在网页端。
 * 刻意不把令牌拼进 URL：令牌进了地址栏就会留在浏览器历史与 Referer 里，
 * 平台登录流程本身就是为避免这一点才走一次性 code 交换的，这里不该开口子。
 * 网页端没登录态时自己会引导登录；本机登录态不受影响。
 */
function openWebProfile() {
  void platformToken
  void getInfo().then((info) => {
    const base = String(info?.platform || '')
    window.open(`${base.replace(/\/$/, '')}/#/profile`, '_blank')
  })
}
const router = useRouter()
const loading = ref(false)
const models = ref<PlatformModel[]>([])
const skillCount = ref<number | null>(null)
const err = ref('')

async function loadCloud() {
  if (!loggedIn.value) {
    models.value = []
    skillCount.value = null
    return
  }
  loading.value = true
  err.value = ''
  try {
    models.value = (await listPlatformModels()) || []
  } catch (e) {
    models.value = []
    err.value = (e as Error).message
  }
  try {
    const s = await listPlatformSkills()
    skillCount.value = Array.isArray(s) ? s.length : null
  } catch {
    skillCount.value = null
  }
  loading.value = false
}

// immediate 已覆盖首次加载，别再挂 onMounted（否则进页面就打两遍）
watch(loggedIn, loadCloud, { immediate: true })

async function doLogin() {
  localStorage.setItem('kylinwork.mode', 'online')
  await login()
}

async function doLogout() {
  if (!window.confirm('退出平台账号？本地模式不受影响。')) return
  logout()
  toast.success('已退出')
}

function go(to: string) {
  router.push(to)
}
</script>

<template>
  <div class="space-y-4">
    <!-- 未登录 -->
    <div v-if="!loggedIn" class="rounded-xl border border-dashed border-border p-6 text-center">
      <p class="text-sm font-medium">未登录</p>
      <p class="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        登录后解锁平台模型、云端技能（技能市场）、密钥管理与用量明细。<br>
        本地功能不受影响，随时可以继续离线使用。
      </p>
      <Button size="sm" class="mt-4 gap-1.5" @click="doLogin">
        <LogIn class="size-3.5" /> 登录平台
      </Button>
    </div>

    <!-- 已登录 -->
    <template v-else>
      <div class="flex items-center justify-between rounded-xl border border-border bg-background px-5 py-4">
        <div class="flex items-center gap-3">
          <div class="flex size-9 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
            {{ (userName || '已').charAt(0) }}
          </div>
          <div>
            <p class="text-sm font-medium">{{ userName || '已登录' }}</p>
            <p class="text-[13px] text-muted-foreground">平台账号 · 会话令牌保存在本机</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="icon" title="刷新" @click="loadCloud">
            <RefreshCw class="size-4" />
          </Button>
          <Button variant="outline" size="sm" class="gap-1.5" @click="doLogout">
            <LogOut class="size-3.5" /> 退出
          </Button>
        </div>
      </div>

      <div v-if="loading" class="flex justify-center py-10">
        <Spinner class="size-6 text-muted-foreground" />
      </div>

      <template v-else>
        <div v-if="err" class="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          加载云端能力失败：{{ err }}
        </div>

        <!-- 有权限的模型 -->
        <div class="rounded-xl border border-border bg-background">
          <div class="flex items-center gap-2 border-b border-border px-5 py-3">
            <Sparkles class="size-4 text-muted-foreground" />
            <p class="flex-1 text-sm font-medium">平台模型</p>
            <Badge variant="secondary">{{ models.length }}</Badge>
          </div>
          <p v-if="!models.length" class="px-5 py-6 text-center text-[13px] text-muted-foreground">
            当前账号没有可用模型，或模型列表为空
          </p>
          <ul v-else class="max-h-72 divide-y divide-border overflow-y-auto">
            <li v-for="m in models" :key="String(m.id)" class="flex items-center gap-3 px-5 py-2.5">
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm">{{ m.displayName || m.name }}</p>
                <p v-if="m.description" class="truncate text-[13px] text-muted-foreground">{{ m.description }}</p>
              </div>
              <Badge v-if="m.provider" variant="outline" class="shrink-0 text-[12px]">{{ m.provider }}</Badge>
            </li>
          </ul>
          <p class="border-t border-border px-5 py-2 text-[13px] text-muted-foreground">
            这些模型已随登录同步到模型选择器的「平台模型」分组，输入框旁可直接切换。
          </p>
        </div>

        <!-- 云端技能 / 入口 -->
        <div class="grid gap-2 sm:grid-cols-2">
          <button
            class="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-3.5 text-left transition-colors hover:bg-accent/50"
            @click="go('/experts?tab=skills')"
          >
            <Puzzle class="size-4 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">云端技能（技能市场）</p>
              <p class="text-[13px] text-muted-foreground">
                {{ skillCount == null ? '未加载' : `${skillCount} 个可用，可一键安装到本地` }}
              </p>
            </div>
          </button>

          <button
            class="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-3.5 text-left transition-colors hover:bg-accent/50"
            @click="go('/client-settings/keys')"
          >
            <KeyRound class="size-4 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">获取密钥</p>
              <p class="text-[13px] text-muted-foreground">创建 API Key，接入你自己的工具链</p>
            </div>
          </button>

          <button
            class="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-3.5 text-left transition-colors hover:bg-accent/50"
            @click="go('/client-settings/usage')"
          >
            <LayoutDashboard class="size-4 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">用量明细</p>
              <p class="text-[13px] text-muted-foreground">按模型查看 token 消耗</p>
            </div>
          </button>

          <button
            class="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-3.5 text-left transition-colors hover:bg-accent/50"
            title="打开网页端个人信息页，自动带上本机登录态"
            @click="openWebProfile"
          >
            <User class="size-4 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">个人信息</p>
              <p class="text-[13px] text-muted-foreground">账号资料与部门信息（网页端）</p>
            </div>
          </button>
        </div>
      </template>
    </template>
</div>
</template>
