<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppSidebar from '@/components/AppSidebar.vue'
import { cn } from '@/lib/utils'
import { uiPrefs } from '@/composables/useUiPrefs'

/**
 * 主框架：导航 + 内容区。
 * <p>
 * 作为布局路由的父组件，用 RouterView 渲染子页面——这样所有主内容页
 * 自动带上侧边栏，不用每个页面自己包一层壳（之前的做法导致核心页面没侧边栏）。
 * <p>
 * 桌面端侧栏常驻；窄屏收成抽屉，openSidebar 传给需要唤起它的页面。
 * 侧栏在左还是右由设置 → 通用的「侧边栏位置」决定（以前那个选项是死的）。
 */
const sidebarOpen = ref(false)
const router = useRouter()

const onRight = computed(() => uiPrefs.sidebarSide === 'right')

function openSidebar() {
  sidebarOpen.value = true
}
function closeSidebar() {
  sidebarOpen.value = false
}

function newTask() {
  closeSidebar()
  // 已在工作空间时 router.push('/') 是同路由导航，会被 Vue Router 吃掉；
  // 用事件让 ChatView 自己重置，保证「新任务」按钮任何状态下都生效。
  window.dispatchEvent(new CustomEvent('kylinwork:new-task'))
  // 带上 new=1：从别的页面点「新任务」时，对话页早已被卸载、事件没人接，
  // 这个标记会随路由一起到达——ChatView 挂载时才知道用户要的是新任务，
  // 而不是「落回上次在看的那一个」。
  void router.push({ path: '/', query: { new: '1' } })
}
function openSession(id: string) {
  closeSidebar()
  // 已经在 /?session=xx 时再点同一条，Vue Router 会判定「导航重复」直接吃掉这次跳转，
  // 右侧就停在原地不动。双保险：先发事件让 ChatView 自己切，再走路由（地址栏同步）。
  window.dispatchEvent(new CustomEvent("kylinwork:open-session", { detail: { id } }))
  void router.push({ path: "/", query: { session: id } })
}
</script>

<template>
  <div class="flex h-screen w-full overflow-hidden text-foreground">
    <!-- 窄屏遮罩 -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-40 bg-black/50 md:hidden"
      @click="closeSidebar"
    />

    <!-- 侧边导航（位置可切左/右） -->
    <aside
      :class="cn(
        'fixed inset-y-0 z-50 w-[264px] shrink-0 bg-card/80 backdrop-blur-xl transition-transform duration-200 md:static md:translate-x-0',
        onRight ? 'right-0 border-l border-border' : 'left-0 border-r border-border',
        sidebarOpen ? 'translate-x-0' : onRight ? 'translate-x-full' : '-translate-x-full',
        onRight && 'md:order-2',
      )"
    >
      <AppSidebar
        @navigate="closeSidebar"
        @new-task="newTask"
        @open-session="openSession"
      />
    </aside>

    <!-- 内容区：布局路由时渲染子路由页面；页面内嵌使用时渲染 @default 插槽 -->
    <!-- overflow-y-auto 是「文档型」页面（专家广场、自动化这类长卡片页）唯一的滚动条：
         它们自己不建滚动容器，只把内容铺高，全靠这里兜住。ChatView 这类自带滚动区的
         页面内容不会溢出，因此不会多出第二条滚动条。 -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-transparent" :class="onRight && 'md:order-1'">
      <slot :open-sidebar="openSidebar">
        <RouterView v-slot="{ Component }">
          <component :is="Component" :open-sidebar="openSidebar" class="h-full min-h-0" />
        </RouterView>
      </slot>
    </div>
  </div>
</template>
