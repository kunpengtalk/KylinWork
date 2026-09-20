<script setup lang="ts">
import ChatMessage from '@/components/chat/ChatMessage.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import ErrorBanner from '@/components/chat/ErrorBanner.vue'
import RunStatusBar from '@/components/chat/RunStatusBar.vue'
import { describeTool } from '@/components/chat/toolMeta'
import type {AskCard, Msg} from '@/components/chat/types'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {BarChart3, CheckCircle2, Circle, FileText, Presentation, Search} from 'lucide-vue-next'
import { Bot, ChevronRight, PanelRight, Paperclip, Target, X } from 'lucide-vue-next'

import { Badge } from '@/components/ui/badge'
import { toast } from 'vue-sonner'
import ArtifactsPanel from '@/components/ArtifactsPanel.vue'
import NotificationCenter from '@/components/NotificationCenter.vue'
import NewProjectDialog from '@/components/NewProjectDialog.vue'
import { listPlatformModels, type PlatformModel } from '@/api/platform'
import { usePlatformAuth } from '@/composables/usePlatformAuth'
import { uiPrefs } from '@/composables/useUiPrefs'
import {
  newSessionId,
  readSessions,
  SESSIONS_CHANGED,
  type SessionMeta,
} from '@/composables/useSessions'
import { sendFeedback, runningChats, type OutputFileLite } from '@/api/engine'
import {getSettings, listFiles, listKnowledgeBases, listSecurityModes, setSecurityMode} from '@/api/client'
import {
  DEFAULT_PROJECT,
  listEngineExperts,
  listEngineMcp,
  listEngineSkills,
  listProjects,
  modelKey,
  parseModelKey,
  setActiveModel,
  setSessionModel,
  switchProject,
  type ModelChannel,
  type ModelHealthMap,
  type Project,
} from '@/api/engine'
import {
  activeSessionId,
  answerAskCard,
  getRun,
  hydrateRun,
  interjectRun,
  onWorkspaceFiles,
  peekRun,
  resumeRun,
  startRun,
  stopRun,
  syncRunsWithEngine,
  type RunState,
} from '@/composables/useChatRuns'

/**
 * 工作空间：对话跑在本地引擎上。
 * <p>
 * 与「网页版」的本质区别：这里的每一句话都交给本机的 agent.js 执行，
 * 工具真的在本机跑（run_node 生成 PPT/Word/Excel、run_shell 调本机命令），
 * 产物写进本地工作目录，所以「成果文件」里能看到、能直接打开、能拖走。
 * 平台只负责登录，不参与执行。
 *
 * 会话列表沿用原客户端的做法——存在 localStorage，刷新不丢。
 */

// ==================== 数据模型 ====================

const route = useRoute()
const router = useRouter()

// ==================== 状态 ====================

/**
 * 运行态（消息、运行中、计时、报错、成果…）按会话存在 useChatRuns 这个单例里，
 * 这里只保留「当前正在看的是哪个会话」。原因见那个文件的开头：
 * 状态挂在组件上，就会连带出现「新建任务被拦、切历史被拦、离开页面即中止」这一串问题。
 */
const run = ref<RunState | null>(null)
const sessions = ref<SessionMeta[]>([])
const sessionId = ref('')
const input = ref('')
const mode = ref(uiPrefs.defaultMode || 'craft')
/** 工作空间里的成果文件（整片工作区一份，不属于某个会话，所以留在视图层） */
const files = ref<OutputFileLite[]>([])
/** 本轮已上传的附件（文件名）：发送时拼成「已上传文件：xxx」一起带走，发出前可以撤掉 */
const attachments = ref<string[]>([])

// ---- 模型选择：本对话指定模型（会话级）+ 健康账本 ----
const models = ref<ModelChannel[]>([])
/** 当前选中的复合键「渠道::模型」（ModelPicker 的 value） */
const activeModel = ref('')
/** 健康账本，按复合键索引 */
const modelHealth = ref<ModelHealthMap>({})

// ---- 权限档位：输入框旁一键切换（对齐业界同类 Agent 产品） ----
const permList = ref<{ name?: string; label?: string; description?: string }[]>([])
const permCurrent = ref('')

// ---- 登录态：决定模型选择器里有没有「平台模型」分组 ----
const { loggedIn } = usePlatformAuth()
const platformModels = ref<PlatformModel[]>([])
const projectDialog = ref<InstanceType<typeof NewProjectDialog> | null>(null)

async function loadPlatformModels() {
  if (!loggedIn.value) {
    platformModels.value = []
    return
  }
  try {
    platformModels.value = await listPlatformModels()
  } catch {
    platformModels.value = []
  }
}
watch(loggedIn, loadPlatformModels, { immediate: true })

// ---- 项目（输入卡下 Work in …）----
const projects = ref<Project[]>([])
const activeProject = ref(DEFAULT_PROJECT)

const inputPlaceholder = computed(() => '今天帮你做些什么？@ 引用文件 · / 调用技能')

/** 首页建议提示词（空状态时展示，点击填入输入框） */
const suggestions = [
  { icon: BarChart3, title: '数据分析', prompt: '帮我分析这份数据，做可视化图表并说明结论' },
  { icon: FileText, title: '文档撰写', prompt: '写一份本周工作周报，重点突出进展和风险' },
  { icon: Presentation, title: '演示文稿', prompt: '做一份产品介绍 PPT，含市场分析和数据图表' },
  { icon: Search, title: '深度调研', prompt: '调研一下主要竞品的最新动态，输出对比报告' },
]

function useSuggestion(prompt: string) {
  input.value = prompt
  void nextTick(() => composerRef.value?.focus())
}
const skills = ref<{ name: string; description?: string }[]>([])

// ==================== @ 引用文件 / 调用技能 ====================
// 输入框的 placeholder 承诺了这两个东西，不实现就是骗人


/** 光标前最近的一个 @ 或 / 触发候选（出现空格就收起，避免误伤正常输入） */


/** 候选菜单的键盘操作：上下选、回车确认、Esc 收起 */
// 默认打开：右侧是"它做出来的东西"，是这个产品的主界面之一，不该藏在按钮后面
const showFiles = ref(true)
/** 面板最大化（T3 的 RightPanelMaximize）：盖过对话区，专心看成果 */
const panelMax = ref(false)

/** 当前渠道/模型：报错和「检测网络」都要按同一个目标说事，换了模型测的就不是这件事 */
function currentModelRef() {
  const { name, modelId } = parseModelKey(activeModel.value)
  return { channel: name || undefined, model: modelId || undefined }
}

/** 当前会话最近一轮的助手消息（运行条和自动滚动都看它） */
function cur(): Msg | undefined {
  const r = run.value
  return r?.messages.find((m) => m.id === r.assistantId)
}

/** 运行条上那句话：优先用引擎给的状态，没有就按当前在做什么推 */
const runView = computed(() => {
  const r = run.value
  if (r?.statusText) return { phase: 'tool' as const, label: r.statusText }
  const m = cur()
  const t = m?.tools.find((x) => x.running)
  if (t) return { phase: 'tool' as const, label: describeTool(t.name, t.input, t.purpose) }
  if (m?.text) return { phase: 'write' as const, label: '正在整理回复…' }
  // 没有工具在跑 = 球在模型那边，"等待模型响应"比"思考中"更准确地说明用户在等谁
  return { phase: 'think' as const, label: '等待模型响应' }
})
const scrollEl = ref<HTMLElement | null>(null)
const composerRef = ref<InstanceType<typeof ChatComposer> | null>(null)

// ==================== 会话（localStorage，与侧边栏共用） ====================

/** 会话条目的写入在 useChatRuns（后台任务收尾时也要更新它），这里只负责跟着刷新列表 */
function onSessionsChanged() {
  sessions.value = readSessions()
}

/**
 * 切到某个会话：把视图绑到它的运行态上。
 * <p>
 * 新会话 / 历史会话 / 正在后台跑的会话走的是同一条路——
 * 「当前在看哪个会话」和「哪些会话在跑」从此是两件事：切走不影响它跑，切回来也不用重来。
 */
function bindSession(id: string) {
  sessionId.value = id
  activeSessionId.value = id
  run.value = peekRun(id) ?? getRun(id)
  // URL 跟着会话走：刷新/重开之后才知道该回到哪一个（正在跑的任务也就接得回来）。
  // 不写进 URL 的话，刷新会落在一个新的空会话上，跑着的任务就"看不见"了。
  // `new` 是一次性的意图标记，落到具体会话上之后就摘掉，否则刷新又会被当成「新建」。
  const { new: _intent, ...rest } = route.query
  if (String(route.query.session || '') !== id || _intent) {
    void router.replace({ query: { ...rest, session: id } })
  }
}

function newTask() {
  // 已经在空会话上了就别再换一个：路由与事件两条通道可能各触发一次，
  // 不去重的话会连开两个空会话。
  const cur = run.value
  if (!cur || cur.messages.length || cur.running) bindSession(newSessionId())
  files.value = []
  mode.value = uiPrefs.defaultMode || 'craft' // 新对话回到设置里选的默认模式
  composerRef.value?.focus()
}

/** 侧栏/顶栏「新任务」按钮：路由同页时由事件驱动这里重置 */
function onNewTaskEvent() {
  newTask()
}

/** 正在回放的会话 id：事件与路由两条通道会同时触发，同一次只回放一遍，避免消息重复 */
let replayingId: string | null = null

/**
 * 打开一个会话（侧栏历史 / 路由参数都走这里）。
 * <p>
 * 这里**没有**「有任务在跑就先别切」那类拦截：正在跑的任务是别的会话的事，
 * 挡住切换就是把「后台执行」这件事本身阉掉了。本会话自己的运行态随它一起切过去。
 */
function openSession(id: string) {
  if (replayingId === id) return
  replayingId = id
  bindSession(id)
  files.value = []
  void hydrateRun(id)
    .then(async () => {
      const r = getRun(id)
      // 会话单独选过模型就顶上来（否则保持全局默认的展示）
      if (r.modelRef.channel) activeModel.value = modelKey(r.modelRef.channel, r.modelRef.model)
      // 引擎说它还在跑 → 接上续流（这条路径过去因为接口契约不一致而从未真正生效）
      if (!r.running && (await engineHasRunning(id))) resumeRun(id)
      await nextTick()
      scrollToBottom()
      if (!r.messages.length) {
        toast.info('这个会话没有可恢复的内容（可能引擎重启时未落盘）')
      }
    })
    .finally(() => {
      if (replayingId === id) replayingId = null
    })
}

/** 问一次引擎：这个会话现在还在跑吗 */
async function engineHasRunning(id: string): Promise<boolean> {
  try {
    return (await runningChats()).includes(id)
  } catch {
    return false
  }
}

/** 回放历史会话已经搬进 useChatRuns（hydrateRun）：那里才能保证「直播进哪个会话槽位」是同一件事 */

// ==================== 工具条：模型 / 权限 / 断点续流 ====================

/** 拉设置：模型渠道（带健康账本）、当前模型、权限档位（都用本机引擎的，与登录无关） */
async function loadToolbar() {
  try {
    const s = await getSettings()
    modelHealth.value = (s.model_health as ModelHealthMap) || {}
    // 只把对话渠道放进模型选择器——向量/重排渠道是给知识库用的，不该出现在聊天里
    models.value = ((s.models as ModelChannel[]) || [])
      .filter((m) => m.kind !== 'embedding' && m.kind !== 'rerank')
      .map((m) => ({ ...m }))
    activeModel.value = modelKey(String(s.active_model || ''), String(s.active_model_id || ''))
  } catch {
    /* 读不到就保持空 */
  }
  try {
    const m = await listSecurityModes()
    const data = m as { modes?: { name?: string; label?: string; description?: string }[]; current?: string }
    permList.value = data?.modes || []
    permCurrent.value = data?.current || ''
  } catch {
    /* 权限档位读不到就先不给快捷切换 */
  }
}

/**
 * 切换本对话的模型（输入框旁模型按钮）。key 是「渠道::模型」复合键。
 * 历史会话的模型存在会话上（服务端持久）；还没首发的会话先切全局默认，
 * 发完第一条消息会话落盘后，再点一次就按会话记住了。
 */
async function pickModel(key: string) {
  if (!key) return
  const { name, modelId } = parseModelKey(key)
  if (!name) return
  activeModel.value = key
  const label = modelId || name
  try {
    await setSessionModel(sessionId.value, name, modelId)
    toast.success('本对话已切换到 ' + label)
  } catch {
    try {
      await setActiveModel(name, modelId)
      toast.success('已设为全局默认模型：' + label)
    } catch (e) {
      toast.error('切换失败：' + (e as Error).message)
    }
  }
}

/** 权限档位一键切换：本地引擎的审批闸门，立刻生效 */
async function setPerm(mode: string) {
  permCurrent.value = mode
  try {
    await setSecurityMode(mode)
    toast.success('权限档位：' + (permList.value.find((m) => m.name === mode)?.label || mode))
  } catch (e) {
    toast.error('切换失败：' + (e as Error).message)
  }
}

async function loadProjects() {
  try {
    projects.value = await listProjects()
  } catch {
    projects.value = []
  }
}

/** 输入卡下的工作空间选择：切工作空间；选「＋ 选择本地文件夹…」弹系统选框新建 */
async function onProjectChange(name: string) {
  activeProject.value = name
  try {
    await switchProject(name)
    toast.success('已切换工作空间：' + name)
  } catch {
    /* 服务端切换失败不影响本地会话分组 */
  }
  try {
    await refreshFiles()
  } catch {
    /* 忽略 */
  }
}

/** 侧栏 / 新建对话框改动工作空间 → 这里同步列表、高亮和成果文件 */
function onProjectsChanged(e: Event) {
  const active = (e as CustomEvent).detail?.active as string | undefined
  void loadProjects().then(() => {
    if (active) {
      activeProject.value = active
      void refreshFiles()
    }
  })
}

// ==================== 输入区两个弹层（对齐业界同类 Agent 产品） ====================
// ① 「+」菜单：添加文件 / 模式 / 专家 / 技能 / 连接器，每项带子列表

// ---------- 输入框工具条：连接器 / 专家 / 技能 三个一级下拉（对齐参考截图） ----------
const selectedMcp = ref('')

// ---- 知识库：本次任务勾选哪些库，发送时带给引擎做检索问答 ----
const kbList = ref<{ id: string; name: string; file_count?: number }[]>([])
const selectedKb = ref<string[]>([])

async function loadKnowledge() {
  try {
    const d = await listKnowledgeBases()
    kbList.value = (d.bases || []).map((b) => ({ id: b.id, name: b.name, file_count: b.file_count }))
    // 选中的库被删了就从选择里摘掉，别让引擎收到不存在的 id
    const ids = new Set(kbList.value.map((k) => k.id))
    selectedKb.value = selectedKb.value.filter((id) => ids.has(id))
  } catch {
    kbList.value = []
  }
}

function onKbChange(ids: string[]) {
  selectedKb.value = ids
  if (ids.length) {
    const names = ids.map((id) => kbList.value.find((k) => k.id === id)?.name).filter(Boolean)
    toast.success(`本次任务将检索知识库：${names.join('、')}`)
  }
}


function pickMcpTool(name: string) {
  selectedMcp.value = selectedMcp.value === name ? '' : name
  toast.success(selectedMcp.value ? `本次任务将使用连接器「${name}」` : '已取消选择连接器')
}

/** 已连接的连接器（enabled !== false）：输入条快捷选择菜单的数据源（与 mcpList 同一份） */
const experts = ref<{ name: string; alias?: string; avatar?: string; category?: string; tags?: string[]; description?: string; role?: string }[]>([])

/** 本次任务选定的专家名（空 = 不指定）。系统级参数，发送时带给引擎；不注入输入框文本 */
const selectedExpert = ref('')

function onExpertChange(name: string) {
  selectedExpert.value = name
  toast.success(name ? `本次任务由专家「${name}」执行` : '已取消指定专家')
}
const mcpList = ref<{ name: string; status?: string; enabled?: boolean }[]>([])




/** 新建项目（选目录）成功：切到新项目并刷新成果列表 */
async function onProjectCreated(name: string) {
  await loadProjects()
  activeProject.value = name
  try {
    await refreshFiles()
  } catch {
    /* 忽略 */
  }
}

// ==================== 发送 ====================

/** 本会话正在跑吗（只有它自己会挡住自己；别的会话在跑不构成理由） */
const busy = computed(() => Boolean(run.value?.running))

/** 起一轮：登记助手占位 + 交给运行态存起来跑。send() 与「重新生成」共用 */
function beginRun(text: string, regen = false): boolean {
  if (!sessionId.value) bindSession(newSessionId())
  const r = getRun(sessionId.value)
  run.value = r
  // Before the run starts: 新一轮开始 = 上一条错误横幅的使命结束了
  r.lastError = null
  const res = startRun(sessionId.value, {
    message: text,
    mode: mode.value,
    kbIds: selectedKb.value,
    expert: selectedExpert.value || undefined,
    regen,
    // 侧栏标题/分组：touchSession 只在会话还不存在时才采用 title（已有会话不会被改名），
    // 所以这里每次都带得上——首次出现的那一刻正好就是「这一轮」
    title: text,
    project: activeProject.value || DEFAULT_PROJECT,
    modelRef: currentModelRef(),
  })
  if (!res.ok) {
    toast.warning(res.error || '这个任务已经在跑了')
    return false
  }
  return true
}

async function send() {
  const raw = input.value.trim()
  if (!raw && !attachments.value.length) return
  // 附件带进消息：agent 的提示词认「已上传文件：xxx」这句话，不带它模型不知道用户塞了东西
  const withFiles = attachments.value.length ? `${raw}\n\n已上传文件：${attachments.value.join('、')}`.trim() : raw
  // 本次选择的连接器：作为约束注入消息（仅对本次任务生效）
  const text = selectedMcp.value ? `（请优先使用连接器「${selectedMcp.value}」提供的工具）${withFiles}` : withFiles
  // 本会话已经在跑时，发送 = 插队注入当前任务；别的会话在跑则照常开新的一轮
  if (busy.value) {
    await interject()
    return
  }

  input.value = ''
  // 气泡里只显示用户写的话；「已上传文件…」是给 agent 的指令，不占版面
  getRun(sessionId.value).messages.push({
    id: 'u' + Date.now(),
    role: 'user',
    text: raw || `已上传文件：${attachments.value.join('、')}`,
    tools: [],
    done: true,
    at: Date.now(),
  })
  attachments.value = []
  beginRun(text)
  await nextTick()
  scrollToBottom()
}

/**
 * 重新生成：丢掉这一轮（及其之后的消息），拿同一句指令重跑。
 * 用户气泡保留——重做的是答复，不是重新提一次需求。
 */
async function regenerate(m: Msg) {
  const r = run.value
  if (!r) return
  if (r.running) {
    toast.warning('这个任务正在跑，先停止或等它结束')
    return
  }
  const task = String(m.task || '').trim()
  if (!task) {
    toast.error('这一轮没有留下可重做的指令')
    return
  }
  const i = r.messages.indexOf(m)
  if (i < 0) return
  r.messages.splice(0, r.messages.length, ...r.messages.slice(0, i))
  // 服务端也要跟着回滚（它按同一个 sessionId 记账），所以带 regen 再发一次
  if (!beginRun(task, true)) return
  await nextTick()
  scrollToBottom()
}

/** 报错横幅上的「重试」：拿失败那一轮的原始指令重做 */
function retryLastError() {
  const m = run.value?.lastError?.msg
  if (!m) return
  void regenerate(m)
}

/**
 * 报错横幅上的「提交反馈」：错误本来就是要进自进化复盘的一等公民
 * ——用户点这一下，比让他自己去描述"刚才为什么失败"有用得多。
 */
function feedbackLastError() {
  const err = run.value?.lastError
  if (!err?.msg) return
  const m = err.msg
  void sendFeedback({
    session: sessionId.value,
    turn: m.turn ?? 0,
    verdict: 'down',
    note: `[任务失败] ${err.title}${err.status ? ` · HTTP ${err.status}` : ''}${err.detail ? ` · ${err.detail}` : ''}`,
    task: m.task || '',
    reply: m.text.slice(0, 800),
  })
    .then(() => toast.success('已提交，会进下一轮复盘'))
    .catch(() => toast.error('提交失败'))
}

/** 删除一轮：用户提问 + 它对应的答复一起拿走，只删答复会留下一个没人回答的问句 */
function deleteTurn(m: Msg) {
  const r = run.value
  if (!r) return
  if (r.running) {
    toast.warning('这个任务正在跑，先停止再删')
    return
  }
  const i = r.messages.indexOf(m)
  if (i < 0) return
  let from = i
  for (let k = i - 1; k >= 0; k--) {
    if (r.messages[k]!.role === 'user') {
      from = k
      break
    }
  }
  r.messages.splice(from, i - from + 1)
  if (r.lastError?.msg === m) r.lastError = null
  toast.success('已删除这一轮')
}

// ==================== 事件渲染 ====================
// 事件怎么落到运行态上是 useChatRuns 的事（直播与历史回放共用同一条），
// 视图这里只处理「看到事件后该怎么摆屏幕」：滚到底、把新产出亮出来。

function stop() {
  if (sessionId.value) stopRun(sessionId.value)
  scrollToBottom()
}

async function pickAnswer(ask: AskCard, label: string) {
  ask.answered = label
  await answerAskCard(ask.askId, label)
}

// ==================== 交互 ====================

function autoScroll() {
  nextTick(() => {
    const el = scrollEl.value
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
      el.scrollTop = el.scrollHeight
    }
  })
}
function scrollToBottom() {
  nextTick(() => {
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
  })
}

/**
 * 事件推进就跟着滚一把。
 * <p>
 * 挂在 run.rev 上而不是在每个事件分支里调用：后台会话照样在涨 rev，
 * 但它不是当前在看的那个，不该抢用户的滚动条——所以只有「当前会话」才滚。
 */
watch(
  () => run.value?.rev,
  (_rev, prev) => {
    if (prev === undefined) return
    autoScroll()
    // 一产出成果就把右侧展示出来：用户要看见东西在长出来
    if (run.value?.changedFiles.length && !showFiles.value) showFiles.value = true
  },
)

async function interject() {
  const t = input.value.trim()
  if (!t || !run.value?.running) return
  input.value = ''
  await interjectRun(sessionId.value, t)
}

// ==================== 自进化反馈（👍👎，链的第一环） ====================


/** 点 👍/👎：立即上报（不写理由也算数）；再点同一票 = 撤票（改判） */
async function toggleFb(m: Msg, verdict: 'up' | 'down') {
  const on = m.fb === verdict
  m.fb = on ? null : verdict
  m.fbNoteOpen = false
  if (on) return
  if (verdict === 'down') {
    // 一次只开一个「哪儿不对」，避免多个输入框叠在一起
    run.value?.messages.forEach((x) => {
      if (x !== m) x.fbNoteOpen = false
    })
  }
  try {
    await sendFeedback({
      session: sessionId.value,
      turn: m.turn ?? 0,
      verdict,
      task: m.task || '',
      reply: m.text.slice(0, 800),
    })
    if (verdict === 'down') {
      m.fbNoteOpen = true
    }
  } catch {
    m.fb = null
    toast.error('反馈发送失败')
  }
}

function saveFbNote(m: Msg, note: string) {
  const v = note.trim()
  m.fbNoteOpen = false
  if (!v) return
  void sendFeedback({
    session: sessionId.value,
    turn: m.turn ?? 0,
    verdict: 'down',
    note: v,
    task: m.task || '',
    reply: m.text.slice(0, 800),
  })
    .then(() => toast.success('记下了，会进下一轮复盘'))
    .catch(() => toast.error('保存失败'))
}

/**
 * 上传附件。两个必须守住的坑：
 * 1) 必须看响应码——以前只管 fetch，400 也当成功，于是永远弹「已上传」，文件其实没落盘
 * 2) 一个一个传：整批失败时说不清是哪个，单个传能把失败的文件名报给用户
 * 传完记进 attachments，发送时拼成「已上传文件：xxx」——agent 的提示词认这句话，
 * 不带上它，模型根本不知道用户塞了东西进来。
 */
/** 对话里点产出文件 → 右侧 Artifact 直接打开（面板关着就顺手展开） */
const filePanel = ref<InstanceType<typeof ArtifactsPanel> | null>(null)
function openArtifact(name: string) {
  if (!showFiles.value) showFiles.value = true
  void nextTick(() => filePanel.value?.open(name))
}

async function onPickFiles(fs: FileList) {
  if (!fs?.length) return
  const list = Array.from(fs)
  const ok: string[] = []
  const failed: string[] = []
  for (const f of list) {
    try {
      const r = await fetch(`/engine-api/upload?session=${encodeURIComponent(sessionId.value)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) },
        body: f,
      })
      const body = await r.json().catch(() => ({} as { error?: string }))
      if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`)
      ok.push(f.name)
    } catch (e) {
      failed.push(`${f.name}（${(e as Error).message || '未知错误'}）`)
    }
  }
  if (ok.length) attachments.value.push(...ok)
  if (ok.length) void refreshFiles()
  if (ok.length) toast.success(`已上传 ${ok.length} 个文件，发消息时它会一起带上`)
  if (failed.length) toast.error(`上传失败：${failed.join('；')}`)
}

async function refreshFiles() {
  try {
    files.value = await listFiles()
  } catch {
    /* 忽略 */
  }
}


/** 成果文件订阅的退订句柄 */
let unsubFiles: (() => void) | null = null

onMounted(async () => {
  sessions.value = readSessions()
  window.addEventListener(SESSIONS_CHANGED, onSessionsChanged)
  // 产出文件变化：任何会话（含后台在跑的那些）产出了东西，右侧面板都跟着更新
  unsubFiles = onWorkspaceFiles((list) => {
    files.value = list
  })
  void refreshFiles()
  void loadToolbar()
  void loadProjects()
  void loadKnowledge()
  window.addEventListener('kylinwork:projects-changed', onProjectsChanged)
  window.addEventListener('kylinwork:new-task', onNewTaskEvent)
  window.addEventListener('kylinwork:open-session', onOpenSessionEvent)
  // 技能列表供 / 菜单用，读不到就算了，不影响打字
  void listEngineSkills()
    .then((s) => (skills.value = (s || []) as { name: string; description?: string }[]))
    .catch(() => {})
  // 专家 / 连接器：给「+」菜单的子列表用
  void listEngineExperts()
    .then((e) => {
      experts.value = (e || []) as { name: string; alias?: string; avatar?: string; category?: string; tags?: string[]; description?: string; role?: string }[]
      // 从专家列表「召唤到对话」过来：?expert=名字 → 直接选中这位专家（不往输入框写提示词），再清掉参数
      const name = String(route.query.expert || '')
      if (name) {
        const hit = experts.value.find((x) => x.name === name)
        if (hit) selectedExpert.value = name
        else toast.warning(`没有找到专家「${name}」`)
        router.replace({ query: { ...route.query, expert: undefined } })
      }
    })
    .catch(() => {})
  void listEngineMcp()
    .then((m) => {
      const arr = Array.isArray(m) ? m : ((m as { servers?: unknown[] })?.servers ?? [])
      mcpList.value = arr as { name: string; status?: string; enabled?: boolean }[]
    })
    .catch(() => {})
  // 回到对话页：先看有没有「新任务」意图（从别的页面点的新任务），
  // 其次按 URL 里的会话，最后落回「上次在看的那一个」——
  // 组件重建时 sessionId 已经归零，不记住它就会新建一个空会话，
  // 后台还在跑的任务当场从屏幕上消失（这正是「任务在跑但页面没动静」的来源）。
  const q = String(route.query.session || '')
  if (route.query.new === '1') newTask()
  else if (q) openSession(q)
  else if (activeSessionId.value) openSession(activeSessionId.value)
  else bindSession(newSessionId())
  void syncRunsWithEngine()
})

// 会话切换的两条通道都落在这里：路由带 session=xx（侧栏点历史）或 new=1（新任务）。
watch(
  () => [String(route.query.session || ''), String(route.query.new || '')] as const,
  ([sid, isNew]) => {
    if (isNew === '1') {
      newTask()
      return
    }
    if (sid && sid !== sessionId.value) openSession(sid)
  },
)

/** 侧栏点历史会话：事件通道（路由同页被吃掉时照样切过去） */
function onOpenSessionEvent(e: Event) {
  const id = String((e as CustomEvent).detail?.id || '')
  if (id) openSession(id)
}

onUnmounted(() => {
  // 这里**不再** abort：任务归 useChatRuns 管，离开页面（去专家广场、切设置…）不该把它掐掉。
  // 引擎侧本来就不因为前端断开而停；前端这边现在也一样，回来接着看。
  if (unsubFiles) unsubFiles()
  window.removeEventListener(SESSIONS_CHANGED, onSessionsChanged)
  window.removeEventListener('kylinwork:projects-changed', onProjectsChanged)
  window.removeEventListener('kylinwork:new-task', onNewTaskEvent)
  window.removeEventListener('kylinwork:open-session', onOpenSessionEvent)
})
</script>

<template>
  <div class="flex h-full">
    <!-- 对话主区 -->
    <div class="flex min-w-0 flex-1 flex-col">
      <!-- 顶栏（对齐 T3 ChatHeader）：左边项目 › 会话标题，右边面板开合/最大化 -->
      <header class="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 px-4">
        <div class="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
          <Bot class="size-4 shrink-0 text-muted-foreground" />
          <span class="max-w-40 shrink-0 truncate text-muted-foreground">{{ activeProject || DEFAULT_PROJECT }}</span>
          <ChevronRight class="size-3 shrink-0 text-muted-foreground/50" />
          <h2 class="min-w-0 truncate font-medium">
            {{ sessions.find((s) => s.id === sessionId)?.title || '新会话' }}
          </h2>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            class="rounded-md p-1.5 transition-colors"
            :class="showFiles ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
            :title="showFiles ? '收起成果面板' : '打开成果面板'"
            @click="showFiles = !showFiles"
          >
            <PanelRight class="size-4" />
          </button>
          <!-- 通知中心：任务完成/出错、等待审批、定时任务跑完都汇总在这里 -->
          <NotificationCenter />
        </div>
      </header>

      <!-- 消息流 -->
      <div ref="scrollEl" class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-3xl space-y-5 px-4 py-6">
          <div v-if="!run?.messages.length && !run?.goalCard" class="flex flex-col items-center pb-12 pt-20 text-center">
            <img src="/icon.png" alt="KylinWork" class="size-16 rounded-2xl shadow-lg shadow-brand-700/20" />
            <p class="mt-7 text-3xl font-semibold tracking-tight">
              今天帮你做些什么？
            </p>
            <p class="mt-3 text-[15px] text-muted-foreground">
              说出需求，专家团队自主规划，在本地工作空间交付可验收的成果
            </p>

            <!-- 建议提示词：点击填入输入框 -->
            <div class="mt-8 grid w-full max-w-xl grid-cols-1 gap-2.5 sm:grid-cols-2">
              <button
                v-for="s in suggestions"
                :key="s.title"
                class="group rounded-xl border border-border bg-background p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
                @click="useSuggestion(s.prompt)"
              >
                <p class="flex items-center gap-2 text-[13px] font-medium text-foreground/90">
                  <span class="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <component :is="s.icon" class="size-3.5" />
                  </span>
                  {{ s.title }}
                </p>
                <p class="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{{ s.prompt }}</p>
              </button>
            </div>

            <p class="mt-6 text-xs text-muted-foreground/70">
              <code class="rounded bg-muted px-1">@</code> 引用工作区文件 ·
              <code class="rounded bg-muted px-1">/</code> 调用技能 ·
              微信扫码即可远程指挥
            </p>
          </div>

          <!-- Goal 目标卡：mode=goal 时后端拆出的验收清单，每轮自动勾选 -->
          <div
            v-if="run?.goalCard && run.goalCard.text"
            class="rounded-xl border-2 border-primary/30 bg-primary/5 p-4"
          >
            <div class="flex items-center gap-2">
              <Target class="size-4 shrink-0 text-primary" />
              <p class="flex-1 text-sm font-semibold">目标</p>
              <Badge v-if="run.goalCard.status === 'done'" variant="default">已完成</Badge>
              <Badge v-else variant="secondary">
                {{ (run.goalCard.round || 0) > 0 ? `第 ${(run.goalCard.round ?? 0) + 1} 轮` : '验收中' }}
              </Badge>
            </div>
            <p class="mt-2 text-sm text-muted-foreground">{{ run.goalCard.text }}</p>
            <ul class="mt-3 space-y-1.5">
              <li v-for="(c, i) in run.goalCard.criteria || []" :key="i" class="flex items-start gap-2 text-xs">
                <CheckCircle2 v-if="c.done" class="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                <Circle v-else class="mt-0.5 size-3.5 shrink-0 text-muted-foreground/40" />
                <span :class="c.done ? 'text-muted-foreground line-through' : ''">{{ c.text }}</span>
              </li>
            </ul>
          </div>

          <ChatMessage
            v-for="m in run?.messages || []"
            :key="m.id"
            :msg="m"
            :files="files"
            :artifact-count="files.length"
            :changed-count="run?.changedFiles.length || 0"
            @feedback="(v) => toggleFb(m, v)"
            @note="(t) => saveFbNote(m, t)"
            @answer="(l) => m.ask && pickAnswer(m.ask, l)"
            @open-file="openArtifact"
            @retry="regenerate(m)"
            @delete="deleteTurn(m)"
            @open-artifacts="showFiles = true"
          />

          <!-- 运行中：在干什么 / 跑了多久 / 多久没新输出 / 一键停止 -->
          <RunStatusBar
            v-if="run?.running"
            :running="Boolean(run?.running)"
            :elapsed="run?.elapsed || 0"
            :label="runView.label"
            :phase="runView.phase"
            :tools="cur()?.tools.length || 0"
            :idle="run?.idle || 0"
            :usage="cur()?.usage"
            @stop="stop"
          />
        </div>
      </div>

      <!-- 已上传的附件：确认"它真的进来了"，发出前还能撤掉 -->
      <div v-if="attachments.length" class="flex flex-wrap gap-1.5">
        <span
          v-for="(a, i) in attachments"
          :key="a + i"
          class="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs text-muted-foreground"
        >
          <Paperclip class="size-3 shrink-0" />
          <span class="max-w-[14rem] truncate">{{ a }}</span>
          <button class="shrink-0 rounded p-0.5 hover:bg-accent hover:text-foreground" title="移除" @click="attachments.splice(i, 1)">
            <X class="size-3" />
          </button>
        </span>
      </div>

      <!-- 报错横幅：最近一次失败，带上重试/检测网络这些能立刻用的入口 -->
      <ErrorBanner
        v-if="run?.lastError"
        class="mx-auto w-full max-w-4xl px-1"
        :title="run?.lastError?.title || ''"
        :detail="run?.lastError?.detail"
        :status="run?.lastError?.status"
        :channel="run?.lastError?.channel"
        :model="run?.lastError?.model"
        @retry="retryLastError"
        @feedback="feedbackLastError"
        @close="run && (run.lastError = null)"
      />

      <ChatComposer
        ref="composerRef"
        v-model="input"
        :running="Boolean(run?.running)"
        :placeholder="inputPlaceholder"
        :mode="mode"
        :channels="models"
        :model-health="modelHealth"
        :platform-models="platformModels"
        :active-model="activeModel"
        :logged-in="loggedIn"
        :perm-list="permList"
        :perm-current="permCurrent"
        :projects="projects"
        :active-project="activeProject"
        :skills="skills"
        :experts="experts"
        :mcp-list="mcpList"
        :selected-mcp="selectedMcp"
        :kb-list="kbList"
        :selected-kb="selectedKb"
        :selected-expert="selectedExpert"
        :files="files"
        @send="send"
        @stop="stop"
        @interject="interject"
        @pick-files="onPickFiles"
        @change-mode="(v: string) => (mode = v)"
        @change-model="pickModel"
        @change-mcp="pickMcpTool"
        @change-kb="onKbChange"
        @change-expert="onExpertChange"
        @change-perm="setPerm"
        @change-project="onProjectChange"
        @new-workspace="projectDialog?.show()"
        @login="router.push('/launch')"
      />
    </div>

    <!-- 右侧成果文件面板：实时列表 + 内嵌预览 + 本机预览服务 -->
    <ArtifactsPanel
      ref="filePanel"
      v-if="showFiles"
      :files="files"
      :changed="run?.changedFiles || []"
      :maximized="panelMax"
      :milestones="run?.panelMilestones || []"
      :agents="run?.panelAgents || []"
      :folder="run?.panelFolder || ''"
      @refresh="refreshFiles"
      @close="showFiles = false"
      @maximize="panelMax = !panelMax"
    />

    <!-- 新建项目（选目录即建） -->
    <NewProjectDialog ref="projectDialog" @created="onProjectCreated" @close="() => {}" />
  </div>
</template>
