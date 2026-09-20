<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ImagePlus, Trash2 } from 'lucide-vue-next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { toast } from 'vue-sonner'
import { deletePetAvatar, getSettings, saveSettings, toggleFullscreen, uploadPetAvatar } from '@/api/client'

/** 设置 → 桌面与快捷键 */
const petCfg = ref({ enabled: false, scale: 1, opacity: 1, notify: true, character: 'cat' })
const shortcut = ref('Shift+Alt+W')
const petInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
/** 纯 node / Web 模式没有桌面窗口，宠物开了也不会出现——得如实说明，别让用户以为坏了 */
const petAvailable = ref(true)

/** 照片形象只存本机；上传后 character 自动切到照片 */
async function onPetPhoto(e: Event) {
  const el = e.target as HTMLInputElement
  const f = el.files?.[0]
  el.value = ''
  if (!f) return
  uploading.value = true
  try {
    await uploadPetAvatar(f)
    petCfg.value.character = 'photo'
    await patch({ pet: petCfg.value })
    toast.success('宠物形象已更新')
  } catch (err) {
    toast.error('上传失败：' + (err as Error).message)
  } finally {
    uploading.value = false
  }
}

async function removePetPhoto() {
  try {
    await deletePetAvatar()
    petCfg.value.character = 'cat'
    await patch({ pet: petCfg.value })
    toast.success('已恢复内置形象')
  } catch (err) {
    toast.error('删除失败：' + (err as Error).message)
  }
}

async function patch(p: Record<string, unknown>) {
  try {
    await saveSettings(p)
    toast.success('已保存')
  } catch (e) {
    toast.error('保存失败：' + (e as Error).message)
  }
}

async function handleFullscreen() {
  try {
    await toggleFullscreen()
  } catch (e) {
    toast.error('切换失败：' + (e as Error).message)
  }
}

onMounted(async () => {
  try {
    const s = await getSettings()
    const pet = (s?.pet || {}) as Record<string, unknown>
    petCfg.value = {
      enabled: pet.enabled === true,
      scale: Number(pet.scale) || 1,
      opacity: Number(pet.opacity) || 1,
      notify: pet.notify !== false,
      character: String(pet.character || 'cat'),
    }
    const sc = (s?.shortcuts || {}) as Record<string, string>
    shortcut.value = String(sc['toggle-window'] || 'Shift+Alt+W')
    // available=false（纯 node / 网页版）时宠物根本没有宿主窗口
    petAvailable.value = pet.available === undefined ? true : pet.available === true
  } catch {
    /* 读不到用默认 */
  }
})
</script>

<template>
  <div class="space-y-3">
    <div
      v-if="!petAvailable"
      class="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-500"
    >
      当前是纯服务端 / 网页模式，没有桌面窗口，桌面宠物无法显示。用桌面客户端打开才能看到它。
    </div>

    <div class="rounded-xl border border-border bg-background px-5 py-4" :class="!petAvailable && 'opacity-60'">
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium">桌面宠物</p>
          <p class="mt-0.5 text-[13px] text-muted-foreground">
            独立小窗，任务完成 / 需要审批时提醒你。{{ petAvailable ? '' : '（当前环境不可用）' }}
          </p>
        </div>
        <input
          v-model="petCfg.enabled"
          type="checkbox"
          class="size-4 accent-primary"
          :disabled="!petAvailable"
          @change="patch({ pet: petCfg })"
        />
      </div>
      <div class="mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <div class="space-y-2">
          <Label class="text-[13px]">缩放（{{ petCfg.scale }}x）</Label>
          <Input v-model.number="petCfg.scale" type="number" step="0.1" min="0.6" max="3" class="h-8" :disabled="!petAvailable" @change="patch({ pet: petCfg })" />
        </div>
        <div class="space-y-2">
          <Label class="text-[13px]">不透明度（{{ petCfg.opacity }}）</Label>
          <Input v-model.number="petCfg.opacity" type="number" step="0.05" min="0.25" max="1" class="h-8" :disabled="!petAvailable" @change="patch({ pet: petCfg })" />
        </div>
        <div class="space-y-2 sm:col-span-2">
          <Label class="text-[13px]">形象</Label>
          <div class="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              class="h-8 gap-1.5"
              :class="petCfg.character === 'cat' ? 'border-primary text-primary' : ''"
              @click="petCfg.character = 'cat'; patch({ pet: petCfg })"
            >
              内置猫
            </Button>
            <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="uploading" @click="petInput?.click()">
              <ImagePlus class="size-3.5" /> {{ uploading ? '上传中…' : '上传照片' }}
            </Button>
            <Button
              v-if="petCfg.character === 'photo'"
              variant="ghost"
              size="sm"
              class="h-8 gap-1.5 text-destructive"
              @click="removePetPhoto"
            >
              <Trash2 class="size-3.5" /> 删除照片
            </Button>
            <input ref="petInput" type="file" accept="image/*" class="hidden" @change="onPetPhoto">
            <p class="w-full text-[13px] text-muted-foreground">照片只存本机；说「把这张图做成桌面宠物」并传图，也能现场生成。</p>
          </div>
        </div>
      </div>
    </div>

    <div class="rounded-xl border border-border bg-background px-5 py-4">
      <p class="text-sm font-medium">全局快捷键</p>
      <p class="mt-0.5 text-[13px] text-muted-foreground">应用未聚焦也能唤起 / 隐藏主窗口。</p>
      <div class="mt-3 flex gap-2">
        <Input v-model="shortcut" class="h-8" placeholder="Shift+Alt+W" />
        <Button size="sm" class="h-8" @click="patch({ shortcuts: { 'toggle-window': shortcut } })">保存</Button>
      </div>
      <Button variant="outline" size="sm" class="mt-3" @click="handleFullscreen">切换全屏</Button>
    </div>
  </div>
</template>
