import { createRouter, createWebHashHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'

/**
 * 路由表。
 * <p>
 * 布局与页面的关系：所有主内容页（含左侧菜单的那个壳）都挂在「/」的 children 上，
 * AppShell 提供侧边栏 + 内容区，子路由各自渲染自己的页面。
 * 例外：启动选择页（/launch）和设置（/client-settings）是全屏无壳的——后者自带
 * 左侧分类导航，套进 AppShell 会出现两条左侧栏；平台页面（apps/models/profile/meetings/
 * doc-compare）自带或不带壳，暂时保持原样，等确认了它们该长什么样再收进布局。
 *
 * 关键变化：**没有登录页，也没有登录守卫**。客户端不登录照样能用——
 * 本地引擎、技能、工具、专家、定时任务、成果文件全是本机的。登录走
 * 「点登录 → 弹浏览器平台登录页 → 回调 kylinwork://auth → 回到本 App」。
 */
const routes: RouteRecordRaw[] = [
  // 首次启动的选择页：登录云端 / 先离线用着。选过一次就记住（localStorage）
  { path: '/launch', name: 'Launch', component: () => import('@/views/LaunchView.vue') },

  // 主布局：AppShell 提供左侧栏，下面都是它的内容页
  {
    path: '/',
    component: AppShell,
    children: [
      { path: '', name: 'Workspace', component: () => import('@/views/ChatView.vue') },
      { path: 'experts', name: 'Experts', component: () => import('@/views/ExpertsView.vue') },
      { path: 'automation', name: 'Automation', component: () => import('@/views/SchedulesView.vue') },
      { path: 'prompts', name: 'Prompts', component: () => import('@/views/PromptsView.vue') },
      // 知识库：建库、上传资料（配置在 设置 → 知识库）
      { path: 'knowledge', name: 'Knowledge', component: () => import('@/views/KnowledgeBasesView.vue') },
      // 网页版应用（应用中心 / 会议 / 文档对比 / 模型广场 / 个人信息）不进客户端，
      // 旧链接一律收回：模型 → 本地模型设置，个人信息 → 设置的账号页
      { path: 'models', redirect: '/client-settings/models' },
      { path: 'profile', redirect: '/client-settings/account' },
    ],
  },

  // ==================== 设置（独立整屏壳，不套 AppShell） ====================
  // 设置自带左侧分类导航（SettingsLayout 的 aside）。若把它挂在 AppShell 之下，
  // AppShell 的主菜单会和设置导航同时渲染 → 两条左侧栏叠在一起。所以它是顶层路由，
  // 自己占满整屏，左上角「返回应用」回 /。
  {
    path: '/client-settings',
    component: () => import('@/layouts/SettingsLayout.vue'),
    children: [
      { path: '', redirect: '/client-settings/general' },
      // 功能页（原独立页面收编进设置壳）
      { path: 'plugins', name: 'SettingsPlugins', component: () => import('@/views/PluginsView.vue') },
      { path: 'files', name: 'SettingsFiles', component: () => import('@/views/FilesView.vue') },
      { path: 'memory', name: 'SettingsMemory', component: () => import('@/views/MemoryView.vue') },
      { path: 'evolve', name: 'SettingsEvolve', component: () => import('@/views/EvolveView.vue') },
      { path: 'eval', name: 'SettingsEval', component: () => import('@/views/EvalView.vue') },
      { path: 'keys', name: 'SettingsKeys', component: () => import('@/views/ApiKeysView.vue') },
      { path: 'usage', name: 'SettingsUsage', component: () => import('@/views/UsageView.vue') },
      { path: 'security', name: 'SettingsSecurity', component: () => import('@/views/SecurityCenterView.vue') },
      // 设置分类（通用/外观/…/备份）统一由 CategoryPage 按 section 渲染
      { path: ':section', name: 'SettingsCategory', component: () => import('@/views/settings/CategoryPage.vue') },
    ],
  },

  // 网页版应用（应用中心 / 会议 / 文档对比 / 模型广场 / 个人信息）不进客户端，旧链接收回
  { path: '/assistant', name: 'Assistant', component: () => import('@/views/AssistantView.vue') },
  { path: '/apps', redirect: '/' },
  { path: '/meetings', redirect: '/' },
  { path: '/doc-compare', redirect: '/' },
  { path: '/models', redirect: '/client-settings/models' },
  { path: '/profile', redirect: '/client-settings/account' },
  { path: '/profile/skills', redirect: { path: '/experts', query: { tab: 'skills' } } },
  // 「我的密钥 / 用量明细」已统一收进设置 → 云端；老路径一律重定向过去，避免同一页两套入口
  { path: '/profile/usage', redirect: '/client-settings/usage' },
  { path: '/profile/keys', redirect: '/client-settings/keys' },
  {
    path: '/profile/keys/guide',
    name: 'ProfileKeysGuide',
    component: () => import('@/views/ApiKeyGuideView.vue'),
  },

  // 兼容旧路径：功能页已收编进设置壳，老链接一律重定向过去
  { path: '/skills', redirect: { path: '/experts', query: { tab: 'skills' } } },
  { path: '/connectors', redirect: { path: '/experts', query: { tab: 'connectors' } } },
  { path: '/schedules', redirect: '/automation' },
  { path: '/files', redirect: '/client-settings/files' },
  { path: '/library', redirect: '/knowledge' },
  { path: '/client-settings/library', redirect: '/client-settings/knowledge' },
  { path: '/plugins', redirect: '/client-settings/plugins' },
  { path: '/memory', redirect: '/client-settings/memory' },
  { path: '/evolve', redirect: '/client-settings/evolve' },
  { path: '/eval', redirect: '/client-settings/eval' },
  { path: '/security', redirect: '/client-settings/security' },
  { path: '/pet', redirect: '/client-settings' },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

/**
 * 启动模式守卫。
 * <p>
 * 没选过「云端 / 离线」就先去选择页。选过之后（localStorage）不再打扰。
 * 这不是登录守卫——离线模式完整可用，只是没有平台那些能力。
 */
router.beforeEach((to) => {
  if (to.path === '/launch') return true
  if (!localStorage.getItem('kylinwork.mode')) return { path: '/launch' }
  return true
})

/**
 * 懒加载分块取不到时自愈。
 * <p>
 * 页面都是 `() => import(...)` 懒加载的，分块名带内容哈希。如果浏览器/渲染进程手里还是
 * 上一次的 index.html（重新构建过、或构建正写到一半），旧分块名 404，Vue Router 只会记一条
 * 错就完事——界面上表现为「点了没反应」（比如点「设置」）。
 * <p>
 * 这里兜底刷一次整页：重新拿到 index.html，分块名就对上了。只自动刷一次，并在每次
 * 成功导航后清掉标记，免得构建真坏时无限刷新。
 */
const CHUNK_RELOAD_FLAG = 'kylinwork.chunk-reload'
const CHUNK_LOAD_ERROR = /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i

router.onError((err, to) => {
  if (!CHUNK_LOAD_ERROR.test(String((err as Error)?.message || err))) return
  if (sessionStorage.getItem(CHUNK_RELOAD_FLAG)) {
    console.warn('[路由] 分块加载失败且已刷新过一次，不再重试：', err)
    return
  }
  sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1')
  console.warn('[路由] 分块加载失败，整页刷新一次以拿到新的资源清单')
  const hash = to?.fullPath && to.fullPath !== '/' ? `#${to.fullPath}` : window.location.hash || '#/'
  window.location.replace(`${window.location.pathname}${window.location.search}${hash}`)
  window.location.reload()
})

// 导航成功说明资源齐了，清掉标记，下次构建变更还能自愈
router.afterEach(() => {
  sessionStorage.removeItem(CHUNK_RELOAD_FLAG)
})
