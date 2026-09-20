<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { Toaster } from '@/components/ui/sonner'
import { installAuthCallback } from '@/composables/usePlatformAuth'

/**
 * 登录回调挂载点。
 * 平台登录页在浏览器里完成登录后跳 kylinwork://auth，系统唤起本 App，
 * Electron 主进程把令牌塞进页面并派发事件，这里接住。
 */
let uninstall: (() => void) | null = null
onMounted(() => {
  uninstall = installAuthCallback()
})
onUnmounted(() => {
  uninstall?.()
})
</script>

<template>
  <RouterView />
  <Toaster position="top-center" rich-colors />
</template>
