import http, { unwrap } from './request'
import type { DocCompare } from '@/types'

/** 对比任务列表 */
export function listCompares() {
  return unwrap<DocCompare[]>(http.get('/api/v1/doc-compares'))
}

/** 创建对比任务 */
export function createCompare(payload: {
  title?: string
  leftUrl?: string
  leftName?: string
  leftText?: string
  rightUrl?: string
  rightName?: string
  rightText?: string
}) {
  return unwrap<DocCompare>(http.post('/api/v1/doc-compares', payload))
}

/** 任务详情（含差异项） */
export function getCompare(id: number) {
  return unwrap<DocCompare>(http.get(`/api/v1/doc-compares/${id}`))
}

/** 执行对比 */
export function runCompare(id: number) {
  return unwrap<DocCompare>(http.post(`/api/v1/doc-compares/${id}/compare`))
}

/** 删除任务 */
export function deleteCompare(id: number) {
  return unwrap<null>(http.delete(`/api/v1/doc-compares/${id}`))
}
