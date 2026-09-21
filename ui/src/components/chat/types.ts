/** 聊天主区用到的共享类型：ChatView 与拆分出去的消息组件都从这里取，避免各自定义一份 */
import type { KnowledgeCitation } from '@/api/client'

export interface ToolCall {
  id: string
  name: string
  purpose?: string
  input?: string
  result?: string
  isError?: boolean
  running: boolean
  expert?: string
  /** write/edit 的行级 diff（后端 lineDiff 产出）：展开区渲染成 +绿 -红 */
  diff?: { op: string; text: string }[]
  /** 起止时间：用于显示这一步花了多久（界面上一行小字，等宽数字） */
  startedAt?: number
  endedAt?: number
}

export interface AskCard {
  askId: string
  question: string
  options: { label: string; detail?: string }[]
  answered?: string
}

/** 一轮产出的文件：名字用于打开，体积用于在文件卡上标出来（对齐参考版的 "49.3 KB"） */
export interface OutFile {
  name: string
  size?: number
}
/** 一轮失败的结构化记录：结构化的错误才能给出可操作的按钮（重试 / 检测网络 / 复制错误） */
export interface MsgError {
  /** 一句话说明（"模型调用失败" 这类），界面上当标题 */
  title: string
  /** 原始错误详情，展开/复制时用 */
  detail?: string
  /** 传输层 HTTP 状态码（如果是 HTTP 失败） */
  status?: number
}

export interface Msg {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** 模型思考过程（thinking 事件流累积），默认折叠展示 */
  thinking?: string
  tools: ToolCall[]
  ask?: AskCard
  usage?: Record<string, unknown>
  milestones?: { text: string; done: boolean }[]
  sources?: { title?: string; url?: string }[]
  /** 本轮知识库检索命中的引用（答复底下的「知识来源」） */
  citations?: KnowledgeCitation[]
  /** 本轮产出的文件（点一下在右侧 Artifact 里打开） */
  files?: string[]
  /** 发出时间 / 结束时间：消息尾部的时刻、以及「已完成 3m12s」这个耗时 */
  at?: number
  startedAt?: number
  endedAt?: number
  /** 这一轮以失败收场时的结构化错误（正常结束为 undefined） */
  error?: MsgError
  /** 自进化反馈：本轮在会话里的助手消息序号（0 起）+ 对应的用户原话 + 已投的票 */
  turn?: number
  task?: string
  fb?: 'up' | 'down' | null
  fbNoteOpen?: boolean
  done: boolean
}
