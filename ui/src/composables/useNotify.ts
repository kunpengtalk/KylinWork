/**
 * 系统通知（对齐 T3 的 Notification 行为设置）。
 * 三类事件可独立开关：任务完成 / 等待审批 / 出错。
 * 偏好存本机 localStorage；通知走标准 Notification API（Electron 下是系统通知）。
 */
export interface NotifyPrefs {
  done: boolean
  approval: boolean
  error: boolean
}

const KEY = 'kylinwork.notify'

export function loadNotifyPrefs(): NotifyPrefs {
  const base: NotifyPrefs = { done: true, approval: true, error: true }
  try {
    return { ...base, ...(JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<NotifyPrefs>) }
  } catch {
    return base
  }
}

export function saveNotifyPrefs(p: NotifyPrefs) {
  localStorage.setItem(KEY, JSON.stringify(p))
}

/** 发一条系统通知；未授权时顺带请求授权（仅首次） */
export async function notify(kind: keyof NotifyPrefs, title: string, body?: string) {
  const prefs = loadNotifyPrefs()
  if (!prefs[kind]) return
  try {
    if (!('Notification' in window)) return
    if (Notification.permission === 'default') {
      await Notification.requestPermission()
    }
    if (Notification.permission === 'granted') {
      new Notification(title, { body, silent: false })
    }
  } catch {
    /* 通知失败不影响主流程 */
  }
}

/** 组合式出口：页面里 const { notify } = useNotify() */
export function useNotify() {
  return { notify, loadNotifyPrefs, saveNotifyPrefs }
}
