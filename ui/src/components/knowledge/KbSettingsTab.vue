<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { AlertTriangle, Save, TestTube2, Trash2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'vue-sonner'
import { deleteKnowledgeBase, testKnowledge, updateKnowledgeBase, type KnowledgeBase } from '@/api/client'
import { optionsOfKind } from './modelOptions'
import type { ModelChannel } from '@/api/engine'

/**
 * 这个库的设置：名称描述、向量 / 重排模型、切块与召回参数。
 * <p>
 * 留空 = 跟随全局「设置 → 知识库」；只有显式改过的字段才写进库。
 * 换了向量模型，旧向量会作废（引擎会清空并提示重建索引）。
 */
const props = defineProps<{ base: KnowledgeBase; channels: ModelChannel[] }>()
const emit = defineEmits<{ (e: 'changed'): void; (e: 'deleted'): void }>()

const saving = ref(false)
const testing = ref<'embedding' | 'rerank' | ''>('')
const testResult = reactive<Record<string, { ok?: boolean; msg: string }>>({})
const confirmDelete = ref(false)
const deleting = ref(false)

const embedOptions = computed(() => optionsOfKind(props.channels, 'embedding'))
const rerankOptions = computed(() => optionsOfKind(props.channels, 'rerank'))

interface FormState {
  name: string
  description: string
  embedding: string
  rerank: string
  chunk_size?: number
  chunk_overlap?: number
  top_k?: number
  score_threshold?: number
  expand_neighbors: boolean
}

const form = reactive<FormState>(formFrom(props.base))
const baseline = ref(JSON.stringify(formFrom(props.base)))

function formFrom(b: KnowledgeBase): FormState {
  return {
    name: b.name || '',
    description: b.description || '',
    embedding: b.embedding || '',
    rerank: b.rerank || '',
    chunk_size: typeof b.chunk_size === 'number' ? b.chunk_size : undefined,
    chunk_overlap: typeof b.chunk_overlap === 'number' ? b.chunk_overlap : undefined,
    top_k: typeof b.top_k === 'number' ? b.top_k : undefined,
    score_threshold: typeof b.score_threshold === 'number' ? b.score_threshold : undefined,
    expand_neighbors: b.expand_neighbors !== false,
  }
}

/** 数字输入框：清空 = 不写进库（跟随全局），所以空串统一解析成 undefined */
function toNum(v: string | number): number | undefined {
  if (v === '' || v === null || v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// 切到别的库 / 保存回来后重新回填
watch(
  () => [props.base.id, props.base.updated_at],
  () => {
    Object.assign(form, formFrom(props.base))
    baseline.value = JSON.stringify(formFrom(props.base))
    testResult.embedding = { msg: '' }
    testResult.rerank = { msg: '' }
  },
)

const dirty = computed(() => JSON.stringify(form) !== baseline.value && !!form.name.trim())
const tuning = computed(() => props.base.tuning)

async function runTest(kind: 'embedding' | 'rerank') {
  const ref = kind === 'embedding' ? form.embedding : form.rerank
  if (!ref) {
    testResult[kind] = { ok: false, msg: '没选模型时测试的是「设置 → 知识库」里那条全局模型' }
  }
  testing.value = kind
  testResult[kind] = { msg: '' }
  try {
    const r = await testKnowledge(kind, kind === 'embedding' ? { embedding: ref || undefined } : { rerank: ref || undefined })
    const msg = kind === 'embedding' ? `可用，向量维度 ${r.dim}（${r.model}）` : `可用，最高相关度 ${r.top?.score}`
    testResult[kind] = { ok: true, msg }
  } catch (e) {
    testResult[kind] = { ok: false, msg: (e as Error).message }
  } finally {
    testing.value = ''
  }
}

async function save() {
  saving.value = true
  try {
    const r = await updateKnowledgeBase(props.base.id, {
      name: form.name.trim(),
      description: form.description.trim(),
      embedding: form.embedding,
      rerank: form.rerank,
      chunk_size: form.chunk_size ?? null,
      chunk_overlap: form.chunk_overlap ?? null,
      top_k: form.top_k ?? null,
      score_threshold: form.score_threshold ?? null,
      expand_neighbors: form.expand_neighbors,
    })
    baseline.value = JSON.stringify(formFrom(r.base))
    emit('changed')
    if (r.embeddings_reset) {
      toast.warning('已换向量模型，旧向量已作废——到「数据源」点「补齐向量」重建。')
    } else {
      toast.success('已保存')
    }
  } catch (e) {
    toast.error('保存失败：' + (e as Error).message)
  } finally {
    saving.value = false
  }
}

async function doDelete() {
  deleting.value = true
  try {
    await deleteKnowledgeBase(props.base.id)
    confirmDelete.value = false
    emit('deleted')
    toast.success('已删除')
  } catch (e) {
    toast.error('删除失败：' + (e as Error).message)
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto p-4">
    <div class="mx-auto max-w-3xl space-y-4">
      <!-- 基本信息 -->
      <section class="space-y-3 rounded-xl border border-border p-4">
        <p class="text-sm font-medium">基本信息</p>
        <div class="space-y-1.5">
          <Label class="text-[13px]">名称</Label>
          <Input v-model="form.name" class="h-9" maxlength="40" />
        </div>
        <div class="space-y-1.5">
          <Label class="text-[13px]">描述</Label>
          <Textarea v-model="form.description" rows="2" class="resize-none text-sm" placeholder="这个库存什么资料、给谁用" />
        </div>
      </section>

      <!-- 向量模型 -->
      <section class="space-y-3 rounded-xl border border-border p-4">
        <div class="flex items-center gap-2">
          <p class="text-sm font-medium">向量模型</p>
          <span class="text-[11px] text-muted-foreground">留空 = 跟随全局设置</span>
        </div>
        <div class="flex gap-2">
          <select v-model="form.embedding" class="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm outline-none">
            <option value="">跟随全局设置</option>
            <option v-for="o in embedOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
          </select>
          <Button variant="outline" size="sm" class="h-9 shrink-0 gap-1.5" :disabled="testing === 'embedding'" @click="runTest('embedding')">
            <Spinner v-if="testing === 'embedding'" class="size-3.5" />
            <TestTube2 v-else class="size-3.5" /> 测试
          </Button>
        </div>
        <p class="text-[11px] text-muted-foreground">
          当前生效：{{ base.embedding_model || '无（按关键词检索）' }}
          <template v-if="base.embedding_source === 'selected'">（本库指定）</template>
          <template v-else-if="base.embedding_source === 'shared'">（全局默认）</template>
        </p>
        <p v-if="!embedOptions.length" class="text-[12px] text-amber-600 dark:text-amber-400">
          还没有标记为「向量」的模型。到「设置 → 模型云服务」把某家服务商的模型类型标成「向量」并填好 Key。
        </p>
        <p v-if="testResult.embedding?.msg" class="text-[12px]" :class="testResult.embedding.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'">
          {{ testResult.embedding.ok ? '✓ ' : '· ' }}{{ testResult.embedding.msg }}
        </p>
        <p class="text-[11px] text-muted-foreground">换了向量模型后旧向量会作废，需要到「数据源」重建。</p>
      </section>

      <!-- 重排模型 -->
      <section class="space-y-3 rounded-xl border border-border p-4">
        <div class="flex items-center gap-2">
          <p class="text-sm font-medium">重排模型</p>
          <span class="text-[11px] text-muted-foreground">选填，留空 = 跟随全局设置</span>
        </div>
        <div class="flex gap-2">
          <select v-model="form.rerank" class="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm outline-none">
            <option value="">跟随全局设置</option>
            <option v-for="o in rerankOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
          </select>
          <Button variant="outline" size="sm" class="h-9 shrink-0 gap-1.5" :disabled="testing === 'rerank'" @click="runTest('rerank')">
            <Spinner v-if="testing === 'rerank'" class="size-3.5" />
            <TestTube2 v-else class="size-3.5" /> 测试
          </Button>
        </div>
        <p v-if="testResult.rerank?.msg" class="text-[12px]" :class="testResult.rerank.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'">
          {{ testResult.rerank.ok ? '✓ ' : '· ' }}{{ testResult.rerank.msg }}
        </p>
      </section>

      <!-- 切块与召回 -->
      <section class="space-y-3 rounded-xl border border-border p-4">
        <p class="text-sm font-medium">切块与召回</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label class="text-[13px]">切块大小（字符）</Label>
            <Input :model-value="form.chunk_size ?? ''" type="number" min="200" max="4000" class="h-9" placeholder="默认 800" @update:model-value="form.chunk_size = toNum($event)" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[13px]">切块重叠（字符）</Label>
            <Input :model-value="form.chunk_overlap ?? ''" type="number" min="0" max="2000" class="h-9" placeholder="默认 120" @update:model-value="form.chunk_overlap = toNum($event)" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[13px]">召回条数 top_k</Label>
            <Input :model-value="form.top_k ?? ''" type="number" min="1" max="50" class="h-9" placeholder="默认 6" @update:model-value="form.top_k = toNum($event)" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-[13px]">相似度阈值</Label>
            <Input :model-value="form.score_threshold ?? ''" type="number" min="0" max="1" step="0.05" class="h-9" placeholder="默认 0" @update:model-value="form.score_threshold = toNum($event)" />
          </div>
        </div>
        <label class="flex items-center gap-2 text-[13px]">
          <input v-model="form.expand_neighbors" type="checkbox" class="size-3.5 accent-primary">
          合并相邻分块（命中常落在被切开的两段上，拼回一段更连贯）
        </label>
        <p class="text-[11px] text-muted-foreground">改了切块参数后，已有资料要到「数据源」点「重建索引」才会按新参数重切。</p>
        <p v-if="tuning" class="text-[11px] text-muted-foreground">
          当前生效：切块 {{ tuning.chunk_size }} / 重叠 {{ tuning.chunk_overlap }} / top_k {{ tuning.top_k }} / 阈值 {{ tuning.score_threshold }}
        </p>
      </section>

      <!-- 保存 -->
      <div class="flex items-center gap-3">
        <Button class="h-9 gap-1.5" :disabled="saving || !dirty" @click="save">
          <Spinner v-if="saving" class="size-3.5" />
          <Save v-else class="size-3.5" /> 保存
        </Button>
        <span v-if="dirty" class="text-[12px] text-muted-foreground">有未保存的修改</span>
        <span v-else class="text-[12px] text-muted-foreground">已保存</span>
      </div>

      <!-- 危险区 -->
      <section class="space-y-3 rounded-xl border border-destructive/25 p-4">
        <div class="flex items-center gap-2 text-destructive">
          <AlertTriangle class="size-4" />
          <p class="text-sm font-medium">危险操作</p>
        </div>
        <p class="text-[12px] text-muted-foreground">删除知识库会连同其中全部资料、分块与向量一起清除，不可恢复。</p>
        <Button variant="outline" size="sm" class="h-8 gap-1.5 border-destructive/40 text-destructive hover:text-destructive" @click="confirmDelete = true">
          <Trash2 class="size-3.5" /> 删除知识库
        </Button>
      </section>
    </div>

    <Dialog v-model:open="confirmDelete">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除知识库</DialogTitle>
          <DialogDescription>确定删除「{{ base.name }}」及其中的全部资料？此操作不可恢复。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="confirmDelete = false">取消</Button>
          <Button variant="destructive" :disabled="deleting" class="gap-1.5" @click="doDelete">
            <Spinner v-if="deleting" class="size-3.5" /> 删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
