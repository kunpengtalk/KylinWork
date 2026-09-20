<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Download, Pencil, Plus, Trash2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'vue-sonner'
import {
  deleteSkill,
  getSkill,
  installDefaultSkill,
  installSkill,
  listDefaultSkills,
  listEngineSkills,
  saveSkill,
} from '@/api/engine'

/**
 * 本地技能管理。
 * <p>
 * 技能就是一份「怎么做这类活」的操作指南，引擎执行前用 use_skill 加载。
 * 全部落在本机 skills/ 目录，不登录也能新建、编辑、删除、安装。
 */
interface SkillRow {
  name: string
  description?: string
  plugin?: string
}

const skills = ref<SkillRow[]>([])
const loading = ref(true)
const editing = ref<{ name: string; description: string; content: string; original?: string } | null>(null)
const isNew = ref(false)
const saving = ref(false)
const repoUrl = ref('')
const installing = ref(false)
const defaults = ref<{ name: string; description?: string }[]>([])
const showDefaults = ref(false)

onMounted(async () => {
  await load()
  loading.value = false
})

async function load() {
  try {
    skills.value = (await listEngineSkills()) as SkillRow[]
  } catch (e) {
    toast.error('读取技能失败：' + (e as Error).message)
  }
}

function startNew() {
  isNew.value = true
  editing.value = { name: '', description: '', content: '' }
}

async function startEdit(name: string) {
  try {
    const s = await getSkill(name)
    isNew.value = false
    editing.value = {
      name: s.name,
      description: s.description || '',
      content: s.content || '',
      original: s.name,
    }
  } catch (e) {
    toast.error('读取技能内容失败：' + (e as Error).message)
  }
}

async function save() {
  const e = editing.value
  if (!e) return
  if (!e.name.trim()) {
    toast.error('技能名称不能为空')
    return
  }
  saving.value = true
  try {
    await saveSkill({
      name: e.name.trim(),
      description: e.description,
      content: e.content,
      original_name: isNew.value ? undefined : e.original,
    })
    toast.success('已保存')
    editing.value = null
    await load()
  } catch (err) {
    toast.error('保存失败：' + (err as Error).message)
  } finally {
    saving.value = false
  }
}

async function remove(name: string) {
  if (!window.confirm(`删除技能「${name}」？`)) return
  try {
    await deleteSkill(name)
    toast.success('已删除')
    await load()
  } catch (e) {
    toast.error('删除失败：' + (e as Error).message)
  }
}

async function installFromRepo() {
  const repo = repoUrl.value.trim()
  if (!repo) return
  installing.value = true
  try {
    await installSkill(repo)
    toast.success('安装完成')
    repoUrl.value = ''
    await load()
  } catch (e) {
    toast.error('安装失败：' + (e as Error).message)
  } finally {
    installing.value = false
  }
}

async function toggleDefaults() {
  showDefaults.value = !showDefaults.value
  if (showDefaults.value && !defaults.value.length) {
    try {
      defaults.value = await listDefaultSkills()
    } catch {
      defaults.value = []
    }
  }
}

async function installDefault(names: string[]) {
  try {
    await installDefaultSkill(names)
    toast.success(`已安装 ${names.length} 个技能`)
    await load()
  } catch (e) {
    toast.error('安装失败：' + (e as Error).message)
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-base font-medium">本地技能</h3>
        <p class="mt-0.5 text-[13px] text-muted-foreground">
          存在本机 skills/ 目录，不登录也能新建、编辑、删除、安装。
        </p>
      </div>
      <div class="flex gap-2">
        <Button variant="outline" size="sm" @click="toggleDefaults">
          {{ showDefaults ? '收起内置' : '内置技能' }}
        </Button>
        <Button size="sm" class="gap-1.5" @click="startNew">
          <Plus class="size-3.5" /> 新建技能
        </Button>
      </div>
    </div>

    <!-- 从 GitHub 安装 -->
    <div class="flex gap-2">
      <Input v-model="repoUrl" class="h-9" placeholder="从 GitHub 安装：owner/repo" />
      <Button variant="outline" size="sm" class="h-9 shrink-0 gap-1.5" :disabled="installing" @click="installFromRepo">
        <Download class="size-3.5" /> 安装
      </Button>
    </div>

    <!-- 内置技能 -->
    <div v-if="showDefaults" class="rounded-lg border border-border bg-muted/30 p-3">
      <div class="flex items-center justify-between">
        <p class="text-sm font-medium">内置技能</p>
        <Button v-if="defaults.length" size="sm" variant="outline" @click="installDefault(defaults.map((d) => d.name))">
          全部安装
        </Button>
      </div>
      <ul class="mt-2 space-y-1">
        <li v-for="d in defaults" :key="d.name" class="flex items-center gap-2 text-[13px]">
          <code class="rounded bg-background px-1">{{ d.name }}</code>
          <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ d.description }}</span>
        </li>
      </ul>
      <p v-if="!defaults.length" class="mt-2 text-[13px] text-muted-foreground">没有可安装的内置技能</p>
    </div>

    <div v-if="loading" class="flex justify-center py-10">
      <Spinner class="size-6 text-muted-foreground" />
    </div>

    <!-- 编辑表单 -->
    <div v-if="editing" class="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-1.5">
          <Label>技能名称</Label>
          <Input v-model="editing.name" class="h-9" :disabled="!isNew" placeholder="ppt-design" />
        </div>
        <div class="space-y-1.5">
          <Label>一句话说明</Label>
          <Input v-model="editing.description" class="h-9" placeholder="给模型看它该在什么时候用这个技能" />
        </div>
      </div>
      <div class="space-y-1.5">
        <Label>技能内容（Markdown）</Label>
        <Textarea v-model="editing.content" :rows="12" placeholder="写清楚步骤、规范、模板……" />
      </div>
      <div class="flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="editing = null">取消</Button>
        <Button size="sm" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</Button>
      </div>
    </div>

    <!-- 列表 -->
    <ul v-if="skills.length" class="divide-y divide-border rounded-lg border border-border">
      <li v-for="s in skills" :key="s.name" class="flex items-center gap-3 px-4 py-2.5">
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-2 text-sm font-medium">
            {{ s.name }}
            <Badge v-if="s.plugin" variant="outline" class="shrink-0 text-[12px]">{{ s.plugin }}</Badge>
            <Badge v-else variant="secondary" class="shrink-0 text-[12px]">本地</Badge>
          </p>
          <p class="mt-0.5 truncate text-[13px] text-muted-foreground">{{ s.description || '（无说明）' }}</p>
        </div>
        <Button variant="ghost" size="icon" title="编辑" @click="startEdit(s.name)">
          <Pencil class="size-4" />
        </Button>
        <Button variant="ghost" size="icon" title="删除" @click="remove(s.name)">
          <Trash2 class="size-4" />
        </Button>
      </li>
    </ul>

    <div v-else-if="!loading && !editing" class="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
      还没有本地技能
    </div>
  </div>
</template>
