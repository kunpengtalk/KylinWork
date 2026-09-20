<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { BookOpen, Copy, KeyRound, Plus, Trash2 } from 'lucide-vue-next'
import ApiKeyQuickStart from '@/components/ApiKeyQuickStart.vue'
import { copyText } from '@/lib/clipboard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'vue-sonner'
import {
  accountQuota,
  apiKeyStats,
  createApiKey,
  deleteApiKey,
  listApiKeys,
  updateApiKeyStatus,
} from '@/api/key'
import type { AccountQuota, ApiKeyVO, KeyStats } from '@/api/key'
import LoginGate from '@/components/LoginGate.vue'

/**
 * 我的密钥。
 * <p>
 * Key 由 ai-relay 管理并通过渠道分组（默认 default）决定可用模型，本页只做自助管理。
 * 明文仅在创建时显示一次，列表一律脱敏。
 */
const router = useRouter()

const keys = ref<ApiKeyVO[]>([])
const stats = ref<KeyStats | null>(null)
/** 账户月度额度（人民币）：账户下所有 Key 共享这一份额度 */
const quota = ref<AccountQuota | null>(null)
const loading = ref(false)
const error = ref('')

const createOpen = ref(false)
const createName = ref('')
const creating = ref(false)
/** 创建成功后的一次性明文 */
const createdKey = ref<ApiKeyVO | null>(null)

onMounted(load)

async function load() {
  loading.value = true
  error.value = ''
  try {
    // 额度接口失败不应阻断 Key 列表：额度只是附加展示信息
    const [list, st, q] = await Promise.all([
      listApiKeys(),
      apiKeyStats(),
      accountQuota().catch(() => null),
    ])
    keys.value = list
    stats.value = st
    quota.value = q
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function submitCreate() {
  creating.value = true
  try {
    const created = await createApiKey(createName.value || undefined)
    createdKey.value = created
    createOpen.value = false
    createName.value = ''
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

async function toggleStatus(key: ApiKeyVO) {
  try {
    await updateApiKeyStatus(key.id, key.status === 1 ? 2 : 1)
    await load()
    toast.success(key.status === 1 ? '已禁用' : '已启用')
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function remove(key: ApiKeyVO) {
  if (!confirm(`确认删除 Key「${key.name}」？删除后使用该 Key 的调用将立即失效。`)) return
  try {
    await deleteApiKey(key.id)
    await load()
    toast.success('已删除')
  } catch (e) {
    toast.error((e as Error).message)
  }
}

function copyKey() {
  const text = createdKey.value?.key
  if (text) void copyText(text, 'Key 已复制到剪贴板')
}

/** 从创建成功弹窗跳到接入说明页（跳转前先收起弹窗，明文不再保留） */
function goGuide() {
  createdKey.value = null
  void router.push('/profile/keys/guide')
}

function formatTime(seconds: number | null) {
  if (!seconds) return '—'
  return new Date(seconds * 1000).toLocaleString('zh-CN')
}

/** 1 积分 = 0.01 元；把人民币额度换算成积分显示 */
function yuanToPoints(yuan: number | null | undefined): number {
  return Math.round(Number(yuan ?? 0) * 100)
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
      <LoginGate>
      <div class="settings-pane mx-auto w-full max-w-5xl px-10 py-8">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 class="text-[22px] font-semibold tracking-tight">我的密钥</h1>
            <p class="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">
              用于以你的身份调用模型中继，默认归属 default 分组
            </p>
          </div>
          <div class="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" class="gap-1.5" @click="router.push('/profile/keys/guide')">
              <BookOpen class="size-4" />
              接入说明
            </Button>
            <Button size="sm" class="gap-1.5" @click="createOpen = true">
              <Plus class="size-4" />
              创建 Key
            </Button>
          </div>
        </div>

        <div class="mt-6 space-y-5">
          <div
            v-if="error"
            class="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            {{ error }}
          </div>

          <!-- 统计 -->
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card v-if="stats">
              <CardHeader class="pb-1">
                <CardDescription class="text-xs">我的 Key</CardDescription>
                <CardTitle class="text-2xl">{{ stats.total }}</CardTitle>
              </CardHeader>
            </Card>
            <Card v-if="stats">
              <CardHeader class="pb-1">
                <CardDescription class="text-xs">启用中</CardDescription>
                <CardTitle class="text-2xl">{{ stats.active }}</CardTitle>
              </CardHeader>
            </Card>
            <Card v-if="quota">
              <CardHeader class="pb-1">
                <CardDescription class="text-xs">账户余额（积分）</CardDescription>
                <CardTitle class="text-2xl">
                  {{ yuanToPoints(quota.remainQuota) }}
                  <span class="text-sm text-muted-foreground">积分</span>
                </CardTitle>
                <p class="pt-1 text-xs text-muted-foreground">
                  余额 ≈ ¥{{ quota.remainQuota }}，1 积分 = 0.01 元；本月额度
                  {{ yuanToPoints(quota.monthlyQuota) }} 积分，已用 {{ yuanToPoints(quota.usedQuota) }} 积分
                </p>
              </CardHeader>
            </Card>
            <Card v-if="stats">
              <CardHeader class="pb-1">
                <CardDescription class="text-xs">Key 剩余点数</CardDescription>
                <CardTitle class="text-2xl">{{ stats.remainQuota }}</CardTitle>
                <p class="pt-1 text-xs text-muted-foreground">旧口径点数，仅供参考</p>
              </CardHeader>
            </Card>
            <Skeleton v-for="i in loading ? 4 : 0" :key="i" class="h-24 w-full" />
          </div>

          <p v-if="quota" class="text-xs leading-relaxed text-muted-foreground">
            账期 {{ quota.periodStart }} ~ {{ quota.periodEnd }}，{{ quota.nextGrantDate }} 自动发放下一期。
            每月发放 200 积分（≈¥2），额度挂在账户上，本账户下的所有 Key 共享这一余额。
          </p>

          <!-- 列表 -->
          <Card>
            <CardHeader class="pb-3">
              <CardTitle class="text-sm">密钥列表</CardTitle>
              <CardDescription class="text-xs">
                明文仅在创建时显示一次，请妥善保存；列表只展示脱敏后的值
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div v-if="loading" class="space-y-2">
                <Skeleton v-for="i in 3" :key="i" class="h-14 w-full" />
              </div>

              <div
                v-else-if="!keys.length"
                class="flex flex-col items-center justify-center gap-2 py-12 text-center"
              >
                <KeyRound class="size-8 text-muted-foreground/50" />
                <p class="text-sm text-muted-foreground">还没有 Key，点击右上角创建</p>
              </div>

              <ul v-else class="divide-y divide-border">
                <li
                  v-for="key in keys"
                  :key="key.id"
                  class="flex flex-wrap items-center gap-3 py-3"
                >
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="text-sm font-medium">{{ key.name }}</span>
                      <Badge :variant="key.status === 1 ? 'default' : 'secondary'" class="font-normal">
                        {{ key.status === 1 ? '启用' : '禁用' }}
                      </Badge>
                      <Badge variant="outline" class="font-normal">{{ key.group }}</Badge>
                    </div>
                    <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <code>{{ key.maskedKey }}</code>
                      <span>剩余 {{ key.remainQuota ?? '不限' }}</span>
                      <span>已用 {{ key.usedQuota ?? 0 }}</span>
                      <span>{{ formatTime(key.createdTime) }}</span>
                    </div>
                  </div>

                  <div class="flex shrink-0 gap-1.5">
                    <Button variant="outline" size="sm" @click="toggleStatus(key)">
                      {{ key.status === 1 ? '禁用' : '启用' }}
                    </Button>
                    <Button variant="ghost" size="icon" @click="remove(key)">
                      <Trash2 class="size-4 text-destructive" />
                    </Button>
                  </div>
                </li>
              </ul>
            </CardContent>
          </Card>

          <!-- 接入说明 / 用量明细入口 -->
          <Card class="border-dashed">
            <CardContent class="flex flex-wrap items-center justify-between gap-3 p-4">
              <p class="text-xs text-muted-foreground">
                不知道怎么调用？查看接入示例；想看消耗，前往用量明细
              </p>
              <div class="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" @click="router.push('/profile/keys/guide')">
                  接入说明
                </Button>
                <Button variant="outline" size="sm" @click="router.push('/client-settings/usage')">
                  用量明细
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <!-- 创建对话框 -->
      <Dialog v-model:open="createOpen">
        <DialogContent class="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>创建 API Key</DialogTitle>
            <DialogDescription>默认归属 default 分组，可调用该分组下的全部模型</DialogDescription>
          </DialogHeader>
          <div class="space-y-2 py-2">
            <Label for="keyName">名称</Label>
            <Input id="keyName" v-model="createName" placeholder="例如：本地调试" />
          </div>
          <DialogFooter>
            <Button variant="outline" @click="createOpen = false">取消</Button>
            <Button :disabled="creating" @click="submitCreate">
              {{ creating ? '创建中…' : '创建' }}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <!-- 明文 + 接入说明（创建成功后只出现这一次） -->
      <Dialog
        :open="!!createdKey"
        @update:open="(v: boolean) => { if (!v) createdKey = null }"
      >
        <DialogContent class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Key 已创建</DialogTitle>
            <DialogDescription>
              明文仅出现这一次，请立即保存；下面是可直接复制使用的接入示例
            </DialogDescription>
          </DialogHeader>

          <div class="space-y-4">
            <div class="rounded-md border border-border bg-muted/40 p-3">
              <code class="break-all text-xs">{{ createdKey?.key }}</code>
            </div>
            <ApiKeyQuickStart :api-key="createdKey?.key" show-more @more="goGuide" />
          </div>

          <DialogFooter>
            <Button class="gap-1.5" @click="copyKey">
              <Copy class="size-4" />
              复制 Key
            </Button>
            <Button variant="outline" @click="createdKey = null">我已保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LoginGate>
  </div>
</template>
