<script setup lang="ts">
import { ref } from 'vue'
import { FolderOpen, Loader2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'vue-sonner'
import { pickFolder } from '@/api/client'
import { createProject } from '@/api/engine'

/**
 * 新建项目（对齐 T3 的「选择项目文件夹」体验）：
 * 点「选择文件夹」弹系统目录框 → 起个名 → 确认。
 * 后端 POST /api/projects 原生支持 {name, dir}：建目录、切 active、一步到位，
 * 不需要再手动去网页表单里填。
 */
const emit = defineEmits<{ (e: 'created', name: string): void; (e: 'close'): void }>()

const open = ref(false)
const name = ref('')
const dir = ref('')
const saving = ref(false)

function show() {
  open.value = true
  name.value = ''
  dir.value = ''
}

/** 关闭（取消 / 点遮罩）：必须真的把 open 置回 false，
 *  否则全屏遮罩一直盖着，整个应用看起来像白屏卡死 */
function close() {
  open.value = false
  emit('close')
}

async function chooseFolder() {
  try {
    const r = await pickFolder()
    const d = r?.dir || r?.path
    if (d) dir.value = d
  } catch (e) {
    toast.error('选择目录失败：' + (e as Error).message)
  }
}

async function confirm() {
  const n = name.value.trim()
  if (!n) {
    toast.error('请填写项目名称')
    return
  }
  saving.value = true
  try {
    await createProject({ name: n, dir: dir.value || undefined })
    toast.success(`工作空间「${n}」已创建并切换`)
    open.value = false
    // 通知所有组件（侧栏 / 对话框）重新拉工作空间列表
    window.dispatchEvent(new CustomEvent('kylinwork:projects-changed'))
    emit('created', n)
  } catch (e) {
    toast.error('创建失败：' + (e as Error).message)
  } finally {
    saving.value = false
  }
}

defineExpose({ show })
</script>

<template>
  <teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="close"
    >
      <div class="w-full max-w-md rounded-xl border border-border bg-background p-5 shadow-xl">
        <h3 class="text-base font-semibold">新建工作空间</h3>
        <p class="mt-1 text-xs text-muted-foreground">
          选一个本地文件夹作为工作空间，AI 的成果文件都会落在这里；名字默认跟目录走。
        </p>

        <div class="mt-4 space-y-3">
          <div class="space-y-1.5">
            <Label>工作空间名称</Label>
            <Input v-model="name" class="h-9" placeholder="不填则使用目录名" maxlength="30" />
          </div>
          <div class="space-y-1.5">
            <Label>本地文件夹</Label>
            <button
              class="flex h-9 w-full items-center gap-2 rounded-md border border-border bg-background px-3 text-left text-sm transition-colors hover:bg-accent/50"
              @click="chooseFolder"
            >
              <FolderOpen class="size-4 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate" :class="dir ? '' : 'text-muted-foreground'">
                {{ dir || '选择文件夹…' }}
              </span>
            </button>
            <p class="text-[11px] text-muted-foreground">不选则自动在数据目录下创建同名文件夹</p>
          </div>
        </div>

        <div class="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="close">取消</Button>
          <Button size="sm" :disabled="saving" @click="confirm">
            <Loader2 v-if="saving" class="mr-1 size-3.5 animate-spin" />
            创建并切换
          </Button>
        </div>
      </div>
    </div>
  </teleport>
</template>
