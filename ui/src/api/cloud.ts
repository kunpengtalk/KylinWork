import { httpEngine } from './request'

/**
 * 模型云服务：服务商（渠道）目录 / Key / 模型清单。
 * <p>
 * 后端把「启用且配好的服务商」物化成引擎的渠道（config.models），
 * 所以这里只管服务商这一层；引擎照旧按渠道跑。
 */

export type CloudKind = 'chat' | 'embedding' | 'rerank'

export interface CloudModelEntry {
  id: string
  type?: CloudKind
}

export interface CloudProvider {
  id: string
  preset_id: string
  name: string
  vendor: string
  base_url: string
  api_key: string
  has_key: boolean
  models: CloudModelEntry[]
  enabled: boolean
  kind: CloudKind
  provider: 'openai' | 'anthropic'
  color: string
  section: string
  builtin: boolean
  note: string
  api_key_url: string
  /** 配好了没有：有 Key（或本地地址）且至少一个模型 */
  configured: boolean
  /** 内置服务商的官方地址锁死，不可改 */
  base_locked: boolean
  is_default_base: boolean
  local: boolean
}

export interface CloudState {
  ok: boolean
  sections: string[]
  labels: Record<string, string>
  providers: CloudProvider[]
  active_model: string
  active_model_id: string
}

export function cloudList() {
  return httpEngine.get<CloudState>('/cloud/providers').then((r) => r.data)
}

/** 新建：给 preset_id 按内置预设建，否则按 name/base_url 建自定义 */
export function cloudCreate(body: {
  preset_id?: string
  name?: string
  base_url?: string
  api_key?: string
  models?: (string | CloudModelEntry)[]
  enabled?: boolean
  kind?: CloudKind
  provider?: 'openai' | 'anthropic'
}) {
  return httpEngine.post<CloudState>('/cloud/providers', body).then((r) => r.data)
}

export function cloudUpdate(
  id: string,
  patch: {
    name?: string
    base_url?: string
    api_key?: string
    models?: (string | CloudModelEntry)[]
    enabled?: boolean
    kind?: CloudKind
    provider?: 'openai' | 'anthropic'
  },
) {
  return httpEngine.post<CloudState>(`/cloud/providers/${encodeURIComponent(id)}`, patch).then((r) => r.data)
}

export function cloudDelete(id: string) {
  return httpEngine.delete<CloudState>(`/cloud/providers/${encodeURIComponent(id)}`).then((r) => r.data)
}

/** 检查连接：拉一次 /models，看地址和 Key 认不认 */
export function cloudCheck(body: { id?: string; base_url?: string; api_key?: string; provider?: string }) {
  return httpEngine.post<{ ok: boolean; count?: number; error?: string }>('/cloud/check', body).then((r) => r.data)
}

/** 拉远端模型清单（可对还没保存的新输入直接测） */
export function cloudFetchModels(body: { id?: string; base_url?: string; api_key?: string; provider?: string }) {
  return httpEngine.post<{ ok: boolean; models?: string[]; error?: string }>('/cloud/models', body).then((r) => r.data)
}

export const KIND_LABEL: Record<CloudKind, string> = {
  chat: '对话',
  embedding: '向量 Embedding',
  rerank: '重排 Reranker',
}
