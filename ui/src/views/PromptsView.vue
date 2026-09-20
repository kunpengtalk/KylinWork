<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Clock, Copy, Download, FileText, Loader2, Pencil, Plus, Search, Star, Trash2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { toast } from 'vue-sonner'
import { marketPrompts, type MarketPrompt } from '@/data/marketPrompts'

/**
 * 提示词（我的 / 提示词广场）。
 * <p>
 * - 我的：存在本机 localStorage，默认展示，可创建 / 编辑 / 删除 / 复制使用
 * - 广场：内置的商务领域提示词库（整理自 GitHub 开源中文提示词仓库，来源随卡展示），
 *   一键「安装到我的」
 * 左侧分类栏带计数；顶部搜索对标题 / 标签 / 正文生效。
 */

interface MyPrompt {
  id: string
  title: string
  category: string
  tags: string[]
  desc: string
  content: string
  createdAt: string
}

const STORE_KEY = 'kylinwork.prompts'
const CATEGORIES = ['商业', '办公', '写作', '编程', '通用']

// ---------- 状态 ----------
const tab = ref<'mine' | 'market'>('mine') // 默认展示「我的提示词」
const category = ref('全部')
const keyword = ref('')
const mine = ref<MyPrompt[]>([])
const loading = ref(true)

// ---------- 我的提示词：本机存取 ----------
function loadMine() {
  try {
    mine.value = JSON.parse(localStorage.getItem(STORE_KEY) || '[]') as MyPrompt[]
  } catch {
    mine.value = []
  }
}

function persistMine() {
  localStorage.setItem(STORE_KEY, JSON.stringify(mine.value))
}

// ---------- 创建 / 编辑弹窗 ----------
const editorOpen = ref(false)
const editingId = ref<string | null>(null) // null = 新建
const form = ref({ title: '', category: '商业', tags: '', desc: '', content: '' })
const saving = ref(false)

function openCreate() {
  editingId.value = null
  form.value = { title: '', category: tab.value === 'market' ? '商业' : category.value === '全部' ? '商业' : category.value, tags: '', desc: '', content: '' }
  editorOpen.value = true
}

function openEdit(p: MyPrompt) {
  editingId.value = p.id
  form.value = { title: p.title, category: p.category, tags: p.tags.join('、'), desc: p.desc, content: p.content }
  editorOpen.value = true
}

function saveEditor() {
  const f = form.value
  if (!f.title.trim() || !f.content.trim()) {
    toast.error('标题和正文必填')
    return
  }
  const tags = f.tags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean)
  if (editingId.value) {
    const p = mine.value.find((x) => x.id === editingId.value)
    if (p) Object.assign(p, { title: f.title.trim(), category: f.category, tags, desc: f.desc.trim(), content: f.content })
    toast.success('已更新')
  } else {
    mine.value.unshift({
      id: 'p_' + Date.now().toString(36),
      title: f.title.trim(),
      category: f.category,
      tags,
      desc: f.desc.trim(),
      content: f.content,
      createdAt: new Date().toISOString(),
    })
    toast.success('已创建，可在「我的提示词」中使用')
  }
  persistMine()
  editorOpen.value = false
}

function removeMine(p: MyPrompt) {
  if (!window.confirm(`删除提示词「${p.title}」？`)) return
  mine.value = mine.value.filter((x) => x.id !== p.id)
  persistMine()
  toast.success('已删除')
}

// ---------- 安装（广场 → 我的） ----------
const installing = ref<string | null>(null)
function installFromMarket(m: MarketPrompt) {
  installing.value = m.id
  try {
    if (mine.value.some((x) => x.title === m.title && x.content === m.content)) {
      toast.info('这条已经在「我的提示词」里了')
      return
    }
    mine.value.unshift({
      id: 'p_' + Date.now().toString(36),
      title: m.title,
      category: m.category,
      tags: [...m.tags],
      desc: m.desc,
      content: m.content,
      createdAt: new Date().toISOString(),
    })
    persistMine()
    toast.success(`「${m.title}」已安装到我的提示词`)
  } finally {
    installing.value = null
  }
}

/** 已安装判断（同标题即视为已装） */
function isInstalled(m: MarketPrompt): boolean {
  return mine.value.some((x) => x.title === m.title)
}

// ---------- 使用：复制到剪贴板 ----------
async function usePrompt(title: string, content: string) {
  try {
    await navigator.clipboard.writeText(content)
    toast.success(`「${title}」已复制，粘贴到对话输入框即可使用`)
  } catch {
    toast.error('复制失败，请手动选择正文复制')
  }
}

// ---------- 过滤 ----------
const kw = computed(() => keyword.value.trim().toLowerCase())

const mineFiltered = computed(() => {
  let list = mine.value
  if (category.value !== '全部') list = list.filter((p) => p.category === category.value)
  const k = kw.value
  if (!k) return list
  return list.filter(
    (p) => p.title.toLowerCase().includes(k) || p.content.toLowerCase().includes(k) || p.tags.some((t) => t.toLowerCase().includes(k)),
  )
})

const marketFiltered = computed(() => {
  let list = marketPrompts
  if (category.value !== '全部') list = list.filter((p) => p.category === category.value)
  const k = kw.value
  if (!k) return list
  return list.filter(
    (p) =>
      p.title.toLowerCase().includes(k) ||
      p.content.toLowerCase().includes(k) ||
      p.tags.some((t) => t.toLowerCase().includes(k)) ||
      p.desc.toLowerCase().includes(k),
  )
})

const list = computed(() => (tab.value === 'mine' ? mineFiltered.value : marketFiltered.value))

/** 左侧分类计数（按当前 tab 的全量数据，不受分类/关键词影响） */
const catCount = computed(() => {
  const base = tab.value === 'mine' ? mine.value : marketPrompts
  const map = new Map<string, number>()
  for (const p of base) map.set(p.category, (map.get(p.category) || 0) + 1)
  return map
})

const categories = computed(() => ['全部', ...CATEGORIES.filter((c) => (catCount.value.get(c) || 0) > 0 || tab.value === 'mine' || CATEGORIES.includes(c as never))])

/** 卡片正文预览：压掉换行，截 160 字 */
function preview(text: string) {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 160 ? t.slice(0, 160) + '…' : t
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

onMounted(() => {
  loadMine()
  loading.value = false
})

// 切 tab 时把分类重置为全部，避免空白
watch(tab, () => (category.value = '全部'))
</script>

<template>
  <div class="flex h-full">
    <!-- 左侧：我的 / 广场 切换 Tab + 分类 -->
    <aside class="w-52 shrink-0 overflow-y-auto border-r border-line bg-[#fafafa] p-3 dark:border-border dark:bg-card/40">
      <!-- 左右 Tab 切换：默认我的提示词 -->
      <div class="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        <button
          class="flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-all"
          :class="tab === 'mine' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
          @click="tab = 'mine'"
        >
          <Star class="size-3.5" /> 我的
        </button>
        <button
          class="flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-all"
          :class="tab === 'market' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
          @click="tab = 'market'"
        >
          <Download class="size-3.5" /> 广场
        </button>
      </div>

      <p class="px-1 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">分类</p>
      <button
        v-for="c in categories"
        :key="c"
        class="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors"
        :class="category === c ? 'bg-accent font-medium text-accent-foreground' : 'text-foreground/80 hover:bg-accent'"
        @click="category = c"
      >
        {{ c }}
        <span class="ml-auto text-[11px] text-muted-foreground">
          {{ c === '全部' ? (tab === 'mine' ? mine.length : marketPrompts.length) : catCount.get(c) || 0 }}
        </span>
      </button>
    </aside>

    <!-- 主区 -->
    <div class="min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-5xl p-6">
        <div class="mb-5 flex flex-wrap items-center gap-3">
          <div class="relative min-w-0 flex-1">
            <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              v-model="keyword"
              placeholder="搜索提示词…"
              class="h-10 w-full rounded-lg border border-line bg-background pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground dark:border-border"
            />
          </div>
          <Button class="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90" @click="openCreate">
            <Plus class="size-4" /> 创建提示词
          </Button>
        </div>

        <div v-if="tab === 'market'" class="mb-4 rounded-lg border border-line bg-[#fafafa] px-4 py-2.5 text-xs text-muted-foreground dark:border-border dark:bg-card/40">
          提示词广场收录了商务 / 办公领域的常用提示词（整理自 GitHub 开源中文提示词库，来源见卡片）。「安装到我的」后可编辑和复用。
        </div>

        <!-- 我的为空：引导卡 -->
        <div
          v-if="tab === 'mine' && !mine.length && !keyword"
          class="mb-4 flex flex-col items-center rounded-xl border border-dashed border-line bg-[#fafafa] px-6 py-12 text-center dark:border-border dark:bg-card/40"
        >
          <Star class="size-8 text-muted-foreground/50" />
          <p class="mt-3 text-sm font-medium">还没有自己的提示词</p>
          <p class="mt-1 text-xs text-muted-foreground">去广场安装现成的，或创建第一条</p>
          <div class="mt-4 flex gap-2">
            <Button size="sm" class="gap-1.5" @click="tab = 'market'">
              <Download class="size-3.5" /> 去提示词广场
            </Button>
            <Button size="sm" variant="outline" class="gap-1.5" @click="openCreate">
              <Plus class="size-3.5" /> 创建第一条
            </Button>
          </div>
        </div>

        <!-- 卡片网格 -->
        <div class="grid gap-4 md:grid-cols-2">
          <article
            v-for="p in list"
            :key="tab === 'mine' ? (p as MyPrompt).id : 'm_' + (p as MarketPrompt).id"
            class="flex flex-col rounded-xl border border-line bg-white p-5 transition-shadow hover:shadow-[0_4px_16px_rgba(17,24,39,0.08)] dark:border-border dark:bg-card"
          >
            <h3 class="text-[17px] font-semibold tracking-tight">
              {{ p.title }}
            </h3>

            <!-- 元信息行：单行并排，链接截断 -->
            <div class="mt-2 flex items-center gap-2.5 overflow-hidden text-[11px] text-muted-foreground">
              <span v-if="tab === 'market'" class="flex min-w-0 items-center gap-1">
                <span class="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
                <span class="truncate">github.com/K-Render/best-chinese-prompt</span>
              </span>
              <span v-if="tab === 'market'" class="flex shrink-0 items-center gap-1">
                <Pencil class="size-3" /> v1.0.0
              </span>
              <span v-if="tab === 'mine' && (p as MyPrompt).createdAt" class="flex shrink-0 items-center gap-1">
                <Clock class="size-3" /> {{ fmtDate((p as MyPrompt).createdAt) }}
              </span>
              <span v-if="tab === 'mine'" class="shrink-0">本地创建</span>
            </div>

            <!-- 标签 -->
            <div v-if="p.tags.length" class="mt-2.5 flex flex-wrap gap-1.5">
              <Badge
                v-for="t in p.tags.slice(0, 5)"
                :key="t"
                class="rounded-full border-transparent bg-blue-50 text-[10px] text-blue-700 dark:bg-blue-950 dark:text-blue-300"
              >
                {{ t }}
              </Badge>
            </div>

            <!-- 正文预览 -->
            <pre class="mt-3 max-h-24 overflow-hidden whitespace-pre-wrap rounded-lg border border-line bg-[#f6f7f9] p-3 font-mono text-[11.5px] leading-relaxed text-[#374151] dark:border-border dark:bg-card/60 dark:text-gray-300">{{ preview(p.content) }}</pre>

            <p class="mt-2.5 flex items-start gap-1.5 text-xs text-muted-foreground">
              <FileText class="mt-0.5 size-3 shrink-0" />
              <span class="line-clamp-1">{{ p.desc || preview(p.content) }}</span>
            </p>

            <!-- 操作 -->
            <div class="mt-4 flex items-center gap-2 border-t border-line pt-3 dark:border-border">
              <template v-if="tab === 'mine'">
                <Button size="sm" variant="outline" class="h-7 gap-1 text-xs" @click="usePrompt(p.title, p.content)">
                  <Copy class="size-3" /> 复制使用
                </Button>
                <Button size="sm" variant="ghost" class="h-7 gap-1 text-xs" @click="openEdit(p as MyPrompt)">
                  <Pencil class="size-3" /> 编辑
                </Button>
                <Button size="sm" variant="ghost" class="ml-auto h-7 gap-1 text-xs text-destructive hover:text-destructive" @click="removeMine(p as MyPrompt)">
                  <Trash2 class="size-3" /> 删除
                </Button>
              </template>
              <template v-else>
                <Badge v-if="isInstalled(p as MarketPrompt)" variant="secondary" class="text-[10px]">✓ 已安装</Badge>
                <Button
                  v-else
                  size="sm"
                  class="h-7 gap-1 text-xs"
                  :disabled="installing === (p as MarketPrompt).id"
                  @click="installFromMarket(p as MarketPrompt)"
                >
                  <Loader2 v-if="installing === (p as MarketPrompt).id" class="size-3 animate-spin" />
                  <Download v-else class="size-3" />
                  安装到我的
                </Button>
                <Button size="sm" variant="ghost" class="ml-auto h-7 gap-1 text-xs" @click="usePrompt(p.title, p.content)">
                  <Copy class="size-3" /> 复制使用
                </Button>
              </template>
            </div>
          </article>
        </div>

        <div v-if="!list.length && !(tab === 'mine' && !keyword)" class="rounded-xl border border-dashed border-line py-16 text-center dark:border-border">
          <p class="text-sm text-muted-foreground">
            {{ keyword ? '没有匹配的提示词' : '该分类下暂无提示词' }}
          </p>
        </div>
      </div>
    </div>

    <!-- 创建 / 编辑弹窗 -->
    <Teleport to="body">
      <div v-if="editorOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="editorOpen = false">
        <div class="max-h-[86vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-xl">
          <h3 class="text-base font-semibold">{{ editingId ? '编辑提示词' : '创建提示词' }}</h3>
          <div class="mt-4 space-y-3">
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="space-y-1.5">
                <Label class="text-xs">标题</Label>
                <Input v-model="form.title" class="h-9" placeholder="例如：周报助手" maxlength="30" />
              </div>
              <div class="space-y-1.5">
                <Label class="text-xs">分类</Label>
                <select v-model="form.category" class="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none">
                  <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
                </select>
              </div>
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">标签（逗号分隔）</Label>
              <Input v-model="form.tags" class="h-9" placeholder="周报, 工作总结, 文档" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">描述</Label>
              <Input v-model="form.desc" class="h-9" placeholder="一句话说明这条提示词的用途" maxlength="60" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">提示词正文</Label>
              <textarea
                v-model="form.content"
                rows="10"
                class="w-full rounded-md border border-border bg-background p-3 font-mono text-[12.5px] leading-relaxed outline-none placeholder:text-muted-foreground"
                placeholder="# Role: …&#10;## Skills&#10;1. …&#10;## Goals&#10;…"
              />
            </div>
          </div>
          <div class="mt-5 flex justify-end gap-2">
            <Button variant="ghost" size="sm" @click="editorOpen = false">取消</Button>
            <Button size="sm" :disabled="saving" @click="saveEditor">
              <Loader2 v-if="saving" class="mr-1 size-3.5 animate-spin" />
              {{ editingId ? '保存修改' : '创建' }}
            </Button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.border-line {
  border-color: #e5e7eb;
}
</style>
