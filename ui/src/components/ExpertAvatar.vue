<script setup lang="ts">
/**
 * 专家头像 — 统一渲染入口，全系统不允许用 emoji 当专家头像（To B 规范）。
 *
 * - `icon` 填 lucide 图标的 kebab-case 名（如 "trending-up"，见 expertIcons.ts 注册表）；
 * - 查不到（含历史数据里的 emoji）一律兜底成 Briefcase 图标，绝不把 emoji 渲染出来；
 * - `category` 决定底色：二级市场=蓝、一级市场与银行=琥珀、企业财务=翠绿，其余中性灰。
 */
import { computed } from 'vue'
import { EXPERT_CATEGORY_TINTS, resolveExpertIcon } from '@/components/expertIcons'

const props = withDefaults(
  defineProps<{
    /** lucide 图标名的 kebab-case，如 "trending-up"；空或不认识时兜底 Briefcase */
    icon?: string
    /** 分类，决定配色（与专家 experts.json 的 category 对应） */
    category?: string
    /** 边长（px），默认 40 */
    size?: number
  }>(),
  { icon: '', category: '', size: 40 },
)

const resolved = computed(() => resolveExpertIcon(props.icon))
const tint = computed(() => EXPERT_CATEGORY_TINTS[String(props.category || '').trim()] || 'bg-muted text-muted-foreground')
const iconSize = computed(() => Math.max(14, Math.round(props.size * 0.5)))
</script>

<template>
  <span
    class="flex shrink-0 items-center justify-center rounded-lg"
    :class="tint"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <component :is="resolved" :size="iconSize" :stroke-width="1.75" />
  </span>
</template>
