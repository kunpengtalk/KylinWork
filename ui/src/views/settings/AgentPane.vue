<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'vue-sonner'
import { getSettings, saveSettings } from '@/api/client'
import { modelKey, parseModelKey, type ModelChannel } from '@/api/engine'

/**
 * Agent 参数 + 助理身份。
 * <p>
 * 这些直接决定本地引擎怎么干活：一次最多跑多少步、多久算卡死、
 * 上下文撑到多大开始压缩、token 花到多少强行收尾。改完立刻生效，不用重启。
 */
const loading = ref(true)
const saving = ref(false)

const agent = ref({
  max_steps: 25,
  tool_timeout_ms: 120000,
  max_runtime_ms: 1800000,
  auto_continue_rounds: 0,
  llm_timeout_ms: 300000,
  max_context_chars: 120000,
  max_tokens_budget: 0,
  failover_model: '',
  failover_model_id: '',
})

const assistant = ref<{ name: string; avatar: string }>({ name: 'KylinWork', avatar: '🤖' })
const persona = ref('')
/** 渠道摊平成「渠道 · 模型」，备用渠道也能挑到具体模型 */
const modelOptions = ref<{ key: string; label: string }[]>([])
/** 备用渠道的复合键（空 = 不启用） */
const failoverKey = ref('')

onMounted(async () => {
  try {
    const s = await getSettings()
    if (s.agent) Object.assign(agent.value, s.agent)
    const asst = s.assistant as { name?: unknown; avatar?: unknown } | undefined
    if (asst) assistant.value = { name: String(asst.name || 'KylinWork'), avatar: String(asst.avatar || '🤖') }
    persona.value = String(s.persona || '')
    modelOptions.value = ((s.models as ModelChannel[]) || []).flatMap((ch) => {
      const ids = ch.models && ch.models.length ? ch.models : ch.model ? [ch.model] : []
      return ids.map((id) => ({ key: modelKey(ch.name, id), label: `${ch.name} · ${id}` }))
    })
    if (agent.value.failover_model) failoverKey.value = modelKey(agent.value.failover_model, agent.value.failover_model_id)
  } catch (e) {
    toast.error('读取失败：' + (e as Error).message)
  } finally {
    loading.value = false
  }
})

async function save() {
  saving.value = true
  try {
    const fo = failoverKey.value ? parseModelKey(failoverKey.value) : { name: '', modelId: '' }
    await saveSettings({
      agent: { ...agent.value, failover_model: fo.name, failover_model_id: fo.modelId },
      assistant: assistant.value,
      persona: persona.value,
    })
    toast.success('已保存并生效')
  } catch (e) {
    toast.error('保存失败：' + (e as Error).message)
  } finally {
    saving.value = false
  }
}

const MIN = 60 * 1000
function toMin(ms: number) {
  return Math.round((Number(ms) || 0) / MIN)
}

const stepsHint = computed(() => (agent.value.max_steps > 100 ? '上限 100，超出会被引擎压回来' : ''))
</script>

<template>
  <div class="space-y-5">
    <div v-if="loading" class="flex justify-center py-10">
      <Spinner class="size-6 text-muted-foreground" />
    </div>

    <template v-else>
      <section class="space-y-3">
        <h3 class="text-base font-medium">执行参数</h3>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label>最大步数</Label>
            <Input v-model.number="agent.max_steps" type="number" min="1" max="100" class="h-9" />
            <p class="text-[13px]" :class="stepsHint ? 'text-amber-600' : 'text-muted-foreground'">
              {{ stepsHint || '一轮任务最多调多少次工具' }}
            </p>
          </div>
          <div class="space-y-1.5">
            <Label>单轮任务最长运行（分钟）</Label>
            <Input :model-value="toMin(agent.max_runtime_ms)" type="number" min="1" class="h-9"
                   @update:model-value="agent.max_runtime_ms = Number($event) * 60000" />
            <p class="text-[13px] text-muted-foreground">含所有专家子任务的总时长</p>
          </div>
          <div class="space-y-1.5">
            <Label>工具超时（分钟）</Label>
            <Input :model-value="toMin(agent.tool_timeout_ms)" type="number" min="1" class="h-9"
                   @update:model-value="agent.tool_timeout_ms = Number($event) * 60000" />
          </div>
          <div class="space-y-1.5">
            <Label>模型无响应判死（分钟）</Label>
            <Input :model-value="toMin(agent.llm_timeout_ms)" type="number" min="1" class="h-9"
                   @update:model-value="agent.llm_timeout_ms = Number($event) * 60000" />
            <p class="text-[13px] text-muted-foreground">连续这么久一个字都不吐才算挂</p>
          </div>
          <div class="space-y-1.5">
            <Label>自动续跑轮数</Label>
            <Input v-model.number="agent.auto_continue_rounds" type="number" min="0" max="20" class="h-9" />
            <p class="text-[13px] text-muted-foreground">撞到步数/时长上限后自动接着干几轮</p>
          </div>
          <div class="space-y-1.5">
            <Label>上下文上限（字符）</Label>
            <Input v-model.number="agent.max_context_chars" type="number" min="20000" class="h-9" />
            <p class="text-[13px] text-muted-foreground">超了先智能压缩，压不动再截老工具输出</p>
          </div>
          <div class="space-y-1.5">
            <Label>Token 预算（0 = 不限）</Label>
            <Input v-model.number="agent.max_tokens_budget" type="number" min="0" class="h-9" />
          </div>
          <div class="space-y-1.5">
            <Label>备用渠道</Label>
            <select v-model="failoverKey" class="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none">
              <option value="">不启用</option>
              <option v-for="m in modelOptions" :key="m.key" :value="m.key">{{ m.label }}</option>
            </select>
            <p class="text-[13px] text-muted-foreground">主模型挂起或持续报错时才换道，每个任务最多换一次</p>
          </div>
        </div>
      </section>

      <section class="space-y-3">
        <h3 class="text-base font-medium">助理身份</h3>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label>名字</Label>
            <Input v-model="assistant.name" class="h-9" placeholder="KylinWork" />
          </div>
          <div class="space-y-1.5">
            <Label>头像（emoji）</Label>
            <Input v-model="assistant.avatar" class="h-9" placeholder="🤖" />
          </div>
        </div>
        <div class="space-y-1.5">
          <Label>个性化偏好</Label>
          <Textarea v-model="persona" :rows="4" placeholder="例如：报告一律交 PDF；代码注释用中文；数据必须标来源……" />
          <p class="text-[13px] text-muted-foreground">这段会进每一次任务的系统提示词，别写密钥</p>
        </div>
      </section>

      <div class="flex justify-end">
        <Button size="sm" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存并生效' }}</Button>
      </div>
    </template>
  </div>
</template>
