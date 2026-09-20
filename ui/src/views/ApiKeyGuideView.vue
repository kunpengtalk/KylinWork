<script setup lang="ts">
import { ArrowLeft, KeyRound, Monitor } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import ApiKeyQuickStart from '@/components/ApiKeyQuickStart.vue'

/**
 * 接入说明（挂在「我的密钥」下）。
 * <p>
 * 说明外部客户端怎么用 API Key 调用：请求打到 API 网关的 `/v1/**`（OpenAI 兼容），
 * 网关匿名放行并剥离伪造的身份头，转发给 ai-relay，由 ai-relay 用 sk- 密钥鉴权、计费、限流。
 * 内容与 ai-relay 现有 Controller 保持一致，避免文档写了但接口没有。
 */
const router = useRouter()

const endpoints = [
  { method: 'POST', path: '/v1/chat/completions', desc: '对话补全；stream=true 时按 SSE 流式返回' },
  { method: 'POST', path: '/v1/completions', desc: '文本补全（非对话）' },
  { method: 'POST', path: '/v1/embeddings', desc: '文本向量化' },
  { method: 'POST', path: '/v1/images/generations', desc: '图像生成' },
  { method: 'POST', path: '/v1/audio/speech', desc: '语音合成' },
  { method: 'POST', path: '/v1/rerank', desc: '结果重排序' },
  { method: 'POST', path: '/v1/messages', desc: 'Anthropic Messages 协议兼容入口' },
  { method: 'GET', path: '/v1/models', desc: '当前 Key 可调用的模型列表' },
  { method: 'GET', path: '/v1beta/models/*', desc: 'Gemini 原生协议入口' },
]

const notices = [
  '接入地址有两套，协议与鉴权完全一致：生产/测试走 API 网关（统一入口、统一审计），本地或网关未接入服务发现时直连 ai-relay。',
  '只支持 Authorization: Bearer sk-… 一种鉴权方式，网关与中继均不识别 x-api-key。',
  'Key 明文只在创建成功时展示一次，列表里只有脱敏值；忘了就只能删除重建。',
  '可调用的模型由 Key 所属分组决定（默认 default 分组），用 GET /v1/models 查询实际可用模型。',
  '禁用或删除 Key 后，使用该 Key 的调用立即失效。',
  '网关会剥离客户端自带的 X-User-* 身份头，无法通过请求头冒充他人身份。',
]

const statusCodes = [
  { code: '401', desc: '未提供 API Key，或 Key 无效' },
  { code: '403', desc: 'Key 已禁用 / 已过期 / 额度用尽，或模型不在该 Key 允许范围内' },
  { code: '404', desc: '模型不存在，或所属分组未开通该模型' },
  { code: '429', desc: '触发限流（RPM / TPM / 并发数）' },
  { code: '5xx', desc: '上游渠道异常或响应超时' },
]
</script>

<template>
  <AppShell>
    <template #default="{ openSidebar }">
      <header class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <Button variant="ghost" size="icon" class="md:hidden" @click="openSidebar">
          <Monitor class="size-4" />
        </Button>
        <Button variant="ghost" size="icon" title="返回我的密钥" @click="router.push('/client-settings/keys')">
          <ArrowLeft class="size-4" />
        </Button>
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-sm font-semibold">接入说明</h1>
          <p class="truncate text-xs text-muted-foreground">
            用 API Key 通过 OpenAI 兼容协议调用大模型网关
          </p>
        </div>
        <Button size="sm" class="gap-1.5" @click="router.push('/client-settings/keys')">
          <KeyRound class="size-4" />
          我的密钥
        </Button>
      </header>

      <div class="flex-1 overflow-y-auto p-4 md:p-6">
        <div class="mx-auto max-w-4xl space-y-5">
          <Alert>
            <AlertDescription class="text-xs">
              下面的示例默认用占位 Key
              <code class="rounded bg-muted px-1">sk-你的密钥</code>。
              在「我的密钥」里新建 Key 时，创建成功弹窗会直接给出带明文的可复制示例。
              若复制的地址请求不通，把接入地址切到「直连中继」再试。
            </AlertDescription>
          </Alert>

          <!-- 快速接入 -->
          <Card>
            <CardHeader class="pb-3">
              <CardTitle class="text-sm">快速接入</CardTitle>
              <CardDescription class="text-xs">
                任选一种你熟悉的方式，把网关地址与 Key 填进去即可调用
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ApiKeyQuickStart />
            </CardContent>
          </Card>

          <!-- 可用接口 -->
          <Card>
            <CardHeader class="pb-3">
              <CardTitle class="text-sm">可用接口</CardTitle>
              <CardDescription class="text-xs">
                均为 OpenAI 兼容协议，路径前缀统一为 /v1
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead class="w-16">方法</TableHead>
                    <TableHead class="w-56">路径</TableHead>
                    <TableHead>说明</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="item in endpoints" :key="item.path">
                    <TableCell class="font-mono text-xs">{{ item.method }}</TableCell>
                    <TableCell>
                      <code class="text-xs">{{ item.path }}</code>
                    </TableCell>
                    <TableCell class="text-xs text-muted-foreground">{{ item.desc }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <!-- 鉴权与安全 -->
          <Card>
            <CardHeader class="pb-3">
              <CardTitle class="text-sm">鉴权与安全</CardTitle>
            </CardHeader>
            <CardContent>
              <ul class="space-y-2">
                <li
                  v-for="(item, index) in notices"
                  :key="index"
                  class="flex gap-2 text-xs leading-relaxed text-muted-foreground"
                >
                  <span class="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                  <span>{{ item }}</span>
                </li>
              </ul>
            </CardContent>
          </Card>

          <!-- 常见状态码 -->
          <Card>
            <CardHeader class="pb-3">
              <CardTitle class="text-sm">常见状态码</CardTitle>
              <CardDescription class="text-xs">
                调用失败时先看状态码，响应体里通常带有具体的错误原因
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead class="w-20">状态码</TableHead>
                    <TableHead>含义</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="item in statusCodes" :key="item.code">
                    <TableCell class="font-mono text-xs">{{ item.code }}</TableCell>
                    <TableCell class="text-xs text-muted-foreground">{{ item.desc }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <!-- 关联入口 -->
          <Card class="border-dashed">
            <CardContent class="flex flex-wrap items-center justify-between gap-3 p-4">
              <p class="text-xs text-muted-foreground">想看这些 Key 产生了多少消耗？前往「用量明细」</p>
              <Button variant="outline" size="sm" @click="router.push('/client-settings/usage')">
                查看用量明细
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </template>
  </AppShell>
</template>
