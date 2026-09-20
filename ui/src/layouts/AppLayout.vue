<script setup lang="ts">
/**
 * 旧布局已被 AppShell 取代（AppShell 提供移动端抽屉式侧栏）。
 * 保留此文件仅为兼容，透传插槽参数（openSidebar）即可。
 */
import AppShell from './AppShell.vue'
</script>

<template>
  <AppShell>
    <template #default="slotProps">
      <slot v-bind="slotProps ?? {}" />
    </template>
  </AppShell>
</template>
