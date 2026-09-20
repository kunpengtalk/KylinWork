<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Brain, Plus, Trash2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'vue-sonner'
import { addMemory, listMemory, removeMemory, saveMemoryManual, type MemoryData } from '@/api/client'

/**
 * 长期记忆。
 * <p>
 * 跨任务成立的用户偏好、常用路径、明确纠正过的做法都存在本机，会进每一次任务的系统提示词。
 * 这一页是桌面客户端独有能力：记忆存在本机，用户随时可查可改。
 */
const data = ref<MemoryData>({ content: '', items: [] })
const loading = ref(true)
const draft = ref('')
/** 是否共享给所有工作空间（对应后端的 shared 标记） */
const shared = ref(false)
const saving = ref(false)

onMounted(async () => {
  await load()
  loading.value = false
})

async function load() {
  try { data.value = await listMemory() } catch (e) { toast.error('读取记忆失败：' + (e as Error).message) }
}

async function handleAdd() {
  const t = draft.value.trim()
  if (!t) return
  try {
    await addMemory(t, shared.value)
    draft.value = ''
    await load()
    toast.success('已记住')
  } catch (e) { toast.error('添加失败：' + (e as Error).message) }
}

async function handleRemove(id: string) {
  try { await removeMemory(id); await load(); toast.success('已删除') }
  catch (e) { toast.error('删除失败：' + (e as Error).message) }
}

async function handleSaveManual() {
  saving.value = true
  try { await saveMemoryManual(data.value.content); toast.success('已保存') }
  catch (e) { toast.error('保存失败：' + (e as Error).message) }
  finally { saving.value = false }
}
</script>

<template>
  <div class="settings-pane mx-auto w-full max-w-3xl space-y-6 px-10 py-8">
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Brain class="size-5" /> 长期记忆
        </CardTitle>
        <CardDescription class="mt-1">
          跨任务成立的事实：你的偏好、习惯、常用路径、纠正过我的地方。只存这些，任务过程不记。
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <div class="flex gap-2">
          <Input v-model="draft" class="h-9" placeholder="例如：报告一律交 PDF，不要 Word" @keyup.enter="handleAdd" />
          <Button size="sm" class="h-9 gap-1.5" @click="handleAdd">
            <Plus class="size-3.5" /> 记住
          </Button>
        </div>
        <label class="flex cursor-pointer items-center gap-1.5 text-[13px] text-muted-foreground">
          <input v-model="shared" type="checkbox" class="size-3.5 accent-current" />
          共享给所有工作空间（默认只在本工作空间生效）
        </label>

        <div v-if="loading" class="flex justify-center py-10">
          <Spinner class="size-6 text-muted-foreground" />
        </div>

        <div v-else-if="!data.items.length" class="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          还没有记忆
        </div>

        <ul v-else class="divide-y divide-border rounded-lg border border-border">
          <li v-for="m in data.items" :key="m.id" class="flex items-center gap-3 px-4 py-2.5">
            <p class="min-w-0 flex-1 text-sm">{{ m.text }}</p>
            <Badge v-if="m.scope" variant="secondary" class="shrink-0 text-[12px]">{{ m.scope }}</Badge>
            <Button variant="ghost" size="icon" title="删除" @click="handleRemove(m.id)">
              <Trash2 class="size-4" />
            </Button>
          </li>
        </ul>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">手写备注</CardTitle>
        <CardDescription>想让 AI 每次都看到的背景说明，写在这里。</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <Textarea v-model="data.content" :rows="6" placeholder="例如：我在某某公司负责某某业务，团队 5 人…" />
        <div class="flex justify-end">
          <Button size="sm" :disabled="saving" @click="handleSaveManual">
            {{ saving ? '保存中…' : '保存' }}
          </Button>
        </div>
        <p class="text-[13px] text-muted-foreground">
          <Label class="text-[13px]">注意</Label>：密钥、密码、令牌不要写进来——这段会进入每一次任务的系统提示词。
        </p>
      </CardContent>
    </Card>
  </div>
</template>
