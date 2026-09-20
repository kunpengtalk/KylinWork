<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Pencil, Plus, Trash2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import ExpertAvatar from '@/components/ExpertAvatar.vue'
import { EXPERT_ICONS } from '@/components/expertIcons'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'vue-sonner'
import { deleteExpert, listEngineExperts, listEngineSkills, saveExpert } from '@/api/engine'

/**
 * 专家管理。
 * <p>
 * 专家 = 一套角色设定 + 一组技能，任务里通过 delegate_to_expert 委派给它。
 * 存在本机 experts.json，不登录也能增删。
 */
interface ExpertRow {
  name: string
  alias?: string
  avatar?: string
  category?: string
  tags?: string[]
  description?: string
  skills?: string[]
  system?: string
  builtin?: boolean
}

const experts = ref<ExpertRow[]>([])
const skillNames = ref<string[]>([])
const loading = ref(true)
const editing = ref<ExpertRow | null>(null)
const isNew = ref(false)
const saving = ref(false)

onMounted(async () => {
  await load()
  loading.value = false
})

async function load() {
  try {
    experts.value = (await listEngineExperts()) as ExpertRow[]
  } catch {
    experts.value = []
  }
  try {
    const s = (await listEngineSkills()) as { name: string }[]
    skillNames.value = s.map((x) => x.name)
  } catch {
    skillNames.value = []
  }
}

function startNew() {
  isNew.value = true
  editing.value = { name: '', alias: '', avatar: 'briefcase', category: '通用', tags: [], description: '', skills: [], system: '' }
}

async function startEdit(name: string) {
  const e = experts.value.find((x) => x.name === name)
  if (!e) return
  isNew.value = false
  editing.value = { ...e, tags: [...(e.tags || [])], skills: [...(e.skills || [])] }
}

async function save() {
  const e = editing.value
  if (!e) return
  if (!e.name.trim() || !e.system?.trim()) {
    toast.error('名称和角色设定（提示词）都要填')
    return
  }
  saving.value = true
  try {
    await saveExpert({ ...e, original_name: isNew.value ? undefined : e.name })
    toast.success('已保存')
    editing.value = null
    await load()
  } catch (err) {
    toast.error('保存失败：' + (err as Error).message)
  } finally {
    saving.value = false
  }
}

async function remove(e: ExpertRow) {
  // 内置专家删了就回不来了（要重装/恢复默认），确认语必须说清楚，别跟自建的一样一句话带过
  const msg = e.builtin
    ? `「${e.name}」是内置专家。删除后需要恢复默认或重装才能找回，确定删除？`
    : `删除专家「${e.name}」？`
  if (!window.confirm(msg)) return
  try {
    await deleteExpert(e.name)
    toast.success('已删除')
    await load()
  } catch (err) {
    toast.error('删除失败：' + (err as Error).message)
  }
}

function toggleSkill(s: string) {
  const e = editing.value
  if (!e) return
  e.skills = e.skills?.includes(s) ? e.skills.filter((x) => x !== s) : [...(e.skills || []), s]
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-base font-medium">专家</h3>
        <p class="mt-0.5 text-[13px] text-muted-foreground">
          角色设定 + 专属技能，任务里可以被委派。存本机，不登录也能增删。
        </p>
      </div>
      <Button size="sm" class="gap-1.5" @click="startNew">
        <Plus class="size-3.5" /> 新建专家
      </Button>
    </div>

    <div v-if="loading" class="flex justify-center py-10">
      <Spinner class="size-6 text-muted-foreground" />
    </div>

    <!-- 编辑 -->
    <div v-if="editing" class="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <div class="grid gap-3 sm:grid-cols-3">
        <div class="space-y-1.5">
          <Label>名称</Label>
          <Input v-model="editing.name" class="h-9" :disabled="!isNew" placeholder="PPT设计师" />
        </div>
        <div class="space-y-1.5">
          <Label>花名</Label>
          <Input v-model="editing.alias" class="h-9" placeholder="可选" />
        </div>
        <div class="space-y-1.5">
          <Label>头像图标</Label>
          <div class="flex flex-wrap gap-1 rounded-md border border-border bg-background p-1.5">
            <button
              v-for="ic in EXPERT_ICONS"
              :key="ic.key"
              type="button"
              class="flex size-8 items-center justify-center rounded-md transition-colors"
              :class="editing.avatar === ic.key ? 'bg-primary/10 text-primary ring-1 ring-primary' : 'text-muted-foreground hover:bg-accent'"
              :title="ic.label"
              @click="editing.avatar = ic.key"
            >
              <component :is="ic.icon" class="size-4" />
            </button>
          </div>
        </div>
      </div>

      <div class="space-y-1.5">
        <Label>一句话简介</Label>
        <Input v-model="editing.description" class="h-9" placeholder="给模型看它什么时候该找这位专家" />
      </div>

      <div class="space-y-1.5">
        <Label>角色设定（系统提示词）</Label>
        <Textarea v-model="editing.system" :rows="8" placeholder="你是……擅长……交付时……" />
      </div>

      <div class="space-y-1.5">
        <Label>专属技能</Label>
        <div class="flex flex-wrap gap-1.5 rounded-md border border-border bg-background p-2">
          <button
            v-for="s in skillNames"
            :key="s"
            class="rounded border px-1.5 py-0.5 text-[13px] transition-colors"
            :class="editing.skills?.includes(s) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent'"
            @click="toggleSkill(s)"
          >
            {{ s }}
          </button>
          <span v-if="!skillNames.length" class="text-[13px] text-muted-foreground">（还没有本地技能）</span>
        </div>
      </div>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="editing = null">取消</Button>
        <Button size="sm" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</Button>
      </div>
    </div>

    <!-- 列表 -->
    <ul v-if="experts.length" class="divide-y divide-border rounded-lg border border-border">
      <li v-for="e in experts" :key="e.name" class="flex items-center gap-3 px-4 py-2.5">
        <ExpertAvatar :icon="e.avatar" :category="e.category" :size="32" />
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-2 text-sm font-medium">
            {{ e.name }}
            <span v-if="e.alias" class="text-[13px] font-normal text-muted-foreground">· {{ e.alias }}</span>
            <Badge v-if="e.builtin" variant="secondary" class="shrink-0 text-[12px]">内置</Badge>
          </p>
          <p class="mt-0.5 truncate text-[13px] text-muted-foreground">{{ e.description }}</p>
        </div>
        <Button variant="ghost" size="icon" title="编辑" @click="startEdit(e.name)">
          <Pencil class="size-4" />
        </Button>
        <Button variant="ghost" size="icon" :title="e.builtin ? '删除内置专家' : '删除'" @click="remove(e)">
          <Trash2 class="size-4" />
        </Button>
      </li>
    </ul>

    <div v-else-if="!loading && !editing" class="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
      还没有专家
    </div>
  </div>
</template>
