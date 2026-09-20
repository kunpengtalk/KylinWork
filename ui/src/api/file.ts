import http, { unwrap } from './request'

/** 上传结果 */
export interface UploadResult {
  /** 相对访问路径（如 /2026/09/xxx.mp3），前端经网关前缀拼接为完整 URL */
  url: string
  filename: string | null
  size: number
  contentType: string | null
}

/**
 * 上传网页版应用素材（音频转写的录音、文档分析的文档等）。
 * 返回可回源的相对路径，直接作为创建录音的 fileUrl 使用。
 */
export async function uploadFile(file: File): Promise<UploadResult> {
  const form = new FormData()
  form.append('file', file)
  const res = await http.post('/api/v1/files/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return unwrap<UploadResult>(Promise.resolve(res))
}
