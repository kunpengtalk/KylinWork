import { reactive, watch } from 'vue'

/**
 * 本机界面偏好（设置 → 通用）。
 * <p>
 * 以前这些选项只写进 localStorage 就没人读了——「侧边栏位置」「项目排序」
 * 这些控件看着能改，其实对界面毫无影响。改成一份共享的响应式真源：
 * 设置页写它，AppShell / AppSidebar / ChatView 读它，改完立刻生效。
 * 存储键沿用 kylinwork.general，老值照常读得到。
 */
const KEY = 'kylinwork.general'

export type SidebarSide = 'left' | 'right'
export type ProjectSort = 'manual' | 'name'
export type ThreadSort = 'recent' | 'created'

export interface UiPrefs {
  lang: string
  /** 新建对话的默认模式：craft / goal / ask / plan */
  defaultMode: string
  sidebarSide: SidebarSide
  projectSort: ProjectSort
  threadSort: ThreadSort
}

const DEFAULTS: UiPrefs = {
  lang: 'zh',
  defaultMode: 'craft',
  sidebarSide: 'left',
  projectSort: 'manual',
  threadSort: 'recent',
}

function read(): UiPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<UiPrefs>
    return { ...DEFAULTS, ...saved }
  } catch {
    return { ...DEFAULTS }
  }
}

export const uiPrefs = reactive<UiPrefs>(read())

// 写回：deep watch 覆盖「改一个字段」和「整份替换」两种用法
watch(uiPrefs, (v) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v))
  } catch {
    /* 存不下就算了，本次会话内仍然生效 */
  }
}, { deep: true })

/** 批量更新（设置页用它保存一个分区） */
export function saveUiPrefs(patch: Partial<UiPrefs>) {
  Object.assign(uiPrefs, patch)
}

/** 恢复默认（设置壳的「恢复默认」调它，不用去猜 localStorage 里有哪些键） */
export function resetUiPrefs() {
  Object.assign(uiPrefs, DEFAULTS)
}

export const UI_PREFS_KEY = KEY
