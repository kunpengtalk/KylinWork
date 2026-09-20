<script setup lang="ts">
import { ArrowRight, Cloud, HardDrive, KeyRound, Users, Zap } from 'lucide-vue-next'
import { usePlatformAuth } from '@/composables/usePlatformAuth'

/**
 * 启动选择页。
 * 两种开始方式：登录云端账号（浏览器完成验证后回调回来）/ 先离线用着。
 * 离线优先——用户装完就想干活，不该先被账号挡住；登录那条路走浏览器。
 */
const { login } = usePlatformAuth()

const MODE_KEY = 'kylinwork.mode'

function goOffline() {
  localStorage.setItem(MODE_KEY, 'offline')
  window.dispatchEvent(new CustomEvent('kylinwork:mode-changed'))
  window.location.hash = '#/'
}

async function goOnline() {
  localStorage.setItem(MODE_KEY, 'online')
  await login()
}

const highlights = [
  { icon: Users, title: '专家与专家团', desc: '按业务域组建专家，配齐技能与连接器' },
  { icon: Zap, title: '任务自动执行', desc: '自主规划、调用工具，交付可验收的成果' },
  { icon: HardDrive, title: '数据本地留存', desc: '客户端形态，配置与成果文件都留在本机' },
]
</script>

<template>
  <div class="flex min-h-screen bg-white">
    <!-- 左侧品牌区：品牌蓝底，白字。右下角压一层深蓝，避免整块死平 -->
    <aside class="relative hidden w-[46%] flex-col justify-between overflow-hidden bg-[#1a56db] p-12 text-white lg:flex">
      <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_0%_0%,rgba(255,255,255,0.20),transparent_58%)]" />
      <div class="pointer-events-none absolute inset-0 bg-[linear-gradient(155deg,transparent_40%,rgba(15,23,42,0.32)_100%)]" />

      <div class="relative flex items-center gap-2.5">
        <img src="/icon.png" alt="KylinWork" class="size-9 rounded-lg bg-white p-1.5 ring-1 ring-white/25" />
        <div>
          <p class="text-[15px] font-semibold leading-tight">KylinWork</p>
          <p class="mt-0.5 text-[11.5px] leading-tight text-white/70">AI 办公工作台</p>
        </div>
      </div>

      <div class="relative">
        <h1 class="text-[32px] font-bold leading-[1.28] tracking-tight">
          把重复、繁琐、跨工具的<br />任务交给 AI
        </h1>
        <p class="mt-4 max-w-sm text-[14.5px] leading-relaxed text-white/80">
          说出需求，专家团队自主规划、调用技能与连接器，交付可验收的成果。
        </p>
        <ul class="mt-10 space-y-4">
          <li v-for="h in highlights" :key="h.title" class="flex items-start gap-3">
            <span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/20">
              <component :is="h.icon" class="size-3.5" />
            </span>
            <div>
              <p class="text-[14px] font-medium">{{ h.title }}</p>
              <p class="mt-0.5 text-[12.5px] leading-relaxed text-white/70">{{ h.desc }}</p>
            </div>
          </li>
        </ul>
      </div>

      <p class="relative flex flex-wrap items-center gap-2 text-[12px] text-white/70">
        <span class="inline-flex items-center gap-1.5"><HardDrive class="size-3.5" /> 数据本地留存</span>
        <span class="text-white/30">·</span>
        <span class="inline-flex items-center gap-1.5"><KeyRound class="size-3.5" /> 自有 Key 管理</span>
      </p>
    </aside>

    <!-- 右侧选择区 -->
    <main class="flex w-full items-center justify-center p-6 lg:w-[54%]">
      <div class="w-full max-w-sm">
        <div class="mb-8 flex items-center gap-2.5 lg:hidden">
          <img src="/icon.png" alt="KylinWork" class="size-9 rounded-lg" />
          <p class="text-[15px] font-semibold">KylinWork</p>
        </div>

        <h2 class="text-[22px] font-bold tracking-tight">开始使用</h2>
        <p class="mt-1.5 text-sm text-[#6b7280]">选一种方式开始，之后随时能切换。</p>

        <!-- 登录云端 -->
        <button
          class="group mt-6 w-full rounded-xl border border-[#e5e7eb] bg-white p-4 text-left transition-colors hover:border-[#111827]"
          @click="goOnline"
        >
          <div class="flex items-center gap-3">
            <Cloud class="size-5 shrink-0 text-[#1a56db]" />
            <div class="min-w-0 flex-1">
              <p class="flex items-center gap-1.5 text-[14px] font-semibold">
                登录云端账号
                <ArrowRight class="size-3.5 text-[#6b7280] transition-transform group-hover:translate-x-0.5" />
              </p>
              <p class="mt-0.5 text-xs leading-relaxed text-[#6b7280]">
                浏览器完成验证后自动回来，解锁云端技能市场、模型与密钥。
              </p>
            </div>
          </div>
        </button>

        <!-- 离线使用 -->
        <button
          class="group mt-3 w-full rounded-xl border border-[#e5e7eb] bg-white p-4 text-left transition-colors hover:border-[#111827]"
          @click="goOffline"
        >
          <div class="flex items-center gap-3">
            <HardDrive class="size-5 shrink-0 text-[#6b7280]" />
            <div class="min-w-0 flex-1">
              <p class="flex items-center gap-1.5 text-[14px] font-semibold">
                先不登录，离线使用
                <ArrowRight class="size-3.5 text-[#6b7280] transition-transform group-hover:translate-x-0.5" />
              </p>
              <p class="mt-0.5 text-xs leading-relaxed text-[#6b7280]">
                本地引擎全功能可用，配好模型就能开工。
              </p>
            </div>
          </div>
        </button>

        <p class="mt-5 text-xs leading-relaxed text-[#9ca3af]">
          两种模式的区别只在云端技能市场、模型广场与密钥这些云端能力；本地的一切不受影响。进入后可在左下角随时切换。
        </p>
      </div>
    </main>
  </div>
</template>
