<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Boxes, Database, Save, TestTube2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Badge } from '@/components/ui/badge'
import { toast } from 'vue-sonner'
import { getSettings, saveSettings, testKnowledge } from '@/api/client'
import { modelKey, type ModelChannel } from '@/api/engine'
import { cloudList, type CloudProvider } from '@/api/cloud'

/**
 * 知识库设置：选检索用的 embedding / rerank 模型，以及切块 / 召回参数。
 * 模型本身在「设置 → 模型云服务」里配（给模型标类型「向量」/「重排」），
 * 这里只从已配好的模型里挑，不再重复填 base_url 和 Key。
 * <p>
 * 下面列表来自 config.models 里 kind 为 embedding / rerank 的渠道，而渠道是「启用且配好」
 * 的服务商派生出来的——所以服务商名单也要读一份，好把「标了模型却没用上」的原因说清楚。
 */
const router = useRouter()
const loading = ref(true)
const saving = ref(false)

const channels = ref<ModelChannel[]>([])
const providers = ref<CloudProvider[]>([])
const embedding = ref('')
const rerank = ref('')
const tuning = ref({ chunk_size: 800, chunk_overlap: 120, top_k: 6, score_threshold: 0, inject_chars: 6000 })

const testing = ref<'embedding' | 'rerank' | ''>('')
const testResult = ref<Record<string, { ok?: boolean; msg: string }>>({})

/** 某个用途下的可选项：每个模型 id 一条，值是「渠道::模型」复合键 */
function optionsOf(kind: 'embedding' | 'rerank') {
  const out: { key: string; label: string; channel: string; modelId: string }[] = []
  for (const ch of channels.value) {
    if ((ch.kind || 'chat') !== kind) continue
    const ids = ch.models && ch.models.length ? ch.models : ch.model ? [ch.model] : []
    for (const id of ids) out.push({ key: modelKey(ch.name, id), label: `${ch.name} · ${id}`, channel: ch.name, modelId: id })
  }
  return out
}
const embedOptions = computed(() => optionsOf('embedding'))
const rerankOptions = computed(() => optionsOf('rerank'))

/**
 * 标了这类模型、却没能出现在下拉框里的服务商，附卡住的原因。
 * 缺 Key / 没启用这两种情况在界面上长得一模一样（都是「还没有模型」），
 * 用户看见自己明明加过 bge-m3 却选不到，只能猜——这里把话说明白。
 */
function blockedOf(kind: 'embedding' | 'rerank') {
  const out: { name: string; reason: string }[] = []
  for (const p of providers.value) {
    const has = (p.models || []).some((m) => (m.type || 'chat') === kind)
    if (!has || p.configured) continue
    out.push({ name: p.name, reason: p.enabled ? '缺 API Key' : '服务商没启用' })
  }
  return out
}
const blockedEmbed = computed(() => blockedOf('embedding'))
const blockedRerank = computed(() => blockedOf('rerank'))

onMounted(async () => {
  try {
    const s = await getSettings()
    channels.value = ((s.models as ModelChannel[]) || []).map((m) => ({ ...m }))
    const k = s.knowledge as Record<string, unknown> | undefined
    if (k) {
      embedding.value = String(k.embedding || '')
      rerank.value = String(k.rerank || '')
      tuning.value = {
        chunk_size: Number(k.chunk_size) || 800,
        chunk_overlap: Number(k.chunk_overlap) || 120,
        top_k: Number(k.top_k) || 6,
        score_threshold: Number(k.score_threshold) || 0,
        inject_chars: Number(k.inject_chars) || 6000,
      }
    }
  } catch (e) {
    toast.error('读取知识库配置失败：' + (e as Error).message)
  } finally {
    loading.value = false
  }
  // 服务商名单只用于把空状态的原因说清楚，读不到就不提这一嘴，别连累整页
  try {
    providers.value = (await cloudList()).providers || []
  } catch {
    providers.value = []
  }
})

async function runTest(kind: 'embedding' | 'rerank') {
  const ref = kind === 'embedding' ? embedding.value : rerank.value
  if (!ref) {
    // 没选就退回测当前已保存的那个
    testResult.value = { ...testResult.value, [kind]: { ok: false, msg: '请先选择一个模型' } }
    return
  }
  testing.value = kind
  testResult.value = { ...testResult.value, [kind]: { msg: '' } }
  try {
    const r = await testKnowledge(kind, kind === 'embedding' ? { embedding: ref } : { rerank: ref })
    const msg = kind === 'embedding' ? `可用，向量维度 ${r.dim}（${r.model}）` : `可用，最高相关度 ${r.top?.score}`
    testResult.value = { ...testResult.value, [kind]: { ok: true, msg } }
  } catch (e) {
    testResult.value = { ...testResult.value, [kind]: { ok: false, msg: (e as Error).message } }
  } finally {
    testing.value = ''
  }
}

async function save() {
  saving.value = true
  try {
    await saveSettings({ knowledge: { embedding: embedding.value, rerank: rerank.value, ...tuning.value } })
    toast.success('已保存，下一条任务生效')
  } catch (e) {
    toast.error('保存失败：' + (e as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="loading" class="flex justify-center py-10">
    <Spinner class="size-6 text-muted-foreground" />
  </div>

  <div v-else class="space-y-6">
    <p class="text-sm text-muted-foreground">
      知识库按这里的配置做检索：<b>Embedding</b> 把文本转成向量做语义召回，<b>Rerank</b> 对召回结果精排。
      模型本身在
      <button class="text-primary underline-offset-2 hover:underline" @click="router.push('/client-settings/models')">设置 → 模型云服务</button>
      里配：给模型的类型标成「向量」/「重排」，并填好该服务商的 API Key（本地地址免 Key）；库和资料在
      <button class="text-primary underline-offset-2 hover:underline" @click="router.push('/knowledge')">知识库</button>
      页管理。
    </p>

    <!-- Embedding -->
    <div class="space-y-3 rounded-lg border border-border p-4">
      <div class="flex items-center gap-2">
        <Boxes class="size-4 text-muted-foreground" />
        <p class="text-sm font-medium">Embedding 模型</p>
        <Badge variant="outline" class="text-[12px]">与「长期记忆」向量召回共用</Badge>
      </div>
      <div class="flex gap-2">
        <select
          v-model="embedding"
          class="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm outline-none"
          :disabled="!embedOptions.length"
        >
          <option value="">{{ embedOptions.length ? '不启用（退回关键词检索）' : '还没有向量模型' }}</option>
          <option v-for="o in embedOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
        </select>
        <Button variant="outline" size="sm" class="h-9 shrink-0 gap-1.5" :disabled="testing === 'embedding' || !embedding" @click="runTest('embedding')">
          <Spinner v-if="testing === 'embedding'" class="size-3.5" />
          <TestTube2 v-else class="size-3.5" /> 测试
        </Button>
      </div>
      <p v-if="!embedOptions.length" class="text-[13px] text-muted-foreground">
        还没有标记为「向量」的模型。去
        <button class="text-primary underline-offset-2 hover:underline" @click="router.push('/client-settings/models')">模型云服务</button>
        找一家服务商，在它的模型列表里把类型标成「向量」，并填好 API Key（本地地址免 Key）。
      </p>
      <p v-if="!embedOptions.length && blockedEmbed.length" class="text-[13px] text-amber-600 dark:text-amber-400">
        已经标好向量模型、但还没生效：{{ blockedEmbed.map((b) => `${b.name}（${b.reason}）`).join('、') }}。
      </p>
      <p v-if="testResult.embedding?.msg" class="text-[13px]" :class="testResult.embedding.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'">
        {{ testResult.embedding.ok ? '✓ ' : '✗ ' }}{{ testResult.embedding.msg }}
      </p>
    </div>

    <!-- Rerank -->
    <div class="space-y-3 rounded-lg border border-border p-4">
      <div class="flex items-center gap-2">
        <Database class="size-4 text-muted-foreground" />
        <p class="text-sm font-medium">Rerank 模型</p>
        <Badge variant="outline" class="text-[12px]">选填</Badge>
      </div>
      <div class="flex gap-2">
        <select
          v-model="rerank"
          class="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm outline-none"
          :disabled="!rerankOptions.length"
        >
          <option value="">{{ rerankOptions.length ? '不启用' : '还没有重排模型' }}</option>
          <option v-for="o in rerankOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
        </select>
        <Button variant="outline" size="sm" class="h-9 shrink-0 gap-1.5" :disabled="testing === 'rerank' || !rerank" @click="runTest('rerank')">
          <Spinner v-if="testing === 'rerank'" class="size-3.5" />
          <TestTube2 v-else class="size-3.5" /> 测试
        </Button>
      </div>
      <p v-if="!rerankOptions.length" class="text-[13px] text-muted-foreground">
        还没有标记为「重排」的模型。去
        <button class="text-primary underline-offset-2 hover:underline" @click="router.push('/client-settings/models')">模型云服务</button>
        找一家服务商，在它的模型列表里把类型标成「重排」，并填好 API Key（本地地址免 Key）。
      </p>
      <p v-if="!rerankOptions.length && blockedRerank.length" class="text-[13px] text-amber-600 dark:text-amber-400">
        已经标好重排模型、但还没生效：{{ blockedRerank.map((b) => `${b.name}（${b.reason}）`).join('、') }}。
      </p>
      <p v-if="testResult.rerank?.msg" class="text-[13px]" :class="testResult.rerank.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'">
        {{ testResult.rerank.ok ? '✓ ' : '✗ ' }}{{ testResult.rerank.msg }}
      </p>
    </div>

    <!-- 检索参数 -->
    <div class="space-y-3 rounded-lg border border-border p-4">
      <p class="text-sm font-medium">检索参数</p>
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-1.5">
          <Label class="text-[13px]">切块大小（字符）</Label>
          <Input v-model.number="tuning.chunk_size" type="number" min="200" max="4000" class="h-9" />
        </div>
        <div class="space-y-1.5">
          <Label class="text-[13px]">切块重叠（字符）</Label>
          <Input v-model.number="tuning.chunk_overlap" type="number" min="0" max="2000" class="h-9" />
        </div>
        <div class="space-y-1.5">
          <Label class="text-[13px]">召回条数 top_k</Label>
          <Input v-model.number="tuning.top_k" type="number" min="1" max="50" class="h-9" />
        </div>
        <div class="space-y-1.5">
          <Label class="text-[13px]">相似度阈值（低于此分丢弃）</Label>
          <Input v-model.number="tuning.score_threshold" type="number" min="0" max="1" step="0.05" class="h-9" />
        </div>
        <div class="space-y-1.5 sm:col-span-2">
          <Label class="text-[13px]">注入上下文上限（字符）</Label>
          <Input v-model.number="tuning.inject_chars" type="number" min="1000" max="40000" class="h-9" />
        </div>
      </div>
      <p class="text-[13px] text-muted-foreground">
        切块大小影响建索引效果：改了之后要到知识库页「重建索引」才会对新旧文件重跑。
      </p>
    </div>

    <div class="flex items-center gap-2">
      <Button class="h-9 gap-1.5" :disabled="saving" @click="save">
        <Save class="size-3.5" /> 保存
      </Button>
    </div>
  </div>
</template>
