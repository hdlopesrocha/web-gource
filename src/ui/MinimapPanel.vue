<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { controller } from '../engine/controller'
import { store } from '../state/store'
import { Minimap } from '../render/minimap'

const canvas = ref<HTMLCanvasElement | null>(null)
const size = ref(168)
let minimap: Minimap | null = null
let timer: number | null = null

const repoName = computed(() =>
  store.repos.length > 1
    ? `${store.repos.length} repositories`
    : store.repo?.name ?? 'repository',
)

function render(): void {
  const simulation = controller.simulation
  if (!minimap || !simulation) return
  minimap.render(simulation, controller.cameraTarget)
}

function createMinimap(element: HTMLCanvasElement): void {
  try {
    minimap = new Minimap(element, { size: size.value, showCamera: true, showAuthors: true })
    render()
  } catch (error) {
    // A missing 2D context (or exhausted canvas memory) must not break the app.
    console.warn('Minimap unavailable:', (error as Error).message)
    minimap = null
  }
}

function start(): void {
  if (timer !== null) return
  timer = window.setInterval(() => {
    if (!document.hidden) render()
  }, 160)
}

onMounted(() => {
  if (!canvas.value) return
  createMinimap(canvas.value)
  start()
})

onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
  timer = null
  minimap = null
})

watch(canvas, (element) => {
  if (!element) return
  createMinimap(element)
  render()
})
</script>

<template>
  <div class="minimap panel">
    <div class="head">
      <span class="title">Overview</span>
      <span class="faint">{{ repoName }}</span>
    </div>
    <canvas ref="canvas" class="map" />
    <div class="legend">
      <span><i class="dot dir" /> directories</span>
      <span><i class="dot file" /> files</span>
      <span><i class="dot author" /> authors</span>
    </div>
  </div>
</template>

<style scoped>
.minimap {
  position: absolute;
  right: 12px;
  bottom: 118px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 5;
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
}

.title {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-faint);
}

.map {
  display: block;
  border-radius: var(--radius-sm);
  border: 1px solid var(--panel-border);
}

.legend {
  display: flex;
  gap: 10px;
  font-size: 10px;
  color: var(--text-faint);
}

.legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  display: inline-block;
}

.dot.dir {
  background: rgba(120, 170, 235, 0.75);
}

.dot.file {
  background: rgba(255, 235, 180, 0.85);
}

.dot.author {
  background: #ffffff;
  border-radius: 50%;
}

@media (max-width: 860px) {
  .minimap {
    display: none;
  }
}
</style>
