<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { store } from './state/store'
import LandingView from './ui/LandingView.vue'
import StageView from './ui/StageView.vue'
import HelpOverlay from './ui/HelpOverlay.vue'
import { controller } from './engine/controller'

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  if (event.metaKey || event.ctrlKey) return

  switch (event.key) {
    case '?':
      store.ui.helpOpen = !store.ui.helpOpen
      break
    case 'Escape':
      store.ui.helpOpen = false
      store.ui.settingsOpen = false
      store.ui.authorsOpen = false
      break
    default:
      return
  }
  event.preventDefault()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  controller.detach()
})
</script>

<template>
  <div class="app">
    <LandingView v-if="store.view === 'landing'" />
    <StageView v-else />
    <HelpOverlay v-if="store.ui.helpOpen" @close="store.ui.helpOpen = false" />
  </div>
</template>

<style scoped>
.app {
  position: fixed;
  inset: 0;
  overflow: hidden;
}
</style>
