<script setup lang="ts">
import { Lock } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { usePlatformAuth } from '@/composables/usePlatformAuth'

/**
 * 平台页面登录闸门：未登录时不渲染子页面，给一张「需要登录」引导卡。
 * 登录态翻转时子页面重新挂载、自动拉数据——不会出现「登录了还停在登录前的空态」。
 * 离线也能完整用本地引擎，这里的闸门只挡平台能力（应用 / 模型 / 密钥 / 用量 / 会议…）。
 */
const { loggedIn, login } = usePlatformAuth()
</script>

<template>
  <div v-if="loggedIn" class="h-full min-h-0">
    <slot />
  </div>
  <div v-else class="flex h-full items-center justify-center p-8">
    <div class="w-full max-w-sm text-center">
      <div class="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted">
        <Lock class="size-5 text-muted-foreground" />
      </div>
      <p class="mt-4 text-base font-semibold">这里需要登录平台</p>
      <p class="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        应用、模型广场、密钥与用量由平台按账号下发；登录后在浏览器里完成验证会自动回到这里。
        本地引擎（对话、工具、技能、定时任务、成果文件）不受影响。
      </p>
      <Button class="mt-5 gap-1.5" @click="login">
        登录平台
      </Button>
    </div>
  </div>
</template>
