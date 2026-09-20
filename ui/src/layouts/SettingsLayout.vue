<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, RotateCcw } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { toast } from 'vue-sonner'
import { resetUiPrefs } from '@/composables/useUiPrefs'
import { SETTINGS_GROUPS as GROUPS } from '@/navigation'

/**
 * 设置壳：左侧分类导航 + 右侧 <RouterView>。
 * <p>
 * 导航样式对齐主流客户端设置页（Cherry Studio / T3 那一类）：
 * 18px 图标 + 15px 标签 + 38px 行高 + 10px 圆角，选中项是浅灰药丸背景；
 * 分组标题用小号灰字，组与组之间留出明显空档——这样一眼能看出「这一坨是一类」。
 * 之前用的是 13px 灰字、没有图标，又小又糊，读起来费劲。
 */
const route = useRoute()
const router = useRouter()

const currentPath = computed(() => route.path)

/** 恢复默认：清掉本机界面偏好（不动引擎配置与成果文件），刷新生效 */
function resetAll() {
  if (!window.confirm('恢复默认界面设置？会清除主题、密度、通用偏好（不影响模型配置与数据）。')) return
  // 主题/密度直接删键；通用偏好转成默认值再写回，别让界面读着旧值
  localStorage.removeItem('kylinwork.appearance')
  localStorage.removeItem('kylinwork.avatar')
  localStorage.removeItem('kylinwork.notify') // 只是本地镜像，真源在引擎配置里
  resetUiPrefs()
  toast.success('已恢复默认，正在刷新…')
  setTimeout(() => window.location.reload(), 600)
}
</script>

<template>
  <div class="flex h-screen overflow-hidden">
    <!-- 左侧分类导航 -->
    <aside class="settings-nav flex w-[268px] shrink-0 flex-col border-r border-border/70 bg-[#fafafa] dark:bg-card/40">
      <!-- 标题 -->
      <div class="flex items-center gap-1.5 px-3.5 pb-2 pt-4">
        <button
          class="flex size-8 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="返回应用"
          @click="router.push('/')"
        >
          <ArrowLeft class="size-[18px]" />
        </button>
        <p class="text-[17px] font-semibold tracking-tight">设置</p>
      </div>

      <!-- 分组导航 -->
      <nav class="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <template v-for="g in GROUPS" :key="g.group">
          <p class="settings-group-label px-3.5 pb-1 pt-5 text-[13px] text-muted-foreground">{{ g.group }}</p>
          <RouterLink
            v-for="c in g.items"
            :key="c.to"
            :to="c.to"
            class="settings-nav-item flex items-center gap-3 rounded-[10px] px-3.5 text-[15px] transition-colors"
            :class="
              currentPath === c.to
                ? 'bg-muted font-medium text-foreground'
                : 'text-foreground/80 hover:bg-muted/60 hover:text-foreground'
            "
          >
            <component :is="c.icon" class="size-[18px] shrink-0" :class="currentPath === c.to ? 'text-foreground' : 'text-muted-foreground'" />
            <span class="min-w-0 flex-1 truncate">{{ c.label }}</span>
          </RouterLink>
        </template>
      </nav>

      <!-- 恢复默认放到导航底部：内容区就不必再顶一条与页面标题重复的横条 -->
      <div class="border-t border-border/70 p-3">
        <Button
          variant="ghost"
          class="h-9 w-full justify-start gap-2.5 rounded-[10px] px-3.5 text-[14px] font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          @click="resetAll"
        >
          <RotateCcw class="size-[18px] shrink-0" /> 恢复默认
        </Button>
      </div>
    </aside>

    <!-- 右侧内容 -->
    <div class="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <RouterView />
    </div>
  </div>
</template>

<style scoped>
/* 行高走变量：外观 → 界面密度选「紧凑」时整体压到 32px（以前那个选项是个死开关）。
   scoped + :global 组合：.kylin-compact 挂在 <html> 上，不在本组件根节点内。 */
.settings-nav-item {
  height: var(--nav-row-h, 38px);
}
:global(.kylin-compact) .settings-nav-item {
  height: 32px;
}
:global(.kylin-compact) .settings-group-label {
  padding-top: 12px;
  font-size: 12px;
}
</style>
