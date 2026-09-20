import http, { unwrap } from './request'
import type { AppInfo, ExpertInfo, McpServerInfo, SkillInfo } from '@/types'

/** 启用中的业务应用列表 */
export function listApps() {
  return unwrap<AppInfo[]>(http.get('/api/v1/apps'))
}

/** 应用详情 */
export function getApp(appKey: string) {
  return unwrap<AppInfo>(http.get(`/api/v1/apps/${appKey}`))
}

/** 可用 MCP 服务 */
export function listMcpServers() {
  return unwrap<McpServerInfo[]>(http.get('/api/v1/integrations/mcp-servers'))
}

/** 可用技能 */
export function listSkills() {
  return unwrap<SkillInfo[]>(http.get('/api/v1/integrations/skills'))
}

/** 专家列表（专家 = 一组技能的集合容器） */
export function listExperts() {
  return unwrap<ExpertInfo[]>(http.get('/api/v1/integrations/experts'))
}

/** 平台能力开关 */
export function integrationStatus() {
  return unwrap<Record<string, unknown>>(http.get('/api/v1/integrations/status'))
}
