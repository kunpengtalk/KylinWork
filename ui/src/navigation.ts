import type { Component } from 'vue'
import {
  Bell,
  Blocks,
  Bot,
  Brain,
  ChartColumn,
  Cloud,
  Cpu,
  FileText,
  FlaskConical,
  FolderOpen,
  Globe,
  HardDriveDownload,
  KeyRound,
  Keyboard,
  Library,
  Palette,
  Plug,
  Puzzle,
  Settings2,
  ShieldCheck,
  Sprout,
  SquarePen,
  Users,
} from 'lucide-vue-next'

/**
 * 导航的唯一事实来源。
 * <p>
 * 设置壳的左侧导航、以及侧边栏 ⌘K 命令面板的「页面」结果，以前各存一份页面清单——
 * 加一个设置页要改两处，漏一处就从命令面板里搜不到。现在都从这里派生。
 * <p>
 * 路径必须是**规范路径**（router/index.ts 里真实存在的那个），别指到重定向上去。
 */

export interface NavItem {
  label: string
  to: string
  icon?: Component
}

export interface NavGroup {
  group: string
  items: NavItem[]
}

/**
 * 主内容页（AppShell 之下）。要点：这些路径与 router/index.ts 的 children 一一对应；
 * 改路由时顺手改这里。带 ?tab= 的指向同一页的不同分区。
 */
export const MAIN_PAGES: NavItem[] = [
  { label: '工作空间', to: '/' },
  { label: '专家中心', to: '/experts' },
  { label: '技能', to: '/experts?tab=skills' },
  { label: '连接器', to: '/experts?tab=connectors' },
  { label: '自动化', to: '/automation' },
  { label: '提示词', to: '/prompts' },
  { label: '知识库', to: '/knowledge' },
  { label: '客户端设置', to: '/client-settings' },
]

/** 设置壳的分组导航。分组按「这东西属于哪件事」来划，不按历史包袱 */
export const SETTINGS_GROUPS: NavGroup[] = [
  {
    group: '应用',
    items: [
      { label: '通用', to: '/client-settings/general', icon: Settings2 },
      { label: '外观', to: '/client-settings/appearance', icon: Palette },
      { label: '通知', to: '/client-settings/notifications', icon: Bell },
      { label: '桌面与快捷键', to: '/client-settings/desktop', icon: Keyboard },
    ],
  },
  {
    group: '模型与智能体',
    items: [
      { label: '模型云服务', to: '/client-settings/models', icon: Cpu },
      { label: '联网搜索', to: '/client-settings/search', icon: Globe },
      { label: 'Agent', to: '/client-settings/agent', icon: Bot },
      { label: '专家', to: '/client-settings/experts', icon: Users },
      { label: '技能', to: '/client-settings/skills', icon: Blocks },
      { label: '连接器', to: '/client-settings/mcp', icon: Plug },
      { label: '频道', to: '/client-settings/channels', icon: SquarePen },
    ],
  },
  {
    group: '文件与数据',
    items: [
      { label: '工作目录', to: '/client-settings/workspace', icon: FolderOpen },
      { label: '知识库', to: '/client-settings/knowledge', icon: Library },
      { label: '成果文件', to: '/client-settings/files', icon: FileText },
      { label: '长期记忆', to: '/client-settings/memory', icon: Brain },
      { label: '备份与缓存', to: '/client-settings/data', icon: HardDriveDownload },
    ],
  },
  {
    group: '扩展',
    items: [
      { label: '插件', to: '/client-settings/plugins', icon: Puzzle },
      { label: '自进化', to: '/client-settings/evolve', icon: Sprout },
      { label: '回归评测', to: '/client-settings/eval', icon: FlaskConical },
    ],
  },
  {
    group: '云端（需登录）',
    items: [
      { label: '账号与模型', to: '/client-settings/account', icon: Cloud },
      { label: '获取密钥', to: '/client-settings/keys', icon: KeyRound },
      { label: '用量明细', to: '/client-settings/usage', icon: ChartColumn },
    ],
  },
  {
    group: '安全',
    items: [{ label: '安全中心', to: '/client-settings/security', icon: ShieldCheck }],
  },
]

/** 命令面板的页面索引：主内容页 + 设置各页，去掉重复的路径 */
export const PALETTE_PAGES: NavItem[] = (() => {
  const seen = new Set<string>()
  return [...MAIN_PAGES, ...SETTINGS_GROUPS.flatMap((g) => g.items)].filter((p) => {
    if (seen.has(p.to)) return false
    seen.add(p.to)
    return true
  })
})()
