<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, ChevronDown, Cpu, Lock, Search, X } from 'lucide-vue-next'
import { modelKey, isModelUnhealthy, type ModelChannel, type ModelHealth, type ModelHealthMap } from '@/api/engine'

/**
 * 模型选择器（对话框形态）：
 * - 一个渠道（服务商）下可以挂多个模型，这里把每个模型都列出来单独可选；
 * - 本地模型分组显示，每组头是渠道名，行是模型 id，右侧带健康账本；
 * - 登录后多一组「平台模型」——平台按账号权限下发的模型。
 *
 * 选中值用「渠道::模型」复合键（见 modelKey），同名渠道下的多个模型不会互相混淆。
 */

const props = defineProps<{
  channels: ModelChannel[]
  health?: ModelHealthMap
  platformModels: { id?: number | string; name?: string; displayName?: string; modelId?: string }[]
  /** 当前选中的复合键（channel::model） */
  active: string
  loggedIn: boolean
}>()
const emit = defineEmits<{ (e: 'change', key: string): void; (e: 'login'): void }>()

const open = ref(false)
const kw = ref('')

const platformName = (m: { id?: number | string; name?: string; displayName?: string; modelId?: string }) =>
  m.displayName || m.name || m.modelId || (m.id != null ? String(m.id) : '')

interface Row {
  key: string
  channel: string
  modelId: string
  health?: ModelHealth
}
interface Group {
  channel: string
  provider?: string
  rows: Row[]
}

/** 本地渠道 → 分组（每个渠道一组，组内每个模型一行） */
const localGroups = computed<Group[]>(() =>
  props.channels.map((ch) => {
    const ids = ch.models && ch.models.length ? ch.models : ch.model ? [ch.model] : []
    return {
      channel: ch.name,
      provider: ch.provider,
      rows: ids.map((id) => ({ key: modelKey(ch.name, id), channel: ch.name, modelId: id, health: props.health?.[modelKey(ch.name, id)] })),
    }
  }),
)

const platformGroup = computed<Group | null>(() => {
  if (!props.loggedIn || !props.platformModels.length) return null
  return {
    channel: '平台模型',
    rows: props.platformModels.map((m) => ({ key: platformName(m), channel: '平台模型', modelId: platformName(m) })),
  }
})

const q = computed(() => kw.value.trim().toLowerCase())
const matchRow = (r: Row) => !q.value || r.modelId.toLowerCase().includes(q.value) || r.channel.toLowerCase().includes(q.value)

const shownGroups = computed<Group[]>(() => {
  const all = [...localGroups.value, ...(platformGroup.value ? [platformGroup.value] : [])]
  if (!q.value) return all.filter((g) => g.rows.length)
  return all
    .map((g) => ({ ...g, rows: g.rows.filter(matchRow) }))
    .filter((g) => g.rows.length)
})

const totalOptions = computed(() => localGroups.value.reduce((n, g) => n + g.rows.length, 0))

/** 当前选中项的展示名：优先「模型 id」，找不到就退回渠道名 */
const currentLabel = computed(() => {
  for (const g of localGroups.value) {
    const hit = g.rows.find((r) => r.key === props.active)
    if (hit) return hit.modelId
  }
  if (props.platformModels.some((m) => platformName(m) === props.active)) return props.active
  // 老配置的 active 可能只有渠道名
  return props.channels.find((c) => c.name === props.active)?.model || props.active || '选择模型'
})

/** 健康账本：近 N 次 X 成；连挂 ≥2 次标红（坏渠道一眼看出来） */
function healthText(h?: ModelHealth): string {
  if (!h || !h.n) return ''
  return `近${h.n}次${h.ok || 0}成${isModelUnhealthy(h) ? ' ⚠' : ''}`
}
function isBad(h?: ModelHealth): boolean {
  return isModelUnhealthy(h)
}

function choose(key: string) {
  emit('change', key)
  open.value = false
  kw.value = ''
}
function close() {
  open.value = false
  kw.value = ''
}
</script>

<template>
  <div>
    <button
      class="flex h-7 max-w-52 cursor-pointer items-center gap-1.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent"
      title="切换模型"
      @click="open = true"
    >
      <Lock v-if="!loggedIn" class="size-3 shrink-0 text-muted-foreground/50" />
      <Cpu v-else class="size-3.5 shrink-0" />
      <span class="min-w-0 truncate">{{ currentLabel }}</span>
      <ChevronDown class="size-3 shrink-0" />
    </button>

    <teleport to="body">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]"
        @click.self="close"
      >
        <div class="flex max-h-[72vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl">
          <div class="flex items-center gap-2 border-b border-border px-4 py-3">
            <p class="flex-1 text-sm font-semibold">选择模型</p>
            <span class="text-[11px] text-muted-foreground">{{ totalOptions }} 个本地模型</span>
            <button class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" @click="close">
              <X class="size-4" />
            </button>
          </div>

          <div class="border-b border-border px-4 py-2">
            <div class="flex items-center gap-2 rounded-md border border-border bg-background px-2">
              <Search class="size-3.5 shrink-0 text-muted-foreground" />
              <input
                v-model="kw"
                class="h-8 w-full bg-transparent text-sm outline-none"
                placeholder="搜索模型或渠道…"
                autofocus
              />
            </div>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            <div v-for="g in shownGroups" :key="g.channel" class="mb-1">
              <div class="flex items-center gap-2 px-2 pb-1 pt-2">
                <p class="text-[11px] font-medium text-muted-foreground">{{ g.channel }}</p>
                <span v-if="g.provider" class="rounded border border-border px-1 text-[10px] text-muted-foreground">{{ g.provider }}</span>
                <span v-if="g.rows.length > 1" class="text-[10px] text-muted-foreground/70">{{ g.rows.length }} 个模型</span>
              </div>
              <button
                v-for="r in g.rows"
                :key="r.key"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                :class="r.key === active ? 'bg-accent/60' : ''"
                @click="choose(r.key)"
              >
                <Check class="size-3.5 shrink-0" :class="r.key === active ? 'text-foreground' : 'text-transparent'" />
                <span class="min-w-0 flex-1 truncate font-mono text-[12px]">{{ r.modelId }}</span>
                <span v-if="healthText(r.health)" class="shrink-0 text-[10px]" :class="isBad(r.health) ? 'text-destructive' : 'text-muted-foreground'">
                  {{ healthText(r.health) }}
                </span>
              </button>
            </div>

            <p v-if="!shownGroups.length" class="px-3 py-8 text-center text-xs text-muted-foreground">
              没有匹配的模型
            </p>

            <div v-if="!loggedIn" class="mt-2 flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2">
              <Lock class="size-3.5 text-muted-foreground" />
              <span class="flex-1 text-[11px] text-muted-foreground">登录后解锁平台模型</span>
              <button class="text-[11px] font-medium text-primary hover:underline" @click="emit('login'); close()">去登录</button>
            </div>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>
