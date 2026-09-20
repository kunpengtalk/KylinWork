import { toast } from 'vue-sonner'

/**
 * 复制文本到剪贴板并给出反馈。
 * <p>
 * 浏览器在非 HTTPS / 非用户手势场景下可能拒绝剪贴板权限，此时降级提示手动复制，
 * 而不是静默失败——否则用户会以为"复制没生效"。
 */
export async function copyText(text: string, successMessage = '已复制到剪贴板') {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    toast.success(successMessage)
  } catch {
    toast.error('复制失败，请手动选中复制')
  }
}
