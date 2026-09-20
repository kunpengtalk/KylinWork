<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Download, Puzzle, RefreshCw, Trash2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'vue-sonner'
import { installPlugin, listPlugins, removePlugin, updatePlugin, type PluginInfo } from '@/api/client'

/**
 * 插件（Agent Plugins 1.0.0 开放标准）：
 * 一个包同时带技能和 MCP 连接器，粘个 GitHub 地址就装，装的立刻生效。
 *
 * 后端 GET /plugins 返回的是 { spec, plugins: [...] }——以前前端当成数组用，
 * 页面永远显示「还没有安装插件」。这里按真实结构解包，并把技能/连接器/作者/体积都摊开。
 */
const items = ref<PluginInfo[]>([])
const spec = ref('')
const loading = ref(true)
const repoUrl = ref('')
const installing = ref(false)
const updating = ref('')

onMounted(async () => {
  await load()
  loading.value = false
})

async function load() {
  try {
    const r = await listPlugins()
    items.value = r?.plugins || []
    spec.value = String(r?.spec || '')
  } catch (e) {
    toast.error('读取插件失败：' + (e as Error).message)
  }
}

async function install() {
  const url = repoUrl.value.trim()
  if (!url) return
  installing.value = true
  try {
    await installPlugin(url)
    toast.success('插件已安装，技能与连接器已生效')
    repoUrl.value = ''
    await load()
  } catch (e) {
    toast.error('安装失败：' + (e as Error).message)
  } finally {
    installing.value = false
  }
}

async function update(name: string | undefined) {
  if (!name) return
  updating.value = name
  try {
    await updatePlugin(name)
    toast.success('已更新到最新版')
    await load()
  } catch (e) {
    toast.error('更新失败：' + (e as Error).message)
  } finally {
    updating.value = ''
  }
}

async function remove(name: string) {
  if (!window.confirm(`卸载插件「${name}」？它带来的技能与连接器会一并移除。`)) return
  try {
    await removePlugin(name)
    toast.success('已卸载')
    await load()
  } catch (e) {
    toast.error('卸载失败：' + (e as Error).message)
  }
}

function fmtSize(n?: number): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="settings-pane mx-auto w-full max-w-3xl space-y-6 px-10 py-8">
      <Card>
        <CardHeader>
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle class="flex items-center gap-2">
                <Puzzle class="size-5" /> 插件
                <Badge v-if="spec" variant="outline" class="text-[12px]">规范 {{ spec }}</Badge>
              </CardTitle>
              <CardDescription class="mt-1">
                Agent Plugins 开放标准：一个包同时带技能和 MCP 连接器，装完立刻生效。
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" class="gap-1.5" :disabled="loading" @click="load">
              <RefreshCw class="size-3.5" /> 刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="flex gap-2">
            <Input
              v-model="repoUrl"
              class="h-9"
              placeholder="粘贴 GitHub 地址，例如 owner/agent-plugins-demo"
              @keyup.enter="install"
            />
            <Button size="sm" class="h-9 shrink-0 gap-1.5" :disabled="installing" @click="install">
              <Spinner v-if="installing" class="size-3.5" />
              <Download v-else class="size-3.5" /> 安装
            </Button>
          </div>

          <div v-if="loading" class="flex justify-center py-10">
            <Spinner class="size-6 text-muted-foreground" />
          </div>

          <div v-else-if="!items.length" class="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            还没有安装插件。粘一个 Agent Plugins 包的 GitHub 地址试试。
          </div>

          <ul v-else class="space-y-3">
            <li v-for="p in items" :key="p.name" class="rounded-lg border border-border px-4 py-3">
              <div class="flex items-start gap-3">
                <div class="min-w-0 flex-1">
                  <p class="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {{ p.name }}
                    <Badge v-if="p.ok === false" variant="destructive" class="text-[12px]">加载失败</Badge>
                    <Badge v-else variant="default" class="text-[12px]">已启用</Badge>
                    <Badge v-if="p.version" variant="outline" class="text-[12px]">v{{ p.version }}</Badge>
                    <Badge v-if="p.license" variant="outline" class="text-[12px]">{{ p.license }}</Badge>
                  </p>
                  <p v-if="p.description" class="mt-0.5 text-[13px] text-muted-foreground">{{ p.description }}</p>
                  <p class="mt-1 flex flex-wrap gap-x-3 text-[13px] text-muted-foreground/80">
                    <span v-if="p.author">作者 {{ p.author }}</span>
                    <span v-if="p.skills?.length">{{ p.skills.length }} 个技能</span>
                    <span v-if="p.mcp_servers?.length">{{ p.mcp_servers.length }} 个连接器</span>
                    <span v-if="p.bytes">占用 {{ fmtSize(p.bytes) }}</span>
                  </p>
                  <p v-if="p.error" class="mt-1 rounded bg-destructive/10 px-2 py-1 text-[13px] text-destructive">{{ p.error }}</p>
                  <ul v-if="p.warnings?.length" class="mt-1 space-y-0.5">
                    <li v-for="(w, i) in p.warnings" :key="i" class="text-[13px] text-amber-600">⚠ {{ w }}</li>
                  </ul>
                  <details v-if="p.skills?.length || p.mcp_servers?.length" class="mt-1.5">
                    <summary class="cursor-pointer text-[13px] text-muted-foreground select-none">带了什么</summary>
                    <ul class="mt-1 space-y-0.5">
                      <li v-for="s in p.skills || []" :key="'s' + s.name" class="text-[13px] text-muted-foreground">
                        <code class="rounded bg-muted px-1">{{ s.name }}</code> {{ s.description }}
                      </li>
                      <li v-for="m in p.mcp_servers || []" :key="'m' + m.name" class="text-[13px] text-muted-foreground">
                        <code class="rounded bg-muted px-1">{{ m.name }}</code> 连接器 · {{ m.transport }}
                      </li>
                    </ul>
                  </details>
                </div>
                <div class="flex shrink-0 flex-col items-end gap-1">
                  <Button
                    v-if="p.source"
                    variant="ghost"
                    size="sm"
                    class="gap-1"
                    :disabled="updating === p.name"
                    @click="update(p.name)"
                  >
                    <RefreshCw class="size-3.5" :class="updating === p.name ? 'animate-spin' : ''" />
                    更新
                  </Button>
                  <span v-else class="text-[12px] text-muted-foreground/70">本地安装 · 无来源</span>
                  <Button variant="ghost" size="icon" title="卸载" @click="remove(p.name)">
                    <Trash2 class="size-4" />
                  </Button>
                </div>
              </div>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
