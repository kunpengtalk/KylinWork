<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ExternalLink, FolderSearch } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { toast } from 'vue-sonner'
import { openWorkspace, pickFolder, getSettings, saveSettings } from '@/api/client'

/** 设置 → 工作目录 */
const workspaceDir = ref('')
const saving = ref(false)

onMounted(async () => {
  try {
    const s = await getSettings()
    workspaceDir.value = String(s?.workspace_dir || '')
  } catch {
    /* 读不到就先空着 */
  }
})

async function handleOpenWorkspace() {
  try {
    await openWorkspace()
  } catch (e) {
    toast.error('打开失败：' + (e as Error).message)
  }
}

async function handlePickFolder() {
  try {
    const r = await pickFolder()
    const dir = r?.dir || r?.path
    if (!dir) return
    // 选完必须落盘：POST /pick-folder 只弹框不改配置，工作目录是永久的（同步进当前项目）
    saving.value = true
    await saveSettings({ workspace_dir: dir, workspace_permanent: true })
    workspaceDir.value = dir
    toast.success('工作目录已切换')
  } catch (e) {
    toast.error('选择目录失败：' + (e as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-xl border border-border bg-background px-5 py-4">
      <p class="text-sm font-medium">当前目录</p>
      <code class="mt-2 block truncate rounded-md bg-muted/40 px-3 py-2 font-mono text-[13px]">{{ workspaceDir || '（未设置）' }}</code>
    </div>
    <div class="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" class="gap-1.5" @click="handleOpenWorkspace">
        <ExternalLink class="size-3.5" /> 在访达中打开
      </Button>
      <Button variant="outline" size="sm" class="gap-1.5" :disabled="saving" @click="handlePickFolder">
        <FolderSearch class="size-3.5" /> 换一个目录
      </Button>
    </div>
    <p class="text-[13px] text-muted-foreground">
      提示：每个工作空间有自己独立的目录，在侧栏「工作空间」或对话框下方的选择器里切换。
    </p>
  </div>
</template>
