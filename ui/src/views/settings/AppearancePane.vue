<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { toast } from 'vue-sonner'

/**
 * 通用外观（对齐 T3 的 Appearance 设置）。
 * 纯本机：主题与密度存 localStorage，改完立刻生效，不经过任何服务端。
 */
const KEY = 'kylinwork.appearance'
const theme = ref<'light' | 'dark' | 'system'>('system')
const density = ref<'comfortable' | 'compact'>('comfortable')

function apply() {
  const root = document.documentElement
  const t =
    theme.value === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme.value
  root.classList.toggle('dark', t === 'dark')
  root.classList.toggle('kylin-compact', density.value === 'compact')
}

function save() {
  localStorage.setItem(KEY, JSON.stringify({ theme: theme.value, density: density.value }))
  apply()
  toast.success('外观已应用')
}

onMounted(() => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}')
    theme.value = s.theme || 'system'
    density.value = s.density || 'comfortable'
  } catch {
    /* 用默认 */
  }
  apply()
})
</script>

<template>
  <div class="space-y-5">
    <div class="space-y-2">
      <Label>主题</Label>
      <div class="grid grid-cols-3 gap-2">
        <button
          v-for="t in [
            { key: 'light', label: '浅色' },
            { key: 'dark', label: '深色' },
            { key: 'system', label: '跟随系统' },
          ]"
          :key="t.key"
          class="rounded-lg border p-3 text-left text-sm transition-colors"
          :class="theme === t.key ? 'border-primary bg-primary/5 font-medium' : 'border-border hover:bg-accent/50'"
          @click="theme = t.key as 'light' | 'dark' | 'system'"
        >
          {{ t.label }}
        </button>
      </div>
    </div>

    <div class="space-y-2">
      <Label>界面密度</Label>
      <div class="grid grid-cols-2 gap-2">
        <button
          v-for="d in [
            { key: 'comfortable', label: '舒适' },
            { key: 'compact', label: '紧凑' },
          ]"
          :key="d.key"
          class="rounded-lg border p-3 text-left text-sm transition-colors"
          :class="density === d.key ? 'border-primary bg-primary/5 font-medium' : 'border-border hover:bg-accent/50'"
          @click="density = d.key as 'comfortable' | 'compact'"
        >
          {{ d.label }}
        </button>
      </div>
    </div>

    <div class="flex justify-end">
      <Button size="sm" @click="save">应用</Button>
    </div>

    <p class="text-[13px] text-muted-foreground">
      外观偏好只保存在本机（localStorage），不随账号同步、不上传。
    </p>
  </div>
</template>
