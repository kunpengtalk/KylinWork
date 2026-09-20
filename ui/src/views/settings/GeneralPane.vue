<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { getSettings } from '@/api/client'
import { modelKey, parseModelKey, setActiveModel, type ModelChannel } from '@/api/engine'
import { uiPrefs } from '@/composables/useUiPrefs'

/**
 * 通用（对齐 T3 的 General 设置页）：一行一卡、左标题右控件的表单行。
 * 默认模型真调本地引擎热生效；界面偏好写进 useUiPrefs，由 AppShell / AppSidebar 实时读。
 */
/** 默认模型的复合键「渠道::模型」 */
const defaultModel = ref('')
const channels = ref<ModelChannel[]>([])

const MODES = [
  { key: 'craft', label: 'Craft · 执行' },
  { key: 'goal', label: 'Goal · 目标' },
  { key: 'ask', label: 'Ask · 问答' },
  { key: 'plan', label: 'Plan · 规划' },
]

/** 把渠道列表摊平成「渠道 · 模型」选项：同一渠道下的多个模型都能单独选 */
const modelOptions = computed(() =>
  channels.value.flatMap((ch) => {
    const ids = ch.models && ch.models.length ? ch.models : ch.model ? [ch.model] : []
    return ids.map((id) => ({ key: modelKey(ch.name, id), label: id, channel: ch.name }))
  }),
)

onMounted(async () => {
  try {
    const s = await getSettings()
    channels.value = ((s.models as ModelChannel[]) || [])
    defaultModel.value = modelKey(String(s.active_model || ''), String(s.active_model_id || ''))
  } catch {
    /* 忽略 */
  }
})

async function onDefaultModel() {
  const { name, modelId } = parseModelKey(defaultModel.value)
  if (!name) return
  try {
    await setActiveModel(name, modelId)
    toast.success('默认模型已切换：' + (modelId || name))
  } catch (e) {
    toast.error('切换失败：' + (e as Error).message)
  }
}
</script>

<template>
  <div class="space-y-3">
    <!-- 一行一卡：左标题+描述，右控件 -->
    <div class="rounded-xl border border-border bg-background px-5 py-4">
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium">语言</p>
          <p class="mt-0.5 text-[13px] text-muted-foreground">选择 KylinWork 界面所使用的语言。</p>
        </div>
        <select
          v-model="uiPrefs.lang"
          class="h-9 w-40 cursor-pointer rounded-md border border-border bg-muted/50 px-2 text-sm outline-none"
        >
          <option value="zh">简体中文</option>
        </select>
      </div>
      <p class="mt-2 text-[13px] text-muted-foreground">目前只提供简体中文，多语言在计划中。</p>
    </div>

    <div class="rounded-xl border border-border bg-background px-5 py-4">
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium">默认模型</p>
          <p class="mt-0.5 text-[13px] text-muted-foreground">为新对话选择使用的模型，切换热生效。</p>
        </div>
        <select v-model="defaultModel" class="h-9 w-52 cursor-pointer rounded-md border border-border bg-muted/50 px-2 text-sm outline-none" @change="onDefaultModel">
          <option v-for="o in modelOptions" :key="o.key" :value="o.key">{{ o.channel }} · {{ o.label }}</option>
        </select>
      </div>
    </div>

    <div class="rounded-xl border border-border bg-background px-5 py-4">
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium">新会话模式</p>
          <p class="mt-0.5 text-[13px] text-muted-foreground">选择新建对话的默认执行模式。</p>
        </div>
        <select v-model="uiPrefs.defaultMode" class="h-9 w-40 cursor-pointer rounded-md border border-border bg-muted/50 px-2 text-sm outline-none">
          <option v-for="m in MODES" :key="m.key" :value="m.key">{{ m.label }}</option>
        </select>
      </div>
    </div>

    <p class="px-1 pt-2 text-[13px] font-medium text-muted-foreground">侧边栏组织</p>

    <div class="rounded-xl border border-border bg-background px-5 py-4">
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium">位置</p>
          <p class="mt-0.5 text-[13px] text-muted-foreground">选择侧边栏在屏幕的哪一侧显示。</p>
        </div>
        <select v-model="uiPrefs.sidebarSide" class="h-9 w-40 cursor-pointer rounded-md border border-border bg-muted/50 px-2 text-sm outline-none">
          <option value="left">左侧</option>
          <option value="right">右侧</option>
        </select>
      </div>
    </div>

    <div class="rounded-xl border border-border bg-background px-5 py-4">
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium">项目排序</p>
          <p class="mt-0.5 text-[13px] text-muted-foreground">控制主侧边栏中项目的排列方式。</p>
        </div>
        <select v-model="uiPrefs.projectSort" class="h-9 w-40 cursor-pointer rounded-md border border-border bg-muted/50 px-2 text-sm outline-none">
          <option value="manual">手动排序</option>
          <option value="name">按名称</option>
        </select>
      </div>
    </div>

    <div class="rounded-xl border border-border bg-background px-5 py-4">
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium">线程排序</p>
          <p class="mt-0.5 text-[13px] text-muted-foreground">控制每个项目下会话的排列方式。</p>
        </div>
        <select v-model="uiPrefs.threadSort" class="h-9 w-40 cursor-pointer rounded-md border border-border bg-muted/50 px-2 text-sm outline-none">
          <option value="recent">最近活跃</option>
          <option value="created">创建时间</option>
        </select>
      </div>
    </div>

    <p class="px-1 pt-1 text-[13px] text-muted-foreground">以上界面偏好只保存在本机，不随账号同步。</p>
  </div>
</template>
