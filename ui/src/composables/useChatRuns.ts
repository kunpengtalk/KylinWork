/**
 * 每个任务（会话）一份运行态 —— 让「一个任务在跑」不再挡住其他任务。
 * <p>
 * 以前这些状态（messages / running / 中止句柄 / 计时 / 成果 / 报错）全挂在 ChatView 上，
 * 一个 `running` 布尔管住所有会话，于是：新建任务被拦、切到别的历史会话被拦、
 * 连离开页面都会在 onUnmounted 里把流 abort 掉。任务根本没跑在「后台」，只是没人在看。
 *
 * 这里把运行态按 sessionId 存到模块级单例里：**流的归属在 store，不在组件**。
 * 组件只负责渲染「当前正在看的那个会话」，其余会话的事件照样进各自的槽位，
 * 切回去就是现成的（不用重放），切走也不影响它继续跑。
 *
 * 引擎本来就是按会话并发的（activeRuns 是 Map、fileClaims 用 runToken 认领产出），
 * 单任务的限制全在前端，所以这一层只需要把状态摆对位置。
 */
import { reactive, ref } from 'vue'
import { toast } from 'vue-sonner'
import type { Msg } from '@/components/chat/types'
import {
  ChatTransportError,
  answerAsk,
  getSession,
  interjectChat,
  resumeChat,
  runningChats,
  startChat,
  stopChat,
  type EngineEvent,
  type OutputFileLite,
} from '@/api/engine'
import { DEFAULT_PROJECT } from '@/api/engine'
import { notify as systemNotify } from '@/composables/useNotify'
import { useNotifications } from '@/composables/useNotifications'
import { readSessions, writeSessions } from '@/composables/useSessions'

export interface RunGoalCard {
  text?: string
  criteria?: { text: string; done: boolean }[]
  status?: string
  round?: number
}

export interface RunError {
  title: string
  detail?: string
  status?: number
  channel?: string
  model?: string
  /** 失败的那一轮，供「重试」直接重做 */
  msg: Msg | null
}

/** 一个会话的运行态。字段与渲染一一对应，切换会话就是换一份它 */
export interface RunState {
  sessionId: string
  messages: Msg[]
  running: boolean
  /** 运行条上那句话（引擎的 status 事件） */
  statusText: string
  elapsed: number
  /** 多久没有新输出（秒）——页面静止时用来区分「在思考」和「卡死了」 */
  idle: number
  /** 事件计数：视图靠它决定要不要自动滚到底（后台会话不该抢滚动） */
  rev: number
  /** 右侧三个分区：里程碑 / 委派的专家 / 产出目录 */
  changedFiles: string[]
  panelMilestones: { text: string; done: boolean }[]
  panelAgents: { name: string; task: string; done: boolean }[]
  panelFolder: string
  goalCard: RunGoalCard | null
  lastError: RunError | null
  /** 历史是否已回放（一个会话只回放一次，回放后切回来直接看内存里的） */
  hydrated: boolean
  /** 本轮失败/成功时用的渠道与模型，「检测网络」要按同一个目标验 */
  modelRef: { channel?: string; model?: string }
  startedAt: number
  endedAt: number
  /** 当前这一轮助手消息的 id：直播事件都往它上面挂 */
  assistantId: string
  /** 断流续接：已应用的当前轮事件数 + 最后一条 text 事件已显示的字符数 */
  resumeFrom: number
  resumeTextOffset: number
  /** 断开前端订阅的函数。服务端任务不受它影响（引擎侧仍然在跑） */
  abort: (() => void) | null
  /** 刚发出去、还没被引擎确认接收的那句话：万一引擎说「该会话已经在跑」，用它补成插队，别让用户白打一遍 */
  pendingMessage: string
}

/**
 * 当前正在看的会话。
 * <p>
 * 必须放在模块级：离开对话页（去专家广场、设置…）再回来，ChatView 是**重新创建**的，
 * 组件自己的 sessionId 会归零。以前那一下会新建一个空会话，于是「还在跑的任务」当场从屏幕上消失——
 * 用户看到的正是「任务在跑，但页面没动静」。记住它，回来还落回同一个会话。
 */
export const activeSessionId = ref('')

/** 接回后台任务时运行条上的那句说明（收到真实事件后就该让位） */
const RESUME_HINT = '正在接回运行中的任务…'

/** 非响应式的每会话附属物：计时器与「还活着」的判定时刻 */
const timers = new Map<string, { tick: ReturnType<typeof setInterval> | null; lastTickAt: number }>()

/** 会话 id → 运行态。用 reactive Map：侧栏读「谁在跑」也能跟着更新 */
const runs = reactive(new Map<string, RunState>())

const { push: pushNotice, refresh: refreshNotices } = useNotifications()

/**
 * 成果文件列表的订阅口。
 * <p>
 * 工作区是**所有会话共用**的一块地方，所以「产出文件变了」这件事不属于某一个任务：
 * 后台任务产出东西时，前台右侧面板也该跟着长出来。视图订阅一下就够，不用各处轮询。
 */
type FilesListener = (files: OutputFileLite[]) => void
const filesListeners = new Set<FilesListener>()

/** 订阅成果文件变化，返回退订函数 */
export function onWorkspaceFiles(cb: FilesListener): () => void {
  filesListeners.add(cb)
  return () => filesListeners.delete(cb)
}

function blank(sessionId: string): RunState {
  return {
    sessionId,
    messages: [],
    running: false,
    statusText: '',
    elapsed: 0,
    idle: 0,
    rev: 0,
    changedFiles: [],
    panelMilestones: [],
    panelAgents: [],
    panelFolder: '',
    goalCard: null,
    lastError: null,
    hydrated: false,
    modelRef: {},
    startedAt: 0,
    endedAt: 0,
    assistantId: '',
    resumeFrom: 0,
    resumeTextOffset: 0,
    abort: null,
    pendingMessage: '',
  }
}

/** 取（没有就建）某个会话的运行态 */
export function getRun(sessionId: string): RunState {
  let r = runs.get(sessionId)
  if (!r) {
    r = blank(sessionId)
    runs.set(sessionId, r)
  }
  return r
}

export function peekRun(sessionId: string): RunState | undefined {
  return runs.get(sessionId)
}

export function isRunning(sessionId: string): boolean {
  return Boolean(runs.get(sessionId)?.running)
}

/** 正在跑的会话 id（侧栏挂转圈、历史列表标「运行中」都读它） */
export function runningSessions(): string[] {
  return [...runs.values()].filter((r) => r.running).map((r) => r.sessionId)
}

/** 删会话时一并回收：停掉流、清计时器，别留下无主的事件往已删会话里写 */
export function forgetRun(sessionId: string): void {
  const r = runs.get(sessionId)
  if (r?.abort) r.abort()
  stopClock(sessionId)
  timers.delete(sessionId)
  runs.delete(sessionId)
}

// ==================== 计时 ====================

function ensureTimer(sessionId: string) {
  let t = timers.get(sessionId)
  if (!t) {
    t = { tick: null, lastTickAt: Date.now() }
    timers.set(sessionId, t)
  }
  return t
}

function startClock(sessionId: string, reset: boolean) {
  const t = ensureTimer(sessionId)
  const r = getRun(sessionId)
  if (reset) {
    r.elapsed = 0
    r.idle = 0
  }
  t.lastTickAt = Date.now()
  if (t.tick) clearInterval(t.tick)
  t.tick = setInterval(() => {
    const cur = runs.get(sessionId)
    // 后台会话照样走秒：切回去看到的耗时才是真的
    if (!cur || !cur.running) return
    cur.elapsed += 1
    cur.idle = Math.floor((Date.now() - t.lastTickAt) / 1000)
  }, 1000)
}

function stopClock(sessionId: string) {
  const t = timers.get(sessionId)
  if (!t) return
  if (t.tick) clearInterval(t.tick)
  t.tick = null
}

/** 收到任何事件 = 任务还活着，空闲计时归零 */
function markAlive(sessionId: string) {
  const t = timers.get(sessionId)
  if (t) t.lastTickAt = Date.now()
  const r = runs.get(sessionId)
  if (r) r.idle = 0
}

// ==================== 会话元信息（侧栏列表） ====================

/**
 * 更新 localStorage 里的会话条目并广播。
 * <p>
 * 放在 store 而不是视图里：任务可能在用户已经离开对话页（甚至切到别的会话）之后才收尾，
 * 那时视图的回调早就没了——「哪条会话失败了」这个红标不能因此丢失。
 */
export function touchSession(
  sessionId: string,
  patch: { title?: string; project?: string; lastError?: boolean },
): void {
  const list = readSessions()
  const i = list.findIndex((s) => s.id === sessionId)
  const now = Date.now()
  if (i < 0) {
    if (!patch.title) return
    list.unshift({
      id: sessionId,
      title: patch.title.slice(0, 40),
      project: patch.project || DEFAULT_PROJECT,
      updatedAt: now,
      createdAt: now,
      lastError: Boolean(patch.lastError),
    })
  } else {
    const prev = list[i]!
    list[i] = {
      ...prev,
      updatedAt: now,
      ...(patch.lastError === undefined ? {} : { lastError: patch.lastError }),
    }
  }
  writeSessions(list)
}

// ==================== 事件渲染 ====================

function lastAssistant(run: RunState): Msg | undefined {
  return run.messages.find((m) => m.id === run.assistantId)
}

/**
 * 把一个引擎事件应用到某个会话的运行态上。
 * <p>
 * 唯一的渲染入口：直播和历史回放都走这里（回放时 run.replaying 关掉打扰性的提示），
 * 所以后台任务和前台任务用的是完全相同的逻辑，不存在「后台跑出来的显示不一样」。
 */
function applyEvent(run: RunState, ev: EngineEvent, replaying = false): void {
  markAlive(run.sessionId)
  // 「正在接回运行中的任务…」只是接回那一瞬间的说明。真收到内容了就说明已经在跑了，
  // 这句留着会一直挂在运行条上，看起来像还卡在重连。
  if (run.statusText === RESUME_HINT && (ev.type === 'text' || ev.type === 'thinking' || ev.type === 'tool_use')) {
    run.statusText = ''
  }
  const m = lastAssistant(run)
  switch (ev.type) {
    case 'text': {
      if (m) m.text += (ev as { delta?: string }).delta || ''
      break
    }
    case 'step_start':
    case 'status': {
      const t = (ev as { text?: string }).text
      if (t) run.statusText = t
      break
    }
    case 'thinking': {
      // 思考过程单独存，不并进正文：它是对话的"幕后"，界面上默认折叠
      if (m) m.thinking = (m.thinking || '') + ((ev as { delta?: string }).delta || '')
      break
    }
    case 'tool_use': {
      const e = ev as { id: string; name: string; purpose?: string; input_preview?: string; expert?: string }
      m?.tools.push({
        id: e.id,
        name: e.name,
        purpose: e.purpose,
        input: e.input_preview,
        running: true,
        expert: e.expert,
        startedAt: Date.now(),
      })
      break
    }
    case 'tool_result': {
      const e = ev as { id: string; preview?: string; isError?: boolean; diff?: { op: string; text: string }[] }
      const t = m?.tools.find((x) => x.id === e.id)
      if (t) {
        t.result = e.preview
        t.isError = e.isError
        t.diff = e.diff
        t.running = false
        t.endedAt = Date.now()
      }
      break
    }
    case 'expert_start': {
      // 委派的开场挂在对应的那一行工具上，别再往正文里塞引用块——同一件事显示两遍
      const e = ev as { expert?: string; task?: string }
      if (m && e.expert) {
        const t = [...m.tools].reverse().find((x) => x.name === 'delegate_to_expert' || x.name === 'delegate_to_team')
        if (t) t.expert = e.expert
        else m.text += `\n\n> 委派专家：**${e.expert}**\n`
        run.panelAgents = [
          ...run.panelAgents.filter((a) => !(a.name === e.expert && !a.done)),
          { name: e.expert || '', task: String(t?.input || e.task || '').slice(0, 60), done: false },
        ]
      }
      break
    }
    case 'expert_done': {
      const e = ev as { expert?: string }
      const a = run.panelAgents.find((x) => x.name === e.expert && !x.done)
      if (a) a.done = true
      break
    }
    case 'parallel': {
      const n = (ev as { count?: number }).count
      if (n && n > 1) run.statusText = `并发执行 ${n} 个只读工具`
      break
    }
    case 'failover': {
      const e = ev as { note?: string; channel?: string }
      note(run, e.note || (e.channel ? `已切换到备用渠道「${e.channel}」继续` : ''))
      break
    }
    case 'sleep':
    case 'auto_continue': {
      const e = ev as { note?: string }
      note(run, e.note)
      break
    }
    case 'interject': {
      const e = ev as { text?: string }
      note(run, e.text ? `已插话：${e.text}` : '')
      break
    }
    case 'ask_user': {
      const e = ev as { ask_id: string; question: string; options?: { label: string; detail?: string }[] }
      if (m) m.ask = { askId: e.ask_id, question: e.question, options: e.options || [] }
      if (!replaying) {
        void systemNotify('approval', '等待你的审批', e.question || 'AI 有一个问题要问你')
        // 引擎侧不发这一类（ask_user 是前端事件），补记进通知中心，否则铃铛里看不到
        void pushNotice({ kind: 'approval', title: '等待你的审批', body: e.question || '', session: run.sessionId })
      }
      break
    }
    case 'ask_answer': {
      const e = ev as { ask_id: string; answer?: string; timeout?: boolean }
      const msg = run.messages.find((x) => x.ask?.askId === e.ask_id)
      if (msg?.ask) msg.ask.answered = e.timeout ? '（超时未答，已按默认继续）' : e.answer || ''
      break
    }
    case 'files': {
      const e = ev as { files?: OutputFileLite[]; changed?: string[] }
      if (e.changed) run.changedFiles = [...new Set([...run.changedFiles, ...e.changed])]
      // 本轮产出挂到这条消息上：答复底下的文件 chip 就是这么来的
      if (m && e.changed?.length) m.files = [...new Set([...(m.files || []), ...e.changed])]
      // 右侧「工作文件夹」分区：取产出文件共同的顶层目录，没有就显示工作空间
      if (e.changed?.length) {
        const dirs = [...new Set(e.changed.map((n) => (n.includes('/') ? n.split('/')[0] : '')))].filter(Boolean)
        run.panelFolder = dirs.length === 1 ? dirs[0]! : run.panelFolder || 'workspace'
      }
      // 工作区文件清单：直播才广播（回放带的是历史快照，广播出去会让右侧显示一份过期的列表）
      if (e.files && !replaying) for (const cb of filesListeners) cb(e.files)
      break
    }
    case 'milestones': {
      const e = ev as { items?: { text: string; done: boolean }[] }
      if (m && e.items) m.milestones = e.items
      if (e.items?.length) run.panelMilestones = e.items
      break
    }
    case 'sources': {
      const e = ev as { items?: { title?: string; url?: string }[] }
      if (m && e.items?.length) m.sources = e.items
      break
    }
    case 'usage': {
      if (m) m.usage = ev as Record<string, unknown>
      break
    }
    // Goal 目标卡：mode=goal 时的验收清单，后端每次任务直播一次（勾选进度实时）
    case 'goal': {
      const g = (ev as { goal?: RunGoalCard }).goal
      if (g) run.goalCard = g
      break
    }
    case 'error': {
      const e = ev as { message?: string }
      // 结构化记在消息上（渲染成带操作入口的错误块），不再往正文里塞一行 ⚠️ 文本
      if (m) m.error = { title: '任务执行出错', detail: e.message || '未知错误' }
      if (!replaying) {
        run.lastError = {
          title: '当前服务异常，请稍后再试或新建任务、切换模型后重试',
          detail: e.message,
          ...run.modelRef,
          msg: m || null,
        }
        toast.error(e.message || '任务出错')
      }
      break
    }
    case 'limit': {
      const e = ev as { note?: string }
      if (m && e.note) m.text += `\n\n⚠️ ${e.note}`
      break
    }
    case 'done':
      break
  }
  if (m && ev.type === 'done') m.done = true
  run.rev++
}

/** 过程提示（换道、睡眠顺延、自动续跑、插话）并进正文引用块：它们属于"执行过程中发生了什么" */
function note(run: RunState, text?: string) {
  const m = lastAssistant(run)
  if (m && text) m.text += `\n\n> ${text}\n`
}

function handlersFor(sessionId: string) {
  return {
    onEvent: (ev: EngineEvent) => applyEvent(getRun(sessionId), ev),
    onError: (e: Error) => failRun(getRun(sessionId), e),
    onDone: () => doneRun(getRun(sessionId)),
  }
}

function failRun(run: RunState, e: Error) {
  const m = lastAssistant(run)
  // HTTP 失败带得出状态码（ChatTransportError）；网络中断这类只有一句话，那就只显示那句话
  const status = e instanceof ChatTransportError ? e.status : undefined
  // 409 = 引擎那边这个会话还有任务在跑，只是前端这边不知道（页面重建过、应用重启过、
  // 或者接回来的时间窗里用户就按了发送）。这不是"出错"，是「它还在跑，你刚说的那句该塞进去」。
  if (status === 409) {
    const pending = run.pendingMessage
    void adoptRunning(run).then(async () => {
      if (pending) {
        try {
          await interjectChat(run.sessionId, pending)
          toast.info('这个任务其实还在后台跑，已经接回画面；你刚发的内容已作为「插队」注入')
        } catch {
          toast.info('这个任务其实还在后台跑，已经接回画面，可以继续看它的进度')
        }
      } else {
        toast.info('这个任务其实还在后台跑，已经接回画面')
      }
    })
    return
  }
  if (m) {
    m.error = { title: '任务中断', detail: e.message, status }
    m.done = true
  }
  run.lastError = {
    title: '当前服务异常，请稍后再试或新建任务、切换模型后重试',
    detail: e.message,
    status,
    ...run.modelRef,
    msg: m || null,
  }
  void systemNotify('error', '任务出错', e.message.slice(0, 120))
  finishRun(run)
}

/**
 * 接回一个「引擎说有、前端却不知道」的正在跑的任务。
 * <p>
 * 做法是把本地这份乐观状态整个丢掉，改从引擎的 transcript 重新回放（hydrate），
 * 再续上直播（resume）——这样画面上看到的就是引擎里真实的那一轮，
 * 而不是把前端的半截状态和引擎的后半截拼在一起。
 */
async function adoptRunning(run: RunState): Promise<void> {
  if (run.abort) run.abort()
  run.running = false
  run.abort = null
  run.pendingMessage = ''
  stopClock(run.sessionId)
  run.lastError = null
  run.hydrated = false // 丢掉本地回放，让 hydrate 按引擎的记录重建
  run.messages = []
  run.changedFiles = []
  run.rev++
  await hydrateRun(run.sessionId)
  resumeRun(run.sessionId)
}

function doneRun(run: RunState) {
  const m = lastAssistant(run)
  if (m) m.done = true
  void refreshNotices()
  finishRun(run)
}

/** 收尾：无论成功、失败还是被手动停止，都走这里，保证「运行中」这个状态一定被摘掉 */
function finishRun(run: RunState) {
  run.running = false
  run.statusText = ''
  run.pendingMessage = ''
  stopClock(run.sessionId)
  run.abort = null
  run.endedAt = Date.now()
  const m = lastAssistant(run)
  if (m) m.endedAt = Date.now()
  // 失败的会话在侧栏要挂个红标：翻历史时一眼看得出哪条是坏的，不用点进去才知道
  touchSession(run.sessionId, { lastError: Boolean(m?.error) })
  run.rev++
}

// ==================== 起任务 / 续流 / 停止 ====================

export interface StartRunOpts {
  message: string
  mode?: string
  kbIds?: string[]
  expert?: string
  regen?: boolean
  /** 首次出现时写进侧栏的标题与所属工作空间 */
  title?: string
  project?: string
  modelRef?: { channel?: string; model?: string }
}

/**
 * 起一轮任务。返回 ok:false 只可能是**同一个会话**已经在跑——
 * 别的会话在跑不构成理由（引擎按会话并发，文件认领用 runToken 区分）。
 */
export function startRun(sessionId: string, opts: StartRunOpts): { ok: boolean; error?: string } {
  const run = getRun(sessionId)
  if (run.running) return { ok: false, error: '该任务已在运行，可用「插队」补充说明' }

  run.running = true
  run.statusText = ''
  run.lastError = null
  run.startedAt = Date.now()
  run.endedAt = 0
  run.resumeFrom = 0
  run.resumeTextOffset = 0
  run.changedFiles = []
  run.goalCard = null
  run.modelRef = opts.modelRef || {}
  run.hydrated = true // 新一轮的消息本来就在内存里，不需要再回放
  // 记下这句话：万一下一秒引擎回 409（它认为这个会话还在跑），要能把用户打的字补成插队
  run.pendingMessage = opts.message

  const now = Date.now()
  const assistantId = 'a' + now
  run.assistantId = assistantId
  run.messages.push({
    id: assistantId,
    role: 'assistant',
    text: '',
    tools: [],
    done: false,
    turn: run.messages.filter((x) => x.role === 'assistant').length,
    task: opts.message,
    at: now,
    startedAt: now,
  })
  startClock(sessionId, true)
  touchSession(sessionId, { title: opts.title, project: opts.project })

  run.abort = startChat(
    { sessionId, message: opts.message, mode: opts.mode, kb_ids: opts.kbIds, expert: opts.expert, regen: opts.regen },
    handlersFor(sessionId),
  )
  return { ok: true }
}

/** 正在回放的会话（并发调用共享同一次回放，避免消息被写两遍） */
const hydrating = new Map<string, Promise<RunState>>()

/**
 * 回放历史会话（一个会话只做一次）。
 * <p>
 * 事件流完整重放，走的是和直播同一个 applyEvent——所以工具行、产出、来源、用量、
 * 里程碑、提问卡全部复原，历史会话不会退化成光秃秃一段字。
 */
export function hydrateRun(sessionId: string): Promise<RunState> {
  const run = getRun(sessionId)
  if (run.hydrated) return Promise.resolve(run)
  const inflight = hydrating.get(sessionId)
  if (inflight) return inflight
  const p = doHydrate(run).finally(() => hydrating.delete(sessionId))
  hydrating.set(sessionId, p)
  return p
}

async function doHydrate(run: RunState): Promise<RunState> {
  const sessionId = run.sessionId
  // 从空开始回放：失败重试时不会把上一条消息写第二遍
  run.messages = []
  try {
    const s = await getSession(sessionId)
    const hist = ((s as { transcript?: unknown[] }).transcript || s.history || []) as Array<{
      type?: string
      role?: string
      text?: string
      content?: string
      events?: { type?: string; delta?: string }[]
    }>
    let userText = ''
    hist.forEach((h) => {
      const role = h.type || h.role
      if (role === 'user') {
        const text = String(h.text || h.content || '')
        if (text.trim()) {
          userText = text
          run.messages.push({ id: 'u' + run.messages.length, role: 'user', text, tools: [], done: true })
        }
      } else if (role === 'assistant') {
        const m: Msg = {
          id: 'a' + run.messages.length,
          role: 'assistant',
          text: String(h.text || ''),
          tools: [],
          done: false,
          turn: run.messages.filter((x) => x.role === 'assistant').length,
          task: userText,
        }
        run.messages.push(m)
        run.assistantId = m.id
        const events = Array.isArray(h.events) ? h.events : []
        if (events.length) {
          for (const ev of events) applyEvent(run, ev as EngineEvent, true)
        }
        m.done = true
        // 兜底：事件里一个字都没有（老格式或失败轮），把落盘的整段文本顶上来，
        // 不然那轮在界面上就是凭空消失
        if (!m.text.trim() && String(h.text || '').trim()) m.text = String(h.text)
      }
    })
    // 目标卡也一并恢复
    const goal = (s as { goal?: RunGoalCard | null }).goal
    if (goal && goal.text) run.goalCard = goal
    // 会话单独选过模型就交给调用方顶上去（这里只管运行态，选择器是视图的事）
    run.modelRef = {
      channel: (s as { model?: string }).model,
      model: (s as { model_id?: string }).model_id,
    }
    // 最后一轮若还在引擎里跑，续流要从「已经应用过的部分」接着来，否则整段重放一遍
    const last = hist[hist.length - 1]
    const lastEvents = last && (last.type || last.role) === 'assistant' && Array.isArray(last.events) ? last.events : []
    const lastTextIdx = lastEvents.map((e) => e.type).lastIndexOf('text')
    if (lastTextIdx >= 0 && lastTextIdx === lastEvents.length - 1) {
      // 尾部是还在增长的合并文本：从它开始补，只补没显示过的后半段
      run.resumeFrom = lastTextIdx
      run.resumeTextOffset = String(lastEvents[lastTextIdx]?.delta || '').length
    } else {
      run.resumeFrom = lastEvents.length
      run.resumeTextOffset = 0
    }
    // 回放出来的那一轮在界面上是"历史"，别把它当成本轮收集产出的起点
    run.changedFiles = []
    // 只有真读到了才记「已回放」：引擎没起来时失败一次，下次进来还能重试
    run.hydrated = true
    run.rev++
  } catch (e) {
    toast.error('加载历史会话失败：' + (e as Error).message)
  }
  return run
}

/**
 * 续流：接上引擎里仍在跑的任务。
 * 页面刷新、断网重连、应用重启（甚至切回来才发现它还在跑）都走这条。
 */
export function resumeRun(sessionId: string): boolean {
  const run = getRun(sessionId)
  if (run.running) return false
  run.running = true
  run.statusText = RESUME_HINT
  // 复用 transcript 里那条「进行中」的助手消息（引擎在开跑时就已经把它写进 transcript 了），
  // 否则会多出一个空气泡：回放出来的前半段在一个气泡里，续上来的后半段在另一个里。
  const tail = run.messages[run.messages.length - 1]
  if (tail && tail.role === 'assistant') {
    run.assistantId = tail.id
    tail.done = false
  } else {
    const now = Date.now()
    const assistantId = 'a' + now
    run.assistantId = assistantId
    run.messages.push({
      id: assistantId,
      role: 'assistant',
      text: '',
      tools: [],
      done: false,
      at: now,
      startedAt: now,
    })
  }
  startClock(sessionId, false)
  run.abort = resumeChat(sessionId, handlersFor(sessionId), {
    from: run.resumeFrom,
    textOffset: run.resumeTextOffset,
  })
  return true
}

/**
 * 跟引擎对一次账：引擎说还在跑的会话，接上续流；引擎说没有的，把内存里的「运行中」摘掉。
 * <p>
 * 应用被强杀/重启后内存里的 activeRuns 会蒸发，引擎侧那份 running.json 才是真相，
 * 所以每次进入对话页都校准一次。
 */
export async function syncRunsWithEngine(): Promise<void> {
  let live: string[] = []
  try {
    live = await runningChats()
  } catch {
    return
  }
  const liveSet = new Set(live)
  for (const run of [...runs.values()]) {
    if (run.running && !liveSet.has(run.sessionId)) {
      // 引擎那边已经不在跑了（多半是应用重启过），本地这份运行态是僵尸
      const m = lastAssistant(run)
      if (m) m.done = true
      finishRun(run)
    }
  }
  for (const id of live) {
    if (isRunning(id)) continue
    await hydrateRun(id)
    resumeRun(id)
  }
}

/** 主动停止某个任务。只影响这一个会话，别的任务照跑 */
export function stopRun(sessionId: string): void {
  const run = getRun(sessionId)
  if (run.abort) run.abort()
  void stopChat(sessionId).catch(() => {})
  finishRun(run)
}

/** 插队：不等当前任务结束就把补充要求塞进去 */
export async function interjectRun(sessionId: string, message: string): Promise<void> {
  const text = message.trim()
  if (!text) return
  try {
    await interjectChat(sessionId, text)
    toast.success('已插队，下一轮生效')
  } catch (err) {
    toast.error('插队失败：' + (err as Error).message)
  }
}

/** 回答 ask_user 的选项卡片 */
export async function answerAskCard(askId: string, label: string): Promise<void> {
  try {
    await answerAsk(askId, label)
  } catch (e) {
    toast.error('提交回答失败：' + (e as Error).message)
  }
}
