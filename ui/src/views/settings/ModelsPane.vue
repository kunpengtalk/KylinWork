<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Check, Pencil, Plus, Trash2, X, Zap } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'vue-sonner'
import { getSettings, saveSettings } from '@/api/client'
import { modelKey, listChannelModels, probeModel, setActiveModel, type ModelChannel } from '@/api/engine'
import { KIND_LABEL } from '@/api/cloud'

/**
 * 模型渠道。
 * <p>
 * 不登录也要能配——这是本地模式能不能跑起来的前提：引擎跑在本机，
 * 用谁的 Key、走哪个网关，全看这里。
 * <p>
 * 一个渠道 = 一个服务商（Key + Base URL），名下可以挂多个模型 id；对话里再挑具体用哪个。
 */

type Channel = ModelChannel & { api_key?: string }

/** 表单里的渠道（models 是可增删的模型 id 列表） */
interface EditForm {
  name: string
  provider: 'openai' | 'anthropic'
  kind: 'chat' | 'embedding' | 'rerank'
  base_url: string
  api_key: string
  models: string[]
  thinking?: string
  temperature?: number
  max_tokens?: number
}

/** 渠道用途：对话给聊天选，向量/重排给知识库选。文案与「模型云服务」页共用一份（@/api/cloud） */
function kindOf(m: Channel): 'chat' | 'embedding' | 'rerank' {
  return m.kind === 'embedding' || m.kind === 'rerank' ? m.kind : 'chat'
}

const models = ref<Channel[]>([])
const activeModel = ref('')
const activeModelId = ref('')
const loading = ref(true)
const saving = ref(false)
const testing = ref(false)

/** 已保存的 Key：编辑时不回显，但如果用户没重新填，保存要沿用旧值（否则一编辑就把 Key 抹了） */
const storedKeys = ref<Record<string, string>>({})
/** 编辑时原本的渠道名（用来定位 storedKeys，名字不可改） */
const editingName = ref('')

const editing = ref<EditForm | null>(null)
const isNew = ref(false)
const newModelId = ref('')
const newModelEl = ref<HTMLInputElement | null>(null)

// 「从服务商拉取可用模型」的结果
const fetching = ref(false)
const fetched = ref<string[]>([])
const fetchedPicked = ref<Record<string, boolean>>({})

onMounted(async () => {
  await load()
  loading.value = false
})

async function load() {
  try {
    const s = await getSettings()
    const list = ((s.models as Channel[]) || []).map((m) => ({ ...m }))
    models.value = list
    activeModel.value = String(s.active_model || '')
    activeModelId.value = String(s.active_model_id || '')
    const keys: Record<string, string> = {}
    for (const m of list) if (m.api_key) keys[m.name] = m.api_key
    storedKeys.value = keys
  } catch (e) {
    toast.error('读取模型配置失败：' + (e as Error).message)
  }
}

const activeKey = computed(() => modelKey(activeModel.value, activeModelId.value))

function startNew() {
  isNew.value = true
  editingName.value = ''
  editing.value = { name: '', provider: 'openai', kind: 'chat', base_url: 'https://api.openai.com/v1', api_key: '', models: [] }
  newModelId.value = ''
  clearFetched()
}

function startEdit(m: Channel) {
  isNew.value = false
  editingName.value = m.name
  editing.value = {
    name: m.name,
    provider: m.provider,
    kind: kindOf(m),
    base_url: m.base_url || '',
    api_key: '', // 不回显已存的 Key，要改就重新填
    models: [...(m.models && m.models.length ? m.models : m.model ? [m.model] : [])],
    thinking: m.thinking,
    temperature: m.temperature,
    max_tokens: m.max_tokens,
  }
  newModelId.value = ''
  clearFetched()
}

function cancelEdit() {
  editing.value = null
  isNew.value = false
  clearFetched()
}

function clearFetched() {
  fetched.value = []
  fetchedPicked.value = {}
}

/** 把输入框里的模型 id 收进列表（去重） */
function addModel() {
  const id = newModelId.value.trim()
  if (!id || !editing.value) return
  if (editing.value.models.includes(id)) {
    toast.info('这个模型已经在列表里了')
  } else {
    editing.value.models.push(id)
  }
  newModelId.value = ''
  newModelEl.value?.focus()
}

function removeModel(id: string) {
  if (!editing.value) return
  editing.value.models = editing.value.models.filter((x) => x !== id)
}

/** 从服务商拉模型清单：先把这条渠道落盘（/models/list 按渠道名去配置里找），再调它的 /models */
async function pullModels() {
  const f = editing.value
  if (!f) return
  if (!f.name.trim() || !f.base_url.trim()) {
    toast.error('先填渠道名称和 Base URL，再来拉模型')
    return
  }
  const key = f.api_key.trim() || storedKeys.value[editingName.value] || ''
  fetching.value = true
  clearFetched()
  try {
    const ch = toChannel(f)
    const list = isNew.value || !models.value.some((m) => m.name === editingName.value)
      ? [...models.value, ch]
      : models.value.map((m) => (m.name === editingName.value ? ch : m))
    await persist(list)
    const r = await listChannelModels({ name: ch.name, api_key: key })
    if (!r.ok) {
      toast.error('拉取失败：' + (r.error || '未知原因'))
      return
    }
    const have = new Set(f.models.map((x) => x.trim()))
    fetched.value = (r.models || []).filter((id) => !have.has(id))
    if (!fetched.value.length) {
      toast.info('服务商返回的模型都已经在列表里了')
      return
    }
    // 默认勾选常见对话模型之外的全选会让列表很吵：先全不勾，让用户挑
    fetchedPicked.value = {}
  } catch (e) {
    toast.error('拉取失败：' + (e as Error).message)
  } finally {
    fetching.value = false
  }
}

/** 把勾选的模型并入列表（排在最前，便于成为默认） */
function addFetched() {
  const f = editing.value
  if (!f) return
  const picked = fetched.value.filter((id) => fetchedPicked.value[id])
  if (!picked.length) {
    toast.info('先勾选要添加的模型')
    return
  }
  for (const id of picked) if (!f.models.includes(id)) f.models.push(id)
  toast.success(`已添加 ${picked.length} 个模型`)
  clearFetched()
}

function toggleAllFetched(v: boolean) {
  const next: Record<string, boolean> = {}
  for (const id of fetched.value) next[id] = v
  fetchedPicked.value = next
}

/** 表单 → 可落盘的渠道对象：Key 为空时沿用已存的旧值 */
function toChannel(f: EditForm): Channel {
  const ids = f.models.map((x) => x.trim()).filter(Boolean)
  const key = f.api_key.trim() || storedKeys.value[editingName.value] || ''
  return {
    name: f.name.trim(),
    provider: f.provider,
    kind: f.kind,
    base_url: f.base_url.trim(),
    api_key: key,
    // 默认模型 = 列表第一个；后端也会以此为准
    model: ids[0] || '',
    models: ids,
    ...(f.thinking ? { thinking: f.thinking } : {}),
    ...(f.temperature != null ? { temperature: f.temperature } : {}),
    ...(f.max_tokens != null ? { max_tokens: f.max_tokens } : {}),
  }
}

/** 校验表单，返回错误信息或 null */
function validate(f: EditForm): string | null {
  if (!f.name.trim()) return '请填渠道名称'
  if (!isNew.value && f.name.trim() !== editingName.value && models.value.some((m) => m.name === f.name.trim()))
    return '渠道名称已存在'
  if (isNew.value && models.value.some((m) => m.name === f.name.trim())) return '渠道名称已存在'
  if (!f.base_url.trim()) return '请填 Base URL'
  if (!f.models.filter((x) => x.trim()).length) return '至少填一个模型 ID'
  const key = f.api_key.trim() || storedKeys.value[editingName.value]
  const local = /localhost|127\.0\.0\.1/.test(f.base_url)
  if (!key && !local) return '请填 API Key（本地部署可留空，但地址要是本机）'
  return null
}

/** 保存整份列表（后端是按整份 models 数组存的） */
async function persist(list: Channel[], active?: { name: string; modelId: string }) {
  saving.value = true
  try {
    const patch: Record<string, unknown> = { models: list }
    if (active) {
      patch.active_model = active.name
      patch.active_model_id = active.modelId
    }
    const r = (await saveSettings(patch)) as { active_model?: string; active_model_id?: string }
    if (r && typeof r === 'object' && 'active_model' in r) {
      activeModel.value = String(r.active_model || '')
      activeModelId.value = String(r.active_model_id || '')
    }
  } catch (e) {
    toast.error('保存失败：' + (e as Error).message)
    throw e
  } finally {
    saving.value = false
  }
}

/** 验活并保存：真发一条请求，Key 不对当场就知道，别等任务跑到一半才报 400 */
async function testAndSave() {
  const f = editing.value
  if (!f) return
  const bad = validate(f)
  if (bad) {
    toast.error(bad)
    return
  }
  const ch = toChannel(f)
  testing.value = true
  try {
    const list = isNew.value
      ? [...models.value, ch]
      : models.value.map((m) => (m.name === editingName.value ? ch : m))
    // 先把这条渠道落盘：验活走 /onboarding，它是按渠道名去配置里找的
    // 注意：落盘前先不动 active model，验活失败也要把表单内容留下（Key 不再被抹）
    await persist(list)

    // 向量/重排渠道不跑对话验活（/onboarding 会拿它当聊天模型打）；它们的连通性在
    // 「设置 → 知识库」里用「测试」按钮验证。这里保存即完成。
    if (ch.kind && ch.kind !== 'chat') {
      await load()
      toast.success('已保存（向量/重排渠道，可到「知识库」设置里测试连通性）')
      cancelEdit()
      return
    }

    const r = await probeModel({ model: ch.name, model_id: ch.model, api_key: ch.api_key })
    if (r.ok) {
      await load()
      toast.success('连接正常，已保存')
      // 第一次配渠道时顺手设成默认
      if (!activeModel.value) await makeActive(ch.name, ch.model)
      cancelEdit()
    } else {
      await load()
      toast.error('连接失败（配置已保存）：' + (r.error || '未知原因'))
    }
  } catch (err) {
    toast.error('测试失败：' + (err as Error).message)
  } finally {
    testing.value = false
  }
}

/** 把某个渠道的某个模型设为全局默认 */
async function makeActive(name: string, modelId: string) {
  try {
    await setActiveModel(name, modelId)
    activeModel.value = name
    activeModelId.value = modelId
    toast.success('已切换为 ' + (modelId || name))
  } catch (e) {
    toast.error('切换失败：' + (e as Error).message)
  }
}

async function remove(m: Channel) {
  if (!window.confirm(`删除渠道「${m.name}」？（名下 ${m.models?.length || 1} 个模型一起删掉）`)) return
  const list = models.value.filter((x) => x.name !== m.name)
  // 删的是当前渠道时，同一次保存里把默认切到剩下第一个，别留下一个指向空气的 active_model
  const wasActive = m.name === activeModel.value
  // 默认只能落在对话渠道上：删的是当前渠道时，切到剩下第一个「对话」渠道
  const next = wasActive ? list.find((x) => kindOf(x) === 'chat') : undefined
  try {
    await persist(list, next ? { name: next.name, modelId: next.models?.[0] || next.model } : undefined)
    await load()
  } catch {
    /* persist 已提示 */
  }
  if (wasActive && !next) {
    activeModel.value = ''
    activeModelId.value = ''
  }
}

const PRESETS = [
  { label: 'OpenAI', provider: 'openai', base_url: 'https://api.openai.com/v1', models: ['gpt-5', 'gpt-5-mini'] },
  { label: 'DeepSeek', provider: 'openai', base_url: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { label: '通义千问', provider: 'openai', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'] },
  { label: '智谱 GLM', provider: 'openai', base_url: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'] },
  { label: '月之暗面', provider: 'openai', base_url: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-32k'] },
  { label: '火山方舟', provider: 'openai', base_url: 'https://ark.cn-beijing.volces.com/api/v3', models: [] },
  { label: 'Anthropic', provider: 'anthropic', base_url: 'https://api.anthropic.com', models: ['claude-sonnet-5'] },
  { label: '本地 Ollama', provider: 'openai', base_url: 'http://127.0.0.1:11434/v1', models: ['qwen3:14b'] },
]

/** 点预设：填地址 + 接口类型，并把它知道的模型 id 补进列表（不覆盖已有） */
function applyPreset(p: (typeof PRESETS)[number]) {
  if (!editing.value) return
  editing.value.base_url = p.base_url
  editing.value.provider = p.provider as 'openai' | 'anthropic'
  if (p.models.length && !editing.value.models.length) editing.value.models = [...p.models]
}

/** 渠道下所有模型 id */
function modelIdsOf(m: Channel): string[] {
  return m.models && m.models.length ? m.models : m.model ? [m.model] : []
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-base font-medium">模型渠道</h3>
        <p class="mt-0.5 text-[13px] text-muted-foreground">
          填一个服务商的 Key 就能开工。一个渠道可以挂多个模型，对话里再挑具体用哪个。
        </p>
      </div>
      <Button size="sm" class="gap-1.5" @click="startNew">
        <Plus class="size-3.5" /> 新增渠道
      </Button>
    </div>

    <div v-if="loading" class="flex justify-center py-10">
      <Spinner class="size-6 text-muted-foreground" />
    </div>

    <!-- 编辑表单 -->
    <div v-if="editing" class="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <div class="grid gap-3 sm:grid-cols-3">
        <div class="space-y-1.5">
          <Label>渠道名称</Label>
          <Input v-model="editing.name" class="h-9" placeholder="例如：DeepSeek" :disabled="!isNew" />
        </div>
        <div class="space-y-1.5">
          <Label>接口类型</Label>
          <select v-model="editing.provider" class="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none">
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
        <div class="space-y-1.5">
          <Label>用途</Label>
          <select v-model="editing.kind" class="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none">
            <option value="chat">对话</option>
            <option value="embedding">向量 Embedding</option>
            <option value="rerank">重排 Reranker</option>
          </select>
        </div>
      </div>
      <p class="text-[13px] text-muted-foreground">
        向量 / 重排渠道不会出现在对话的模型选择里，只供「设置 → 知识库」选用。
      </p>

      <div class="space-y-1.5">
        <Label>Base URL</Label>
        <Input v-model="editing.base_url" class="h-9" placeholder="https://api.xxx.com/v1" />
        <div class="flex flex-wrap gap-1">
          <button
            v-for="p in PRESETS"
            :key="p.label"
            class="rounded border border-border px-1.5 py-0.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            @click="applyPreset(p)"
          >
            {{ p.label }}
          </button>
        </div>
      </div>

      <div class="space-y-1.5">
        <Label>API Key</Label>
        <Input v-model="editing.api_key" type="password" class="h-9" placeholder="sk-…（已保存的不会回显，留空即保持不变）" />
      </div>

      <!-- 模型列表：一个渠道挂多个模型 -->
      <div class="space-y-1.5">
        <Label>模型 ID（第一个为默认）</Label>
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="(id, i) in editing.models"
            :key="id"
            class="flex items-center gap-1 rounded-md border px-2 py-0.5 text-[13px]"
            :class="i === 0 ? 'border-primary/40 bg-primary/5 font-medium' : 'border-border'"
          >
            {{ id }}
            <span v-if="i === 0" class="text-[12px] text-muted-foreground">默认</span>
            <button class="text-muted-foreground hover:text-destructive" @click="removeModel(id)">
              <X class="size-3" />
            </button>
          </span>
          <span v-if="!editing.models.length" class="text-[13px] text-muted-foreground">还没有模型，下面加一个</span>
        </div>
        <div class="flex gap-2">
          <Input
            ref="newModelEl"
            v-model="newModelId"
            class="h-8"
            placeholder="例如 deepseek-chat，回车添加"
            @keydown.enter.prevent="addModel"
          />
          <Button variant="outline" size="sm" class="h-8 shrink-0" @click="addModel">添加</Button>
          <Button variant="outline" size="sm" class="h-8 shrink-0 gap-1.5" :disabled="fetching" @click="pullModels">
            <Spinner v-if="fetching" class="size-3.5" />
            {{ fetching ? '拉取中…' : '拉取可用模型' }}
          </Button>
        </div>

        <!-- 拉取结果：勾选后并入列表 -->
        <div v-if="fetched.length" class="mt-2 rounded-md border border-border bg-background p-2">
          <div class="flex items-center gap-2 px-1 pb-1.5">
            <p class="flex-1 text-[13px] font-medium text-muted-foreground">服务商支持 {{ fetched.length }} 个模型</p>
            <button class="text-[13px] text-muted-foreground hover:text-foreground" @click="toggleAllFetched(true)">全选</button>
            <button class="text-[13px] text-muted-foreground hover:text-foreground" @click="toggleAllFetched(false)">全不选</button>
          </div>
          <div class="max-h-44 overflow-y-auto">
            <label
              v-for="id in fetched"
              :key="id"
              class="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[13px] hover:bg-accent"
            >
              <input v-model="fetchedPicked[id]" type="checkbox" class="size-3.5 accent-current" />
              <span class="font-mono">{{ id }}</span>
            </label>
          </div>
          <div class="flex justify-end gap-2 pt-1.5">
            <Button variant="ghost" size="sm" class="h-7 text-[13px]" @click="clearFetched">取消</Button>
            <Button size="sm" class="h-7 text-[13px]" @click="addFetched">添加勾选的</Button>
          </div>
        </div>
      </div>

      <!-- 高级参数（可折叠）：跟随 pi 的参数习惯 -->
      <details class="rounded-md border border-border bg-background/60">
        <summary class="cursor-pointer px-3 py-2 text-[13px] font-medium text-muted-foreground select-none">
          高级参数（可选）
        </summary>
        <div class="grid gap-3 border-t border-border p-3 sm:grid-cols-3">
          <div class="space-y-1.5">
            <Label class="text-[13px]">思考等级</Label>
            <select v-model="editing.thinking" class="h-8 w-full rounded-md border border-border bg-background px-2 text-[13px] outline-none">
              <option value="">默认</option>
              <option value="off">off</option>
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
          </div>
          <div class="space-y-1.5">
            <Label class="text-[13px]">温度（0–2）</Label>
            <Input v-model.number="editing.temperature" type="number" step="0.1" min="0" max="2" class="h-8" placeholder="默认" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[13px]">最大输出 tokens</Label>
            <Input v-model.number="editing.max_tokens" type="number" min="256" class="h-8" placeholder="默认" />
          </div>
        </div>
      </details>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="cancelEdit">取消</Button>
        <Button size="sm" class="gap-1.5" :disabled="testing || saving" @click="testAndSave">
          <Zap v-if="!testing" class="size-3.5" />
          <Spinner v-else class="size-3.5" />
          测试并保存
        </Button>
      </div>
    </div>

    <!-- 渠道列表 -->
    <ul v-if="models.length" class="divide-y divide-border rounded-lg border border-border">
      <li v-for="m in models" :key="m.name" class="px-4 py-3">
        <div class="flex items-center gap-3">
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-2 text-sm font-medium">
              {{ m.name }}
              <Badge v-if="activeModel === m.name && kindOf(m) === 'chat'" variant="default" class="shrink-0 text-[12px]">当前</Badge>
              <Badge v-if="kindOf(m) !== 'chat'" variant="secondary" class="shrink-0 text-[12px]">{{ KIND_LABEL[kindOf(m)] }}</Badge>
              <Badge variant="outline" class="shrink-0 text-[12px]">{{ m.provider }}</Badge>
            </p>
            <p class="mt-0.5 truncate font-mono text-[13px] text-muted-foreground">{{ m.base_url }}</p>
          </div>
          <Button variant="ghost" size="icon" title="编辑" @click="startEdit(m)">
            <Pencil class="size-4" />
          </Button>
          <Button variant="ghost" size="icon" title="删除" @click="remove(m)">
            <Trash2 class="size-4" />
          </Button>
        </div>
        <!-- 渠道下的模型：对话渠道点一下设为当前；向量/重排渠道只展示（去知识库设置里选） -->
        <div class="mt-2 flex flex-wrap gap-1.5">
          <button
            v-for="id in modelIdsOf(m)"
            :key="id"
            :disabled="kindOf(m) !== 'chat'"
            class="flex items-center gap-1 rounded-md border px-2 py-0.5 text-[13px] transition-colors"
            :class="kindOf(m) !== 'chat'
              ? 'border-border text-muted-foreground'
              : activeKey === modelKey(m.name, id) ? 'border-primary/50 bg-primary/10 font-medium' : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'"
            :title="kindOf(m) !== 'chat' ? '向量/重排模型在「知识库」设置里选用' : activeKey === modelKey(m.name, id) ? '当前使用中' : '设为当前模型'"
            @click="kindOf(m) === 'chat' && makeActive(m.name, id)"
          >
            <Check v-if="kindOf(m) === 'chat' && activeKey === modelKey(m.name, id)" class="size-3" />
            {{ id }}
          </button>
        </div>
      </li>
    </ul>

    <div v-else-if="!loading && !editing" class="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
      还没有模型渠道，点右上角新增一个
    </div>

    <p v-if="saving" class="text-[13px] text-muted-foreground">保存中…</p>
  </div>
</template>
