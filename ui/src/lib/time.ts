/**
 * 时间显示：任务列表用相对时间（「10天前」），消息用绝对时间（「9月14日 15:37」）。
 * 两种粒度各有各的用处——列表里扫的是"新旧"，单条消息要的是"什么时候发的"。
 * 时长格式化在 chat/toolMeta.ts，那边是给工具行用的，别在这里重复一份。
 */

/** 相对时间：刚刚 / 12分钟前 / 3小时前 / 10天前 / 4个月前 / 2年前 */
export function timeAgo(ts?: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  if (diff < 60_000) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min}分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day}天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month}个月前`
  return `${Math.floor(month / 12)}年前`
}

/** 绝对时间：今天只给时分，跨天给「M月D日 HH:mm」，跨年补上年份 */
export function formatStamp(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return `今天 ${hm}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/** 文件体积：与 ArtifactsPanel / 输入框 @ 候选保持同一套写法 */
export function formatSize(n?: number): string {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
