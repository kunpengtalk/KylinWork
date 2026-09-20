<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { toast } from 'vue-sonner'
import { loadNotifyPrefs, notify, saveNotifyPrefs, type NotifyPrefs } from '@/composables/useNotify'
import { getSettings, saveSettings } from '@/api/client'

/**
 * 通知行为（对齐 T3 的 Notifications 设置）。
 * 任务完成 / 等待审批 / 出错 三类独立开关；主窗口被盖住时最容易被漏掉的就是这些。
 *
 * 偏好真源是 config.json 的 notify 键：弹通知的是主进程（引擎），它只读配置文件——
 * 以前只存 localStorage 的话，设置页关了开关、引擎照样弹。localStorage 只做旧值迁移兜底。
 */
const prefs = ref<NotifyPrefs>({ done: true, approval: true, error: true })
const permission = ref<NotificationPermission | 'unsupported'>('default')

onMounted(async () => {
  permission.value = 'Notification' in window ? Notification.permission : 'unsupported'
  try {
    const s = (await getSettings()) as { notify?: Partial<NotifyPrefs> }
    if (s?.notify && typeof s.notify === 'object') {
      prefs.value = { done: true, approval: true, error: true, ...s.notify }
      return
    }
  } catch {
    /* 引擎没起来就按本地缓存 */
  }
  prefs.value = loadNotifyPrefs() // 迁移：老版本只存过 localStorage
})

async function requestPermission() {
  if (!('Notification' in window)) {
    toast.error('当前环境不支持系统通知')
    return
  }
  permission.value = await Notification.requestPermission()
}

async function test() {
  await notify('done', 'KylinWork 通知测试', '如果你看到这条系统通知，说明通知已就绪。')
}

async function update() {
  saveNotifyPrefs(prefs.value) // 本地缓存：测试通知与页面回显用
  try {
    await saveSettings({ notify: { ...prefs.value } })
    toast.success('已保存')
  } catch {
    toast.error('保存失败：引擎未就绪')
  }
}
</script>

<template>
  <div class="space-y-4">
    <div
      v-if="permission === 'denied'"
      class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
    >
      系统通知权限已被拒绝。需要在系统设置里为 KylinWork 重新允许通知。
    </div>

    <div class="space-y-2">
      <div
        v-for="row in [
          { key: 'done', label: '任务完成', desc: '后台任务跑完、成果文件已就绪时提醒' },
          { key: 'approval', label: '等待审批', desc: 'AI 请求执行危险命令、需要你点允许时提醒' },
          { key: 'error', label: '任务出错', desc: '任务以失败收场时提醒' },
        ]"
        :key="row.key"
        class="flex items-center justify-between rounded-md border border-border px-3 py-2.5"
      >
        <div>
          <p class="text-sm font-medium">{{ row.label }}</p>
          <p class="mt-0.5 text-[13px] text-muted-foreground">{{ row.desc }}</p>
        </div>
        <input
          v-model="prefs[row.key as keyof NotifyPrefs]"
          type="checkbox"
          class="size-4 accent-primary"
          @change="update"
        >
      </div>
    </div>

    <div class="flex items-center gap-2">
      <Button v-if="permission !== 'granted'" variant="outline" size="sm" @click="requestPermission">
        授权系统通知
      </Button>
      <Button variant="outline" size="sm" @click="test">发一条测试通知</Button>
    </div>

    <p class="text-[13px] text-muted-foreground">
      通知只在本机弹出，内容不含对话正文；偏好保存在本机。
    </p>
  </div>
</template>
