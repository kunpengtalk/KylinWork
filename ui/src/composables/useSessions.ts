/**
 * 会话（任务历史）在 localStorage 里的读写。
 * <p>
 * ChatView 负责写入、侧边栏负责读取，两边以前各自定义了一份 SessionMeta 和 loadSessions，
 * 连 key 都是硬编码的字符串——改一边忘一边就会「历史记录莫名消失」。统一到这里。
 */

export interface SessionMeta {
  id: string
  title: string
  project: string
  updatedAt: number
  createdAt?: number
  /** 最后一轮是以失败收场的：侧栏据此挂红标，翻历史时不用点进去才知道哪条是坏的 */
  lastError?: boolean
}

export const SESSIONS_KEY = 'kylinwork.sessions'
/** 会话列表变化时广播，侧边栏据此刷新（同标签页内 localStorage 不会自动触发 storage 事件） */
export const SESSIONS_CHANGED = 'kylinwork:sessions-changed'

/** 读全部会话。坏数据一律当空表，别让一条脏记录把历史整没了 */
export function readSessions(): SessionMeta[] {
  try {
    const arr = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]')
    return Array.isArray(arr) ? (arr as SessionMeta[]) : []
  } catch {
    return []
  }
}

/** 覆盖写全部会话，并通知侧边栏刷新 */
export function writeSessions(list: SessionMeta[]) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(list))
  window.dispatchEvent(new Event(SESSIONS_CHANGED))
}

/** 删一条会话（读写同一份存储，避免调用方自己解析一遍） */
export function removeSessionById(id: string) {
  writeSessions(readSessions().filter((s) => s.id !== id))
}

export function newSessionId(): string {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
