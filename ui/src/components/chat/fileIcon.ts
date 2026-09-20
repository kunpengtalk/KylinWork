/**
 * 成果文件的类型图标（设计对齐业界同类 Agent 产品的 artifact-icon）：
 * 列表里先认图标再认名字——同一列几十个文件，靠文字扫是扫不过来的。
 *
 * 视觉语言统一成"淡色底 + 同色系线性图标"的一枚小方块（对齐参考版文件卡的做法）：
 * 底色只是把类型区分开，真正承担辨识的是图标形状。以前只给图标上色、没有底衬，
 * 一排文件摆开就是一堆飘着的彩色小图，收进方框里整列反而安静得多。
 */
import {
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Globe,
  Presentation,
} from 'lucide-vue-next'
import type { Component } from 'vue'

export interface FileIconMeta {
  icon: Component
  /** 图标本身的颜色 */
  tone: string
  /** 图标底衬（淡色方块） */
  tint: string
}

const T = (icon: Component, tone: string, tint: string): FileIconMeta => ({ icon, tone, tint })

const BLUE_TONE = 'text-blue-600 dark:text-blue-400'
const BLUE_TINT = 'bg-blue-500/10 dark:bg-blue-400/15'

/** 顺序有意义：pdf 要排在 docx 前面（同色系但更像"文档"），html 排最前（它是主交付物） */
const MAP: [RegExp, FileIconMeta][] = [
  [/\.html?$/i, T(Globe, 'text-sky-600 dark:text-sky-400', 'bg-sky-500/10 dark:bg-sky-400/15')],
  [/\.pdf$/i, T(FileText, 'text-red-600 dark:text-red-400', 'bg-red-500/10 dark:bg-red-400/15')],
  [/\.(md|markdown|txt|log)$/i, T(FileText, BLUE_TONE, BLUE_TINT)],
  [/\.(docx?|rtf|odt)$/i, T(FileText, BLUE_TONE, BLUE_TINT)],
  [/\.(xlsx?|csv|tsv|numbers)$/i, T(FileSpreadsheet, 'text-emerald-600 dark:text-emerald-400', 'bg-emerald-500/10 dark:bg-emerald-400/15')],
  [/\.(pptx?|key)$/i, T(Presentation, 'text-amber-600 dark:text-amber-400', 'bg-amber-500/10 dark:bg-amber-400/15')],
  [/\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i, T(FileImage, 'text-violet-600 dark:text-violet-400', 'bg-violet-500/10 dark:bg-violet-400/15')],
  [/\.(mp4|mov|webm|mkv|avi|m4v)$/i, T(FileVideo, 'text-pink-600 dark:text-pink-400', 'bg-pink-500/10 dark:bg-pink-400/15')],
  [/\.(mp3|wav|m4a|aac|flac|ogg)$/i, T(FileAudio, 'text-purple-600 dark:text-purple-400', 'bg-purple-500/10 dark:bg-purple-400/15')],
  [/\.(zip|rar|7z|tar|gz|tgz)$/i, T(FileArchive, 'text-slate-500 dark:text-slate-400', 'bg-slate-500/10 dark:bg-slate-400/15')],
  [/\.(js|mjs|cjs|ts|tsx|jsx|vue|json|css|scss|less|py|sh|bash|ya?ml|xml|sql)$/i, T(FileCode2, 'text-orange-600 dark:text-orange-400', 'bg-orange-500/10 dark:bg-orange-400/15')],
]

export function fileMeta(name: string): FileIconMeta {
  const n = String(name || '')
  for (const [re, meta] of MAP) if (re.test(n)) return meta
  return { icon: FileIcon, tone: 'text-muted-foreground', tint: 'bg-muted' }
}
