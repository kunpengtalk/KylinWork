<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Blocks, Cloud, Download, HardDrive, Loader2, LogIn, MessageSquarePlus, Plug, RefreshCw, Search, Users, Wrench } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import ExpertAvatar from '@/components/ExpertAvatar.vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'vue-sonner'
import { listEngineExperts, listEngineMcp, listEngineSkills, listExpertTeams, saveMcpList, saveSkill } from '@/api/engine'
import { getInfo } from '@/api/client'
import {
  getPlatformSkillContent,
  listPlatformExperts,
  listPlatformMcpServers,
  listPlatformSkills,
  type PlatformExpert,
  type PlatformMcp,
  type PlatformSkill,
} from '@/api/platform'
import { usePlatformAuth } from '@/composables/usePlatformAuth'

/**
 * 专家·技能·连接器（对齐平台 /experts 三 Tab）。
 * <p>
 * 双来源设计：
 * - 本地：本机 skills/ 目录、本地专家（agent 可直接委派）、本机 MCP —— 不登录就能用
 * - 云端（技能市场）：平台侧的技能商城 / 专家 / MCP，登录后加载。
 *   云端专家调平台模型与云端技能；本地专家走本机引擎，能力上看任务需要。
 * 来源分段「全部 / 本地 / 云端」在每个 Tab 里都可切换；未登录选「云端」时给登录引导。
 */

interface Expert {
  name: string
  alias?: string
  avatar?: string
  category?: string
  tags?: string[]
  description?: string
  skills?: string[]
  builtin?: boolean
}

interface Team {
  name: string
  avatar?: string
  description?: string
  members?: string[]
}

interface Skill {
  name: string
  description?: string
  plugin?: string
}

interface McpServer {
  name: string
  transport?: string
  connected?: boolean
  error?: string
  plugin?: string
  tools?: { name: string; description?: string }[]
}

const experts = ref<Expert[]>([])
const teams = ref<Team[]>([])
const skills = ref<Skill[]>([])
const mcp = ref<{ servers?: McpServer[]; total_tools?: number }>({})
const loading = ref(true)
const keyword = ref('')

/** 当前 Tab：支持 ?tab=skills / connectors 直达（侧栏「专家·技能·连接器」带参进入） */
const route = useRoute()
const router = useRouter()
const activeTab = ref(String(route.query.tab || 'experts'))

/**
 * URL 才是准：侧栏「专家广场」和「专家·技能·连接器」指的都是这个路由，
 * 只是 query 不一样；而 query 变化不会重建组件，所以不跟一把的话，
 * 在页内点侧栏另一个入口是「点了没反应」。带上 ?tab= 的深链同理。
 */
watch(
  () => String(route.query.tab || 'experts'),
  (t) => {
    activeTab.value = t
  },
)

/** 切 Tab 顺手写回 URL：状态可分享，也让侧栏那两个入口随时点得动 */
function setTab(v: string) {
  activeTab.value = v
  void router.replace({ query: { ...route.query, tab: v } })
}

/** 召唤专家：跳回对话页并带上 ?expert=名字，由 ChatView 注入角色设定 */
function summon(name: string) {
  router.push({ path: '/', query: { expert: name } })
}

// ---- 登录态与云端（技能市场）数据 ----
const { token: platformToken, login: platformLogin } = usePlatformAuth()
const loggedIn = computed(() => Boolean(platformToken.value))

const platformSkills = ref<PlatformSkill[]>([])
const platformExperts = ref<PlatformExpert[]>([])
const platformMcps = ref<PlatformMcp[]>([])
const platformError = ref('')

async function loadPlatform() {
  platformError.value = ''
  if (!platformToken.value) {
    platformSkills.value = []
    platformExperts.value = []
    platformMcps.value = []
    return
  }
  const fail = (e: unknown) => {
    platformError.value = (e as Error).message
  }
  await Promise.allSettled([
    listPlatformSkills().then((r) => (platformSkills.value = r || [])).catch(fail),
    listPlatformExperts().then((r) => (platformExperts.value = r || [])).catch(fail),
    listPlatformMcpServers().then((r) => (platformMcps.value = r || [])).catch(fail),
  ])
}

/** 来源分段：全部 / 本地 / 技能市场（云端商城） */
const source = ref<'all' | 'local' | 'cloud'>('all')
const SOURCES = [
  { key: 'all', label: '全部' },
  { key: 'local', label: '本地' },
  { key: 'cloud', label: '技能市场' },
] as const

/** 正在安装到本地的技能市场技能 id */
const installingSkill = ref<number | null>(null)

/** 技能市场技能分类：从数据里聚合（全部 + 各分类） */
const skillCategories = computed(() => {
  const set = new Set<string>()
  for (const s of platformSkills.value) if (s.category) set.add(s.category)
  return ['全部', ...[...set]]
})
const activeCategory = ref('全部')

/** 正在安装到本地的云端 MCP id */
const installingMcp = ref<number | null>(null)

/**
 * 云端 MCP 安装到本地：注册为 streamable-http 连接器，请求带上用户令牌鉴权。
 * 安装后任务运行时，agent 的工具清单里就有它的全部工具。
 */
async function installHubMcp(m: PlatformMcp) {
  installingMcp.value = m.id
  try {
    const cur = (await listEngineMcp()) as { servers?: McpServer[] }
    const existing = (cur.servers || []).filter((s) => !String(s.name).startsWith('内部·'))
    let base = ''
    try {
      base = String((await getInfo()).platform || '')
    } catch {
      /* 拿不到就用默认 */
    }
    if (!base) base = ''
    const rec = m as unknown as Record<string, unknown>
    const endpoint =
      String(rec.endpoint || rec.url || '') ||
      `${base.replace(/\/$/, '')}/api/v1/integrations/mcp-servers/${m.id}/mcp`
    const entry = {
      name: `内部·${m.displayName || m.name}`,
      transport: 'streamable-http',
      url: endpoint,
      headers: platformToken.value ? { Authorization: `Bearer ${platformToken.value}` } : {},
    }
    await saveMcpList([...existing, entry] as never)
    toast.success(`「${m.displayName || m.name}」已安装到本地连接器`)
    mcp.value = (await listEngineMcp()) as { servers?: McpServer[]; total_tools?: number }
  } catch (e) {
    toast.error('安装失败：' + (e as Error).message)
  } finally {
    installingMcp.value = null
  }
}

/** 云端 MCP 是否已装到本地（按显示名匹配） */
function mcpInstalled(m: PlatformMcp): boolean {
  return mcpServers.value.some((s) => s.name === `内部·${m.displayName || m.name}` && s.connected)
}

/** 把技能市场技能正文下载下来存成本地技能，让引擎的 use_skill 真正能加载执行 */
async function installHubSkill(s: PlatformSkill) {
  installingSkill.value = s.id
  try {
    const detail = await getPlatformSkillContent(s.id)
    const content = String(
      detail.content || detail.markdown || detail.skillMd || detail.md || '',
    ).trim()
    const rawName = String(detail.name || s.name || s.displayName || '').trim()
    const name = rawName.toLowerCase().replace(/[^\w\u4e00-\u9fff.-]+/g, '-')
    if (!content || !name) {
      toast.error('技能内容为空，无法安装')
      return
    }
    await saveSkill({
      name,
      description: String(detail.summary || s.summary || s.displayName || ''),
      content,
    })
    toast.success(`「${s.displayName || s.name}」已装进本地技能`)
    try {
      skills.value = (await listEngineSkills()) as Skill[]
    } catch {
      /* 刷新失败下次进来自然拿到 */
    }
  } catch (e) {
    toast.error('安装失败：' + (e as Error).message)
  } finally {
    installingSkill.value = null
  }
}

onMounted(async () => {
  await load()
  loading.value = false
})

async function load() {
  try {
    experts.value = (await listEngineExperts()) as Expert[]
  } catch {
    experts.value = []
  }
  try {
    teams.value = (await listExpertTeams()) as Team[]
  } catch {
    teams.value = []
  }
  try {
    skills.value = (await listEngineSkills()) as Skill[]
  } catch {
    skills.value = []
  }
  try {
    mcp.value = (await listEngineMcp()) as { servers?: McpServer[]; total_tools?: number }
  } catch {
    mcp.value = {}
  }
  await loadPlatform()
}

watch(platformToken, loadPlatform)

// ---- 过滤：关键词 + 来源分段，专家/技能/连接器三份 ----
const localExperts = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return k
    ? experts.value.filter(
        (e) =>
          e.name.toLowerCase().includes(k) ||
          (e.description || '').toLowerCase().includes(k) ||
          (e.tags || []).some((t) => t.toLowerCase().includes(k)),
      )
    : experts.value
})
const cloudExperts = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return platformExperts.value.filter(
    (e) =>
      !k ||
      e.name.toLowerCase().includes(k) ||
      e.displayName.toLowerCase().includes(k) ||
      (e.summary || '').toLowerCase().includes(k) ||
      (e.tags || '').toLowerCase().includes(k),
  )
})
const expertList = computed(() => {
  if (source.value === 'local') return localExperts.value.map((e) => ({ kind: 'local' as const, e }))
  if (source.value === 'cloud') return cloudExperts.value.map((e) => ({ kind: 'cloud' as const, e }))
  return [
    ...localExperts.value.map((e) => ({ kind: 'local' as const, e })),
    ...cloudExperts.value.map((e) => ({ kind: 'cloud' as const, e })),
  ]
})

const localSkills = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return k
    ? skills.value.filter(
        (s) => s.name.toLowerCase().includes(k) || (s.description || '').toLowerCase().includes(k),
      )
    : skills.value
})
const cloudSkills = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  let list = platformSkills.value.filter(
    (s) =>
      !k ||
      s.name.toLowerCase().includes(k) ||
      s.displayName.toLowerCase().includes(k) ||
      (s.summary || '').toLowerCase().includes(k),
  )
  if (activeCategory.value !== '全部') list = list.filter((s) => s.category === activeCategory.value)
  return list
})
const skillList = computed(() => {
  if (source.value === 'local') return localSkills.value.map((s) => ({ kind: 'local' as const, s }))
  if (source.value === 'cloud') return cloudSkills.value.map((s) => ({ kind: 'cloud' as const, s }))
  return [
    ...localSkills.value.map((s) => ({ kind: 'local' as const, s })),
    ...cloudSkills.value.map((s) => ({ kind: 'cloud' as const, s })),
  ]
})

const mcpServers = computed(() => mcp.value.servers || [])
const localMcps = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return k ? mcpServers.value.filter((s) => s.name.toLowerCase().includes(k)) : mcpServers.value
})
const cloudMcps = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return platformMcps.value.filter(
    (m) => !k || m.name.toLowerCase().includes(k) || m.displayName.toLowerCase().includes(k) || (m.description || '').toLowerCase().includes(k),
  )
})
const mcpList = computed(() => {
  if (source.value === 'local') return localMcps.value.map((m) => ({ kind: 'local' as const, m }))
  if (source.value === 'cloud') return cloudMcps.value.map((m) => ({ kind: 'cloud' as const, m }))
  return [
    ...localMcps.value.map((m) => ({ kind: 'local' as const, m })),
    ...cloudMcps.value.map((m) => ({ kind: 'cloud' as const, m })),
  ]
})

/** 需要登录引导：选了「云端」（或全部里没有云端数据可看）且未登录 */
const needLogin = computed(() => source.value === 'cloud' && !loggedIn.value)

/** 来源分段上的计数：跟着当前 Tab 走（专家/技能/连接器各有各的数） */
const sourceCounts = computed<Record<string, number>>(() => {
  if (activeTab.value === 'skills') {
    return { all: localSkills.value.length + cloudSkills.value.length, local: localSkills.value.length, cloud: cloudSkills.value.length }
  }
  if (activeTab.value === 'connectors') {
    return { all: localMcps.value.length + cloudMcps.value.length, local: localMcps.value.length, cloud: cloudMcps.value.length }
  }
  return { all: localExperts.value.length + cloudExperts.value.length, local: localExperts.value.length, cloud: cloudExperts.value.length }
})

/** 当前 Tab 下筛选结果的条数：给来源分段后面收一句「共 N 项」 */
const shownCount = computed(() => {
  if (activeTab.value === 'skills') return skillList.value.length
  if (activeTab.value === 'connectors') return mcpList.value.length
  return expertList.value.length
})
</script>

<template>
  <div class="mx-auto w-full max-w-5xl space-y-6 p-6">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 class="text-xl font-semibold tracking-tight">专家·技能·连接器</h1>
      <p class="text-[12.5px] text-muted-foreground">
        本地开箱即用；登录后加载平台侧的技能商城、专家与 MCP，可一键安装启用。
      </p>
    </div>

    <div v-if="loading" class="flex justify-center py-16">
      <Spinner class="size-6 text-muted-foreground" />
    </div>

    <Tabs v-else :model-value="activeTab" @update:model-value="setTab(String($event))">
      <!-- 顶栏：段控切换 + 搜索/刷新。吸顶，长列表滚到底也能切 Tab -->
      <div class="sticky top-0 z-20 -mx-6 border-b border-border/70 bg-background/85 px-6 py-2.5 backdrop-blur">
        <div class="flex flex-wrap items-center gap-3">
          <TabsList class="h-9 gap-1 rounded-xl border border-border/70 bg-muted/50 p-1">
            <TabsTrigger value="experts" class="flex-none gap-1.5 rounded-lg px-3 text-[13px]">
              <Users class="size-3.5" /> 专家
            </TabsTrigger>
            <TabsTrigger value="skills" class="flex-none gap-1.5 rounded-lg px-3 text-[13px]">
              <Blocks class="size-3.5" /> 技能
            </TabsTrigger>
            <TabsTrigger value="connectors" class="flex-none gap-1.5 rounded-lg px-3 text-[13px]">
              <Plug class="size-3.5" /> 连接器
            </TabsTrigger>
          </TabsList>

          <div class="ml-auto flex items-center gap-2">
            <div class="relative">
              <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                v-model="keyword"
                placeholder="搜索专家、技能和连接器"
                class="h-9 w-56 rounded-lg border border-border bg-card pl-8 pr-3 text-[13px] outline-none transition-colors placeholder:text-muted-foreground focus:border-ring md:w-64"
              />
            </div>
            <Button variant="outline" size="sm" class="h-9 gap-1.5" @click="load" :disabled="loading">
              <RefreshCw class="size-3.5" /> 刷新
            </Button>
          </div>
        </div>

        <!-- 来源分段：专家/技能/连接器三个 Tab 共用一条，别再各画一份 -->
        <div class="mt-2.5 flex flex-wrap items-center gap-2">
          <div class="inline-flex items-center gap-0.5 rounded-full border border-border/70 bg-muted/40 p-0.5">
            <button
              v-for="s in SOURCES"
              :key="s.key"
              class="rounded-full px-3 py-1 text-[12px] leading-none transition-colors"
              :class="source === s.key ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
              @click="source = s.key"
            >
              {{ s.label }}
              <span class="ml-1 tabular-nums" :class="source === s.key ? 'text-muted-foreground' : 'opacity-70'">{{ sourceCounts[s.key] }}</span>
            </button>
          </div>
          <p class="ml-auto text-[11.5px] text-muted-foreground">共 {{ shownCount }} 项</p>
        </div>
      </div>

      <!-- ==================== 专家 ==================== -->
      <TabsContent value="experts" class="space-y-4 pt-4">
        <!-- 未登录引导 -->
        <div v-if="needLogin" class="rounded-xl border border-dashed border-border p-8 text-center">
          <LogIn class="mx-auto size-6 text-muted-foreground" />
          <p class="mt-2 text-sm font-medium">登录后查看云端专家</p>
          <p class="mt-1 text-xs text-muted-foreground">云端专家调平台模型与云端技能，由平台统一维护</p>
          <Button size="sm" class="mt-3 gap-1.5" @click="platformLogin">
            <LogIn class="size-3.5" /> 登录平台
          </Button>
        </div>

        <template v-else>
          <!-- 专家团（本地）：紧凑磁贴，横向铺开，别再一条一张卡占满整行 -->
          <section v-if="teams.length && source !== 'cloud'" class="space-y-2.5">
            <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h2 class="text-[13px] font-semibold">专家团</h2>
              <p class="text-[11.5px] text-muted-foreground">按名单顺序接力，一句话走完整条流水线</p>
            </div>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div v-for="t in teams" :key="t.name" class="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
                <p class="flex items-center gap-2 text-[13px] font-medium">
                  <ExpertAvatar icon="users" :size="24" />
                  <span class="truncate">{{ t.name }}</span>
                </p>
                <p v-if="t.description" class="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
                  {{ t.description }}
                </p>
                <div class="mt-2 flex flex-wrap gap-1">
                  <Badge v-for="m in (t.members || []).slice(0, 4)" :key="m" variant="secondary" class="text-[10px]">{{ m }}</Badge>
                  <Badge v-if="(t.members || []).length > 4" variant="outline" class="text-[10px]">
                    +{{ t.members!.length - 4 }}
                  </Badge>
                </div>
              </div>
            </div>
          </section>

          <div class="flex flex-wrap items-baseline gap-x-2">
            <h2 class="text-[13px] font-semibold">{{ source === 'cloud' ? '云端专家' : source === 'local' ? '本地专家' : '专家' }}</h2>
            <p class="text-[11.5px] text-muted-foreground">点「召唤到对话」按它的角色设定直接开工</p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <Card v-for="item in expertList" :key="item.kind + (item.kind === 'local' ? item.e.name : item.e.id)">
              <CardHeader class="pb-1">
                <div class="flex items-start gap-3">
                  <ExpertAvatar
                    :icon="item.kind === 'cloud' ? '' : item.e.avatar"
                    :category="item.kind === 'cloud' ? '' : item.e.category"
                    :size="40"
                  />
                  <div class="min-w-0 flex-1">
                    <CardTitle class="flex flex-wrap items-center gap-1.5 text-[14px]">
                      <span class="truncate">{{ item.kind === 'local' ? item.e.name : item.e.displayName || item.e.name }}</span>
                      <Badge v-if="item.kind === 'local'" variant="secondary" class="shrink-0 text-[10px]">
                        <HardDrive class="mr-0.5 size-2.5" /> 本地
                      </Badge>
                      <Badge v-else class="shrink-0 text-[10px]">
                        <Cloud class="mr-0.5 size-2.5" /> 云端
                      </Badge>
                    </CardTitle>
                    <CardDescription class="mt-0.5 line-clamp-2 text-[12px] leading-relaxed">
                      {{ item.kind === 'local' ? item.e.description : item.e.summary || item.e.description }}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent class="flex flex-1 flex-col gap-2">
                <div v-if="item.kind === 'local' && item.e.tags?.length" class="flex flex-wrap gap-1">
                  <Badge v-for="t in item.e.tags" :key="t" variant="secondary" class="text-[10px]">{{ t }}</Badge>
                </div>
                <div v-else-if="item.kind === 'cloud'" class="flex flex-wrap gap-1">
                  <Badge
                    v-for="t in String(item.e.tags || '').split(/[,，、|]/).filter(Boolean).slice(0, 4)"
                    :key="t"
                    variant="secondary"
                    class="text-[10px]"
                  >
                    {{ t }}
                  </Badge>
                  <Badge variant="outline" class="text-[10px]">{{ item.e.skillCount }} 个技能</Badge>
                </div>
                <div v-if="item.kind === 'local' && item.e.skills?.length" class="text-xs text-muted-foreground">
                  擅长：{{ item.e.skills.join('、') }}
                </div>
                <div v-if="item.kind === 'cloud' && item.e.scene" class="text-xs text-muted-foreground">
                  场景：{{ item.e.scene }} · 维护人：{{ item.e.ownerName || '公司' }}
                </div>
                <div v-if="item.kind === 'local'" class="mt-auto flex justify-end border-t border-border/60 pt-2">
                  <Button size="sm" variant="outline" class="gap-1.5 text-xs" title="跳到对话页，按该专家的角色发起任务" @click="summon(item.e.name)">
                    <MessageSquarePlus class="size-3.5" /> 召唤到对话
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <div v-if="!expertList.length" class="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
            {{ keyword ? '没有匹配的专家' : source === 'cloud' ? '云端专家为空' : '还没有本地专家' }}
          </div>
        </template>
      </TabsContent>

      <!-- ==================== 技能（技能市场） ==================== -->
      <TabsContent value="skills" class="space-y-4 pt-4">
        <!-- 技能市场状态横幅：未登录给接入入口，已登录给商城概览 -->
        <div
          v-if="!loggedIn"
          class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-[#fafafa] px-4 py-3 dark:border-border dark:bg-card/40"
        >
          <div>
            <p class="text-[13px] font-medium">技能市场</p>
            <p class="text-xs text-muted-foreground">登录后浏览平台侧的全部技能，一键安装到本地使用</p>
          </div>
          <Button size="sm" class="gap-1.5" @click="platformLogin">
            <LogIn class="size-3.5" /> 登录接入技能市场
          </Button>
        </div>
        <div
          v-else
          class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-[#fafafa] px-4 py-3 dark:border-border dark:bg-card/40"
        >
          <p class="text-[13px]">
            <span class="font-medium">技能市场已连接</span>
            <span class="text-muted-foreground"> · {{ platformSkills.length }} 个技能可浏览安装</span>
            <span v-if="platformError" class="text-destructive"> · {{ platformError }}</span>
          </p>
          <Button variant="outline" size="sm" class="h-7 gap-1.5 text-xs" @click="loadPlatform">
            <RefreshCw class="size-3" /> 刷新商城
          </Button>
        </div>

        <div v-if="needLogin" class="rounded-xl border border-dashed border-border p-8 text-center">
          <LogIn class="mx-auto size-6 text-muted-foreground" />
          <p class="mt-2 text-sm font-medium">登录后浏览技能市场</p>
          <p class="mt-1 text-xs text-muted-foreground">平台侧的技能，可一键安装到本地执行</p>
          <Button size="sm" class="mt-3 gap-1.5" @click="platformLogin">
            <LogIn class="size-3.5" /> 登录平台
          </Button>
        </div>

        <template v-else>
          <div class="flex flex-wrap items-baseline gap-x-2">
            <h2 class="text-[13px] font-semibold">{{ source === 'cloud' ? '技能市场' : source === 'local' ? '本地技能' : '技能' }}</h2>
            <p class="text-[11.5px] text-muted-foreground">引擎按技能名按需加载，装到本地就能被任务调用</p>
          </div>

          <!-- 云端分类横向滚动（技能市场顶栏） -->
          <div v-if="source !== 'local' && skillCategories.length > 1" class="-mt-2 flex items-center gap-1.5 overflow-x-auto pb-1">
            <button
              v-for="c in skillCategories"
              :key="c"
              class="shrink-0 rounded-full border px-3 py-1 text-[12px] leading-none transition-colors"
              :class="activeCategory === c
                ? 'border-primary/30 bg-primary/10 font-medium text-primary'
                : 'border-border text-muted-foreground hover:text-foreground'"
              @click="activeCategory = c"
            >
              {{ c }}
            </button>
          </div>

          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Card v-for="item in skillList" :key="item.kind + (item.kind === 'local' ? item.s.name : item.s.id)" class="flex flex-col">
              <CardHeader class="pb-1">
                <CardTitle class="flex items-start gap-2 text-[13.5px]">
                  <Blocks class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 flex-1 break-all leading-snug">
                    {{ item.kind === 'local' ? item.s.name : item.s.displayName || item.s.name }}
                  </span>
                </CardTitle>
                <CardDescription class="mt-1 flex items-center gap-1.5 text-[11px]">
                  <Badge v-if="item.kind === 'local'" variant="secondary" class="text-[10px]">
                    <HardDrive class="mr-0.5 size-2.5" /> 本地
                  </Badge>
                  <template v-else>
                    <Badge class="text-[10px]"><Cloud class="mr-0.5 size-2.5" /> 云端</Badge>
                    <span>v{{ item.s.latestVersion || '0.0.1' }}</span>
                  </template>
                </CardDescription>
              </CardHeader>
              <CardContent class="flex flex-1 flex-col gap-2">
                <p class="line-clamp-3 text-[12px] leading-relaxed text-muted-foreground">
                  {{ item.kind === 'local' ? item.s.description || '（无说明）' : item.s.summary || '（无说明）' }}
                </p>
                <div v-if="item.kind === 'cloud'" class="mt-auto flex items-center justify-between">
                  <Badge variant="outline" class="text-[10px]">允许安装</Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    class="h-7 gap-1 text-xs"
                    :disabled="installingSkill === item.s.id"
                    @click="installHubSkill(item.s)"
                  >
                    <Spinner v-if="installingSkill === item.s.id" class="size-3" />
                    <Download v-else class="size-3" />
                    {{ installingSkill === item.s.id ? '安装中' : '安装' }}
                  </Button>
                </div>
                <div v-else-if="item.s.plugin" class="mt-auto flex items-center gap-1">
                  <Badge variant="outline" class="text-[10px]">{{ item.s.plugin }}</Badge>
                </div>
              </CardContent>
            </Card>
          </div>

          <div v-if="!skillList.length" class="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
            {{ keyword ? '没有匹配的技能' : source === 'cloud' ? (activeCategory === '全部' ? '云端技能市场为空' : '该分类下暂无技能') : '本机还没有技能' }}
          </div>
        </template>
      </TabsContent>

      <!-- ==================== 连接器 ==================== -->
      <TabsContent value="connectors" class="space-y-4 pt-4">
        <div v-if="needLogin" class="rounded-xl border border-dashed border-border p-8 text-center">
          <LogIn class="mx-auto size-6 text-muted-foreground" />
          <p class="mt-2 text-sm font-medium">登录后查看云端 MCP</p>
          <p class="mt-1 text-xs text-muted-foreground">平台统一维护的 MCP Server，启用后任务可直接调用其工具</p>
          <Button size="sm" class="mt-3 gap-1.5" @click="platformLogin">
            <LogIn class="size-3.5" /> 登录平台
          </Button>
        </div>

        <template v-else>
          <div class="flex flex-wrap items-baseline gap-x-2">
            <h2 class="text-[13px] font-semibold">{{ source === 'cloud' ? '云端 MCP' : source === 'local' ? '本地连接器' : '连接器' }}</h2>
            <p class="text-[11.5px] text-muted-foreground">启用后任务可直接调用其中的工具</p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <Card v-for="item in mcpList" :key="item.kind + (item.kind === 'local' ? item.m.name : item.m.id)">
              <CardHeader class="pb-1">
                <CardTitle class="flex flex-wrap items-center gap-1.5 text-[13.5px]">
                  <Plug class="size-4 shrink-0 text-muted-foreground" />
                  <span class="truncate">{{ item.kind === 'local' ? item.m.name : item.m.displayName || item.m.name }}</span>
                  <Badge v-if="item.kind === 'local'" variant="secondary" class="ml-auto shrink-0 text-[10px]">
                    <HardDrive class="mr-0.5 size-2.5" /> 本地
                  </Badge>
                  <Badge v-else class="ml-auto shrink-0 text-[10px]"><Cloud class="mr-0.5 size-2.5" /> 云端</Badge>
                </CardTitle>
                <CardDescription class="mt-1 truncate font-mono text-[11px]">
                  {{ item.kind === 'local' ? item.m.transport || 'stdio' : item.m.protocol || 'streamable http' }}
                </CardDescription>
              </CardHeader>
              <CardContent class="flex flex-1 flex-col gap-2">
                <p v-if="item.kind === 'cloud'" class="line-clamp-2 text-[12px] text-muted-foreground">
                  {{ item.m.description || '（无说明）' }}
                </p>
                <!-- 状态：本地看连接、云端看服务状态 -->
                <div class="flex items-center gap-1.5">
                  <span
                    v-if="item.kind === 'local'"
                    class="size-1.5 rounded-full"
                    :class="item.m.connected ? 'bg-emerald-500' : 'bg-amber-500'"
                  />
                  <span class="text-[11px]" :class="item.kind === 'local' && !item.m.connected ? 'text-amber-600' : 'text-muted-foreground'">
                    {{
                      item.kind === 'local'
                        ? item.m.connected
                          ? `已启用 · ${item.m.tools?.length || 0} 个工具`
                          : item.m.error || '未连接'
                        : item.m.status === 'enabled' || item.m.status === '1'
                          ? '已启用'
                          : item.m.status || '已启用'
                    }}
                  </span>
                  <Badge v-if="item.kind === 'cloud'" variant="outline" class="ml-auto text-[10px]">
                    {{ item.m.toolCount }} 个工具
                  </Badge>
                </div>
                <!-- 工具标签 -->
                <div v-if="item.kind === 'local' && item.m.tools?.length" class="flex flex-wrap gap-1">
                  <Badge v-for="t in item.m.tools.slice(0, 4)" :key="t.name" variant="secondary" class="text-[10px]">
                    {{ t.name }}
                  </Badge>
                  <Badge v-if="item.m.tools.length > 4" variant="outline" class="text-[10px]">
                    +{{ item.m.tools.length - 4 }}
                  </Badge>
                </div>
                <div v-else-if="item.kind === 'cloud' && item.m.tools?.length" class="flex flex-wrap gap-1">
                  <Badge v-for="t in item.m.tools.slice(0, 4)" :key="t.toolName" variant="secondary" class="text-[10px]">
                    {{ t.toolName }}
                  </Badge>
                  <Badge v-if="item.m.tools.length > 4" variant="outline" class="text-[10px]">
                    +{{ item.m.tools.length - 4 }}
                  </Badge>
                </div>
                <div v-if="item.kind === 'local' && item.m.plugin" class="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Wrench class="size-3" /> 来自插件 {{ item.m.plugin }}
                </div>
                <!-- 云端 MCP：安装到本地（注册为 streamable-http 连接器，带用户令牌鉴权） -->
                <div v-if="item.kind === 'cloud'" class="mt-auto flex items-center justify-between pt-1">
                  <Badge v-if="mcpInstalled(item.m)" variant="secondary" class="text-[10px]">✓ 已安装</Badge>
                  <template v-else>
                    <Badge variant="outline" class="text-[10px]">允许安装</Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      class="h-7 gap-1 text-xs"
                      :disabled="installingMcp === item.m.id"
                      @click="installHubMcp(item.m)"
                    >
                      <Loader2 v-if="installingMcp === item.m.id" class="size-3 animate-spin" />
                      <Download v-else class="size-3" />
                      {{ installingMcp === item.m.id ? '安装中' : '安装到本地' }}
                    </Button>
                  </template>
                </div>
              </CardContent>
            </Card>
          </div>

          <div v-if="!mcpList.length" class="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
            {{ keyword ? '没有匹配的连接器' : source === 'cloud' ? '云端 MCP 为空' : '本机还没有 MCP 连接器，可在 设置 → 连接器 添加' }}
          </div>

          <div v-if="source !== 'cloud'" class="text-center">
            <Button variant="outline" size="sm" class="gap-1.5" @click="$router.push('/client-settings/mcp')">
              管理本地连接器…
            </Button>
          </div>
        </template>
      </TabsContent>
    </Tabs>

    <p v-if="platformError && loggedIn" class="text-center text-[11px] text-muted-foreground">
      云端数据加载失败：{{ platformError }}（稍后点「刷新」重试）
    </p>
  </div>
</template>
