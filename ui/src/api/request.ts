import axios, { type AxiosInstance } from 'axios'
import type { ApiResponse } from '@/types'

/**
 * 请求分三路走，这是 KylinWork 作为桌面客户端才有的结构性设计：
 *
 * - http       → /client-api  Java 云端平台网关（应用 / 专家 / 模型 / 用量 / 密钥…）
 * - httpAuth   → /            Java 认证接口（验证码、登录；此时还没有 token）
 * - httpEngine → /engine-api  KylinWork 本地引擎（Agent 对话、工具、技能、MCP、专家委派、成果文件）
 *
 * 前两路是登录与平台能力接口；第三路是 KylinWork 自己的 Agent 引擎，
 * 承载本地执行的那部分能力。
 */
function createHttp(baseURL: string): AxiosInstance {
  const instance = axios.create({ baseURL, timeout: 60_000 })

  instance.interceptors.request.use((config) => {
    const token = getToken()
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  })

  instance.interceptors.response.use(
    (resp) => resp,
    (error) => {
      const status = error?.response?.status
      // 本地引擎的错误体是 { error }（Express 兜底处理器），平台网关是 { message }，两种都认
      const message =
        error?.response?.data?.message ?? error?.response?.data?.error ?? error?.message ?? '请求失败'
      if (status === 401) {
        handleUnauthorized()
      }
      // 状态码要跟着抛出去：调用方得按它分流（404 = 这条会话引擎里没有，跟网络故障不是一回事）
      const err = new Error(message) as Error & { status?: number }
      err.status = status
      return Promise.reject(err)
    },
  )

  return instance
}

export const http = createHttp('/client-api')
export const httpAuth = createHttp('/')

/**
 * 本地引擎实例。
 * <p>
 * 不做统一解包：引擎接口是按用途设计的原生 JSON（有数组、有对象、有流式），
 * 强行套 {code,message,data} 反而要每个接口多解一层。401 由拦截器统一处理。
 */
export const httpEngine = createHttp('/engine-api')

/**
 * 解包 Java 侧统一响应体。
 * <p>
 * 注意：网关鉴权失败时返回的是 HTTP 200 + body.code=401（过滤器直接写 JSON 响应），
 * 因此这里必须检查 body 的 code，不能只看 HTTP 状态码。
 *
 * @param silent 设为 true 时：401 不触发全局跳登录，仅抛错。
 *   适用于「个人信息 / 资源列表」等非关键接口——它们失败应该让用户看到错误，
 *   而不应让用户强制退出。
 */
export async function unwrap<T>(
  promise: Promise<{ data: ApiResponse<T> }>,
  opts: { silent?: boolean } = {},
): Promise<T> {
  const resp = await promise
  if (resp.data.code === 401) {
    if (!opts.silent) {
      handleUnauthorized()
    }
    throw new Error(resp.data.message || '登录已过期')
  }
  if (resp.data.code !== 200) {
    throw new Error(resp.data.message || '请求失败')
  }
  return resp.data.data
}

// ==================== 登录态 ====================

export function getToken(): string {
  return readCookie('token') ?? ''
}

/**
 * 平台接口 401：清掉本地令牌并广播登录态变化（侧边栏随之回到未登录），
 * 不强制跳转——客户端没有登录页，离线也能完整用本地引擎；
 * 各页面请求失败时自己显示错误，而不是把整个应用甩回首页。
 */
function handleUnauthorized() {
  document.cookie = 'token=; path=/; max-age=0'
  document.cookie = 'user=; path=/; max-age=0'
  window.dispatchEvent(new CustomEvent('kylinwork:platform-changed'))
}

export function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(^| )${name}=([^;]+)`))
  return match ? match[2] : null
}

export default http

// ==================== SSE 流式读取 ====================

/** SSE 事件回调 */
export interface StreamHandlers {
  onEvent: (event: { type: string; data: unknown }) => void
  onError?: (error: Error) => void
  onDone?: () => void
}

/**
 * 以 POST + fetch 流式读取 SSE。
 *
 * 为什么不用浏览器原生 EventSource：EventSource 只支持 GET 且无法自定义请求头，
 * 而本链路需要 POST 携带较长的用户输入，并依赖网关的登录态校验。
 *
 * @returns 中断函数（用户点击「停止生成」时调用）
 */
export function postStream(
  url: string,
  body: unknown,
  handlers: StreamHandlers,
): () => void {
  const controller = new AbortController()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const run = async () => {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!resp.ok || !resp.body) {
        // 4xx/5xx：尽量读出后端的错误体，给出真正的原因，
        // 而不是一句没有信息量的「请求失败（HTTP 400）」
        let detail = ''
        if (resp.body) {
          try {
            detail = await resp.text()
            const parsed = JSON.parse(detail) as { message?: string; msg?: string; error?: string }
            detail = parsed.message ?? parsed.msg ?? parsed.error ?? detail
          } catch {
            // 非 JSON 响应，保留原始文本（可能是 HTML 错误页，截断即可）
          }
        }
        const suffix = detail ? `：${detail.slice(0, 200)}` : ''
        throw new Error(`请求失败（HTTP ${resp.status}）${suffix}`)
      }
      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE 以空行分帧；保留最后一段不完整数据等待后续分片
        let sepIndex: number
        while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sepIndex)
          buffer = buffer.slice(sepIndex + 2)
          handleFrame(frame, handlers)
        }
      }
      // 收尾：处理末尾没有空行结束的最后一帧
      if (buffer.trim()) {
        handleFrame(buffer, handlers)
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

/** 解析单帧 SSE：提取 event 与 data 字段 */
function handleFrame(frame: string, handlers: StreamHandlers) {
  let eventType = 'message'
  const dataLines: string[] = []

  for (const rawLine of frame.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  if (dataLines.length === 0) return

  const raw = dataLines.join('\n')
  try {
    handlers.onEvent({ type: eventType, data: JSON.parse(raw) })
  } catch {
    handlers.onEvent({ type: eventType, data: raw })
  }
}
