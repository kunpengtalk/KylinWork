/**
 * 工具调用的一句人话。
 *
 * 设计对齐业界同类 Agent 产品的 capability-call-line：工具在界面上不应该是 `run_shell` 这种机器名，
 * 也不该一上来就把几百行输出糊在屏幕上——默认只给「做了什么」的一句话 + 耗时，
 * 原始入参和结果收在展开区里，想看才看。
 *
 * 所以这里维护两张表：图标（一眼分辨读写执行联网）和动词（拼成中文短句）。
 */
import {
  BookOpen,
  Bot,
  Bug,
  Code2,
  Eye,
  FileSearch,
  FileText,
  FolderTree,
  Globe,
  HelpCircle,
  Image as ImageIcon,
  PencilLine,
  Save,
  Search,
  Share2,
  Sparkles,
  Terminal,
  Trash2,
  Users,
  Video,
  Volume2,
  Wrench,
} from 'lucide-vue-next'
import type { Component } from 'vue'

/** 图标配色按"这类动作会不会改动东西"分：只读冷静色、写入暖色、执行警示色 */
export type ToolKind = 'read' | 'write' | 'exec' | 'net' | 'media' | 'memory' | 'delegate' | 'ask' | 'other'

interface ToolMeta {
  /** 中文动词，拼成「读了 xxx」这种短句 */
  verb: string
  icon: Component
  kind: ToolKind
  /** 从 input_preview 里取什么当宾语；none = 只说动词（代码、长文本不适合当标题） */
  obj: 'path' | 'cmd' | 'url' | 'query' | 'text' | 'none'
}

const M = (verb: string, icon: Component, kind: ToolKind, obj: ToolMeta['obj'] = 'text'): ToolMeta => ({ verb, icon, kind, obj })

export const TOOL_META: Record<string, ToolMeta> = {
  // 读写文件
  read_file: M('读取', FileText, 'read', 'path'),
  write_file: M('写入', PencilLine, 'write', 'path'),
  edit_file: M('修改', PencilLine, 'write', 'path'),
  list_files: M('查看目录', FolderTree, 'read', 'none'),
  search_files: M('搜索代码', FileSearch, 'read', 'query'),
  // 执行
  run_node: M('跑代码', Code2, 'exec', 'none'),
  run_shell: M('执行命令', Terminal, 'exec', 'cmd'),
  check_page: M('验收网页', Bug, 'exec', 'path'),
  // 联网
  web_search: M('搜索', Search, 'net', 'query'),
  fetch_url: M('抓取', Globe, 'net', 'url'),
  render_page: M('渲染页面', Globe, 'net', 'url'),
  // 产出
  gen_diagram: M('画图', Sparkles, 'media', 'none'),
  generate_image: M('生成图片', ImageIcon, 'media', 'none'),
  generate_video: M('生成视频', Video, 'media', 'none'),
  html_to_image: M('网页转图', ImageIcon, 'media', 'path'),
  text_to_speech: M('配音', Volume2, 'media', 'none'),
  feishu_doc_create: M('建飞书文档', Share2, 'media', 'none'),
  // 记忆与资料库
  remember: M('记住', Save, 'memory', 'text'),
  forget: M('忘掉', Trash2, 'memory', 'text'),
  library_list: M('查资料库', BookOpen, 'read', 'none'),
  library_read: M('读资料', BookOpen, 'read', 'path'),
  knowledge_search: M('检索知识库', BookOpen, 'read', 'text'),
  look_at_image: M('看图', Eye, 'read', 'path'),
  // 协作
  use_skill: M('加载技能', Sparkles, 'read', 'text'),
  save_skill: M('保存技能', Save, 'write', 'text'),
  ask_user: M('问你一个问题', HelpCircle, 'ask', 'none'),
  delegate_to_expert: M('委派专家', Users, 'delegate', 'text'),
  delegate_to_team: M('交给专家团', Users, 'delegate', 'text'),
  desktop_pet: M('桌面宠物', Bot, 'other', 'none'),
}

export const FALLBACK_META: ToolMeta = { verb: '调用', icon: Wrench, kind: 'other', obj: 'text' }

export function metaOf(name: string): ToolMeta {
  return TOOL_META[name] || FALLBACK_META
}

/**
 * 工具图标的配色：**统一单色**（对齐参考版的做法）。
 *
 * 以前按"这类动作会不会改动东西"给读/写/执行/联网分别上蓝/绿/橙/紫，单看一行挺清楚，
 * 但一轮任务动不动二十来行工具调用，铺开就是一屏彩虹，反而没人能沿线扫下来。
 * 动作的区分交给**图标形状**（读=文档、写=笔、执行=终端、联网=地球、委派=双人），
 * 颜色只留给真正需要跳出来的状态：失败（红）、正在跑（转圈）。
 */
export const KIND_TONE: Record<ToolKind, string> = {
  read: 'text-muted-foreground',
  write: 'text-muted-foreground',
  exec: 'text-muted-foreground',
  net: 'text-muted-foreground',
  media: 'text-muted-foreground',
  memory: 'text-muted-foreground',
  delegate: 'text-muted-foreground',
  ask: 'text-muted-foreground',
  other: 'text-muted-foreground',
}

/** 宾语清洗：去掉换行压成一行，按类型裁剪长度 */
function cleanObject(raw: string, obj: ToolMeta['obj'], max: number): string {
  let s = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  // 原始 JSON 不配当标题（{"depth":1} 这种），一句动词短语比它可读得多
  if (/^[{[]/.test(s) && /["':]/.test(s)) return ''
  if (obj === 'url') {
    // https://example.com/a/b?x=1 → example.com/a/b —— 协议和查询串对人不重要
    try {
      const u = new URL(s)
      s = u.host + (u.pathname === '/' ? '' : u.pathname)
    } catch {
      s = s.replace(/^https?:\/\//, '')
    }
    return s.length > 48 ? s.slice(0, 48) + '…' : s
  }
  if (obj === 'path') {
    // 只留文件名：路径前缀在界面上一眼扫不出信息，还占满一行
    const tail = s.split(/[/\\]/).filter(Boolean).pop() || s
    return tail.length > max ? tail.slice(0, max) + '…' : tail
  }
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * 拼一句话。优先用模型自己写的 purpose（它最清楚这一步想干嘛），
 * 没有再退化成「动词 + 宾语」——退化句式必须仍然读得通。
 */
export function describeTool(name: string, inputPreview?: string, purpose?: string): string {
  const meta = metaOf(name)
  const p = String(purpose || '').replace(/\s+/g, ' ').trim()
  if (p) return p.length > 64 ? p.slice(0, 64) + '…' : p
  if (meta.obj === 'none') return meta.verb
  const obj = cleanObject(String(inputPreview || ''), meta.obj, meta.obj === 'cmd' ? 56 : 40)
  return obj ? `${meta.verb} ${obj}` : meta.verb
}

/** 耗时：1.2s / 340ms / 2m05s，等宽数字对齐 */
export function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return ''
  if (ms < 1000) return `${Math.max(10, Math.round(ms / 10) * 10)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}m${String(s).padStart(2, '0')}s`
}

/**
 * 正在跑的那一步，行下面跟的那句实时说明（对齐参考版的「搜索网页中…」「正在执行命令」）。
 * <p>
 * 为什么不直接用 describeTool：那个是**过去式**（"搜索了 xxx"、"运行了 xxx"），用来总结已完成的一步；
 * 用户盯着一个静止的页面时想知道的是"它现在卡在哪一步"，所以这里给的是现在进行时，
 * 而且越具体越好——把正在搜的关键词、正在写的文件名摆出来，"它还在动"才看得见。
 */
export function liveHint(name: string, inputPreview?: string, purpose?: string): string {
  const meta = metaOf(name)
  const obj = cleanObject(String(inputPreview || ''), meta.obj, 60)
  const withObj = (verb: string) => (obj ? `${verb} ${obj}` : verb)
  switch (name) {
    case 'web_search':
      return withObj('搜索网页中…')
    case 'fetch_url':
      return withObj('抓取网页中…')
    case 'render_page':
      return '渲染网页中…'
    case 'run_shell':
      return '正在执行命令'
    case 'run_node':
      return '正在运行代码'
    case 'check_page':
      return '正在验收网页'
    case 'read_file':
      return withObj('正在读取')
    case 'write_file':
    case 'edit_file':
      return withObj('正在写入')
    case 'list_files':
      return '正在查看目录'
    case 'search_files':
      return withObj('搜索代码中…')
    case 'gen_diagram':
    case 'generate_image':
      return '正在生成图片'
    case 'generate_video':
      return '正在生成视频'
    case 'html_to_image':
      return withObj('正在转成图片')
    case 'text_to_speech':
      return '正在配音'
    case 'use_skill':
      return withObj('正在加载技能')
    case 'delegate_to_expert':
    case 'delegate_to_team':
      return withObj('正在委派专家')
    case 'ask_user':
      return '等待你的回答'
    default:
      // 兜底用模型自己写的 purpose（最贴切），再不行才是机械的「动词中…」
      if (purpose) return purpose.length > 60 ? purpose.slice(0, 60) + '…' : purpose
      return `${meta.verb}中…`
  }
}
