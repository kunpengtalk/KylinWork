<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Check, Pencil, Plus, Trash2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'vue-sonner'
import { listEngineMcp, saveMcpList, type McpInput } from '@/api/engine'

/**
 * MCP 连接器。
 * <p>
 * 连接器给引擎额外注入工具。存本机 config.json，不登录也能配。
 * 注意两点（以前这里都是错的）：
 * 1. 后端是「整份 servers 保存」——插件带来的连接器只读，绝不能再存回 config，
 *    否则它们会被当成用户自己的条目写进配置文件（GET 里是把两者混在一起返回的）。
 * 2. stdio 是 spawn(command, args)：命令必须是可执行文件本身，参数要分开填；
 *    把 `npx -y @xxx/mcp` 整串塞进 command 是起不来的。
 */
interface ServerRow extends McpInput {
  connected?: boolean
  error?: string
  plugin?: string
  header_keys?: string[]
  tools?: { name: string; description?: string }[]
}

/** 编辑表单：args / headers 在界面上是文本，提交前再转成结构化字段 */
interface McpForm {
  name: string
  transport: 'stdio' | 'streamable-http'
  command: string
  argsText: string
  url: string
  headersText: string
}

const servers = ref<ServerRow[]>([])
const loading = ref(true)
const saving = ref(false)
const editing = ref<McpForm | null>(null)
const isNew = ref(false)
/** 编辑中的渠道原本的请求头键（值不回显，只用来说明「留空会沿用哪些」） */
const editingHeaderKeys = ref<string[]>([])

/** 用户自己配的（可改可删）；插件带来的只读 */
const localServers = computed(() => servers.value.filter((s) => !s.plugin))
const pluginServers = computed(() => servers.value.filter((s) => s.plugin))

onMounted(async () => {
  await load()
  loading.value = false
})

async function load() {
  try {
    const r = (await listEngineMcp()) as { servers?: ServerRow[] }
    servers.value = r.servers || []
  } catch (e) {
    toast.error('读取连接器失败：' + (e as Error).message)
  }
}

function startNew() {
  isNew.value = true
  editingHeaderKeys.value = []
  editing.value = { name: '', transport: 'stdio', command: '', argsText: '', url: '', headersText: '' }
}

function startEdit(s: ServerRow) {
  isNew.value = false
  editingHeaderKeys.value = s.header_keys || Object.keys(s.headers || {})
  editing.value = {
    name: s.name,
    transport: (s.transport as McpForm['transport']) || (s.command ? 'stdio' : 'streamable-http'),
    command: s.command || '',
    argsText: (s.args || []).join(' '),
    url: s.url || '',
    headersText: '',
  }
}

/** 表单 → 后端认的输入（stdio 走 command/args，http 走 url/headers） */
function toInput(f: McpForm): McpInput {
  if (f.transport === 'stdio') {
    return {
      name: f.name.trim(),
      transport: 'stdio',
      command: f.command.trim(),
      args: f.argsText.split(/\s+/).map((x) => x.trim()).filter(Boolean),
    }
  }
  const headers = parseHeaders(f.headersText)
  const out: McpInput = { name: f.name.trim(), transport: 'streamable-http', url: f.url.trim() }
  // 没填就整个不带：后端会用上一份请求头（GET 不回显值，带了空对象反而把令牌洗掉）
  if (headers) out.headers = headers
  return out
}

/** "Key: Value" 多行 → 对象；全空返回 null（表示「保持原样」） */
function parseHeaders(text: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const i = t.indexOf(':')
    if (i <= 0) continue
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return Object.keys(out).length ? out : null
}

async function save() {
  const f = editing.value
  if (!f) return
  if (!f.name.trim()) {
    toast.error('名称不能为空')
    return
  }
  if (f.transport === 'stdio' ? !f.command.trim() : !f.url.trim()) {
    toast.error(f.transport === 'stdio' ? '请填启动命令（可执行文件本身，参数填到「参数」里）' : '请填服务地址')
    return
  }
  const input = toInput(f)
  // stdio 的 env 界面上不编辑：编辑既有条目时原样带上，别把它清空
  if (input.transport === 'stdio' && !isNew.value) {
    const prev = localServers.value.find((s) => s.name === f.name)
    if (prev?.env && Object.keys(prev.env).length) input.env = prev.env
  }
  saving.value = true
  try {
    // 后端收整份列表：只提交用户自己的条目，插件的原样不动（它们不在 config 里）
    const list: McpInput[] = isNew.value
      ? [...localServers.value, input]
      : localServers.value.map((s) => (s.name === f.name ? input : stripView(s)))
    await saveMcpList(list)
    toast.success('已保存，连接器正在重启')
    editing.value = null
    await load()
  } catch (err) {
    toast.error('保存失败：' + (err as Error).message)
  } finally {
    saving.value = false
  }
}

/** 把只读的视图字段摘掉，避免把 connected/error/tools 这些回存进 config */
function stripView(s: ServerRow): McpInput {
  return {
    name: s.name,
    transport: s.transport,
    command: s.command,
    args: s.args,
    env: s.env,
    url: s.url,
    ...(s.headers ? { headers: s.headers } : {}),
  }
}

async function remove(s: ServerRow) {
  if (!window.confirm(`删除连接器「${s.name}」？`)) return
  saving.value = true
  try {
    await saveMcpList(localServers.value.filter((x) => x.name !== s.name).map(stripView))
    toast.success('已删除')
    await load()
  } catch (e) {
    toast.error('删除失败：' + (e as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-base font-medium">MCP 连接器</h3>
        <p class="mt-0.5 text-[13px] text-muted-foreground">
          给引擎注入额外工具。存本机配置，不登录也能配。改动会重启所有连接器。
        </p>
      </div>
      <Button size="sm" class="gap-1.5" @click="startNew">
        <Plus class="size-3.5" /> 新增
      </Button>
    </div>

    <div v-if="loading" class="flex justify-center py-10">
      <Spinner class="size-6 text-muted-foreground" />
    </div>

    <!-- 编辑 -->
    <div v-if="editing" class="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-1.5">
          <Label>名称</Label>
          <Input v-model="editing.name" class="h-9" :disabled="!isNew" placeholder="my-mcp" />
          <p class="text-[13px] text-muted-foreground">只能字母、数字、- 和 _（工具名按 mcp__服务器__工具 拼）</p>
        </div>
        <div class="space-y-1.5">
          <Label>传输方式</Label>
          <select v-model="editing.transport" class="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none">
            <option value="stdio">stdio（本地命令）</option>
            <option value="streamable-http">HTTP（远程地址）</option>
          </select>
        </div>
      </div>

      <template v-if="editing.transport === 'stdio'">
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label>命令</Label>
            <Input v-model="editing.command" class="h-9" placeholder="npx" />
          </div>
          <div class="space-y-1.5">
            <Label>参数</Label>
            <Input v-model="editing.argsText" class="h-9" placeholder="-y @modelcontextprotocol/server-filesystem /path" />
          </div>
        </div>
        <p class="text-[13px] text-muted-foreground">命令是可执行文件本身（npx / uvx / node），其余按空格拆成参数。</p>
      </template>

      <template v-else>
        <div class="space-y-1.5">
          <Label>服务地址</Label>
          <Input v-model="editing.url" class="h-9" placeholder="https://mcp.example.com/mcp" />
        </div>
        <div class="space-y-1.5">
          <Label>请求头（可选）</Label>
          <Textarea v-model="editing.headersText" :rows="3" class="font-mono text-[13px]" placeholder="Authorization: Bearer xxx" />
          <p class="text-[13px] text-muted-foreground">
            <template v-if="isNew">每行一条 <code>Key: Value</code>（远程服务多半需要 Authorization）。</template>
            <template v-else-if="editingHeaderKeys.length">
              留空 = 保持原有的 {{ editingHeaderKeys.join('、') }} 不变（值出于安全不回显）。
            </template>
            <template v-else>每行一条 <code>Key: Value</code>。</template>
          </p>
        </div>
      </template>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="editing = null">取消</Button>
        <Button size="sm" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</Button>
      </div>
    </div>

    <!-- 用户自己的连接器 -->
    <ul v-if="localServers.length" class="divide-y divide-border rounded-lg border border-border">
      <li v-for="s in localServers" :key="s.name" class="px-4 py-3">
        <div class="flex items-center gap-3">
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-2 text-sm font-medium">
              {{ s.name }}
              <Badge :variant="s.connected ? 'default' : 'secondary'" class="shrink-0 text-[12px]">
                {{ s.connected ? '已连接' : '未连接' }}
              </Badge>
              <Badge variant="outline" class="shrink-0 text-[12px]">{{ s.transport }}</Badge>
            </p>
            <p class="mt-0.5 truncate font-mono text-[13px] text-muted-foreground">
              {{ s.command ? [s.command, ...(s.args || [])].join(' ') : s.url }}
            </p>
          </div>
          <span v-if="s.tools?.length" class="shrink-0 text-[13px] text-muted-foreground">
            {{ s.tools.length }} 个工具
          </span>
          <Button variant="ghost" size="icon" title="编辑" @click="startEdit(s)">
            <Pencil class="size-4" />
          </Button>
          <Button variant="ghost" size="icon" title="删除" @click="remove(s)">
            <Trash2 class="size-4" />
          </Button>
        </div>
        <p v-if="s.error" class="mt-1 text-[13px] text-destructive">{{ s.error }}</p>
      </li>
    </ul>

    <!-- 插件带来的：只读，删改都走插件那套 -->
    <ul v-if="pluginServers.length" class="divide-y divide-border rounded-lg border border-dashed border-border">
      <li v-for="s in pluginServers" :key="s.name" class="flex items-center gap-3 px-4 py-3">
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-2 text-sm font-medium">
            {{ s.name }}
            <Badge :variant="s.connected ? 'default' : 'secondary'" class="shrink-0 text-[12px]">
              {{ s.connected ? '已连接' : '未连接' }}
            </Badge>
            <Badge variant="outline" class="shrink-0 text-[12px]">插件 · {{ s.plugin }}</Badge>
          </p>
          <p class="mt-0.5 truncate font-mono text-[13px] text-muted-foreground">
            {{ s.command ? [s.command, ...(s.args || [])].join(' ') : s.url }}
          </p>
        </div>
        <span class="shrink-0 text-[13px] text-muted-foreground">随插件的 mcp.json 走 · 只读</span>
      </li>
    </ul>

    <div
      v-if="!loading && !editing && !servers.length"
      class="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground"
    >
      还没有配置连接器
    </div>

    <p class="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <Check class="size-3" />
      改动会重启全部连接器，正在跑的任务不受影响
    </p>
  </div>
</template>
