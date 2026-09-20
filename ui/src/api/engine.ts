import { httpEngine } from './request'

/**
 * KylinWork 本地引擎的对话与工作台接口。
 * <p>
 * 这是「客户端」和「网页版」的分界线：对话跑在本机的 agent.js 上，
 * 工具真在本机执行（run_node 出 PPT/Word/Excel、run_shell 调本机命令），
 * 产物落在本地工作目录。平台那套只负责登录，不参与执行。
 *
 * 事件是 SSE：每行 `data: {json}\n\n`，以 {type:"done"} 收尾。
 */

// ==================== 事件类型 ====================

export type EngineEvent =
  | { type: 'text'; delta: string; depth?: number }
  | { type: 'tool_use'; id: string; name: string; depth?: number; purpose?: string; input_preview?: string }
  | { type: 'tool_result'; id: string; name: string; depth?: number; isError?: boolean; preview?: string }
  | { type: 'files'; files?: OutputFileLite[]; changed?: string[] }
  | { type: 'dir'; dir?: string }
  | { type: 'goal'; goal?: string }
  | { type: 'expert_start'; expert?: string; team?: string; task?: string }
  | { type: 'expert_done'; expert?: string; team?: string }
  | { type: 'team_start'; team?: string; members?: string[]; task?: string }
  | { type: 'team_done'; team?: string }
  | { type: 'usage'; model?: string; provider?: string; prompt?: number; completion?: number; cached?: number; calls?: number; elapsed_ms?: number }
  | { type: 'ask_user'; ask_id: string; question: string; options?: AskOption[]; timeout_ms?: number; depth?: number }
  | { type: 'ask_answer'; ask_id: string; answer?: string; timeout?: boolean; depth?: number }
  | { type: 'limit'; note?: string }
  | { type: 'auto_continue'; round?: number; total?: number; note?: string }
  | { type: 'failover'; note?: string; channel?: string }
  | { type: 'sleep'; ms?: number; note?: string }
  | { type: 'trim'; chars?: number }
  | { type: 'compact'; removed?: number }
  | { type: 'status'; text?: string }
  | { type: 'step_start'; step?: number }
  | { type: 'milestones'; file?: string; items?: { text: string; done: boolean }[] }
  | { type: 'sources'; items?: { title?: string; url?: string }[] }
  | { type: 'parallel'; count?: number }
  | { type: 'interject'; text?: string }
  | { type: 'credits'; spent?: number; left?: number }
  | { type: 'error'; message?: string }
  | { type: 'done' }
  | { type: string; [k: string]: unknown }

export interface OutputFileLite {
  name: string
  size: number
  mtime: string
}

export interface AskOption {
  label: string
  detail?: string
}

export interface ChatHandlers {
  onEvent: (ev: EngineEvent) => void
  onError?: (e: Error) => void
  onDone?: () => void
}

/**
 * 传输层错误：把 HTTP 状态码带出来。
 * 报错横幅要把"人话说明"和"502 这个事实"分两行摆（对齐参考版的 `502 | Trace ID` 那行），
 * 混成一句话之后界面上就只剩一段字符串，没法结构化展示。
 */
export class ChatTransportError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ChatTransportError'
    this.status = status
  }
}

/**
 * 主动验活当前模型渠道（报错横幅的「检测网络」）。
 * 服务端只发一条最小请求，**不改配置**——区别于下面那个走 /onboarding 的 probeModel：
 * 那个会写入并切换当前模型，探索性地"测一下网络"不该顺手改掉用户选好的模型。
 */
export function probeActiveModel(opts: { model?: string; model_id?: string } = {}) {
  return httpEngine
    .post('/model/probe', opts)
    .then((r) => r.data as { ok: boolean; error?: string; channel?: string; model?: string })
}

// ==================== 对话 ====================

/**
 * 发起一次任务（SSE 流式）。
 * @returns 中断函数——只是断开前端订阅，服务端任务照跑（刷新页面也不丢）
 */
export function startChat(
  body: { sessionId: string; message: string; mode?: string; regen?: boolean; kb_ids?: string[]; expert?: string },
  handlers: ChatHandlers,
): () => void {
  const controller = new AbortController()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  const run = async () => {
    try {
      const resp = await fetch('/engine-api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!resp.ok || !resp.body) {
        let detail = ''
        if (resp.body) {
          try {
            const t = await resp.text()
            const p = JSON.parse(t) as { error?: string; message?: string }
            detail = p.error || p.message || t
          } catch {
            detail = ''
          }
        }
        throw new ChatTransportError(
          `请求失败（HTTP ${resp.status}）${detail ? `：${detail.slice(0, 200)}` : ''}`,
          resp.status,
        )
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      let done = false

      while (!done) {
        const { value, done: fin } = await reader.read()
        if (fin) break
        buffer += decoder.decode(value, { stream: true })

        // SSE 以空行分帧；末尾不完整的那截留着等下一个分片
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const ev = parseFrame(frame)
          if (ev) {
            if (ev.type === 'done') done = true
            else handlers.onEvent(ev)
          }
        }
      }
      // 有些情况下最后一帧没有结尾空行
      if (buffer.trim()) {
        const ev = parseFrame(buffer)
        if (ev && ev.type !== 'done') handlers.onEvent(ev)
      }
      handlers.onDone?.()
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  void run()
  return () => controller.abort()
}

/**
 * 续流：页面刷新后重新接上仍在跑的任务。
 * 与主连接走同一套事件，所以渲染逻辑完全一样。
 *
 * @param from       已经应用过的事件数（服务端从这个序号开始补，不再整段重放）
 * @param textOffset 尾部那条还在增长的合并文本已经显示过的字符数
 */
export function resumeChat(
  sessionId: string,
  handlers: ChatHandlers,
  opts: { from?: number; textOffset?: number } = {},
): () => void {
  const controller = new AbortController()
  const qs = new URLSearchParams()
  if (opts.from) qs.set('from', String(opts.from))
  if (opts.textOffset) qs.set('textOffset', String(opts.textOffset))
  const suffix = qs.toString() ? `?${qs}` : ''
  const run = async () => {
    try {
      const resp = await fetch(`/engine-api/chat/stream/${encodeURIComponent(sessionId)}${suffix}`, {
        signal: controller.signal,
      })
      if (!resp.ok || !resp.body) throw new Error(`续流失败（HTTP ${resp.status}）`)
      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const ev = parseFrame(frame)
          if (ev && ev.type !== 'done') handlers.onEvent(ev)
        }
      }
      handlers.onDone?.()
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }
  void run()
  return () => controller.abort()
}

function parseFrame(frame: string): EngineEvent | null {
  let raw = ''
  for (const line of frame.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith(':')) continue
    if (t.startsWith('data:')) raw += t.slice(5).trimStart()
  }
  if (!raw) return null
  try {
    return JSON.parse(raw) as EngineEvent
  } catch {
    return null
  }
}

/** 停止任务 */
export function stopChat(sessionId: string) {
  return httpEngine.post('/chat/stop', { sessionId }).then((r) => r.data)
}

/** 插队：不等当前任务结束就把补充要求塞进去 */
export function interjectChat(sessionId: string, message: string) {
  return httpEngine.post('/chat/interject', { sessionId, message }).then((r) => r.data)
}

/** 回答 ask_user 的选项卡片 */
export function answerAsk(askId: string, answer: string) {
  return httpEngine.post('/chat/answer', { askId, answer }).then((r) => r.data)
}

/**
 * 正在跑的任务列表（用于刷新/重启后找回后台任务）。
 * 服务端回的是 `{ sessions: [...] }`；早期版本直接回一个裸数组，这里一并兼容，
 * 免得换个引擎版本就「后台任务全都找不回来」。
 */
export function runningChats(): Promise<string[]> {
  return httpEngine
    .get<{ sessions?: string[] } | string[]>('/chat/running')
    .then((r) => (Array.isArray(r.data) ? r.data : r.data?.sessions || []))
}

// ==================== 会话 ====================

export interface Session {
  id: string
  title?: string
  project?: string
  history?: unknown[]
  createdAt?: string
  updatedAt?: string
  [k: string]: unknown
}

export function getSession(id: string) {
  return httpEngine.get<Session>(`/session/${encodeURIComponent(id)}`).then((r) => r.data)
}

// ==================== 频道（微信 / 飞书 / QQ / 企微 … IM 接入） ====================

/** 全频道状态总览 */
export function imStatus() {
  return httpEngine.get('/im/status').then((r) => r.data)
}

/** 微信扫码第一步：取二维码（image 是可直接展示的 dataURL） */
export function wechatQrcode() {
  return httpEngine.post<{ ok: boolean; qrcode: string; image: string; deep_link: string }>(
    '/im/wechat/qrcode',
  ).then((r) => r.data)
}

/** 微信扫码第二步：轮询扫码状态（服务端长轮询最长约 35s，前端 timeout 放宽） */
export function wechatQrcodeStatus(qrcode: string) {
  return httpEngine.get<{ ok: boolean; status: string; ilink?: unknown }>('/im/wechat/qrcode-status', {
    params: { qrcode },
    timeout: 60000,
  }).then((r) => r.data)
}

/** 断开微信（个人号） */
export function wechatDisconnect() {
  return httpEngine.post('/im/wechat/disconnect').then((r) => r.data)
}

/** 频道连通性测试：feishu / qq / wechat（wechat 用 which 区分企业微信自建应用与公众号） */
export function imTest(channel: 'feishu' | 'qq' | 'wechat', which?: 'wecom' | 'mp') {
  return httpEngine.post<{ ok: boolean; error?: string }>(`/im/${channel}/test`, which ? { which } : {}).then((r) => r.data)
}

/** IM 会话日志：最近 100 条（新在前），助理页轮询用 */
export function imLog() {
  return httpEngine.get('/im/log').then((r) => r.data)
}

/** 正在执行的任务进度（按会话 key），助理页轮询用 */
export function imProgress() {
  return httpEngine.get('/im/progress').then((r) => r.data)
}

/** 本地通道发消息：直接在助理里下任务，走本机引擎 */
export function imLocalSend(message: string, model?: string, modelId?: string) {
  return httpEngine.post<{ reply: string }>('/im/local', { message, model: model || undefined, model_id: modelId || undefined }).then((r) => r.data)
}

export function deleteSession(id: string) {
  return httpEngine.delete(`/session/${encodeURIComponent(id)}`).then((r) => r.data)
}

export function setSessionModel(id: string, model: string, modelId?: string) {
  return httpEngine.post(`/session/${encodeURIComponent(id)}/model`, { model, model_id: modelId || '' }).then((r) => r.data)
}

// ==================== 项目 ====================

export interface Project {
  name: string
  description?: string
  instructions?: string
  dir?: string
  [k: string]: unknown
}

/** 引擎没配项目时兜底的那个项目名（引擎 index.js 建默认项目用的也是它） */
export const DEFAULT_PROJECT = '默认项目'

/** 工作空间列表：引擎返回 {projects, active}，这里只取数组，别把整个响应对象当列表用 */
export async function listProjects(): Promise<Project[]> {
  const r = await httpEngine.get<{ projects?: Project[]; active?: string } | Project[]>('/projects')
  const d = r.data
  return Array.isArray(d) ? d : d?.projects || []
}

export function createProject(data: Partial<Project>) {
  return httpEngine.post('/projects', data).then((r) => r.data)
}

export function switchProject(name: string) {
  return httpEngine.post('/projects/switch', { name }).then((r) => r.data)
}

export function deleteProject(name: string, purge = false) {
  return httpEngine
    .delete(`/projects/${encodeURIComponent(name)}${purge ? '?purge=1' : ''}`)
    .then((r) => r.data)
}

// ==================== 引擎资源：技能 / MCP / 专家 ====================

export function listEngineSkills() {
  return httpEngine.get<unknown[]>('/skills').then((r) => r.data)
}

export function listEngineMcp() {
  return httpEngine.get<unknown>('/mcp').then((r) => r.data)
}

export function listEngineExperts() {
  return httpEngine.get<unknown[]>('/experts').then((r) => r.data)
}

export function listExpertTeams() {
  return httpEngine.get<unknown[]>('/expert-teams').then((r) => r.data)
}

// ==================== 模型渠道 ====================

export interface ModelChannel {
  name: string
  provider: 'openai' | 'anthropic'
  base_url?: string
  api_key?: string
  /** 渠道用途：对话 / 向量(embedding) / 重排(rerank)。缺省=chat；向量/重排渠道只出现在知识库设置里 */
  kind?: 'chat' | 'embedding' | 'rerank'
  /** 渠道默认模型（models[] 里的第一个，缺省时也是它） */
  model: string
  /** 同渠道下可选的模型 id 列表——一个服务商挂多个模型，选中哪个由 active_model_id 决定 */
  models?: string[]
  /** 高级参数：随渠道一起存 config.json，热生效 */
  thinking?: string
  temperature?: number
  max_tokens?: number
}

/** 选中项的复合键：渠道 + 模型 id。下拉的 value 和健康账本都按它走 */
export function modelKey(name: string, modelId?: string): string {
  const n = String(name || '').trim()
  const id = String(modelId || '').trim()
  if (!n) return id
  return id ? `${n}::${id}` : n
}

/** 复合键 → { name, modelId }（后端传回来的旧值可能是纯渠道名） */
export function parseModelKey(key: string): { name: string; modelId: string } {
  const s = String(key || '')
  const i = s.indexOf('::')
  if (i < 0) return { name: s, modelId: '' }
  return { name: s.slice(0, i), modelId: s.slice(i + 2) }
}

/** 单个模型的健康账本：近 n 次成功 ok 次，连挂 fail_streak 次 */
export interface ModelHealth {
  n?: number
  ok?: number
  fail_streak?: number
}
/** 引擎 /api/state 下发的健康账本，键是复合键（见 modelKey） */
export type ModelHealthMap = Record<string, ModelHealth>

/** 连挂 ≥2 次算坏渠道。选择器标红、健康文案加 ⚠ 都认这一个口径 */
export function isModelUnhealthy(h?: ModelHealth): boolean {
  return (h?.fail_streak || 0) >= 2
}

/** 验活并激活某个模型渠道（会真发一条请求，key 不对当场就知道）。modelId 指定同渠道下设哪个模型 */
export function probeModel(body: { model: string; model_id?: string; api_key?: string; skip_test?: boolean }) {
  return httpEngine.post<{ ok: boolean; error?: string }>('/onboarding', body).then((r) => r.data)
}

/** 拉取某渠道在服务商侧可用的模型 id 列表（走它的 /models 接口） */
export function listChannelModels(body: { name: string; api_key?: string }) {
  return httpEngine.post<{ ok: boolean; models?: string[]; error?: string }>('/models/list', body).then((r) => r.data)
}

/** 切换当前生效的模型（渠道 + 该渠道下的模型 id） */
export function setActiveModel(name: string, modelId?: string) {
  return httpEngine.post('/settings', { active_model: name, active_model_id: modelId || '' }).then((r) => r.data)
}

// ==================== 技能管理（本地安装/编辑/删除） ====================

export interface SkillDetail {
  name: string
  description?: string
  content?: string
  dir?: string
  hasAssets?: boolean
  plugin?: string
}

/** 技能详情（含正文，用来编辑） */
export function getSkill(name: string) {
  return httpEngine.get<SkillDetail>(`/skills/${encodeURIComponent(name)}`).then((r) => r.data)
}

/** 新建或更新技能 */
export function saveSkill(data: {
  name: string
  description?: string
  content?: string
  original_name?: string
}) {
  return httpEngine.post('/skills', data).then((r) => r.data)
}

export function deleteSkill(name: string) {
  return httpEngine.delete(`/skills/${encodeURIComponent(name)}`).then((r) => r.data)
}

/** 从 GitHub 安装技能 */
export function installSkill(repo: string) {
  return httpEngine.post('/skills/install', { repo }).then((r) => r.data)
}

/** 内置技能清单（可一键安装） */
export function listDefaultSkills() {
  return httpEngine.get<{ name: string; description?: string }[]>('/skills/defaults/list').then((r) => r.data)
}

export function installDefaultSkill(names: string[]) {
  return httpEngine.post('/skills/defaults/install', { names }).then((r) => r.data)
}

// ==================== MCP 连接器管理 ====================

export interface McpInput {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  transport?: string
}

/**
 * 保存连接器。
 * ⚠️ 后端收的是**整份 servers 数组**（不是单条增删改），
 * 所以界面上任何改动都要把完整列表发回去——它会顺带把所有连接器重启一遍。
 */
export function saveMcpList(servers: McpInput[]) {
  return httpEngine.post('/mcp', { servers }).then((r) => r.data)
}

// ==================== 专家管理 ====================

export interface ExpertInput {
  name: string
  alias?: string
  avatar?: string
  category?: string
  tags?: string[]
  description?: string
  skills?: string[]
  system?: string
  original_name?: string
}

export function saveExpert(data: ExpertInput) {
  return httpEngine.post('/experts', data).then((r) => r.data)
}

export function deleteExpert(name: string) {
  return httpEngine.delete(`/experts/${encodeURIComponent(name)}`).then((r) => r.data)
}

// ==================== 反馈（自进化的第一环） ====================

export interface FeedbackPayload {
  /** 会话 id */
  session: string
  /** 本轮在第几条助手消息（0 起，跟回放顺序一致） */
  turn: number
  /** up = 赞，down = 踩 */
  verdict: 'up' | 'down'
  /** 👎 后的补充说明，选填 */
  note?: string
  /** 这条用户消息的原文，供复盘时点回现场 */
  task?: string
  /** 助手回复的纯文本（截 800 字，后端会再截） */
  reply?: string
}

export function sendFeedback(payload: FeedbackPayload) {
  return httpEngine.post('/feedback', payload).then((r) => r.data)
}

// ==================== 应用内通知中心 ====================

/** 一条通知。kind 决定图标与配色；session 点开回到那条对话，target 点开跳到某个页面 */
export interface AppNotice {
  id: string
  kind: 'done' | 'approval' | 'error' | 'info' | string
  title: string
  body?: string
  at: number
  read: boolean
  session?: string
  target?: string
}

export interface NoticeFeed {
  items: AppNotice[]
  unread: number
}

/** 最近的通知流水（引擎侧事件 + 前端补记的事件同源） */
export function listNotifications() {
  return httpEngine.get<NoticeFeed>('/notifications').then((r) => r.data)
}

/** 标记已读；不传 ids 就是全部标记 */
export function markNotificationsRead(ids?: string[]) {
  return httpEngine.post<NoticeFeed>('/notifications/read', ids && ids.length ? { ids } : {}).then((r) => r.data)
}

/** 前端侧事件（如 ask_user 弹了选项卡片）也记一笔，免得铃铛面板里看不到 */
export function pushNotification(body: { kind?: string; title: string; body?: string; session?: string; target?: string }) {
  return httpEngine.post<NoticeFeed>('/notifications', body).then((r) => r.data)
}

export function clearNotifications() {
  return httpEngine.delete<NoticeFeed>('/notifications').then((r) => r.data)
}
