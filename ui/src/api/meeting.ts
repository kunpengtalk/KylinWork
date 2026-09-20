import http, { unwrap } from './request'
import type { Speech, SpeechAnalyse, SpeechCat } from '@/types'

/** 语音记录列表 */
export function listSpeeches(catId?: number) {
  return unwrap<Speech[]>(http.get('/api/v1/meetings', { params: catId ? { catId } : {} }))
}

/** 创建语音记录 */
export function createSpeech(payload: {
  title?: string
  fileUrl?: string
  fileName?: string
  catId?: number
}) {
  return unwrap<Speech>(http.post('/api/v1/meetings', payload))
}

/** 语音记录详情（含段落与纪要） */
export function getSpeech(id: number) {
  return unwrap<Speech>(http.get(`/api/v1/meetings/${id}`))
}

/** 触发转写 */
export function transcribeSpeech(id: number) {
  return unwrap<Speech>(http.post(`/api/v1/meetings/${id}/transcribe`))
}

/** 手动保存转写文本 */
export function updateTranscript(id: number, transcript: string) {
  return unwrap<Speech>(http.put(`/api/v1/meetings/${id}/transcript`, { transcript }))
}

/** 生成纪要 */
export function analyseSpeech(id: number) {
  return unwrap<SpeechAnalyse[]>(http.post(`/api/v1/meetings/${id}/analyse`))
}

/** 删除语音记录 */
export function deleteSpeech(id: number) {
  return unwrap<null>(http.delete(`/api/v1/meetings/${id}`))
}

/** 话术分类列表 */
export function listSpeechCats() {
  return unwrap<SpeechCat[]>(http.get('/api/v1/meetings/cats'))
}

/** 新增话术分类 */
export function createSpeechCat(name: string, description?: string) {
  return unwrap<SpeechCat>(http.post('/api/v1/meetings/cats', { name, description }))
}

/** 删除话术分类 */
export function deleteSpeechCat(id: number) {
  return unwrap<null>(http.delete(`/api/v1/meetings/cats/${id}`))
}
