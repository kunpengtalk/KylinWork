import { http, httpAuth, unwrap } from './request'

/**
 * 平台（技能市场）侧的能力接口。
 * <p>
 * 与 engine.ts（本地引擎）是两套：这边的数据在服务器上，需要登录才能取。
 * 客户端的策略是「先本地、后平台」——没登录时本地技能照样能让引擎干活，
 * 登录后把技能市场上的技能、专家、连接器一并接进来。
 */

/** 技能市场上的技能 */
export interface PlatformSkill {
  id: number
  name: string
  displayName: string
  summary: string
  category: string
  latestVersion: string
  latestVersionId: number
}

/** 平台专家（技能集合容器） */
export interface PlatformExpert {
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

/** 平台 MCP 服务 */
export interface PlatformMcp {
  id: number
  name: string
  displayName: string
  description: string
  protocol: string
  status: string
  toolCount: number
  tools: { toolName: string; description: string; riskLevel: string }[]
}

/** 技能市场技能列表（需登录） */
export function listPlatformSkills() {
  return unwrap<PlatformSkill[]>(http.get('/api/v1/integrations/skills'))
}

/** 平台模型广场（需登录）：登录后这些模型以「平台模型」提供方出现在模型选择器里 */
export interface PlatformModel {
  /** 真实返回的主字段是 modelId（/api/v1/models 的 schema 以它为主键） */
  modelId?: string
  id?: number | string
  name?: string
  displayName?: string
  provider?: string
  description?: string
  vendor?: string
  [k: string]: unknown
}

export function listPlatformModels(keyword?: string) {
  return unwrap<PlatformModel[]>(
    http.get('/api/v1/models', { params: keyword ? { keyword } : {} }),
  )
}

/**
 * 技能市场技能正文（需登录）。
 * <p>
 * 后端已实现：GET /client-api/api/v1/integrations/skills/{id}/content，
 * 返回 SKILL.md Markdown 正文 + 元数据。客户端拿到正文后存成本地技能
 * （走 /api/skills），引擎的 use_skill 就能真正加载执行。
 * 字段用宽松类型：不同版本可能叫 content / markdown / skillMd。
 */
export function getPlatformSkillContent(id: number) {
  return unwrap<Record<string, unknown>>(http.get(`/api/v1/integrations/skills/${id}/content`))
}

/** 平台专家列表（需登录） */
export function listPlatformExperts() {
  return unwrap<PlatformExpert[]>(http.get('/api/v1/integrations/experts'))
}

/** 平台 MCP 服务列表（需登录） */
export function listPlatformMcpServers() {
  return unwrap<PlatformMcp[]>(http.get('/api/v1/integrations/mcp-servers'))
}

/** 平台能力开关：用来判断当前账号能用哪些平台能力 */
export function platformIntegrationStatus() {
  return unwrap<Record<string, unknown>>(http.get('/api/v1/integrations/status'))
}

// ==================== 一次性 code 登录（后端已实现并部署） ====================

/** exchange 返回的登录结果（与后端 /auth-api/oauth/exchange 对齐） */
export interface PlatformLoginResult {
  token: string
  loginName: string
  actualName: string
  employeeId?: number | null
  avatar?: string | null
  phone?: string | null
  departmentId?: number | null
  departmentName?: string | null
  administratorFlag?: boolean
  [k: string]: unknown
}

/**
 * 一次性 code 换正式令牌。
 * <p>
 * 这是安全登录方案的第二步：平台登录页签发 5 分钟的一次性 code，
 * 客户端拿它到这个**匿名白名单**接口换 token。code 用后即焚，重复使用会被拒。
 * 优点：正式令牌不出现在浏览器地址栏 / 系统历史里。
 */
export function exchangeCode(code: string) {
  return unwrap<PlatformLoginResult>(httpAuth.post('/auth-api/oauth/exchange', { code }))
}
