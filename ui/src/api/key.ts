import http, { unwrap } from './request'

/** API Key 视图（列表时明文已脱敏，仅创建响应带明文） */
export interface ApiKeyVO {
  id: number
  name: string
  /** 完整明文，仅在创建响应中返回一次 */
  key?: string
  /** 脱敏展示：sk-abcd…wxyz */
  maskedKey: string
  /** 渠道分组，决定该 Key 可用哪些模型 */
  group: string
  /** 1=启用 2=禁用 */
  status: number
  remainQuota: number | null
  usedQuota: number | null
  createdTime: number | null
  expiredTime: number | null
}

export interface KeyStats {
  total: number
  active: number
  inactive: number
  remainQuota: number
}

/**
 * 账户月度额度（人民币）。
 * 额度挂在账户上：账户名下的所有 Key 共享这一份额度，按自然月发放（每月 1 日重置已用）。
 */
export interface AccountQuota {
  userId: number
  platformUserId: number | null
  username: string
  /** 币种，固定 CNY */
  currency: string
  /** 本月额度（元） */
  monthlyQuota: number
  /** 本月已用（元） */
  usedQuota: number
  /** 本月剩余（元） */
  remainQuota: number
  /** 账期起始日 */
  periodStart: string
  /** 账期结束日 */
  periodEnd: string
  /** 下次发放日 */
  nextGrantDate: string
}

/** 我的 Key 列表 */
export function listApiKeys() {
  return unwrap<ApiKeyVO[]>(http.get('/api/v1/api-keys'))
}

/** 创建 Key（明文仅此一次返回） */
export function createApiKey(name?: string, group?: string) {
  return unwrap<ApiKeyVO>(http.post('/api/v1/api-keys', { name, group }))
}

/** 启停（status: 1=启用 2=禁用） */
export function updateApiKeyStatus(id: number, status: number) {
  return unwrap<null>(http.put(`/api/v1/api-keys/${id}/status`, { status }))
}

/** 删除 */
export function deleteApiKey(id: number) {
  return unwrap<null>(http.delete(`/api/v1/api-keys/${id}`))
}

/** 统计（我的） */
export function apiKeyStats() {
  return unwrap<KeyStats>(http.get('/api/v1/api-keys/statistics'))
}

/** 账户月度额度（我的，人民币） */
export function accountQuota() {
  return unwrap<AccountQuota>(http.get('/api/v1/api-keys/quota'))
}
