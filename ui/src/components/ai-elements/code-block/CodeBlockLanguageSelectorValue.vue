<script setup lang="ts">
import { SelectValue } from '@/components/ui/select'

type CodeBlockLanguageSelectorValueProps = InstanceType<typeof SelectValue>['$props']

interface Props extends /* @vue-ignore */ CodeBlockLanguageSelectorValueProps {}

const props = defineProps<Props>()
</script>

<template>
  <SelectValue v-bind="{ ...props, ...$attrs }">
    <slot />
  </SelectValue>
</template>
