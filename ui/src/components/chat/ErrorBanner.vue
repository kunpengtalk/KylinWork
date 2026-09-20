<script setup lang="ts">
/**
 * 对话报错横幅（对齐参考版底部那条）：错误不该只留一行 toast 就消失。
 * <p>
 * 用户看到的是"任务失败了"，真正想知道的是三件事：**为什么、是不是我的问题、现在能干什么**。
 * 所以这条横幅把说明、状态码/详情、以及四个可操作入口摆在一起：
 * 提交反馈（进自进化复盘）、复制错误（拿去别处问）、重试（再跑一次）、
 * 检测网络（真的发一条最小请求问上游，替用户分辨"网断了"还是"模型坏了"）。
 */
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { TriangleAlert, X } from 'lucide-vue-next'
import { probeActiveModel } from '@/api/engine'

const props = defineProps<{
  title: string
  detail?: string
  status?: number
  /** 出错时用的渠道名与模型 id（检测网络要按同一个目标验，换了模型测的就不是这件事了） */
  channel?: string
  model?: string
}>()

const emit = defineEmits<{
  (e: 'retry'): void
  (e: 'feedback'): void
  (e: 'close'): void
}>()

const probing = ref(false)
/** 验活结果：通了给绿的一句，不通把上游原话贴出来 */
const probeResult = ref<{ ok: boolean; text: string } | null>(null)

async function checkNetwork() {
  if (probing.value) return
  probing.value = true
  probeResult.value = null
  try {
    const r = await probeActiveModel({ model: props.channel, model_id: props.model })
    probeResult.value = r.ok
      ? { ok: true, text: `连接正常（${r.model || props.model || '当前模型'} 有响应）` }
      : { ok: false, text: r.error || '连接失败' }
  } catch (e) {
    probeResult.value = { ok: false, text: (e as Error).message }
  } finally {
    probing.value = false
  }
}

function copyError() {
  const text = [
    '【KylinWork 错误报告】',
    `说明：${props.title}`,
    props.status ? `HTTP：${props.status}` : '',
    props.detail ? `详情：${props.detail}` : '',
    props.channel ? `渠道：${props.channel}` : '',
    props.model ? `模型：${props.model}` : '',
    `时间：${new Date().toLocaleString()}`,
  ]
    .filter(Boolean)
    .join('\n')
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success('错误信息已复制'))
    .catch(() => toast.error('复制失败'))
}
</script>

<template>
  <div class="mb-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-2.5">
    <div class="flex items-start gap-2">
      <TriangleAlert class="mt-0.5 size-4 shrink-0 text-destructive" />
      <div class="min-w-0 flex-1">
        <p class="text-[13px] font-medium">{{ title }}</p>
        <p class="mt-0.5 break-all font-mono text-[11px] leading-4 text-muted-foreground">
          <template v-if="status">HTTP {{ status }}</template>
          <template v-if="status && (detail || channel)"> · </template>
          <template v-if="channel">{{ channel }}<template v-if="model">/{{ model }}</template></template>
          <template v-if="(status || channel) && detail"> · </template>
          <template v-if="detail">{{ detail }}</template>
        </p>
        <!-- 检测网络的结果就地贴出来：用户点了按钮，答案就该长在按钮旁边 -->
        <p
          v-if="probeResult"
          class="mt-1 text-[11px] leading-4"
          :class="probeResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'"
        >
          {{ probeResult.ok ? '✓ ' : '✕ ' }}{{ probeResult.text }}
        </p>
      </div>
      <button class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="关闭" @click="emit('close')">
        <X class="size-3.5" />
      </button>
    </div>

    <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        class="rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        @click="emit('feedback')"
      >
        提交反馈
      </button>
      <button
        type="button"
        class="rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        @click="copyError"
      >
        复制错误
      </button>
      <button
        type="button"
        class="rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        @click="emit('retry')"
      >
        重试
      </button>
      <button
        type="button"
        class="rounded-md bg-foreground px-2.5 py-1 text-xs text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        :disabled="probing"
        @click="checkNetwork"
      >
        {{ probing ? '检测中…' : '检测网络' }}
      </button>
    </div>
  </div>
</template>
