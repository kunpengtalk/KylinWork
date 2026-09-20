import { computed, ref } from 'vue'
import {
  clearNotifications,
  listNotifications,
  markNotificationsRead,
  pushNotification,
  type AppNotice,
} from '@/api/engine'

/**
 * 应用内通知中心（铃铛面板的数据层）。
 * <p>
 * 单例：模块级状态，多个组件共享同一份列表与未读数。
 * 数据源是引擎侧的通知流水（任务完成/出错、等待审批、定时任务跑完都由 notify.desktop 顺手记一笔），
 * 这里只负责轮询取回、标记已读、清空；前端侧事件用 push() 补记同一条流水。
 */

const items = ref<AppNotice[]>([])
const loading = ref(false)
let started = false

async function refresh() {
  try {
    const r = await listNotifications()
    items.value = r.items || []
  } catch {
    /* 引擎没起来就先空着，下一次轮询再试 */
  }
}

/** 补记一条前端侧事件（如 ask_user 弹了选项卡片） */
async function push(body: { kind?: string; title: string; body?: string; session?: string; target?: string }) {
  try {
    const r = await pushNotification(body)
    items.value = r.items || []
  } catch {
    /* 记不上不影响主流程 */
  }
}

async function markRead(ids?: string[]) {
  try {
    const r = await markNotificationsRead(ids)
    items.value = r.items || []
  } catch {
    /* 忽略 */
  }
}

async function clear() {
  try {
    const r = await clearNotifications()
    items.value = r.items || []
  } catch {
    /* 忽略 */
  }
}

/** 轮询 + 窗口重新聚焦时立刻刷新；多处调用只会启动一次 */
function start(intervalMs = 15000) {
  if (started) return
  started = true
  void refresh()
  setInterval(() => void refresh(), intervalMs)
  window.addEventListener('focus', () => void refresh())
}

export function useNotifications() {
  const unread = computed(() => items.value.filter((i) => !i.read).length)
  return { items, unread, loading, refresh, push, markRead, clear, start }
}
