<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Database, Plus, Settings2, Trash2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'vue-sonner'
import { deleteKnowledgeBase, listKnowledgeBases, type KnowledgeBase } from '@/api/client'
import { loadModelChannels } from '@/components/knowledge/modelOptions'
import type { ModelChannel } from '@/api/engine'
import KbCreateDialog from '@/components/knowledge/KbCreateDialog.vue'
import KbDocsTab from '@/components/knowledge/KbDocsTab.vue'
import KbRecallTab from '@/components/knowledge/KbRecallTab.vue'
import KbSettingsTab from '@/components/knowledge/KbSettingsTab.vue'

/**
 * 知识库：左侧建库 / 选库，右侧按「数据源 / 召回测试 / 设置」三块管理这个库。
 * <p>
 * 建库是弹窗（名称、描述、向量 / 重排模型一起填）；每个库可以各配一套模型与检索参数，
 * 没配的字段回落到「设置 → 知识库」的全局默认。对话里勾选某个库后，引擎先检索再回答。
 */
const router = useRouter()

type Tab = 'docs' | 'recall' | 'settings'

const bases = ref<KnowledgeBase[]>([])
const channels = ref<ModelChannel[]>([])
const activeId = ref('')
const tab = ref<Tab>('docs')
const loading = ref(true)
const createOpen = ref(false)

const pendingDelete = ref<KnowledgeBase | null>(null)
const deleting = ref(false)

const activeBase = computed(() => bases.value.find((b) => b.id === activeId.value) || null)

const TABS: { key: Tab; label: string }[] = [
  { key: 'docs', label: '数据源' },
  { key: 'recall', label: '召回测试' },
  { key: 'settings', label: '设置' },
]

onMounted(async () => {
  await loadBases()
  loading.value = false
  channels.value = await loadModelChannels()
})

async function loadBases() {
  try {
    const d = await listKnowledgeBases()
    bases.value = d.bases || []
    if (!activeId.value || !bases.value.some((b) => b.id === activeId.value)) {
      activeId.value = bases.value[0]?.id || ''
    }
  } catch (e) {
    toast.error('读取知识库失败：' + (e as Error).message)
  }
}

function pickBase(id: string) {
  if (activeId.value === id) return
  activeId.value = id
  tab.value = 'docs'
}

function onCreated(base: KnowledgeBase) {
  void loadBases().then(() => {
    activeId.value = base.id
    tab.value = 'docs'
  })
  toast.success(`已创建知识库「${base.name}」`)
}

async function confirmDelete() {
  const b = pendingDelete.value
  if (!b) return
  deleting.value = true
  try {
    await deleteKnowledgeBase(b.id)
    pendingDelete.value = null
    if (activeId.value === b.id) activeId.value = ''
    await loadBases()
    toast.success('已删除')
  } catch (e) {
    toast.error('删除失败：' + (e as Error).message)
  } finally {
    deleting.value = false
  }
}

/** 头部的四个统计：资料数 / 分块数 / 向量进度 / 检索方式 */
const vectorPct = computed(() => {
  const b = activeBase.value
  if (!b) return 0
  if (!b.chunk_count) return 0
  return Math.round(((b.embedded_chunks || 0) / b.chunk_count) * 100)
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 顶栏 -->
    <header class="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 px-4">
      <Database class="size-4 shrink-0 text-muted-foreground" />
      <h2 class="text-sm font-medium">知识库</h2>
      <p class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        建库、上传资料；对话里勾选后，引擎会先检索再回答
      </p>
      <Button variant="ghost" size="sm" class="h-7 gap-1.5 text-xs text-muted-foreground" @click="router.push('/client-settings/knowledge')">
        <Settings2 class="size-3.5" /> 全局检索配置
      </Button>
    </header>

    <div v-if="loading" class="flex flex-1 items-center justify-center">
      <Spinner class="size-6 text-muted-foreground" />
    </div>

    <div v-else class="flex min-h-0 flex-1">
      <!-- 左：库列表 -->
      <aside class="flex w-72 shrink-0 flex-col border-r border-border/70 bg-[#fafafa] dark:bg-card/40">
        <div class="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
          <span class="text-[13px] font-medium text-muted-foreground">知识库<span class="ml-1 text-muted-foreground/70">{{ bases.length }}</span></span>
          <Button variant="outline" size="sm" class="h-7 gap-1" @click="createOpen = true">
            <Plus class="size-3.5" /> 新建
          </Button>
        </div>
        <ul class="min-h-0 flex-1 overflow-y-auto p-2">
          <p v-if="!bases.length" class="px-2 py-6 text-center text-xs text-muted-foreground">
            还没有知识库，点右上角「新建」
          </p>
          <li v-for="b in bases" :key="b.id" class="group relative">
            <button
              class="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors"
              :class="activeId === b.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'"
              @click="pickBase(b.id)"
            >
              <Database class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[13px] font-medium">{{ b.name }}</span>
                <span class="mt-0.5 block text-[11px] text-muted-foreground">
                  {{ b.file_count || 0 }} 份资料 · {{ b.chunk_count || 0 }} 段
                </span>
              </span>
              <span class="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button class="rounded p-1 text-muted-foreground hover:text-foreground" title="设置" @click.stop="pickBase(b.id); tab = 'settings'">
                  <Settings2 class="size-3" />
                </button>
                <button class="rounded p-1 text-muted-foreground hover:text-destructive" title="删除知识库" @click.stop="pendingDelete = b">
                  <Trash2 class="size-3" />
                </button>
              </span>
            </button>
          </li>
        </ul>
      </aside>

      <!-- 右：库详情 -->
      <section class="flex min-w-0 flex-1 flex-col">
        <div v-if="!activeBase" class="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <span class="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Database class="size-6" />
          </span>
          <p class="text-foreground">还没有知识库</p>
          <p class="text-xs">单一主题建一个库，检索更准</p>
          <Button class="mt-1 gap-1.5" @click="createOpen = true"><Plus class="size-3.5" /> 新建知识库</Button>
        </div>

        <template v-else>
          <!-- 头部：名称 + 统计 + Tab -->
          <div class="border-b border-border/60 px-4 pb-0 pt-3">
            <div class="flex items-start gap-3">
              <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Database class="size-4" />
              </span>
              <div class="min-w-0 flex-1">
                <h3 class="truncate text-sm font-medium">{{ activeBase.name }}</h3>
                <p v-if="activeBase.description" class="mt-0.5 truncate text-[11px] text-muted-foreground">{{ activeBase.description }}</p>
              </div>
            </div>

            <div class="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-[11px]">
              <span><b class="text-foreground">{{ activeBase.file_count || 0 }}</b> <span class="text-muted-foreground">资料</span></span>
              <span><b class="text-foreground">{{ activeBase.chunk_count || 0 }}</b> <span class="text-muted-foreground">分块</span></span>
              <span>
                <b class="text-foreground">{{ activeBase.embedding_model ? `${vectorPct}%` : '—' }}</b>
                <span class="text-muted-foreground">已向量化</span>
              </span>
              <span><b class="text-foreground">{{ activeBase.embedding_model ? '混合' : '关键词' }}</b> <span class="text-muted-foreground">检索 · Top {{ activeBase.tuning?.top_k ?? 6 }}</span></span>
            </div>

            <p v-if="activeBase.stale_files" class="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
              有 {{ activeBase.stale_files }} 份资料的向量是换模型之前算的，本次检索会跳过它们——到「数据源」点「重建索引」可恢复。
            </p>

            <div class="mt-3 flex gap-1">
              <button
                v-for="t in TABS"
                :key="t.key"
                class="rounded-t-md border-b-2 px-3 py-1.5 text-[13px] transition-colors"
                :class="tab === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
                @click="tab = t.key"
              >
                {{ t.label }}
              </button>
            </div>
          </div>

          <KbDocsTab v-if="tab === 'docs'" :key="'docs-' + activeBase.id" :base="activeBase" @changed="loadBases" />
          <KbRecallTab v-else-if="tab === 'recall'" :key="'recall-' + activeBase.id" :base="activeBase" />
          <KbSettingsTab
            v-else
            :key="'set-' + activeBase.id"
            :base="activeBase"
            :channels="channels"
            @changed="loadBases"
            @deleted="loadBases"
          />
        </template>
      </section>
    </div>

    <KbCreateDialog v-model:open="createOpen" :channels="channels" @created="onCreated" />

    <Dialog :open="!!pendingDelete" @update:open="(v) => !v && (pendingDelete = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除知识库</DialogTitle>
          <DialogDescription>确定删除「{{ pendingDelete?.name }}」及其中的全部资料？此操作不可恢复。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="pendingDelete = null">取消</Button>
          <Button variant="destructive" :disabled="deleting" class="gap-1.5" @click="confirmDelete">
            <Spinner v-if="deleting" class="size-3.5" /> 删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
