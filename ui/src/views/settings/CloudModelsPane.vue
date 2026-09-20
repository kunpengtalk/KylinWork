<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  Check, Copy, Eye, EyeOff, ExternalLink, Loader2, Lock, Plus, RefreshCw, Search, Star, Trash2, X, Zap,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'vue-sonner'
import {
  cloudCheck, cloudCreate, cloudDelete, cloudFetchModels, cloudList, cloudUpdate,
  type CloudKind, type CloudModelEntry, type CloudProvider, type CloudState,
} from '@/api/cloud'

/**
 * 模型云服务。
 * <p>
 * 一套键盘敲定的服务商目录：内置 21 家 + 自定义，配 Key、挑模型、开关启用。
 * 启用且配好的服务商会被后端物化成引擎渠道（config.models），对话里就能直接选。
 * <p>
 * 界面分左右：左边是可搜索、按分区归类的服务商列表，右边是选中项的地址 / Key / 模型管理。
 */

const state = ref<CloudState | null>(null)
const loading = ref(true)
const busy = ref(false) // 任一写操作进行中
const kw = ref('')
const selectedId = ref('')

const providers = computed<CloudProvider[]>(() => state.value?.providers || [])
const sections = computed(() => state.value?.sections || [])
const labels = computed(() => state.value?.labels || {})
const selected = computed<CloudProvider | null>(() => providers.value.find((p) => p.id === selectedId.value) || null)

/** 左列表：搜索 + 按分区归类（空分区不显示） */
const grouped = computed(() => {
  const q = kw.value.trim().toLowerCase()
  const match = (p: CloudProvider) =>
    !q || p.name.toLowerCase().includes(q) || p.vendor.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
  return sections.value
    .map((s) => ({ section: s, label: labels.value[s] || s, items: providers.value.filter((p) => p.section === s && match(p)) }))
    .filter((g) => g.items.length)
})

onMounted(async () => {
  await load()
  loading.value = false
})

async function load() {
  try {
    const s = await cloudList()
    apply(s)
  } catch (e) {
    toast.error('读取模型云服务失败：' + (e as Error).message)
  }
}

/** 写操作统一入口：后端每次都回全量状态，直接覆盖即可 */
async function applyOrToast(fn: () => Promise<CloudState>, okMsg?: string) {
  busy.value = true
  try {
    const s = await fn()
    apply(s)
    if (okMsg) toast.success(okMsg)
    return true
  } catch (e) {
    toast.error((e as Error).message)
    return false
  } finally {
    busy.value = false
  }
}

function apply(s: CloudState) {
  state.value = s
  if (!s.providers.some((p) => p.id === selectedId.value)) selectedId.value = s.providers[0]?.id || ''
}

function pick(p: CloudProvider) {
  selectedId.value = p.id
}

async function toggleEnabled(p: CloudProvider, e: Event) {
  e.stopPropagation()
  const next = !p.enabled
  const done = await applyOrToast(() => cloudUpdate(p.id, { enabled: next }))
  if (done && next && !p.configured) toast.info('已启用，但还没填 Key / 模型——填好后才能真正跑起来')
}

// ==================== 右侧详情：单个服务商 ====================

/** 编辑草稿：选中项变了就重置，避免把上一家的输入带到下一家 */
const keyDraft = ref('')
const baseDraft = ref('')
const showKey = ref(false)
const checking = ref(false)
const checkMsg = ref<{ ok: boolean; text: string } | null>(null)

watch(selected, (p) => {
  keyDraft.value = p?.api_key || ''
  baseDraft.value = p?.base_url || ''
  showKey.value = false
  checkMsg.value = null
})

async function saveKey() {
  const p = selected.value
  if (!p || keyDraft.value === (p.api_key || '')) return
  await applyOrToast(() => cloudUpdate(p.id, { api_key: keyDraft.value.trim() }))
}

async function saveBase() {
  const p = selected.value
  if (!p || p.base_locked || baseDraft.value.trim() === (p.base_url || '')) return
  await applyOrToast(() => cloudUpdate(p.id, { base_url: baseDraft.value.trim() }))
}

async function copyKey() {
  const p = selected.value
  if (!p || !p.api_key) return
  try {
    await navigator.clipboard.writeText(p.api_key)
    toast.success('API Key 已复制')
  } catch {
    toast.error('复制失败，请手动选中复制')
  }
}

/** 检查连接：用当前输入（可能还没保存）去拉一次模型列表 */
async function check() {
  const p = selected.value
  if (!p) return
  checking.value = true
  checkMsg.value = null
  try {
    const r = await cloudCheck({ id: p.id, base_url: baseDraft.value.trim() || p.base_url, api_key: keyDraft.value.trim() || p.api_key, provider: p.provider })
    if (r.ok) checkMsg.value = { ok: true, text: `连接正常，拉到 ${r.count || 0} 个模型` }
    else checkMsg.value = { ok: false, text: r.error || '连接失败' }
  } catch (e) {
    checkMsg.value = { ok: false, text: (e as Error).message }
  } finally {
    checking.value = false
  }
}

async function removeProvider() {
  const p = selected.value
  if (!p) return
  if (!window.confirm(`删除自定义服务商「${p.name}」？（Key 与模型清单一并删掉）`)) return
  await applyOrToast(() => cloudDelete(p.id), '已删除')
}

// ==================== 模型清单 ====================

const modelKw = ref('')
const shownModels = computed<CloudModelEntry[]>(() => {
  const p = selected.value
  if (!p) return []
  const q = modelKw.value.trim().toLowerCase()
  return q ? p.models.filter((m) => m.id.toLowerCase().includes(q)) : p.models
})

const newModelId = ref('')

async function saveModels(entries: CloudModelEntry[], okMsg?: string) {
  const p = selected.value
  if (!p) return
  await applyOrToast(() => cloudUpdate(p.id, { models: entries }), okMsg)
}

async function addModel() {
  const p = selected.value
  const id = newModelId.value.trim()
  if (!p || !id) return
  if (p.models.some((m) => m.id === id)) {
    toast.info('这个模型已经在列表里了')
    return
  }
  await saveModels([...p.models, { id }])
  newModelId.value = ''
}

async function removeModel(id: string) {
  const p = selected.value
  if (!p) return
  await saveModels(p.models.filter((m) => m.id !== id))
}

/** 设为默认：挪到最前（引擎取 models[0] 作渠道默认模型） */
async function setDefault(id: string) {
  const p = selected.value
  if (!p) return
  const rest = p.models.filter((m) => m.id !== id)
  const hit = p.models.find((m) => m.id === id)
  if (!hit) return
  await saveModels([hit, ...rest], `默认模型已切到 ${id}`)
}

async function setModelType(id: string, type: CloudKind) {
  const p = selected.value
  if (!p) return
  await saveModels(p.models.map((m) => (m.id === id ? { ...m, type } : m)))
}

// ==================== 获取远端模型列表 ====================

const fetchOpen = ref(false)
const fetching = ref(false)
const fetched = ref<string[]>([])
const fetchedPicked = ref<Record<string, boolean>>({})
const fetchedKw = ref('')

const fetchedShown = computed(() => {
  const q = fetchedKw.value.trim().toLowerCase()
  return q ? fetched.value.filter((id) => id.toLowerCase().includes(q)) : fetched.value
})

async function openFetch() {
  const p = selected.value
  if (!p) return
  fetching.value = true
  fetched.value = []
  fetchedPicked.value = {}
  fetchedKw.value = ''
  try {
    const r = await cloudFetchModels({ id: p.id, base_url: baseDraft.value.trim() || p.base_url, api_key: keyDraft.value.trim() || p.api_key, provider: p.provider })
    if (!r.ok) {
      toast.error('拉取失败：' + (r.error || '未知原因'))
      return
    }
    const have = new Set(p.models.map((m) => m.id))
    fetched.value = (r.models || []).filter((id) => !have.has(id))
    if (!fetched.value.length) {
      toast.info('服务商返回的模型都已经在列表里了')
      return
    }
    fetchOpen.value = true
  } catch (e) {
    toast.error('拉取失败：' + (e as Error).message)
  } finally {
    fetching.value = false
  }
}

async function addFetched() {
  const p = selected.value
  if (!p) return
  const picked = fetched.value.filter((id) => fetchedPicked.value[id])
  if (!picked.length) {
    toast.info('先勾选要添加的模型')
    return
  }
  const merged = [...p.models, ...picked.filter((id) => !p.models.some((m) => m.id === id)).map((id) => ({ id }))]
  const ok = await applyOrToast(() => cloudUpdate(p.id, { models: merged }), `已添加 ${picked.length} 个模型`)
  if (ok) fetchOpen.value = false
}

function toggleAllFetched(v: boolean) {
  const next: Record<string, boolean> = {}
  for (const id of fetched.value) next[id] = v
  fetchedPicked.value = next
}

// ==================== 新增自定义服务商 ====================

const addOpen = ref(false)
const addName = ref('')
const addBase = ref('')

function openAdd() {
  addName.value = ''
  addBase.value = ''
  addOpen.value = true
}

async function submitAdd() {
  if (!addName.value.trim()) {
    toast.error('请填服务商名称')
    return
  }
  if (!addBase.value.trim()) {
    toast.error('请填 API 地址')
    return
  }
  const ok = await applyOrToast(
    () => cloudCreate({ name: addName.value.trim(), base_url: addBase.value.trim(), enabled: false }),
    '已添加，去填 Key 和模型',
  )
  if (ok) addOpen.value = false
}

// ==================== 小组件 ====================

const MODEL_TYPES: { value: CloudKind; label: string }[] = [
  { value: 'chat', label: '对话' },
  { value: 'embedding', label: '向量' },
  { value: 'rerank', label: '重排' },
]

function initial(name: string): string {
  return (name || '?').trim().charAt(0).toUpperCase()
}
function isActive(p: CloudProvider): boolean {
  const s = state.value
  return !!s && p.kind === 'chat' && s.active_model === p.name && (s.active_model_id ? s.active_model_id === p.models[0]?.id : true)
}
function rowStatusText(p: CloudProvider): string {
  if (p.configured) return `${p.models.length} 个模型`
  // 本地地址不需要 Key，所以只可能差模型
  if (p.local) return '缺模型'
  if (!p.models.length) return p.has_key ? '缺模型' : '待配置'
  // 模型填了、Key 空着：以前一律显示「待配置」，看着像什么都没动，
  // 用户就把「已经挑好模型」当成了「已经配好」，回头在知识库里找不到这些模型。
  // 只对「开了开关却没 Key」的点名——没动过的内置预设还是叫「待配置」，
  // 否则整个列表二十行都在喊缺 Key，真正该看的那行反而淹了。
  return p.enabled ? '缺 API Key' : '待配置'
}
</script>

<template>
  <div class="space-y-4">
    <!-- 标题与说明由设置页头统一给出，这里不再重复，只留刷新 -->
    <div class="flex items-center justify-end">
      <Button size="sm" variant="outline" class="gap-1.5" :disabled="busy" @click="load">
        <RefreshCw class="size-3.5" /> 刷新
      </Button>
    </div>

    <div v-if="loading" class="flex justify-center py-16">
      <Spinner class="size-6 text-muted-foreground" />
    </div>

    <div v-else class="flex gap-4">
      <!-- 左：服务商列表 -->
      <aside class="flex w-72 shrink-0 flex-col">
        <div class="flex items-center gap-2 rounded-md border border-border px-2">
          <Search class="size-3.5 shrink-0 text-muted-foreground" />
          <input v-model="kw" class="h-8 w-full bg-transparent text-[13px] outline-none" placeholder="搜索服务商…" />
          <button v-if="kw" class="text-muted-foreground hover:text-foreground" @click="kw = ''"><X class="size-3.5" /></button>
        </div>

        <div class="mt-2 max-h-[560px] space-y-3 overflow-y-auto pr-1">
          <div v-for="g in grouped" :key="g.section">
            <p class="px-1 pb-1 text-[11px] font-medium text-muted-foreground">{{ g.label }}</p>
            <button
              v-for="p in g.items"
              :key="p.id"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors"
              :class="p.id === selectedId ? 'bg-accent' : 'hover:bg-accent/60'"
              @click="pick(p)"
            >
              <span
                class="flex size-7 shrink-0 items-center justify-center rounded-md text-[12px] font-semibold text-white"
                :style="{ backgroundColor: p.color || '#64748b' }"
              >{{ initial(p.name) }}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[13px] font-medium">{{ p.name }}</span>
                <span class="block truncate text-[11px] text-muted-foreground">{{ p.vendor }}</span>
              </span>
              <span
                v-if="!p.configured"
                class="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] text-amber-600 dark:text-amber-400"
              >{{ rowStatusText(p) }}</span>
              <span v-else class="shrink-0 text-[10px] text-muted-foreground">{{ rowStatusText(p) }}</span>
              <!-- 启用开关 -->
              <span
                class="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors"
                :class="p.enabled ? 'bg-primary' : 'bg-muted-foreground/30'"
                role="switch"
                :aria-checked="p.enabled"
                @click="toggleEnabled(p, $event)"
              >
                <span class="absolute size-3 rounded-full bg-white transition-all" :class="p.enabled ? 'left-3.5' : 'left-0.5'" />
              </span>
            </button>
          </div>
          <p v-if="!grouped.length" class="px-2 py-6 text-center text-[12px] text-muted-foreground">没有匹配的服务商</p>
        </div>

        <button
          class="mt-2 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          @click="openAdd"
        >
          <Plus class="size-3.5" /> 自定义服务商
        </button>
      </aside>

      <!-- 右：详情 -->
      <section class="min-w-0 flex-1">
        <div v-if="!selected" class="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          从左边选一个服务商
        </div>

        <div v-else class="space-y-3">
          <!-- 头部 -->
          <div class="flex items-center gap-3">
            <span
              class="flex size-10 shrink-0 items-center justify-center rounded-lg text-base font-semibold text-white"
              :style="{ backgroundColor: selected.color || '#64748b' }"
            >{{ initial(selected.name) }}</span>
            <div class="min-w-0 flex-1">
              <p class="flex items-center gap-2 text-sm font-semibold">
                <span class="truncate">{{ selected.name }}</span>
                <Badge v-if="selected.enabled" variant="secondary" class="text-[11px]">已启用</Badge>
                <Badge v-if="isActive(selected)" variant="default" class="text-[11px]">使用中</Badge>
              </p>
              <p class="truncate text-[12px] text-muted-foreground">{{ selected.vendor }}</p>
            </div>
            <Button v-if="!selected.builtin" variant="ghost" size="icon-sm" title="删除服务商" :disabled="busy" @click="removeProvider">
              <Trash2 class="size-4" />
            </Button>
          </div>

          <p v-if="selected.note" class="text-[12px] text-muted-foreground">{{ selected.note }}</p>

          <!-- 连接 -->
          <div class="space-y-3 rounded-lg border border-border p-4">
            <div class="space-y-1.5">
              <Label class="text-[13px]">API 地址</Label>
              <div v-if="selected.base_locked" class="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                <Lock class="size-3.5 shrink-0 text-muted-foreground" />
                <span class="truncate font-mono text-[13px] text-muted-foreground">{{ selected.base_url }}</span>
                <span class="ml-auto shrink-0 text-[11px] text-muted-foreground">官方地址</span>
              </div>
              <Input
                v-else
                v-model="baseDraft"
                class="h-9 font-mono text-[13px]"
                placeholder="https://api.xxx.com/v1"
                @blur="saveBase"
                @keydown.enter="saveBase"
              />
            </div>

            <div class="space-y-1.5">
              <Label class="text-[13px]">API Key</Label>
              <div class="flex gap-2">
                <div class="relative flex-1">
                  <Input
                    v-model="keyDraft"
                    :type="showKey ? 'text' : 'password'"
                    class="h-9 pr-8 font-mono text-[13px]"
                    placeholder="sk-…"
                    @blur="saveKey"
                    @keydown.enter="saveKey"
                  />
                  <button
                    type="button"
                    class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    @click="showKey = !showKey"
                  >
                    <EyeOff v-if="showKey" class="size-3.5" /><Eye v-else class="size-3.5" />
                  </button>
                </div>
                <Button variant="outline" size="sm" class="h-9 shrink-0" :disabled="!selected.api_key" @click="copyKey"><Copy class="size-3.5" /></Button>
                <Button variant="outline" size="sm" class="h-9 shrink-0 gap-1.5" :disabled="checking" @click="check">
                  <Loader2 v-if="checking" class="size-3.5 animate-spin" /><Zap v-else class="size-3.5" /> 检查
                </Button>
              </div>
              <p class="flex items-center gap-2 text-[12px]">
                <a v-if="selected.api_key_url" :href="selected.api_key_url" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 text-primary hover:underline">
                  获取密钥 <ExternalLink class="size-3" />
                </a>
                <span v-if="checkMsg" :class="checkMsg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'">{{ checkMsg.text }}</span>
              </p>
            </div>
          </div>

          <!-- 模型管理 -->
          <div class="rounded-lg border border-border">
            <div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
              <p class="text-[13px] font-medium">模型 <span class="text-muted-foreground">{{ selected.models.length }}</span></p>
              <div class="ml-auto flex items-center gap-2">
                <div class="flex items-center gap-1.5 rounded-md border border-border px-2">
                  <Search class="size-3.5 shrink-0 text-muted-foreground" />
                  <input v-model="modelKw" class="h-7 w-32 bg-transparent text-[12px] outline-none" placeholder="搜索模型…" />
                </div>
                <Button variant="outline" size="sm" class="h-7 gap-1.5 text-[12px]" :disabled="fetching" @click="openFetch">
                  <Loader2 v-if="fetching" class="size-3.5 animate-spin" /><RefreshCw v-else class="size-3.5" /> 获取模型列表
                </Button>
              </div>
              <p class="w-full text-[11px] text-muted-foreground">按模型标类型：对话的进对话的模型选择，向量 / 重排的供「知识库」选用。</p>
            </div>

            <ul v-if="shownModels.length" class="divide-y divide-border">
              <li v-for="(m, i) in shownModels" :key="m.id" class="flex items-center gap-2 px-4 py-2">
                <span class="min-w-0 flex-1 truncate font-mono text-[12px]">{{ m.id }}</span>
                <Badge v-if="i === 0 && !modelKw" variant="outline" class="shrink-0 text-[10px]">默认</Badge>
                <select
                  :value="m.type || 'chat'"
                  class="h-7 shrink-0 rounded-md border border-border bg-background px-1 text-[12px] outline-none"
                  @change="setModelType(m.id, ($event.target as HTMLSelectElement).value as CloudKind)"
                >
                  <option v-for="t in MODEL_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
                </select>
                <Button variant="ghost" size="icon-xs" title="设为默认" :disabled="busy || i === 0" @click="setDefault(m.id)">
                  <Star class="size-3.5" :class="i === 0 ? 'fill-current text-amber-500' : ''" />
                </Button>
                <Button variant="ghost" size="icon-xs" title="删除模型" :disabled="busy" @click="removeModel(m.id)">
                  <Trash2 class="size-3.5" />
                </Button>
              </li>
            </ul>
            <p v-else class="px-4 py-8 text-center text-[12px] text-muted-foreground">
              {{ modelKw ? '没有匹配的模型' : '还没有模型，下面加一个，或「获取模型列表」' }}
            </p>

            <div class="flex gap-2 border-t border-border px-4 py-2.5">
              <Input
                v-model="newModelId"
                class="h-8 font-mono text-[12px]"
                placeholder="例如 deepseek-chat，回车添加"
                @keydown.enter.prevent="addModel"
              />
              <Button variant="outline" size="sm" class="h-8 shrink-0" :disabled="busy || !newModelId.trim()" @click="addModel">添加</Button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- 获取模型列表 -->
    <Dialog v-model:open="fetchOpen">
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>选择要添加的模型</DialogTitle>
          <DialogDescription>来自 {{ selected?.name }} 的 /models 接口，共 {{ fetched.length }} 个未添加。</DialogDescription>
        </DialogHeader>
        <div class="flex items-center gap-2 rounded-md border border-border px-2">
          <Search class="size-3.5 shrink-0 text-muted-foreground" />
          <input v-model="fetchedKw" class="h-8 w-full bg-transparent text-[13px] outline-none" placeholder="过滤…" />
        </div>
        <div class="flex items-center justify-end gap-2 text-[12px]">
          <button class="text-muted-foreground hover:text-foreground" @click="toggleAllFetched(true)">全选</button>
          <button class="text-muted-foreground hover:text-foreground" @click="toggleAllFetched(false)">全不选</button>
        </div>
        <div class="max-h-72 overflow-y-auto rounded-md border border-border p-1">
          <label v-for="id in fetchedShown" :key="id" class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] hover:bg-accent">
            <input v-model="fetchedPicked[id]" type="checkbox" class="size-3.5 accent-current" />
            <span class="font-mono">{{ id }}</span>
          </label>
          <p v-if="!fetchedShown.length" class="px-2 py-6 text-center text-[12px] text-muted-foreground">没有匹配项</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" @click="fetchOpen = false">取消</Button>
          <Button size="sm" :disabled="busy" @click="addFetched">添加勾选的</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 自定义服务商 -->
    <Dialog v-model:open="addOpen">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>自定义服务商</DialogTitle>
          <DialogDescription>不在内置目录里的（自建网关、本地 vLLM / Ollama 等），在这里加。</DialogDescription>
        </DialogHeader>
        <div class="space-y-3">
          <div class="space-y-1.5">
            <Label>名称</Label>
            <Input v-model="addName" class="h-9" placeholder="例如：公司网关" />
          </div>
          <div class="space-y-1.5">
            <Label>API 地址</Label>
            <Input v-model="addBase" class="h-9 font-mono text-[13px]" placeholder="https://api.xxx.com/v1 或 http://127.0.0.1:8000/v1" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" @click="addOpen = false">取消</Button>
          <Button size="sm" :disabled="busy" @click="submitAdd"><Check class="size-3.5" /> 添加</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
