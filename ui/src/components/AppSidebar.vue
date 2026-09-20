<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  Blocks,
  Bot,
  BookOpen,
  ChevronDown,
  CircleAlert,
  Clock,
  Database,
  Folder,
  Loader2,
  MessageSquare,
  Plus,
  SquarePen,
  Trash2,
} from 'lucide-vue-next'
import { getInfo, pickFolder } from '@/api/client'
import {listEngineSkills, listProjects, createProject, switchProject, deleteProject, DEFAULT_PROJECT} from '@/api/engine'
import AccountBar from '@/components/sidebar/AccountBar.vue'
import { toast } from 'vue-sonner'
import { uiPrefs } from '@/composables/useUiPrefs'
import { PALETTE_PAGES } from '@/navigation'
import { readSessions, removeSessionById, SESSIONS_CHANGED, type SessionMeta } from '@/composables/useSessions'
import { forgetRun, runningSessions } from '@/composables/useChatRuns'
import { timeAgo } from '@/lib/time'

/**
 * 左侧导航 —— 品牌 → 新建/搜索 → 功能导航（助理·专家·自动化·参考模板）
 * → 平台（登录后）→ 「任务」会话历史 → 工作空间 → 底部设置。
 */
const emit = defineEmits<{
  (e: 'navigate'): void
  (e: 'new-task'): void
  (e: 'open-session', id: string): void
}>()

const router = useRouter()
/** 构建时注入的应用版本（见 vite.config.ts 的 define），避免界面上写死版本号后忘记改 */
const APP_VERSION = __APP_VERSION__


// ---------- 搜索：会话 / 页面 / 技能 三组全局结果 ----------
const searchOpen = ref(false)
const searchKw = ref('')
const searchSkills = ref<{ name: string; description?: string }[]>([])

/** 命令面板的页面索引：与 设置 的左侧导航同源（src/navigation.ts），加页面不用改两处 */
const searchPages = PALETTE_PAGES

const pageHits = computed(() => {
  const k = searchKw.value.trim().toLowerCase()
  if (!k) return []
  return searchPages.filter((p) => p.label.toLowerCase().includes(k)).slice(0, 5)
})
const skillHits = computed(() => {
  const k = searchKw.value.trim().toLowerCase()
  if (!k) return []
  return searchSkills.value
    .filter((s) => s.name.toLowerCase().includes(k) || (s.description || '').toLowerCase().includes(k))
    .slice(0, 5)
})

// 搜索框常驻：第一次输入时才拉技能列表（惰性加载，不拖慢启动）
watch(searchKw, (v) => {
  if (v && !searchSkills.value.length) {
    void listEngineSkills()
      .then((s) => (searchSkills.value = (s || []) as { name: string; description?: string }[]))
      .catch(() => {})
  }
})

function goPage(to: string) {
  searchOpen.value = false
  searchKw.value = ''
  emit('navigate')
  router.push(to)
}

// ---------- 全局搜索面板（⌘K 命令面板式） ----------
const searchInputEl = ref<HTMLInputElement | null>(null)
const activeIdx = ref(0)

interface SearchHit {
  key: string
  kind: 'session' | 'page' | 'skill'
  label: string
  desc?: string
  run: () => void
}

/** 扁平化结果：会话 + 页面 + 技能，供键盘 ↑↓ 统一导航 */
const flatResults = computed<SearchHit[]>(() => {
  const out: SearchHit[] = []
  for (const s of filteredSessions.value.slice(0, 8)) {
    out.push({
      key: 's_' + s.id,
      kind: 'session',
      label: s.title,
      run: () => {
        searchOpen.value = false
        searchKw.value = ''
        emit('open-session', s.id)
      },
    })
  }
  for (const p of pageHits.value) {
    out.push({ key: 'p_' + p.to, kind: 'page', label: p.label, run: () => goPage(p.to) })
  }
  for (const s of skillHits.value) {
    out.push({
      key: 'k_' + s.name,
      kind: 'skill',
      label: s.name,
      desc: s.description,
      run: () => goPage('/experts?tab=skills'),
    })
  }
  return out
})

watch([searchKw, searchOpen], () => (activeIdx.value = 0))

function openSearch() {
  searchOpen.value = true
  void nextTick(() => searchInputEl.value?.focus())
}

function onSearchKey(e: KeyboardEvent) {
  const n = flatResults.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIdx.value = n ? Math.min(activeIdx.value + 1, n - 1) : 0
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIdx.value = Math.max(activeIdx.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    flatResults.value[activeIdx.value]?.run()
  } else if (e.key === 'Escape') {
    searchOpen.value = false
  }
}

function onGlobalKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    if (searchOpen.value) searchOpen.value = false
    else openSearch()
  }
}

// ---------- 项目（线程区） ----------
/** 工作空间：dir 可能为空（没选目录的项目要能展示，但不能切换过去） */
interface Project {
  name: string
  dir?: string
}
const projects = ref<Project[]>([])
const activeProject = ref(DEFAULT_PROJECT)

async function loadProjects() {
  try {
    projects.value = await listProjects()
  } catch {
    projects.value = []
  }
}

/** 选择本地文件夹 → 以目录名创建工作空间（名字跟目录走），并切过去 */
async function pickProjectFolder() {
  try {
    const r = await pickFolder()
    const dir = r?.dir || r?.path
    if (!dir) return
    const name = dir.split('/').filter(Boolean).pop() || 'workspace'
    await createProject({ name, dir })
    await loadProjects()
    activeProject.value = name
    emit('navigate')
    // 通知对话框那边同步工作空间列表
    window.dispatchEvent(new CustomEvent('kylinwork:projects-changed', { detail: { active: name } }))
    toast.success(`已创建工作空间「${name}」`)
  } catch (e) {
    toast.error('创建失败：' + (e as Error).message)
  }
}

async function pickProject(name: string) {
  activeProject.value = name
  try {
    await switchProject(name)
  } catch {
    /* 切换失败不影响本地高亮 */
  }
  emit('navigate')
}

/**
 * 删除工作空间，两种方式让用户选：
 * - 仅从列表移除：本地文件夹原样保留
 * - 连本地文件夹一起删：引擎端递归删目录（有系统目录保护），不可恢复
 */
async function removeProject(name: string, purge: boolean) {
  delMenuFor.value = null
  if (purge && !window.confirm(`把工作空间「${name}」的本地文件夹连同里面所有文件一起删除？\n此操作不可恢复！`)) return
  try {
    const r = (await deleteProject(name, purge)) as { purged?: boolean }
    toast.success(purge ? '已删除工作空间及本地文件夹' : '已从列表移除（本地文件保留）')
    void r
    await loadProjects()
  } catch (e) {
    toast.error('删除失败：' + (e as Error).message)
  }
}

// ---------- 聊天（会话历史，与 ChatView 共用 localStorage） ----------
const sessions = ref<SessionMeta[]>([])

/** 列表默认展开：参考版那两个「任务 (n) / 空间 (n)」是可收起的，收起后侧栏才腾得出地方 */
const tasksOpen = ref(true)
const spacesOpen = ref(true)

function loadSessions() {
  sessions.value = readSessions().filter((s) => (s.project || DEFAULT_PROJECT) === activeProject.value)
}

/** 排序：按设置 → 通用里选的「线程排序」（最近活跃 / 创建时间） */
function sortSessions(list: SessionMeta[]): SessionMeta[] {
  const byCreated = (s: SessionMeta) => s.createdAt || s.updatedAt || 0
  const key = uiPrefs.threadSort === 'created' ? byCreated : (s: SessionMeta) => s.updatedAt || 0
  return [...list].sort((a, b) => key(b) - key(a))
}

const filteredSessions = computed(() => {
  const k = searchKw.value.trim().toLowerCase()
  const list = k ? sessions.value.filter((s) => s.title.toLowerCase().includes(k)) : sessions.value
  return sortSessions(list)
})

/**
 * 正在跑的任务 id。
 * <p>
 * 读的是运行态 store 而不是引擎接口：任务可以在别的会话里、甚至用户已经切到别的页面之后
 * 还在跑，侧栏得照样能标出来——否则「多任务」就只是一句空话，用户根本不知道有几个在跑。
 */
const runningIds = computed(() => new Set(runningSessions()))

function removeSession(id: string) {
  if (!window.confirm('删除该任务及其对话记录？')) return
  // 正在跑的先掐掉再删记录，不然事件还会往一个已经删掉的会话里写
  forgetRun(id)
  removeSessionById(id) // 写入会广播 sessions-changed，loadSessions 挂在那个事件上，这里不用再手动刷
}

// ---------- 环境 / 账号 ----------
const env = ref<{ environment?: string; platform?: string }>({})


onMounted(() => {
  loadProjects()
  loadSessions()
  window.addEventListener(SESSIONS_CHANGED, loadSessions)
  window.addEventListener('kylinwork:projects-changed', onProjectsChanged)
  window.addEventListener('keydown', onGlobalKey)
  void (async () => {
    try {
      env.value = await getInfo()
    } catch {
      /* 读不到就不显示 */
    }
  })()
})

/** 对话框里新建/切换了工作空间 → 这里同步列表和高亮 */
function onProjectsChanged(e: Event) {
  const active = (e as CustomEvent).detail?.active as string | undefined
  void loadProjects().then(() => {
    if (active) activeProject.value = active
  })
}

onUnmounted(() => {
  window.removeEventListener(SESSIONS_CHANGED, loadSessions)
  window.removeEventListener('kylinwork:projects-changed', onProjectsChanged)
  window.removeEventListener('keydown', onGlobalKey)
})

// ---------- 删除二选一菜单：当前展开的是哪个工作空间 ----------
const delMenuFor = ref<string | null>(null)
/** 检索：任务与工作空间共用一个关键词；没有目录或没名字的空间一律不展示。
 *  排序跟着设置 → 通用的「项目排序」走（手动 = 保持引擎返回的顺序）。 */
const filteredProjects = computed(() => {
  const list = projects.value.filter((p) => String(p.name || '').trim() && String(p.dir || '').trim())
  const k = searchKw.value.trim().toLowerCase()
  const matched = k ? list.filter((p) => p.name.toLowerCase().includes(k)) : list
  if (uiPrefs.projectSort === 'name') {
    return [...matched].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }
  return matched
})

</script>

<template>
  <div class="relative flex h-full flex-col bg-[#fafafa] dark:bg-card/40">
    <!-- 全局搜索面板（⌘K 命令面板，居中大框） -->
    <div v-if="searchOpen" class="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px]" @click="searchOpen = false" />
    <Teleport to="body">
      <div
        v-if="searchOpen"
        class="fixed left-1/2 top-[14%] z-50 w-[min(92vw,640px)] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl"
      >
        <div class="flex items-center gap-3 border-b border-border/70 px-5">
          <Search class="size-[18px] shrink-0 text-muted-foreground" />
          <input
            ref="searchInputEl"
            v-model="searchKw"
            placeholder="搜索对话记录、页面、技能…"
            class="h-16 w-full bg-transparent text-lg outline-none placeholder:text-muted-foreground"
            @keydown="onSearchKey"
          >
          <button
            class="shrink-0 rounded-md border border-border px-2 py-1 text-[14px] text-muted-foreground transition-colors hover:bg-accent"
            title="关闭"
            @click="searchOpen = false"
          >
            esc
          </button>
        </div>

      <div class="max-h-[340px] overflow-y-auto p-1.5">
        <template v-if="searchKw.trim()">
          <template v-for="(r, i) in flatResults" :key="r.key">
            <p
              v-if="i === 0 || flatResults[i - 1]!.kind !== r.kind"
              class="px-2 pb-1 pt-1.5 text-[12px] font-medium text-muted-foreground"
            >
              {{ r.kind === 'session' ? '对话' : r.kind === 'page' ? '页面' : '技能' }}
            </p>
            <button
              class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors"
              :class="i === activeIdx ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'"
              :ref="i === activeIdx ? (el) => (el as HTMLElement)?.scrollIntoView({ block: 'nearest' }) : undefined"
              @mousemove="activeIdx = i"
              @click="r.run()"
            >
              <MessageSquare v-if="r.kind === 'session'" class="size-3.5 shrink-0 text-muted-foreground" />
              <SquarePen v-else-if="r.kind === 'page'" class="size-3.5 shrink-0 text-muted-foreground" />
              <Blocks v-else class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate text-[14px]">{{ r.label }}</span>
              <span v-if="r.desc" class="max-w-36 shrink-0 truncate text-[14px] text-muted-foreground">{{ r.desc }}</span>
            </button>
          </template>
          <p v-if="!flatResults.length" class="px-2 py-8 text-center text-xs text-muted-foreground">
            没有匹配结果
          </p>
        </template>
        <template v-else>
          <p class="px-2 pb-1 pt-1.5 text-[12px] font-medium text-muted-foreground">最近对话</p>
          <button
            v-for="s in filteredSessions.slice(0, 5)"
            :key="s.id"
            class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent/60"
            @click="
              searchOpen = false;
              emit('open-session', s.id)
            "
          >
            <MessageSquare class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate text-[14px]">{{ s.title }}</span>
          </button>
          <p v-if="!filteredSessions.length" class="px-2 py-6 text-center text-xs text-muted-foreground">
            还没有对话记录，输入关键词搜索页面与技能
          </p>
        </template>
      </div>

      <div class="flex items-center gap-3 border-t border-border/70 px-3.5 py-1.5 text-[12px] text-muted-foreground">
        <span>↑↓ 切换</span>
        <span>↵ 打开</span>
        <span>esc 关闭</span>
        <span class="ml-auto">⌘K 唤起</span>
      </div>
    </div>
    </Teleport>
    <!-- 品牌 -->
    <div class="px-4 pt-4 pb-3">
      <div class="flex items-center gap-2">
        <img src="/icon.png" alt="KylinWork" class="size-5 rounded-md" />
        <p class="text-[15px] font-bold tracking-tight">
          KylinWork <span class="text-[13px] font-normal text-muted-foreground">v{{ APP_VERSION }}</span>
        </p>
      </div>
      <p v-if="env.environment" class="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="env.environment === 'prod' ? 'bg-red-500' : 'bg-amber-500'"
        />
        {{ env.environment === 'prod' ? '生产环境' : '测试环境' }}
      </p>
    </div>

    <!-- 新任务 -->
    <div class="px-3 pb-2">
      <button
        class="flex w-full items-center gap-2.5 rounded-md bg-primary/90 px-2.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary"
        @click="emit('new-task')"
      >
        <SquarePen class="size-4" /> 新任务
      </button>
    </div>

    <!-- 滚动主体：任务 / 工作空间 / 功能导航 -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <!-- 功能导航 -->
      <nav class="space-y-0.5 px-3 pb-2 pt-4">
      <RouterLink
        class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground/90 transition-colors hover:bg-accent"
        to="/assistant"
        @click="emit('navigate')"
      >
        <MessageSquare class="size-4 text-muted-foreground" />
        助理
      </RouterLink>
      <RouterLink
        class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground/90 transition-colors hover:bg-accent"
        to="/experts"
        @click="emit('navigate')"
      >
        <Bot class="size-4 text-muted-foreground" />
        专家广场
      </RouterLink>
      <RouterLink
        class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground/90 transition-colors hover:bg-accent"
        to="/experts?tab=skills"
        @click="emit('navigate')"
      >
        <Blocks class="size-4 text-muted-foreground" />
        专家·技能·连接器
      </RouterLink>
      <RouterLink
        class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground/90 transition-colors hover:bg-accent"
        to="/automation"
        @click="emit('navigate')"
      >
        <Clock class="size-4 text-muted-foreground" />
        自动化
      </RouterLink>
      <RouterLink
        class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground/90 transition-colors hover:bg-accent"
        to="/prompts"
        @click="emit('navigate')"
      >
        <BookOpen class="size-4 text-muted-foreground" />
        提示词
      </RouterLink>
      <RouterLink
        class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground/90 transition-colors hover:bg-accent"
        to="/knowledge"
        @click="emit('navigate')"
      >
        <Database class="size-4 text-muted-foreground" />
        知识库
      </RouterLink>
    </nav>

      <!-- 任务：跑在默认工作空间里的会话 -->
      <div class="px-3 pt-3">
        <!-- 搜索触发条（⌘K）：点开命令面板 -->
        <button
          class="mb-2 flex w-full items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-left text-xs text-muted-foreground/80 transition-colors hover:border-border hover:bg-accent hover:text-foreground"
          @click="openSearch"
        >
          <Search class="size-3.5 shrink-0" />
          <span class="min-w-0 flex-1 truncate">搜索对话、页面、技能…</span>
          <span class="shrink-0 rounded border border-border px-1 py-px text-[12px] text-muted-foreground/70">⌘K</span>
        </button>

        <button
          class="mb-2 flex w-full items-center justify-between px-1 pb-0.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          :title="tasksOpen ? '收起任务列表' : '展开任务列表'"
          @click="tasksOpen = !tasksOpen"
        >
          <span>任务 ({{ filteredSessions.length }})</span>
          <ChevronDown class="size-3.5 shrink-0 transition-transform" :class="!tasksOpen && '-rotate-90'" />
        </button>
        <p v-if="tasksOpen && !filteredSessions.length" class="px-1 pb-1 text-xs text-muted-foreground/70">
          还没有任务，点「新任务」开始
        </p>
        <ul v-if="tasksOpen" class="space-y-0.5">
          <li v-for="s in filteredSessions" :key="s.id" class="group flex items-center gap-1">
            <button
              class="min-w-0 flex-1 truncate rounded-md px-2.5 py-1.5 text-left text-[14px] text-foreground/85 transition-colors hover:bg-accent"
              :title="s.lastError ? `${s.title}（最后一轮失败）` : s.title"
              @click="emit('open-session', s.id)"
            >
              {{ s.title }}
            </button>
            <!-- 运行中：后台任务在别处跑的时候，这里是唯一能看见它的地方 -->
            <Loader2
              v-if="runningIds.has(s.id)"
              class="size-3.5 shrink-0 animate-spin text-primary"
              title="运行中"
              data-running
            />
            <!-- 失败过的那条挂红标：历史列表里一眼扫得出"哪条是坏的" -->
            <span v-else-if="s.lastError" class="shrink-0 text-destructive" title="最后一轮失败">
              <CircleAlert class="size-3.5" />
            </span>
            <!-- 相对时间：列表里扫的是"新不新"，比精确时刻有用；hover 时让位给删除按钮 -->
            <span
              v-if="!runningIds.has(s.id)"
              class="shrink-0 text-[12px] tabular-nums text-muted-foreground/60 group-hover:hidden"
            >
              {{ timeAgo(s.updatedAt) }}
            </span>
            <button
              class="hidden shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive group-hover:block"
              title="删除任务记录"
              @click="removeSession(s.id)"
            >
              <Trash2 class="size-3" />
            </button>
          </li>
        </ul>
      </div>

      <!-- 工作空间：选一个本地文件夹，所有产出都在里面完成 -->
      <div class="px-3 pt-4">
        <div class="flex items-center justify-between px-1 pb-1">
          <button
            class="flex items-center gap-1 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            :title="spacesOpen ? '收起工作空间' : '展开工作空间'"
            @click="spacesOpen = !spacesOpen"
          >
            空间 ({{ filteredProjects.length }})
            <ChevronDown class="size-3.5 shrink-0 transition-transform" :class="!spacesOpen && '-rotate-90'" />
          </button>
          <button
            class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="选择本地文件夹，新建工作空间"
            @click="pickProjectFolder"
          >
            <Plus class="size-3.5" />
          </button>
        </div>
        <p v-if="spacesOpen && !filteredProjects.length" class="px-1 pb-1 text-xs text-muted-foreground/70">
          {{ searchKw ? '没有匹配的工作空间' : '还没有工作空间，点 + 选择本地文件夹' }}
        </p>
        <ul v-if="spacesOpen" class="space-y-0.5">
          <li v-for="p in filteredProjects" :key="p.name" class="group relative flex items-center gap-1">
            <button
              class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[14px] transition-colors"
              :class="activeProject === p.name ? 'bg-accent font-medium text-accent-foreground' : 'text-foreground/85 hover:bg-accent'"
              :title="p.dir || p.name"
              @click="pickProject(p.name)"
            >
              <Folder class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
            </button>
            <button
              class="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
              title="删除"
              @click="delMenuFor = delMenuFor === p.name ? null : p.name"
            >
              <Trash2 class="size-3" />
            </button>
            <!-- 删除二选一：仅移除列表 / 连本地文件夹一起删 -->
            <div
              v-if="delMenuFor === p.name"
              class="absolute right-0 top-7 z-50 w-52 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-xl"
            >
              <button
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
                @click="removeProject(p.name, false)"
              >
                仅从列表移除
                <span class="ml-auto text-[12px] text-muted-foreground">保留文件</span>
              </button>
              <button
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-destructive transition-colors hover:bg-destructive/10"
                @click="removeProject(p.name, true)"
              >
                连本地文件夹删除
                <span class="ml-auto text-[12px] opacity-70">不可恢复</span>
              </button>
            </div>
          </li>
        </ul>
      </div>
   </div>

    <div v-if="delMenuFor" class="fixed inset-0 z-40" @click="delMenuFor = null" />
    <AccountBar :env="env" @navigate="emit('navigate')" />
  </div>
</template>

<style scoped>
/* 让滚动条更贴近 T3 的细腻观感 */
::-webkit-scrollbar {
  width: 6px;
}
::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 3px;
}
:hover::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.12);
}
</style>
