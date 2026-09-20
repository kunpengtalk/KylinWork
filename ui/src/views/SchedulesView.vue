<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { CalendarClock, Pencil, Play, Plus, RefreshCw, Trash2, X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'vue-sonner'
import { listProjects, type Project } from '@/api/engine'
import {
  createSchedule,
  deleteSchedule,
  listScheduleRuns,
  listSchedules,
  runSchedule,
  setScheduleCatchUp,
  toggleSchedule,
  updateSchedule,
  type Schedule,
  type ScheduleRepeat,
  type ScheduleRun,
} from '@/api/client'

/**
 * 定时任务（自动化）。
 * <p>
 * 目标就一个：不用写 cron 也能建任务。时间从下拉里选——每几分钟 / 每几小时 / 每天几点 /
 * 每周几几点 / 每月几号几点 / 只跑一次；每个任务还能选在哪个工作空间里跑（不选就跟随当前）。
 * 想直接写 cron 的人，重复方式里选「自定义 Cron」。
 * AI 也能通过 create_schedule 工具建同样的任务（它也在工作空间里跑）。
 */

type RepeatType = ScheduleRepeat['type'] | 'cron'

const items = ref<Schedule[]>([])
const runs = ref<ScheduleRun[]>([])
const projects = ref<Project[]>([])
const loading = ref(true)
const saving = ref(false)
const showForm = ref(false)

const form = reactive({
  id: '' as string,
  name: '',
  task: '',
  workspace: '', // 工作空间名字；空 = 跟随当前
  catchUp: true,
  type: 'daily' as RepeatType,
  every: 15,
  time: '09:00',
  days: [1] as number[],
  day: 1,
  onceAt: '',
  cron: '',
})

const WEEK = [
  { v: 1, label: '一' },
  { v: 2, label: '二' },
  { v: 3, label: '三' },
  { v: 4, label: '四' },
  { v: 5, label: '五' },
  { v: 6, label: '六' },
  { v: 0, label: '日' },
]

onMounted(async () => {
  await Promise.all([load(), loadRuns(), loadProjects()])
  loading.value = false
})

async function load() {
  try { items.value = await listSchedules() } catch (e) { toast.error('读取定时任务失败：' + (e as Error).message) }
}
async function loadRuns() {
  try { runs.value = await listScheduleRuns() } catch { /* 运行记录读不到不影响主列表 */ }
}
async function loadProjects() {
  try { projects.value = await listProjects() } catch { projects.value = [] }
}

function resetForm() {
  Object.assign(form, {
    id: '', name: '', task: '', workspace: '', catchUp: true,
    type: 'daily', every: 15, time: '09:00', days: [1], day: 1, onceAt: '', cron: '',
  })
}

function openCreate() {
  resetForm()
  showForm.value = true
}

function openEdit(s: Schedule) {
  resetForm()
  form.id = s.id
  form.name = s.name
  form.task = s.task
  form.catchUp = s.catch_up !== false
  // 工作空间：存的是绝对路径，能对上某个工作空间就回填它的名字，否则原样填路径
  const dir = String(s.workspace_dir || '')
  form.workspace = dir ? (projects.value.find((p) => p.dir === dir)?.name || dir) : ''
  const r = s.repeat
  if (r) {
    form.type = r.type
    if (r.every != null) form.every = r.every
    if (r.hour != null || r.minute != null) form.time = hm(r.hour ?? 0, r.minute ?? 0)
    if (r.day != null) form.day = r.day
    if (Array.isArray(r.days) && r.days.length) form.days = [...r.days]
    if (r.type === 'once' && r.at) {
      const d = new Date(r.at)
      form.onceAt = localInput(d)
    }
  } else {
    form.type = 'cron'
    form.cron = s.cron || ''
  }
  showForm.value = true
}

function hm(h: number, m: number) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
/** Date → datetime-local 需要的本地字符串（不能用 toISOString，那是 UTC） */
function localInput(d: Date) {
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 表单 → 后端要的 repeat / cron。做本地校验，能当场提示的就别等后端报错 */
function buildRule(): { repeat?: ScheduleRepeat; cron?: string } {
  if (form.type === 'cron') {
    if (!form.cron.trim()) throw new Error('请填写 cron 表达式，例如 0 9 * * 1')
    return { cron: form.cron.trim() }
  }
  const [h, m] = form.time.split(':').map((x) => parseInt(x, 10))
  if (form.type === 'minutes') return { repeat: { type: 'minutes', every: clamp(form.every, 1, 59) } }
  if (form.type === 'hours') return { repeat: { type: 'hours', every: clamp(form.every, 1, 24), minute: m || 0 } }
  if (form.type === 'daily') return { repeat: { type: 'daily', hour: h || 0, minute: m || 0 } }
  if (form.type === 'weekly') {
    if (!form.days.length) throw new Error('每周至少选一天')
    return { repeat: { type: 'weekly', days: [...form.days], hour: h || 0, minute: m || 0 } }
  }
  if (form.type === 'monthly') return { repeat: { type: 'monthly', day: clamp(form.day, 1, 31), hour: h || 0, minute: m || 0 } }
  // once
  if (!form.onceAt) throw new Error('请选择要执行的具体时间')
  const at = new Date(form.onceAt)
  if (Number.isNaN(at.getTime())) throw new Error('执行时间无法识别')
  if (at.getTime() <= Date.now()) throw new Error('执行时间要晚于现在')
  return { repeat: { type: 'once', at: at.toISOString() } }
}

function clamp(v: number, lo: number, hi: number) {
  const n = Number.isFinite(+v) ? Math.round(+v) : lo
  return Math.min(hi, Math.max(lo, n))
}

async function handleSave() {
  if (!form.task.trim()) { toast.error('任务内容不能为空'); return }
  let rule: { repeat?: ScheduleRepeat; cron?: string }
  try { rule = buildRule() } catch (e) { toast.error((e as Error).message); return }
  const payload = {
    name: form.name.trim(),
    task: form.task.trim(),
    workspace_dir: form.workspace || '',
    catch_up: form.catchUp,
    ...rule,
  }
  saving.value = true
  try {
    if (form.id) { await updateSchedule(form.id, payload); toast.success('已更新') }
    else { await createSchedule(payload); toast.success('定时任务已创建') }
    showForm.value = false
    await load()
  } catch (e) {
    toast.error('保存失败：' + (e as Error).message)
  } finally {
    saving.value = false
  }
}

async function handleToggle(s: Schedule) {
  try { await toggleSchedule(String(s.id), !s.enabled); await load() }
  catch (e) { toast.error('切换失败：' + (e as Error).message) }
}

async function handleCatchUp(s: Schedule) {
  try { await setScheduleCatchUp(String(s.id), s.catch_up === false); await load() }
  catch (e) { toast.error('设置失败：' + (e as Error).message) }
}

async function handleRun(s: Schedule) {
  try { await runSchedule(String(s.id)); toast.success('已触发，跑完可以在工作空间里看结果'); await load() }
  catch (e) { toast.error('触发失败：' + (e as Error).message) }
}

async function handleDelete(s: Schedule) {
  if (!window.confirm(`删除定时任务「${s.name}」？该任务的运行记录也会一并删除。`)) return
  try { await deleteSchedule(String(s.id)); toast.success('已删除'); await Promise.all([load(), loadRuns()]) }
  catch (e) { toast.error('删除失败：' + (e as Error).message) }
}

/** 规则的人话描述（和后端 describeRepeat 对齐，够展示用） */
function describe(s: Schedule): string {
  const r = s.repeat
  if (!r) return s.cron || '—'
  const t = (r.hour ?? 0) * 60 + (r.minute ?? 0)
  const clock = hm(Math.floor(t / 60), t % 60)
  switch (r.type) {
    case 'minutes': return `每 ${r.every} 分钟`
    case 'hours': return `每 ${r.every} 小时`
    case 'daily': return `每天 ${clock}`
    case 'weekly': return `每周${(r.days || []).map((d) => WEEK.find((w) => w.v === d)?.label || d).join('、')} ${clock}`
    case 'monthly': return `每月 ${r.day} 号 ${clock}`
    case 'once': return `只跑一次：${fmtTime(r.at)}`
    default: return s.cron || '—'
  }
}

/** 任务跑在哪个工作空间 */
function workspaceLabel(dir?: string): string {
  if (!dir) return '当前工作空间'
  const p = projects.value.find((x) => x.dir === dir)
  if (p) return p.name
  return dir.split(/[/\\]/).filter(Boolean).pop() || dir
}

function fmtTime(v?: string | null): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function runStatus(r: ScheduleRun): { label: string; variant: 'default' | 'secondary' | 'destructive' } {
  if (r.ok === null || r.ok === undefined) return { label: '运行中', variant: 'secondary' }
  return r.ok ? { label: '成功', variant: 'default' } : { label: '失败', variant: 'destructive' }
}

const canSave = computed(() => !!form.task.trim() && !saving.value)
</script>

<template>
  <div class="mx-auto w-full max-w-4xl space-y-6 p-6">
    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle class="flex items-center gap-2">
              <CalendarClock class="size-5" /> 定时任务
            </CardTitle>
            <CardDescription class="mt-1">
              到点自动让 AI 干活。时间从下拉里选，不用写 cron；每个任务还能指定在哪个工作空间里跑。
              客户端常驻时才会触发，关机期间错过的那次默认会补跑。
            </CardDescription>
          </div>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" class="gap-1.5" :disabled="loading" @click="load">
              <RefreshCw class="size-3.5" /> 刷新
            </Button>
            <Button size="sm" class="gap-1.5" @click="showForm ? (showForm = false) : openCreate()">
              <Plus v-if="!showForm" class="size-3.5" />
              <X v-else class="size-3.5" />
              {{ showForm ? '收起' : '新建' }}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent class="space-y-4">
        <!-- ===== 新建 / 编辑表单 ===== -->
        <div v-if="showForm" class="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="space-y-1.5">
              <Label for="s-name">任务名称<span class="ml-1 text-xs text-muted-foreground">可留空，默认取任务内容</span></Label>
              <Input id="s-name" v-model="form.name" class="h-9" placeholder="例如：每天早上生成日报" />
            </div>
            <div class="space-y-1.5">
              <Label for="s-ws">工作空间</Label>
              <select
                id="s-ws"
                v-model="form.workspace"
                class="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">跟随当前工作空间</option>
                <option v-for="p in projects" :key="p.name" :value="p.name">{{ p.name }}</option>
              </select>
            </div>
          </div>

          <div class="space-y-1.5">
            <Label for="s-task">任务内容<span class="ml-1 text-xs text-muted-foreground">写给 AI 的指令，说清要产出什么</span></Label>
            <textarea
              id="s-task"
              v-model="form.task"
              rows="2"
              class="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="例如：整理昨天的聊天记录，生成一份日报 markdown 放到工作空间"
            />
          </div>

          <!-- 时间规则 -->
          <div class="rounded-md border border-border bg-background/60 p-3">
            <div class="flex flex-wrap items-center gap-2">
              <Label class="shrink-0">何时执行</Label>
              <select
                v-model="form.type"
                class="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="minutes">每隔几分钟</option>
                <option value="hours">每隔几小时</option>
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
                <option value="once">只跑一次</option>
                <option value="cron">自定义 Cron（高级）</option>
              </select>

              <!-- 每 N 分钟 -->
              <template v-if="form.type === 'minutes'">
                <span class="text-sm text-muted-foreground">每</span>
                <Input v-model.number="form.every" type="number" min="1" max="59" class="h-9 w-20" />
                <span class="text-sm text-muted-foreground">分钟</span>
              </template>

              <!-- 每 N 小时 -->
              <template v-else-if="form.type === 'hours'">
                <span class="text-sm text-muted-foreground">每</span>
                <Input v-model.number="form.every" type="number" min="1" max="24" class="h-9 w-20" />
                <span class="text-sm text-muted-foreground">小时的</span>
                <Input v-model="form.time" type="time" class="h-9 w-28" />
              </template>

              <!-- 每天 / 每周 / 每月 共用的时间点 -->
              <template v-else-if="form.type === 'daily'">
                <Input v-model="form.time" type="time" class="h-9 w-28" />
              </template>

              <template v-else-if="form.type === 'weekly'">
                <div class="flex items-center gap-1">
                  <label
                    v-for="w in WEEK"
                    :key="w.v"
                    class="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border text-sm select-none"
                    :class="form.days.includes(w.v) ? 'border-primary bg-primary text-primary-foreground' : 'border-input'"
                  >
                    <input
                      type="checkbox"
                      class="hidden"
                      :checked="form.days.includes(w.v)"
                      @change="form.days.includes(w.v) ? form.days.splice(form.days.indexOf(w.v), 1) : form.days.push(w.v)"
                    />
                    {{ w.label }}
                  </label>
                </div>
                <Input v-model="form.time" type="time" class="h-9 w-28" />
              </template>

              <template v-else-if="form.type === 'monthly'">
                <span class="text-sm text-muted-foreground">每月</span>
                <Input v-model.number="form.day" type="number" min="1" max="31" class="h-9 w-20" />
                <span class="text-sm text-muted-foreground">号</span>
                <Input v-model="form.time" type="time" class="h-9 w-28" />
              </template>

              <template v-else-if="form.type === 'once'">
                <Input v-model="form.onceAt" type="datetime-local" class="h-9 w-56" />
              </template>

              <template v-else>
                <Input v-model="form.cron" class="h-9 w-52 font-mono" placeholder="分 时 日 月 周，如 0 9 * * 1" />
              </template>
            </div>

            <p class="mt-2 text-xs text-muted-foreground">
              {{ form.type === 'once' ? '跑完这一次后任务会自动停用。' : form.type === 'cron' ? 'cron 五字段：分 时 日 月 周。例如 0 9 * * 1 表示每周一 9:00。' : '到点后 AI 会用全新会话执行任务内容。' }}
            </p>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3">
            <label class="flex items-center gap-2 text-sm text-muted-foreground">
              <input v-model="form.catchUp" type="checkbox" class="size-4" />
              关机/休眠期间错过的那次，开机后补跑
            </label>
            <div class="flex gap-2">
              <Button variant="ghost" size="sm" @click="showForm = false">取消</Button>
              <Button size="sm" :disabled="!canSave" @click="handleSave">
                {{ saving ? '保存中…' : form.id ? '保存修改' : '创建' }}
              </Button>
            </div>
          </div>
        </div>

        <!-- ===== 列表 ===== -->
        <div v-if="loading" class="flex justify-center py-12">
          <Spinner class="size-6 text-muted-foreground" />
        </div>

        <div v-else-if="!items.length" class="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          还没有定时任务。点右上角「新建」，或直接让 AI 帮你建一个。
        </div>

        <ul v-else class="divide-y divide-border rounded-lg border border-border">
          <li v-for="s in items" :key="String(s.id)" class="px-4 py-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <p class="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {{ s.name }}
                  <Badge :variant="s.enabled ? 'default' : 'secondary'">
                    {{ s.enabled ? '已启用' : '已停用' }}
                  </Badge>
                  <Badge v-if="s.running" variant="secondary">运行中</Badge>
                </p>
                <p class="mt-1 truncate text-xs text-muted-foreground">{{ s.task }}</p>
                <p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span>{{ describe(s) }}</span>
                  <span>· 工作空间：{{ workspaceLabel(s.workspace_dir as string) }}</span>
                  <span>· 上次 {{ fmtTime(s.last_run_at) }}</span>
                  <span v-if="s.enabled">· 下次 {{ fmtTime(s.next_run_at) }}</span>
                </p>
                <p v-if="s.last_result" class="mt-1 truncate text-xs text-muted-foreground/80">结果：{{ s.last_result }}</p>
              </div>
              <div class="flex shrink-0 gap-1.5">
                <Button variant="ghost" size="sm" @click="handleToggle(s)">{{ s.enabled ? '停用' : '启用' }}</Button>
                <Button variant="ghost" size="sm" class="gap-1" @click="handleRun(s)">
                  <Play class="size-3.5" /> 立即跑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  :title="s.catch_up === false ? '当前：错过不补跑，点击改为补跑' : '当前：错过会补跑，点击改为不补'"
                  @click="handleCatchUp(s)"
                >
                  {{ s.catch_up === false ? '不补跑' : '补跑' }}
                </Button>
                <Button variant="ghost" size="icon" title="编辑" @click="openEdit(s)">
                  <Pencil class="size-4" />
                </Button>
                <Button variant="ghost" size="icon" title="删除" @click="handleDelete(s)">
                  <Trash2 class="size-4" />
                </Button>
              </div>
            </div>
          </li>
        </ul>
      </CardContent>
    </Card>

    <Card v-if="runs.length">
      <CardHeader>
        <CardTitle class="text-base">最近运行记录</CardTitle>
        <CardDescription>最近一次在前，最多保留 300 条。</CardDescription>
      </CardHeader>
      <CardContent>
        <ul class="divide-y divide-border rounded-lg border border-border">
          <li v-for="r in runs.slice(0, 20)" :key="String(r.id)" class="flex items-center gap-3 px-4 py-2.5 text-sm">
            <Badge :variant="runStatus(r).variant" class="shrink-0">{{ runStatus(r).label }}</Badge>
            <span class="w-32 shrink-0 truncate text-muted-foreground">{{ r.name || '—' }}</span>
            <span class="flex-1 truncate text-muted-foreground">{{ r.result || (r.trigger ? `触发：${r.trigger}` : '') }}</span>
            <span class="shrink-0 text-xs text-muted-foreground">{{ fmtTime(r.started_at) }}</span>
          </li>
        </ul>
      </CardContent>
    </Card>
  </div>
</template>
