<script setup lang="ts">
/**
 * 输入区：文本框 + @/ 候选菜单 + 工具条（文件 / 模式 / 模型 / 连接器 / 专家 / 技能）
 * + 卡片下的工作空间选择与权限档位 + 发送 / 停止。
 *
 * 从 ChatView 拆出来：这一块近三百行，状态全是它自己的（各种下拉开合、候选菜单），
 * 主视图只需要知道「用户发了什么、改了哪个选项」。所以这里只向外抛事件，
 * 不发请求、不碰会话与消息。
 */
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Button } from '@/components/ui/button'
import ExpertAvatar from '@/components/ExpertAvatar.vue'
import ModelPicker from '@/components/ModelPicker.vue'
import { openWorkspace } from '@/api/client'
import type { ModelChannel, ModelHealthMap } from '@/api/engine'
import {
  ArrowUp,
  AtSign,
  Blocks,
  Bot,
  Check,
  ChevronDown,
  Database,
  FolderOpen,
  Paperclip,
  Plug,
  Plus,
  ShieldCheck,
  Slash,
  Square,
  Zap,
} from 'lucide-vue-next'

const props = defineProps<{
  modelValue: string
  running: boolean
  placeholder: string
  mode: string
  // name 允许为空：平台模型、权限档位这些外部数据源偶尔缺 name，
  // 展示层自己跳过即可，不该让整条消息的类型检查挂掉
  channels: ModelChannel[]
  /** 模型健康账本，按「渠道::模型」复合键查 */
  modelHealth?: ModelHealthMap
  platformModels: { name?: string; label?: string }[]
  activeModel: string
  loggedIn: boolean
  permList: { name?: string; label?: string; description?: string }[]
  permCurrent: string
  projects: { name: string; dir?: string }[]
  activeProject: string
  skills: { name: string; description?: string }[]
  experts: {
    name: string
    alias?: string
    avatar?: string
    category?: string
    tags?: string[]
    description?: string
    role?: string
  }[]
  mcpList: { name: string; enabled?: boolean }[]
  selectedMcp: string
  /** 知识库列表与本次选中的库 id（可多选） */
  kbList: { id: string; name: string; file_count?: number }[]
  selectedKb: string[]
  /** 本次选定的专家名（空 = 不指定）。只作为系统级参数带给引擎，不写进输入框文本 */
  selectedExpert: string
  /** 工作区文件，供 @ 引用候选 */
  files: { name: string; size: number }[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'send'): void
  (e: 'stop'): void
  (e: 'interject'): void
  (e: 'pick-files', files: FileList): void
  (e: 'change-mode', mode: string): void
  (e: 'change-model', name: string): void
  (e: 'change-mcp', name: string): void
  (e: 'change-kb', ids: string[]): void
  (e: 'change-expert', name: string): void
  (e: 'change-perm', name: string): void
  (e: 'change-project', name: string): void
  (e: 'new-workspace'): void
  (e: 'login'): void
}>()

const MODE_LABEL: Record<string, string> = {
  craft: 'Craft · 执行',
  goal: 'Goal · 目标',
  ask: 'Ask · 问答',
  plan: 'Plan · 规划',
}

const router = useRouter()
const inputEl = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const text = computed({
  get: () => props.modelValue,
  set: (v: string) => emit('update:modelValue', v),
})

/** 没有 name 的渠道条目直接滤掉：模型选择器拿它也没法显示 */
const namedChannels = computed(() => props.channels.filter((m) => Boolean(m.name)))

/** 弹层开合：+ 菜单 / 工具条下拉 / 工作空间选择 */
const plusOpen = ref(false)
const plusSection = ref('')
const toolMenu = ref<'mcp' | 'expert' | 'skill' | 'kb' | ''>('')
const wsOpen = ref(false)
const wsKw = ref('')
/** 技能下拉的关键词：按技能名或说明（备注）过滤 */
const skillKw = ref('')

function togglePlus(section: string) {
  plusSection.value = plusSection.value === section ? '' : section
}
function toggleToolMenu(m: 'mcp' | 'expert' | 'skill' | 'kb') {
  // 每次重新打开技能菜单都从空关键词开始
  if (m === 'skill' && toolMenu.value !== 'skill') skillKw.value = ''
  toolMenu.value = toolMenu.value === m ? '' : m
}
/** 权限档位：与其它弹层同一套开合纪律（开一个就收其它的） */
const permOpen = ref(false)
function togglePerm() {
  toolMenu.value = ''
  permOpen.value = !permOpen.value
}
function pickPerm(name?: string) {
  permOpen.value = false
  if (name && name !== props.permCurrent) emit('change-perm', name)
}
const permLabel = computed(() => props.permList.find((m) => m.name === props.permCurrent)?.label || props.permCurrent || '权限')
/** 知识库多选：点一下加入/移出，选中顺序即展示顺序 */
function toggleKb(id: string) {
  const next = props.selectedKb.includes(id)
    ? props.selectedKb.filter((x) => x !== id)
    : [...props.selectedKb, id]
  emit('change-kb', next)
}
function closeAll() {
  plusOpen.value = false
  plusSection.value = ''
  toolMenu.value = ''
  wsOpen.value = false
  permOpen.value = false
  skillKw.value = ''
}

const wsFiltered = computed(() => {
  // 没有目录或没名字的空间不展示
  const list = props.projects.filter((p) => String(p.name || '').trim() && String(p.dir || '').trim())
  const k = wsKw.value.trim().toLowerCase()
  return k ? list.filter((p) => p.name.toLowerCase().includes(k)) : list
})

/** 技能按名字或说明（备注）过滤；关键词为空时保持原顺序 */
const skillFiltered = computed(() => {
  const k = skillKw.value.trim().toLowerCase()
  if (!k) return props.skills
  return props.skills.filter(
    (s) => s.name.toLowerCase().includes(k) || (s.description || '').toLowerCase().includes(k),
  )
})

/** 选定技能：以 /技能名 注入输入框并收起菜单 */
function pickSkill(name?: string) {
  if (!name) return
  injectText(`/${name} `)
  toolMenu.value = ''
  skillKw.value = ''
}

const enabledMcps = computed(() => props.mcpList.filter((m) => m.enabled !== false))

/** 向输入框追加一段文字（专家角色 / 技能指令） */
function injectText(t: string) {
  text.value = text.value ? `${text.value.trimEnd()} ${t}` : t
  plusOpen.value = false
  toolMenu.value = ''
  void nextTick(() => inputEl.value?.focus())
}

/** 选定专家：只记一个专家名，作为系统级参数随消息带给引擎（由引擎把它写进任务上下文），
 *  不在输入框里注入任何「请以…的角色」的提示词——选中即生效，靠系统而不是靠用户再去写一遍。 */
type ExpertPick = { name: string; alias?: string; role?: string }
function pickExpert(e: ExpertPick) {
  emit('change-expert', props.selectedExpert === e.name ? '' : e.name)
  toolMenu.value = ''
}

// ---------------- @ 引用文件 / / 调用技能：候选菜单 ----------------
const mentionOpen = ref(false)
const mentionKind = ref<'file' | 'skill'>('file')
const mentionItems = ref<{ label: string; desc?: string; hay?: string }[]>([])
const mentionIndex = ref(0)
const mentionStart = ref(0)

function closeMention() {
  mentionOpen.value = false
  mentionItems.value = []
}

function fmtSize(n: number) {
  if (!n || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function updateMention() {
  const el = inputEl.value
  if (!el) return closeMention()
  const pos = el.selectionStart ?? text.value.length
  const before = text.value.slice(0, pos)
  const idx = Math.max(before.lastIndexOf('@'), before.lastIndexOf('/'))
  if (idx < 0) return closeMention()

  const kw = before.slice(idx + 1)
  if (/\s/.test(kw)) return closeMention()

  mentionKind.value = before[idx] === '@' ? 'file' : 'skill'
  mentionStart.value = idx
  // 技能的 hay 带上说明，让「/关键词」也能按备注内容命中；文件不参与说明匹配（desc 是体积）
  const src =
    mentionKind.value === 'file'
      ? props.files.map((f) => ({ label: f.name, desc: fmtSize(f.size), hay: '' }))
      : props.skills.map((s) => ({ label: s.name, desc: s.description || '', hay: s.description || '' }))
  const k = kw.toLowerCase()
  mentionItems.value = src
    .filter((i) => i.label.toLowerCase().includes(k) || (i.hay || '').toLowerCase().includes(k))
    .slice(0, 8)
  mentionOpen.value = mentionItems.value.length > 0
}

function pickMention(label: string) {
  const el = inputEl.value
  const pos = el?.selectionStart ?? text.value.length
  const before = text.value.slice(0, mentionStart.value)
  const after = text.value.slice(pos)
  text.value = `${before}${label} ${after}`
  closeMention()
  nextTick(() => {
    el?.focus()
    const p = before.length + label.length + 1
    el?.setSelectionRange(p, p)
  })
}

function onMentionKey(e: KeyboardEvent) {
  if (!mentionOpen.value) return false
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    mentionIndex.value = (mentionIndex.value + 1) % mentionItems.value.length
    return true
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    mentionIndex.value = (mentionIndex.value - 1 + mentionItems.value.length) % mentionItems.value.length
    return true
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    pickMention(mentionItems.value[mentionIndex.value]!.label)
    return true
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    closeMention()
    return true
  }
  return false
}

function onKeydown(e: KeyboardEvent) {
  if (onMentionKey(e)) return
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    emit('send')
  }
}

defineExpose({ focus: () => inputEl.value?.focus() })
</script>

<template>
  <div class="shrink-0 bg-background px-4 pb-2">
    <!-- 遮罩：点外部关闭所有弹层 -->
    <div v-if="plusOpen || wsOpen || toolMenu || permOpen" class="fixed inset-0 z-40" @click="closeAll" />
    <div class="mx-auto w-full max-w-4xl">
      <div class="rounded-[22px] border border-border bg-background shadow-sm">
        <!-- @ 引用文件 / 调用技能：候选菜单 -->
        <div
          v-if="mentionOpen && mentionItems.length"
          class="mb-2 overflow-hidden rounded-lg border border-border bg-background shadow-lg"
        >
          <p class="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
            <AtSign v-if="mentionKind === 'file'" class="size-3" />
            <Slash v-else class="size-3" />
            {{ mentionKind === 'file' ? '引用工作区文件（@）' : '调用技能（/）' }}
          </p>
          <ul class="max-h-56 overflow-y-auto p-1">
            <li v-for="(it, i) in mentionItems" :key="it.label">
              <button
                class="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors"
                :class="i === mentionIndex ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50'"
                @mousedown.prevent="pickMention(it.label)"
                @mouseenter="mentionIndex = i"
              >
                <span class="min-w-0 flex-1 truncate">{{ it.label }}</span>
                <span v-if="it.desc" class="max-w-40 shrink-0 truncate text-[11px] text-muted-foreground">{{ it.desc }}</span>
              </button>
            </li>
          </ul>
        </div>

        <textarea
          ref="inputEl"
          v-model="text"
          rows="3"
          :placeholder="placeholder"
          class="w-full resize-none bg-transparent px-5 pt-4 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
          @keydown="onKeydown"
          @keyup="updateMention"
          @input="updateMention"
          @click="updateMention"
        />

        <!-- 工具条：窄窗口下整行换行，别把「技能」这种两字标签挤成竖排 -->
        <div class="flex flex-wrap items-center gap-1 px-2 pb-2">
          <!-- 「+」：添加文件 / 模式 -->
          <div class="relative shrink-0">
            <button
              class="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="添加文件、切换模式"
              @click="plusOpen = !plusOpen; plusSection = ''"
            >
              <Plus class="size-4" />
            </button>
            <div
              v-if="plusOpen"
              class="absolute bottom-10 left-0 z-50 w-48 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-xl"
            >
              <button
                class="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent"
                @click="plusOpen = false; fileInput?.click()"
              >
                <Paperclip class="size-4 text-muted-foreground" /> 添加文件
              </button>
              <button
                class="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent"
                @click="togglePlus('mode')"
              >
                <Zap class="size-4 text-muted-foreground" /> 模式
                <ChevronDown class="ml-auto size-3.5 text-muted-foreground/60" :class="plusSection === 'mode' ? 'rotate-180' : ''" />
              </button>
              <div v-if="plusSection === 'mode'" class="border-t border-border/60 px-1 py-1">
                <button
                  v-for="(label, k) in MODE_LABEL"
                  :key="k"
                  class="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs transition-colors"
                  :class="mode === k ? 'bg-accent font-medium text-accent-foreground' : 'text-foreground/80 hover:bg-accent'"
                  @click="emit('change-mode', k); plusOpen = false"
                >
                  {{ label }}
                  <Check v-if="mode === k" class="ml-auto size-3 text-primary" />
                </button>
              </div>
            </div>
          </div>
          <input
            ref="fileInput"
            type="file"
            multiple
            class="hidden"
            @change="emit('pick-files', ($event.target as HTMLInputElement).files!)"
          >

          <!-- 权限档位：紧挨「+」，一眼看到"这次能做什么"（参考版就是把它摆在输入框里） -->
          <div v-if="permList.length" class="relative shrink-0">
            <button
              class="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs transition-colors"
              :class="permOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
              title="权限档位：决定本次任务能自动做到哪一步"
              @click="togglePerm"
            >
              <ShieldCheck class="size-3.5 shrink-0" />
              <span class="max-w-24 truncate">{{ permLabel }}</span>
              <ChevronDown class="size-3 text-muted-foreground/60" :class="permOpen ? 'rotate-180' : ''" />
            </button>
            <div
              v-if="permOpen"
              class="absolute bottom-10 left-0 z-50 w-64 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-xl"
            >
              <button
                v-for="m in permList"
                :key="m.name"
                class="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent"
                @click="pickPerm(m.name)"
              >
                <span class="flex w-full items-center gap-2 text-[13px]">
                  {{ m.label || m.name }}
                  <Check v-if="permCurrent === m.name" class="ml-auto size-3 shrink-0 text-primary" />
                </span>
                <span v-if="m.description" class="text-[11px] leading-4 text-muted-foreground">{{ m.description }}</span>
              </button>
            </div>
          </div>

          <!-- 连接器 -->
          <div class="relative shrink-0">
            <button
              class="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs transition-colors"
              :class="selectedMcp ? 'bg-accent/60 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
              title="选择本次任务使用的连接器"
              @click="toggleToolMenu('mcp')"
            >
              <Plug class="size-3.5 shrink-0" />
              <span class="max-w-28 truncate">{{ selectedMcp || '连接器' }}</span>
              <ChevronDown class="size-3 text-muted-foreground/60" :class="toolMenu === 'mcp' ? 'rotate-180' : ''" />
            </button>
            <div
              v-if="toolMenu === 'mcp'"
              class="absolute bottom-10 left-0 z-50 w-60 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-xl"
            >
              <p v-if="!enabledMcps.length" class="px-3 py-2 text-xs text-muted-foreground">没有已连接的连接器</p>
              <button
                v-for="s in enabledMcps"
                :key="s.name"
                class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent"
                @click="emit('change-mcp', s.name); toolMenu = ''"
              >
                <span class="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                <span class="min-w-0 flex-1 truncate">{{ s.name }}</span>
                <Check v-if="selectedMcp === s.name" class="size-3 shrink-0 text-primary" />
              </button>
              <button
                class="mt-0.5 w-full rounded-md px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                @click="toolMenu = ''; router.push('/client-settings/mcp')"
              >
                管理连接器…
              </button>
            </div>
          </div>

          <!-- 知识库：多选，选中后本次任务先检索再回答 -->
          <div class="relative shrink-0">
            <button
              class="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs transition-colors"
              :class="selectedKb.length ? 'bg-accent/60 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
              title="选择本次任务使用的知识库（可多选）"
              @click="toggleToolMenu('kb')"
            >
              <Database class="size-3.5 shrink-0" />
              <span class="max-w-28 truncate">
                {{ selectedKb.length ? `知识库 · ${selectedKb.length}` : '知识库' }}
              </span>
              <ChevronDown class="size-3 text-muted-foreground/60" :class="toolMenu === 'kb' ? 'rotate-180' : ''" />
            </button>
            <div
              v-if="toolMenu === 'kb'"
              class="absolute bottom-10 left-0 z-50 w-64 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-xl"
            >
              <p v-if="!kbList.length" class="px-3 py-2 text-xs text-muted-foreground">还没有知识库，去「知识库」页新建</p>
              <button
                v-for="k in kbList"
                :key="k.id"
                class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent"
                @click="toggleKb(k.id)"
              >
                <Database class="size-3.5 shrink-0 text-muted-foreground" />
                <span class="min-w-0 flex-1 truncate">{{ k.name }}</span>
                <span class="shrink-0 text-[10px] text-muted-foreground">{{ k.file_count || 0 }}</span>
                <Check v-if="selectedKb.includes(k.id)" class="size-3 shrink-0 text-primary" />
              </button>
              <div v-if="selectedKb.length" class="mt-0.5 border-t border-border/60 p-1">
                <button
                  class="w-full rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  @click="emit('change-kb', [])"
                >
                  清空选择
                </button>
              </div>
              <button
                class="mt-0.5 w-full rounded-md px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                @click="toolMenu = ''; router.push('/knowledge')"
              >
                管理知识库…
              </button>
            </div>
          </div>

          <!-- 专家：选中后名字显示在这里（带高亮），输入框里不出现任何提示词 -->
          <div class="relative shrink-0">
            <button
              class="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs transition-colors"
              :class="selectedExpert ? 'bg-accent/60 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
              :title="selectedExpert ? `本次任务由专家「${selectedExpert}」执行` : '选择专家，按其角色与专长执行'"
              @click="toggleToolMenu('expert')"
            >
              <Bot class="size-3.5 shrink-0" />
              <span class="max-w-28 truncate">{{ selectedExpert || '专家' }}</span>
              <ChevronDown class="size-3 text-muted-foreground/60" :class="toolMenu === 'expert' ? 'rotate-180' : ''" />
            </button>
            <div
              v-if="toolMenu === 'expert'"
              class="absolute bottom-10 left-0 z-50 max-h-96 w-[32rem] overflow-y-auto rounded-xl border border-border bg-popover p-2 shadow-xl"
            >
              <p v-if="!experts.length" class="px-3 py-2 text-xs text-muted-foreground">还没有专家，去「专家」页创建</p>
              <template v-else>
                <div class="grid grid-cols-2 gap-2">
                  <button
                    v-for="e in experts"
                    :key="e.name"
                    class="rounded-lg border p-2.5 text-left transition-colors"
                    :class="selectedExpert === e.name ? 'border-primary/60 bg-accent' : 'border-transparent bg-card/50 hover:border-border hover:bg-accent'"
                    :title="`选定专家「${e.name}」，本次任务由他执行`"
                    @click="pickExpert(e)"
                  >
                    <div class="flex items-center gap-2">
                      <ExpertAvatar :icon="e.avatar" :category="e.category" :size="32" />
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-[13px] font-medium leading-4">{{ e.name }}</p>
                        <p class="truncate text-[10px] text-muted-foreground">{{ e.alias || e.category || ' ' }}</p>
                      </div>
                      <Check v-if="selectedExpert === e.name" class="size-3.5 shrink-0 text-primary" />
                    </div>
                    <p v-if="e.description || e.role" class="mt-1.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{{ e.role || e.description }}</p>
                    <div v-if="e.tags?.length" class="mt-1.5 flex flex-wrap gap-1">
                      <span v-for="t in e.tags.slice(0, 3)" :key="t" class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ t }}</span>
                    </div>
                  </button>
                </div>
                <button
                  v-if="selectedExpert"
                  class="mt-1.5 w-full rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  @click="emit('change-expert', ''); toolMenu = ''"
                >
                  不使用专家
                </button>
              </template>
            </div>
          </div>

          <!-- 技能 -->
          <div class="relative shrink-0">
            <button
              class="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="调用本地技能"
              @click="toggleToolMenu('skill')"
            >
              <Blocks class="size-3.5 shrink-0" />
              <span>技能</span>
              <ChevronDown class="size-3 shrink-0 text-muted-foreground/60" :class="toolMenu === 'skill' ? 'rotate-180' : ''" />
            </button>
            <div
              v-if="toolMenu === 'skill'"
              class="absolute bottom-10 left-0 z-50 flex w-72 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
            >
              <!-- 检索框钉在最上面，列表在下面自己滚，面板高度不再随技能数量无限变大 -->
              <div class="shrink-0 border-b border-border/60 p-2">
                <input
                  v-model="skillKw"
                  autofocus
                  placeholder="搜索技能名或说明"
                  class="h-8 w-full rounded-md bg-muted/60 px-2.5 text-xs outline-none placeholder:text-muted-foreground"
                  @keydown.enter.prevent="pickSkill(skillFiltered[0]?.name)"
                  @keydown.esc.prevent="toolMenu = ''"
                >
              </div>
              <ul class="max-h-64 overflow-y-auto p-1">
                <li v-if="!skills.length" class="px-2.5 py-2 text-xs text-muted-foreground">本地还没有技能</li>
                <li v-else-if="!skillFiltered.length" class="px-2.5 py-2 text-xs text-muted-foreground">没有匹配的技能</li>
                <li v-for="s in skillFiltered" :key="s.name">
                  <button
                    class="w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-accent"
                    title="以 /技能名 调用"
                    @click="pickSkill(s.name)"
                  >
                    <p class="truncate text-[13px]">/{{ s.name }}</p>
                    <p v-if="s.description" class="truncate text-[11px] text-muted-foreground">{{ s.description }}</p>
                  </button>
                </li>
              </ul>
              <p class="shrink-0 border-t border-border/60 px-3 py-1 text-[10px] text-muted-foreground">
                {{ skillFiltered.length }} / {{ skills.length }}
              </p>
            </div>
          </div>

          <div class="ms-auto flex shrink-0 items-center gap-1">
            <!-- 模型选择器摆在发送键旁边：换模型是"发之前最后一件事"，跟着右手走 -->
            <ModelPicker
              v-if="namedChannels.length"
              :channels="namedChannels"
              :health="modelHealth"
              :platform-models="platformModels"
              :active="activeModel"
              :logged-in="loggedIn"
              @change="emit('change-model', $event)"
              @login="emit('login')"
            />

            <Button v-if="running" variant="ghost" size="sm" class="h-7 gap-1 whitespace-nowrap text-xs text-muted-foreground" title="把这条立即注入正在跑的任务" @click="emit('interject')">
              <Zap class="size-3.5 shrink-0" /> 插队
            </Button>
            <button
              v-if="!running"
              class="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-30"
              :disabled="!text.trim()"
              title="发送 (Enter)"
              @click="emit('send')"
            >
              <ArrowUp class="size-4" />
            </button>
            <button
              v-else
              class="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90"
              title="停止"
              @click="emit('stop')"
            >
              <Square class="size-3" fill="currentColor" />
            </button>
          </div>
        </div>
      </div>

      <!-- 卡片下：工作空间弹层 + 权限 -->
      <div class="mt-1 flex items-center gap-1 px-1">
        <div class="relative">
          <button
            class="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="选择工作空间：任务在哪个本地文件夹里完成"
            @click="wsOpen = !wsOpen; wsKw = ''"
          >
            <FolderOpen class="size-3.5" />
            {{ activeProject || '选择工作空间' }}
            <ChevronDown class="size-3 transition-transform" :class="wsOpen ? 'rotate-180' : ''" />
          </button>
          <div
            v-if="wsOpen"
            class="absolute bottom-9 left-0 z-50 w-64 overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
          >
            <div class="border-b border-border/60 p-2">
              <input
                v-model="wsKw"
                autofocus
                placeholder="搜索工作空间"
                class="h-8 w-full rounded-md bg-muted/60 px-2.5 text-xs outline-none placeholder:text-muted-foreground"
              >
            </div>
            <ul class="max-h-60 overflow-y-auto p-1">
              <p v-if="!wsFiltered.length" class="px-2.5 py-2 text-xs text-muted-foreground">
                {{ wsKw ? '没有匹配的工作空间' : '还没有工作空间' }}
              </p>
              <li v-for="p in wsFiltered" :key="p.name">
                <button
                  class="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors"
                  :class="activeProject === p.name ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-accent'"
                  :title="p.dir || p.name"
                  @click="emit('change-project', p.name); wsOpen = false"
                >
                  <FolderOpen class="size-3.5 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
                  <Check v-if="activeProject === p.name" class="size-3 shrink-0 text-primary" />
                </button>
              </li>
            </ul>
            <div class="border-t border-border/60 p-1">
              <button
                class="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
                @click="wsOpen = false; emit('new-workspace')"
              >
                <Plus class="size-3.5 text-muted-foreground" /> 新建工作空间
              </button>
              <button
                class="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
                @click="wsOpen = false; openWorkspace()"
              >
                <FolderOpen class="size-3.5 text-muted-foreground" /> 打开本地文件夹
              </button>
            </div>
          </div>
        </div>
        <div class="flex-1" />
      </div>

      <p class="mt-1.5 pb-1 text-center text-[11px] text-muted-foreground/70">
        内容由 AI 生成，请核对关键信息；所选模型 / 连接器 / 技能仅对本次任务生效
      </p>
    </div>
  </div>
</template>
