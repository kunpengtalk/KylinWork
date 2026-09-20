import http, { postStream, unwrap } from './request'
import type { ChatMessage, ChatResponse, ChatStreamEvent, Conversation } from '@/types'

/** 会话列表（可按应用过滤） */
export function listConversations(appKey?: string) {
  return unwrap<Conversation[]>(
    http.get('/api/v1/conversations', { params: appKey ? { appKey } : {} }),
  )
}

/** 会话历史消息 */
export function listMessages(conversationId: number) {
  return unwrap<ChatMessage[]>(http.get(`/api/v1/conversations/${conversationId}/messages`))
}

/** 删除会话 */
export function deleteConversation(conversationId: number) {
  return unwrap<null>(http.delete(`/api/v1/conversations/${conversationId}`))
}

/** 同步对话 */
export function sendChat(appKey: string, message: string, conversationId?: number) {
  return unwrap<ChatResponse>(http.post('/api/v1/chat/send', {
    appKey,
    message,
    conversationId: conversationId ?? null,
  }))
}

/** 中断生成 */
export function stopChat(appKey: string, conversationId: number) {
  return unwrap<null>(
    http.post(`/api/v1/chat/stop?appKey=${encodeURIComponent(appKey)}&conversationId=${conversationId}`),
  )
}

/**
 * 流式对话（SSE）。
 * 返回中断函数，供「停止生成」使用。
 * <p>
 * 会话级覆盖（可选）：modelName / mcpServers / skillIds——
 * 输入框选择器所选内容随消息传入，null 跟随应用默认配置。
 */
export interface ChatOverrides {
  modelName?: string
  mcpServers?: string[]
  skillIds?: number[]
  /** 专家：注入该专家的角色设定 */
  expertId?: number
}

export function streamChat(
  payload: {
    appKey: string
    message: string
    conversationId?: number | null
  } & ChatOverrides,
  handlers: {
    onEvent: (event: ChatStreamEvent) => void
    onError?: (error: Error) => void
    onDone?: () => void
  },
) {
  return postStream('/client-api/api/v1/chat/stream', payload, {
    onEvent: (e) => handlers.onEvent(e.data as ChatStreamEvent),
    onError: handlers.onError,
    onDone: handlers.onDone,
  })
}

/** 对话选项（选择器数据源） */
export interface ChatOptionItem {
  value: string
  label: string
  description?: string | null
}

export interface ChatOptions {
  models: ChatOptionItem[]
  mcpServers: ChatOptionItem[]
  skills: ChatOptionItem[]
  experts: ChatOptionItem[]
}

/** 拉取对话输入框选择器数据（模型/连接器/技能/专家一次拉齐） */
export function getChatOptions() {
  return unwrap<ChatOptions>(http.get('/api/v1/chat/options'))
}
