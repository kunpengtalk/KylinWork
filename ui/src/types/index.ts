/** 业务应用 */
export interface AppInfo {
  id: number
  appKey: string
  name: string
  description: string
  category: string
  icon: string
  /** 入口类型：chat=工作区对话；meeting=会议纪要页；doc-compare=文档对比页 */
  entryType: string
  modelName: string | null
  welcomeMsg: string
  mcpServers: string[]
  knowledgeIds: number[]
  skillIds: number[]
  memoryEnabled: boolean
  status: string
  createdAt: string | null
}

/** SSE 流式事件（与后端 ChatStreamEvent 对应） */
export interface ChatStreamEvent {
  type: 'delta' | 'thinking' | 'tool_call' | 'tool_result' | 'result' | 'done' | 'error'
  content?: string
  toolName?: string
  conversationId?: number
  messageId?: number
  message?: string
}

/** 同步对话响应 */
export interface ChatResponse {
  conversationId: number
  messageId: number
  reply: string
}

/** 会话 */
export interface Conversation {
  id: number
  appId: number
  title: string
  messageCount: number
  lastMessageAt: string | null
  createdAt: string | null
}

/** 消息 */
export interface ChatMessage {
  id: number
  conversationId: number
  role: 'user' | 'assistant'
  content: string
  toolTrace: string | null
  createdAt: string | null
}

/** 语音段落 */
export interface SpeechPara {
  id: number
  speechId: number
  speaker: string
  startSec: number
  endSec: number
  content: string
  sortOrder: number
  createdAt: string | null
}

/** 纪要分析结果 */
export interface SpeechAnalyse {
  id: number
  speechId: number
  kind: 'summary' | 'decision' | 'todo' | 'intro'
  content: string
  createdAt: string | null
}

/** 语音记录 */
export interface Speech {
  id: number
  catId: number | null
  title: string
  fileUrl: string
  fileName: string
  durationSec: number
  transcript: string
  status: 'pending' | 'transcribing' | 'transcribed' | 'analysed' | 'failed'
  errorMsg: string
  createdAt: string | null
  updatedAt: string | null
  paras?: SpeechPara[]
  analyses?: SpeechAnalyse[]
}

/** 话术分类 */
export interface SpeechCat {
  id: number
  userId: number
  name: string
  description: string
  sortOrder: number
  createdAt: string | null
  updatedAt: string | null
}

/** 文档对比差异项 */
export interface DocDiff {
  id: number
  compareId: number
  diffType: 'added' | 'removed' | 'modified' | 'unchanged'
  location: string
  leftText: string
  rightText: string
  comment: string
  riskLevel: 'high' | 'medium' | 'low'
  sortOrder: number
  createdAt: string | null
}

/** 文档对比任务 */
export interface DocCompare {
  id: number
  title: string
  leftName: string
  rightName: string
  status: 'pending' | 'comparing' | 'done' | 'failed'
  conclusion: string
  errorMsg: string
  createdAt: string | null
  updatedAt: string | null
  diffs?: DocDiff[]
}

/** 统一响应包装 */
export interface ApiResponse<T> {
  code: number
  message: string
  data: T
}

/** MCP 服务 */
export interface McpServerInfo {
  id: number
  name: string
  displayName: string
  description: string
  protocol: string
  status: string
  toolCount: number
  tools: { toolName: string; description: string; riskLevel: string }[]
}

/** 技能 */
export interface SkillInfo {
  id: number
  name: string
  displayName: string
  summary: string
  category: string
  latestVersion: string
  latestVersionId: number
}

/** 专家：一组技能的集合容器（区别于「业务应用」） */
export interface ExpertInfo {
  id: number
  name: string
  displayName: string
  summary: string
  description: string
  scene: string
  tags: string
  skillCount: number
  ownerName: string
}
