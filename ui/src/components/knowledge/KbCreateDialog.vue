<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Plus } from 'lucide-vue-next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { createKnowledgeBase, type KnowledgeBase } from '@/api/client'
import { optionsOfKind, type ModelOption } from './modelOptions'
import type { ModelChannel } from '@/api/engine'

/**
 * 新建知识库：名称、描述、向量 / 重排模型一次填好。
 * <p>
 * 以前是列表上一行输入框——不填名字按钮是灰的，容易被当成「点了没反应」，
 * 也没地方选模型（只能去设置里配全局的）。改成弹窗后，每个库可以各配一套模型。
 */
const props = defineProps<{
  open: boolean
  channels: ModelChannel[]
}>()
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'created', base: KnowledgeBase): void
}>()

const name = ref('')
const description = ref('')
const embedding = ref('')
const rerank = ref('')
const creating = ref(false)
const error = ref('')

const embedOptions = computed<ModelOption[]>(() => optionsOfKind(props.channels, 'embedding'))
const rerankOptions = computed<ModelOption[]>(() => optionsOfKind(props.channels, 'rerank'))
const canSubmit = computed(() => !!name.value.trim() && !creating.value)

// 每次打开重置：模型选择每次重新挑，名称/描述保留（连着建几个库时省得重打）
watch(
  () => props.open,
  (v) => {
    if (!v) return
    embedding.value = ''
    rerank.value = ''
    error.value = ''
  },
)

async function submit() {
  const n = name.value.trim()
  if (!n) return
  creating.value = true
  error.value = ''
  try {
    const r = await createKnowledgeBase({
      name: n,
      description: description.value.trim(),
      embedding: embedding.value,
      rerank: rerank.value,
    })
    emit('created', r.base)
    emit('update:open', false)
    name.value = ''
    description.value = ''
  } catch (e) {
    // 建库失败必须留在弹窗里看得见——静默关掉会让人以为建好了
    error.value = (e as Error).message
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>新建知识库</DialogTitle>
        <DialogDescription>单一主题建一个库，检索更准。建好后可继续上传资料。</DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-4 py-1">
        <div class="space-y-1.5">
          <Label for="kb-name" class="text-[13px]">名称</Label>
          <Input id="kb-name" v-model="name" class="h-9" placeholder="例如：产品手册" @keyup.enter="submit" />
        </div>

        <div class="space-y-1.5">
          <Label for="kb-desc" class="text-[13px]">描述（可选）</Label>
          <Input id="kb-desc" v-model="description" class="h-9" placeholder="这个库存什么资料、给谁用" />
        </div>

        <div class="space-y-1.5">
          <Label class="text-[13px]">向量模型</Label>
          <select
            v-model="embedding"
            class="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none"
          >
            <option value="">跟随全局设置（不启用则按关键词检索）</option>
            <option v-for="o in embedOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
          </select>
          <p v-if="!embedOptions.length" class="text-[12px] text-muted-foreground">
            还没有标记为「向量」的模型，可先建库，之后到「设置 → 知识库」配置。
          </p>
          <p v-else class="text-[12px] text-muted-foreground">选「跟随全局设置」即用「设置 → 知识库」里选的那条。</p>
        </div>

        <div class="space-y-1.5">
          <Label class="text-[13px]">重排模型</Label>
          <select
            v-model="rerank"
            class="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none"
          >
            <option value="">跟随全局设置（不启用则不重排）</option>
            <option v-for="o in rerankOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
          </select>
        </div>

        <p v-if="error" class="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[12px] text-destructive">
          {{ error }}
        </p>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="emit('update:open', false)">取消</Button>
        <Button class="gap-1.5" :disabled="!canSubmit" @click="submit">
          <Spinner v-if="creating" class="size-3.5" />
          <Plus v-else class="size-3.5" /> 新建知识库
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
