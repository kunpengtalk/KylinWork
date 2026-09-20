import http, { unwrap } from './request'

/** 单条消费记录 */
export interface UsageRecord {
  requestId: string
  model: string
  provider: string
  /** 脱敏后的 Key */
  apiKeyMasked: string
  callType: string
  logType: string
  apiStatus: number | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 单位：美元（ai-relay spend_logs.spend 的原始口径） */
  spend: number
  responseTimeMs: number | null
  createdAt: string
}

export interface UsagePage {
  items: UsageRecord[]
  total: number
  pageNum: number
  pageSize: number
}

export interface UsageStats {
  totalRequests: number
  /** 单位：美元 */
  totalSpend: number
  totalTokens: number
  successCount: number
  failureCount: number
  avgLatencyMs: number
  /** 成功率百分比 */
  successRate: number
}

/** 我的技能 */
export interface MySkill {
  id: number
  name: string
  displayName: string
  summary: string
  description: string
  category: string
  tags: string
  lifecycleStatus: string
  lifecycleStatusText: string
  visibility: string
  latestVersion: string
  scopeType: string
  currentUserPermission: string
  downloadCount: number
  viewCount: number
  starCount: number
  ratingAvg: number | null
  ratingCount: number
  ownerName: string
  createdAt: string
  updatedAt: string
}

/** 我的消费明细 */
export function myUsage(pageNum = 1, pageSize = 20) {
  return unwrap<UsagePage>(
    http.get('/api/v1/profile/usage', { params: { pageNum, pageSize } }),
  )
}

/** 我的用量聚合 */
export function myUsageStats() {
  return unwrap<UsageStats>(http.get('/api/v1/profile/usage/stats'))
}

/** 我创建的技能 */
export function mySkills() {
  return unwrap<MySkill[]>(http.get('/api/v1/profile/skills'))
}
