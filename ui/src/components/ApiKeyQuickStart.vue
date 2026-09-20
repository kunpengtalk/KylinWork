<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowRight, Copy } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { copyText } from '@/lib/clipboard'
import { llmBaseUrl, relayLlmBaseUrl } from '@/lib/gateway'

/**
 * API Key 接入速查（接入地址 + 鉴权 + 多语言示例）。
 * <p>
 * 两处复用：
 * <ul>
 *   <li>「我的密钥 → 接入说明」页面：展示占位 Key</li>
 *   <li>创建 Key 成功弹窗：代入刚生成的明文，让用户可以"复制即用"</li>
 * </ul>
 * 协议与网关路由保持一致：OpenAI 兼容 `/v1/**`，ai-relay 只识别
 * `Authorization: Bearer sk-...`（不识别 x-api-key）。
 * 接入地址提供「经网关 / 直连中继」两种：本地未启用 Nacos 时网关解析不到 ai-relay，
 * 只能直连中继，故两个地址都给出，由用户按环境选择。
 */
const props = defineProps<{
  /** 明文 Key；缺省时用占位符（列表里只有脱敏值，取不到明文） */
  apiKey?: string
  /** 是否展示「查看完整接入说明」入口 */
  showMore?: boolean
}>()

const emit = defineEmits<{ (e: 'more'): void }>()

const addressModes = (
  [
    {
      value: 'gateway',
      label: '当前环境',
      url: llmBaseUrl,
      hint: '接入地址跟随当前登录环境的域名自动生成，直接复制即可用。',
    },
    relayLlmBaseUrl
      ? {
          value: 'relay',
          label: '直连中继',
          url: relayLlmBaseUrl,
          hint: '本地调试用：网关未接入服务发现（如未启用 Nacos）时，只有这条路径可达。',
        }
      : null,
  ] as const
).filter((item): item is Exclude<typeof item, null> => item !== null)

const mode = ref<(typeof addressModes)[number]['value']>('gateway')
const base = computed(() => addressModes.find((item) => item.value === mode.value)!.url)
const hint = computed(() => addressModes.find((item) => item.value === mode.value)!.hint)
const key = computed(() => props.apiKey?.trim() || 'sk-你的密钥')

const samples = computed(() => ({
  curl: `curl ${base.value}/chat/completions \\
  -H "Authorization: Bearer ${key.value}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'`,

  python: `from openai import OpenAI

client = OpenAI(base_url="${base.value}", api_key="${key.value}")

# 可用模型：client.models.list()
resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)

for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")`,

  node: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${base.value}", apiKey: "${key.value}" });

const stream = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "你好" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`,

  client: `支持 OpenAI 协议的客户端（Cherry Studio / NextChat / AnythingLLM 等）填写：

  接口类型（Provider）：OpenAI / OpenAI 兼容
  API 地址（Base URL）：${base.value}
  API 密钥（API Key） ：${key.value}
  模型（Model）       ：先用下面这行拿到可用模型，再填进去

curl ${base.value}/models -H "Authorization: Bearer ${key.value}"`,
}))
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <Button
        v-for="item in addressModes"
        :key="item.value"
        size="sm"
        :variant="mode === item.value ? 'default' : 'outline'"
        @click="mode = item.value"
      >
        {{ item.label }}
      </Button>
    </div>

    <dl class="grid gap-y-2 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-x-3 sm:gap-y-2">
      <dt class="text-xs text-muted-foreground">接入地址</dt>
      <dd class="flex items-center gap-1.5">
        <code class="break-all rounded bg-muted px-1.5 py-0.5 text-xs">{{ base }}</code>
        <Button
          variant="ghost"
          size="icon"
          class="size-6 shrink-0"
          title="复制接入地址"
          @click="copyText(base, '接入地址已复制')"
        >
          <Copy class="size-3.5" />
        </Button>
      </dd>

      <dt class="text-xs text-muted-foreground">鉴权方式</dt>
      <dd class="flex items-center gap-1.5">
        <code class="break-all rounded bg-muted px-1.5 py-0.5 text-xs">
          Authorization: Bearer {{ key }}
        </code>
        <Button
          variant="ghost"
          size="icon"
          class="size-6 shrink-0"
          title="复制鉴权头"
          @click="copyText(`Bearer ${key}`, '鉴权头已复制')"
        >
          <Copy class="size-3.5" />
        </Button>
      </dd>
    </dl>

    <p class="text-xs leading-relaxed text-muted-foreground">{{ hint }}</p>

    <Tabs default-value="curl">
      <TabsList>
        <TabsTrigger value="curl">cURL</TabsTrigger>
        <TabsTrigger value="python">Python</TabsTrigger>
        <TabsTrigger value="node">Node.js</TabsTrigger>
        <TabsTrigger value="client">客户端</TabsTrigger>
      </TabsList>

      <TabsContent v-for="(code, lang) in samples" :key="lang" :value="lang" class="mt-2">
        <div class="relative">
          <pre
            class="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 pr-9 text-xs leading-relaxed"
          ><code class="whitespace-pre">{{ code }}</code></pre>
          <Button
            variant="ghost"
            size="icon"
            class="absolute right-1.5 top-1.5 size-6"
            title="复制代码"
            @click="copyText(code)"
          >
            <Copy class="size-3.5" />
          </Button>
        </div>
      </TabsContent>
    </Tabs>

    <p class="text-xs leading-relaxed text-muted-foreground">
      示例中的 <code class="rounded bg-muted px-1">model</code> 请替换为
      <code class="rounded bg-muted px-1">GET {{ base }}/models</code> 返回的模型 ID；
      <code class="rounded bg-muted px-1">stream: true</code> 表示按 SSE 流式返回。
    </p>

    <Button v-if="showMore" variant="outline" size="sm" class="gap-1.5" @click="emit('more')">
      查看完整接入说明
      <ArrowRight class="size-3.5" />
    </Button>
  </div>
</template>
