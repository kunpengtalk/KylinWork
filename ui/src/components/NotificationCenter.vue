<script setup lang="ts">
import { onMounted, ref, type Component } from 'vue'
import { useRouter } from 'vue-router'
import { onClickOutside } from '@vueuse/core'
import { Bell, CheckCheck, CircleCheck, Info, ShieldAlert, Trash2, TriangleAlert } from 'lucide-vue-next'
import { useNotifications } from '@/composables/useNotifications'
import type { AppNotice } from '@/api/engine'

/**
 * 通知中心：右上角的小铃铛 + 下拉面板。
 * <p>
 * 面板里是所有「该让你知道一声」的事——任务完成/出错、等你审批、定时任务跑完。
 * 点一条就回到那条对话（有 session）或对应页面（有 target），并自动标记已读。
 */

const router = useRouter()
const { items, unread, markRead, clear, refresh, start } = useNotifications()

// 轮询只启动一次（单例），多个入口同时挂也不会重复开定时器
onMounted(() => start())

const open = ref(false)
const root = ref<HTMLElement | null>(null)
onClickOutside(root, () => (open.value = false))

async function toggle() {
  open.value = !open.value
  if (open.value) await refresh() // 打开时对齐一次，别让用户看到过期列表
}

const KIND_META: Record<string, { icon: Component; cls: string }> = {
  done: { icon: CircleCheck, cls: 'text-emerald-600 dark:text-emerald-400' },
  error: { icon: TriangleAlert, cls: 'text-destructive' },
  approval: { icon: ShieldAlert, cls: 'text-amber-600 dark:text-amber-400' },
  info: { icon: Info, cls: 'text-muted-foreground' },
}
function kindOf(k: string) {
  return KIND_META[k] || KIND_META.info
}

function timeText(at: number): string {
  const d = Date.now() - (at || 0)
  if (d < 60000) return '刚刚'
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`
  return `${Math.floor(d / 86400000)} 天前`
}

async function openNotice(n: AppNotice) {
  open.value = false
  if (!n.read) void markRead([n.id])
  if (n.session) {
    // 与侧栏点会话同一套：先发事件让 ChatView 自己切，再走路由同步地址栏
    window.dispatchEvent(new CustomEvent('kylinwork:open-session', { detail: { id: n.session } }))
    void router.push({ path: '/', query: { session: n.session } })
  } else if (n.target) {
    void router.push(n.target)
  }
}
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="relative shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      :class="open ? 'bg-accent text-foreground' : ''"
      title="通知"
      @click="toggle"
    >
      <Bell class="size-4" />
      <span
        v-if="unread"
        class="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground"
      >{{ unread > 99 ? '99+' : unread }}</span>
    </button>

    <div
      v-if="open"
      class="absolute right-0 top-full z-50 mt-2 w-[340px] overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
    >
      <div class="flex items-center gap-2 border-b border-border px-3 py-2">
        <p class="flex-1 text-[13px] font-medium">通知</p>
        <button
          v-if="items.length"
          class="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          @click="markRead()"
        >
          <CheckCheck class="size-3.5" /> 全部已读
        </button>
        <button
          v-if="items.length"
          class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="清空"
          @click="clear()"
        >
          <Trash2 class="size-3.5" />
        </button>
      </div>

      <div class="max-h-[380px] overflow-y-auto">
        <button
          v-for="n in items"
          :key="n.id"
          class="flex w-full items-start gap-2.5 border-b border-border/60 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent/60"
          @click="openNotice(n)"
        >
          <component :is="kindOf(n.kind).icon" class="mt-0.5 size-4 shrink-0" :class="kindOf(n.kind).cls" />
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              <span class="min-w-0 flex-1 truncate text-[13px]" :class="n.read ? 'font-normal text-muted-foreground' : 'font-medium'">{{ n.title }}</span>
              <span v-if="!n.read" class="size-1.5 shrink-0 rounded-full bg-primary" />
            </span>
            <span v-if="n.body" class="mt-0.5 block truncate text-[12px] text-muted-foreground">{{ n.body }}</span>
            <span class="mt-0.5 block text-[11px] text-muted-foreground/70">{{ timeText(n.at) }}</span>
          </span>
        </button>

        <p v-if="!items.length" class="px-3 py-10 text-center text-[12px] text-muted-foreground">
          暂无通知。任务完成、等待审批、定时任务跑完都会出现在这里。
        </p>
      </div>
    </div>
  </div>
</template>
