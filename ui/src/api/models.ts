import http, { unwrap } from './request'

/** 模型卡片 */
export interface ModelCard {
  /** 模型 ID（调用时的 model 参数） */
  modelId: string
  description: string | null
  /** 接入方（厂商名称） */
  vendor: string | null
  /** 标签，逗号分隔 */
  tags: string | null
  /** 输入价格（美元 / token） */
  inputPrice: number | null
  /** 输出价格（美元 / token） */
  outputPrice: number | null
}

/** 模型卡片列表 */
export function listModels(keyword?: string) {
  return unwrap<ModelCard[]>(
    http.get('/api/v1/models', { params: keyword ? { keyword } : {} }),
  )
}

/** 价格换算展示：美元/token → $/1M tokens */
export function formatPrice(perToken: number | null): string {
  if (perToken == null) return '—'
  const perMillion = perToken * 1_000_000
  return `$${perMillion.toFixed(2)} / 1M tokens`
}
