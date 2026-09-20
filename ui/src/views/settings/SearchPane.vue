<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Save, Search, TestTube2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Badge } from '@/components/ui/badge'
import { toast } from 'vue-sonner'
import { getSettings, saveSettings, testSearch } from '@/api/client'

/**
 * 联网搜索：web_search 工具用哪家搜索服务。
 * provider 三选一（Jina / Tavily / Brave），各自填 Key；
 * 不填 Key 自动回退免费 DuckDuckGo——离线也能搜，只是精度差一点。
 */
const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok?: boolean; provider?: string; sample?: string; error?: string } | null>(null)

const provider = ref('jina')
const keys = ref({ jina_key: '', tavily_key: '', brave_key: '' })

const PROVIDERS = [
  { value: 'jina', label: 'Jina', desc: 's.jina.ai（免费领 key，中文效果好）', keyField: 'jina_key', keyLabel: 'Jina API Key' },
  { value: 'tavily', label: 'Tavily', desc: 'tavily.com（面向 AI 的搜索）', keyField: 'tavily_key', keyLabel: 'Tavily API Key' },
  { value: 'brave', label: 'Brave', desc: 'brave.com/search/api（隐私优先）', keyField: 'brave_key', keyLabel: 'Brave API Key' },
]

const activeProvider = ref(PROVIDERS[0])

onMounted(async () => {
  try {
    const s = await getSettings()
    const sc = s.search as Record<string, string> | undefined
    if (sc) {
      provider.value = String(sc.provider || 'jina')
      keys.value = {
        jina_key: String(sc.jina_key || ''),
        tavily_key: String(sc.tavily_key || ''),
        brave_key: String(sc.brave_key || ''),
      }
    }
    activeProvider.value = PROVIDERS.find((p) => p.value === provider.value) || PROVIDERS[0]
  } catch (e) {
    toast.error('读取搜索配置失败：' + (e as Error).message)
  } finally {
    loading.value = false
  }
})

async function save() {
  saving.value = true
  try {
    await saveSettings({ search: { provider: provider.value, ...keys.value } })
    toast.success('已保存，下一条任务生效')
  } catch (e) {
    toast.error('保存失败：' + (e as Error).message)
  } finally {
    saving.value = false
  }
}

async function runTest() {
  testing.value = true
  testResult.value = null
  try {
    // 测的是表单里当前填的 provider + key（不必先保存）；后端也支持不传时测已保存配置
    const key = (keys.value as Record<string, string>)[activeProvider.value.keyField] || ''
    testResult.value = await testSearch({ provider: provider.value, key })
  } catch (e) {
    testResult.value = { ok: false, error: (e as Error).message }
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div v-if="loading" class="flex justify-center py-10">
    <Spinner class="size-6 text-muted-foreground" />
  </div>

  <div v-else class="space-y-5">
    <p class="text-sm text-muted-foreground">
      <code class="rounded bg-muted px-1">web_search</code> 工具用它联网查资料。换家服务就是在界面上点一下，配置热生效。
    </p>

    <!-- Provider 三选一 -->
    <div class="space-y-2">
      <Label class="text-[13px]">搜索服务</Label>
      <div class="grid gap-2 sm:grid-cols-3">
        <button
          v-for="p in PROVIDERS"
          :key="p.value"
          class="rounded-lg border p-3 text-left transition-colors"
          :class="provider === p.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50'"
          @click="provider = p.value; activeProvider = p"
        >
          <p class="text-sm font-medium">{{ p.label }}</p>
          <p class="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{{ p.desc }}</p>
        </button>
      </div>
    </div>

    <!-- 当前 provider 的 Key -->
    <div v-if="activeProvider" class="space-y-2">
      <Label :for="activeProvider.keyField" class="text-[13px]">{{ activeProvider.keyLabel }}</Label>
      <div class="flex gap-2">
        <Input
          :id="activeProvider.keyField"
          v-model="keys[activeProvider.keyField as keyof typeof keys]"
          type="password"
          :placeholder="`填 ${activeProvider.label} 的 API Key`"
          class="h-9"
        />
        <Button variant="outline" size="sm" class="h-9 gap-1.5" :disabled="testing || saving" @click="runTest">
          <TestTube2 v-if="!testing" class="size-3.5" />
          <Spinner v-else class="size-3.5" />
          测试搜索
        </Button>
      </div>
      <p class="text-[13px] text-muted-foreground">
        留空则自动回退免费 DuckDuckGo（不填也能搜，结果质量差一些）。
      </p>
    </div>

    <!-- 测试结果 -->
    <div v-if="testResult" class="rounded-lg border p-3 text-[13px]" :class="testResult.ok ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-red-500/40 bg-red-500/5'">
      <p class="flex items-center gap-1.5 font-medium" :class="testResult.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'">
        <Search class="size-3.5" />
        {{ testResult.ok ? '搜索可用' : '搜索失败' }}
      </p>
      <p class="mt-1 text-muted-foreground">
        {{ testResult.ok ? `「${testResult.provider}」实测返回：${testResult.sample}` : testResult.error }}
      </p>
    </div>

    <div class="flex items-center gap-2 pt-2">
      <Button class="h-9 gap-1.5" :disabled="saving || testing" @click="save">
        <Save class="size-3.5" /> 保存
      </Button>
      <Badge v-if="provider === 'jina' && !keys.jina_key" variant="outline" class="text-[12px]">当前走 DuckDuckGo 兜底</Badge>
    </div>
  </div>
</template>
