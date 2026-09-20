/**
 * 专家头像图标注册表（To B 规范：专家头像不允许 emoji，一律用 lucide 线性图标）。
 *
 * `key` 是存进 experts.json avatar 字段的 kebab-case 图标名；
 * `label` 是图标选择器里的中文提示。渲染统一走 ExpertAvatar.vue。
 */
import type { Component } from 'vue'
import {
  Banknote,
  BookOpen,
  Briefcase,
  Building2,
  Calculator,
  ChartColumn,
  ChartPie,
  ClipboardList,
  Coins,
  Globe,
  Landmark,
  Scale,
  ScrollText,
  SearchCheck,
  Target,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-vue-next'

export interface ExpertIconOption {
  key: string
  label: string
  icon: Component
}

export const EXPERT_ICONS: ExpertIconOption[] = [
  { key: 'trending-up', label: '趋势', icon: TrendingUp },
  { key: 'chart-column', label: '柱状图', icon: ChartColumn },
  { key: 'chart-pie', label: '饼图', icon: ChartPie },
  { key: 'landmark', label: '银行', icon: Landmark },
  { key: 'scroll-text', label: '债券档案', icon: ScrollText },
  { key: 'calculator', label: '核算', icon: Calculator },
  { key: 'globe', label: '宏观', icon: Globe },
  { key: 'banknote', label: '资金', icon: Banknote },
  { key: 'clipboard-list', label: '经营清单', icon: ClipboardList },
  { key: 'search-check', label: '尽调', icon: SearchCheck },
  { key: 'book-open', label: '研究', icon: BookOpen },
  { key: 'briefcase', label: '商务', icon: Briefcase },
  { key: 'building', label: '企业', icon: Building2 },
  { key: 'coins', label: '财富', icon: Coins },
  { key: 'scale', label: '合规', icon: Scale },
  { key: 'target', label: '目标', icon: Target },
  { key: 'wallet', label: '钱包', icon: Wallet },
  { key: 'users', label: '团队', icon: Users },
]

/** 注册表里查不到的 avatar（含历史 emoji）一律兜底成 Briefcase */
export function resolveExpertIcon(key?: string): Component {
  const k = String(key || '').trim().toLowerCase()
  return (EXPERT_ICONS.find((i) => i.key === k) || EXPERT_ICONS.find((i) => i.key === 'briefcase')!).icon
}

/** 按专家分类配色：二级市场=蓝、一级市场与银行=琥珀、企业财务=翠绿，其余中性 */
export const EXPERT_CATEGORY_TINTS: Record<string, string> = {
  二级市场: 'bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-400',
  一级市场与银行: 'bg-amber-500/10 text-amber-600 dark:bg-amber-400/15 dark:text-amber-400',
  企业财务: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-400',
}
