/**
 * 会话（任务历史）在 localStorage 里的读写。
 * <p>
 * ChatView 负责写入、侧边栏负责读取，两边以前各自定义了一份 SessionMeta 和 loadSessions，
 * 连 key 都是硬编码的字符串——改一边忘一边就会「历史记录莫名消失」。统一到这里。
 */

import { listScheduleRuns, type ScheduleRun } from '@/api/client'
import { DEFAULT_PROJECT } from '@/api/engine'

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
  markSessionDeleted(id)
  writeSessions(readSessions().filter((s) => s.id !== id))
}

/**
 * 用户删掉的会话 id（墓碑）。
 * <p>
 * 本地索引只是「目录」，引擎那侧还有一份记录。删了会话却不留痕的话，
 * 定时任务同步（syncScheduleSessions）下一轮就会照着运行记录把它原样捞回来——
 * 用户会看到自己删掉的会话自己长回列表里。id 是唯一的、不会复用，所以墓碑只增不删，
 * 存多了按最近若干条截断。
 */
const DELETED_KEY = 'kylinwork.deleted-sessions'
const DELETED_MAX = 500

function readDeleted(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(DELETED_KEY) || '[]')
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}

function markSessionDeleted(id: string) {
  const list = readDeleted().filter((x) => x !== id)
  list.push(id)
  localStorage.setItem(DELETED_KEY, JSON.stringify(list.slice(-DELETED_MAX)))
}

export function newSessionId(): string {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * 把定时任务的执行合并进本地会话索引。
 * <p>
 * 定时任务是在引擎里跑的，它的会话记录（transcript、产出）都在引擎那侧，本地这份
 * localStorage 索引本来只由 ChatView 写入——于是「立即跑」之后左侧任务列表里什么都看不到。
 * 这里按引擎返回的运行记录把对应会话补进索引：新增的插进去，已存在的对齐标题/工作空间/失败标。
 * <p>
 * 幂等：只有真的多出或改了条目才写盘。每次写盘都会广播 sessions-changed 触发重新读取，
 * 无条件写就成了无限循环。
 * @returns 正在跑的定时会话 id（侧栏据此挂转圈）
 */
export async function syncScheduleSessions(): Promise<string[]> {
  let runs: ScheduleRun[] = []
  try {
    runs = await listScheduleRuns(300)
  } catch {
    return []
  }
  const list = readSessions()
  const byId = new Map(list.map((s) => [s.id, s]))
  const deleted = new Set(readDeleted())
  const running: string[] = []
  let changed = false
  for (const r of runs) {
    const id = String(r.session_id || '')
    if (!id) continue
    // 用户删过的别再捞回来
    if (deleted.has(id)) continue
    // 运行记录只有开始时间（结束时 updated_at 仍是它），按最近活跃排序够用了
    const at = Date.parse(String(r.started_at || '')) || Date.now()
    const title = String(r.name || '').trim() || '定时任务'
    const project = String(r.session_project || '').trim() || DEFAULT_PROJECT
    const lastError = r.ok === false
    if (r.ok === null || r.ok === undefined) running.push(id)
    const prev = byId.get(id)
    if (!prev) {
      byId.set(id, { id, title: title.slice(0, 40), project, updatedAt: at, createdAt: at, lastError })
      changed = true
      continue
    }
    // 已有条目：标题/工作空间/失败标以引擎为准，用户本地改过的 updatedAt 不动
    const next = {
      ...prev,
      title: title.slice(0, 40),
      project,
      lastError,
    }
    if (prev.title !== next.title || prev.project !== next.project || Boolean(prev.lastError) !== lastError) {
      byId.set(id, next)
      changed = true
    }
  }
  if (changed) writeSessions([...byId.values()])
  return running
}
