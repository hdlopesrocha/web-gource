<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { controller } from '../engine/controller'
import { store } from '../state/store'
import PlaybackBar from './PlaybackBar.vue'
import InfoOverlay from './InfoOverlay.vue'
import SettingsPanel from './SettingsPanel.vue'
import AuthorsPanel from './AuthorsPanel.vue'
import MinimapPanel from './MinimapPanel.vue'
import { loadingPercent } from '../state/store'

const canvas = ref<HTMLCanvasElement | null>(null)
const container = ref<HTMLDivElement | null>(null)
const warningsOpen = ref(false)
const fullscreen = ref(false)

const repo = computed(() => store.repo)
const stats = computed(() => store.timelineStats)
const loading = computed(() => store.loading)
const warnings = computed(() => store.warnings)

const summary = computed(() => {
  if (!stats.value) return ''
  const parts = [
    `${stats.value.commits.toLocaleString()} commits`,
    `${stats.value.authors.toLocaleString()} authors`,
    `${stats.value.files.toLocaleString()} files`,
  ]
  if (stats.value.merges > 0) parts.push(`${stats.value.merges} merges`)
  if (stats.value.withoutFileData > 0) parts.push(`${stats.value.withoutFileData} without file data`)
  if (stats.value.ignoredFiles) parts.push(`${stats.value.ignoredFiles} ignored files`)
  return parts.join(' · ')
})

function toggleFullscreen(): void {
  if (!document.fullscreenElement) {
    void document.documentElement.requestFullscreen().then(() => (fullscreen.value = true)).catch(() => undefined)
  } else {
    void document.exitFullscreen().then(() => (fullscreen.value = false)).catch(() => undefined)
  }
}

function onFullscreenChange(): void {
  fullscreen.value = Boolean(document.fullscreenElement)
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  if (event.metaKey || event.ctrlKey || event.altKey) return

  const speedSteps = [0.25, 0.5, 1, 2, 4, 8, 16, 32]
  const currentSpeed = store.hud?.speed ?? 1

  switch (event.key) {
    case ' ':
      controller.togglePlay()
      break
    case 'ArrowLeft':
      if (event.shiftKey) controller.seek((store.hud?.time ?? 0) - 5)
      else controller.step(-1)
      break
    case 'ArrowRight':
      if (event.shiftKey) controller.seek((store.hud?.time ?? 0) + 5)
      else controller.step(1)
      break
    case 'Home':
      controller.seekToIndex(0)
      break
    case 'End':
      controller.seek(store.hud?.duration ?? 0)
      break
    case '+':
    case '=': {
      const next = speedSteps.find((value) => value > currentSpeed + 0.001) ?? speedSteps[speedSteps.length - 1]
      controller.setSpeed(next)
      break
    }
    case '-':
    case '_': {
      const previous = [...speedSteps].reverse().find((value) => value < currentSpeed - 0.001) ?? speedSteps[0]
      controller.setSpeed(previous)
      break
    }
    case 'r':
    case 'R':
      controller.restart()
      break
    case 'c':
    case 'C':
      controller.resetCamera()
      break
    case 'l':
    case 'L':
      controller.updateSettings({ showLabels: !store.settings.showLabels })
      break
    case 'm':
    case 'M':
      store.ui.minimapVisible = !store.ui.minimapVisible
      break
    case 'a':
    case 'A':
      store.ui.authorsOpen = !store.ui.authorsOpen
      break
    case 's':
    case 'S':
      store.ui.settingsOpen = !store.ui.settingsOpen
      break
    case 'f':
    case 'F':
      toggleFullscreen()
      break
    default:
      return
  }
  event.preventDefault()
}

watch(canvas, (element) => {
  if (element && container.value) controller.attach(element, container.value)
})

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  if (canvas.value && container.value) controller.attach(canvas.value, container.value)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  // Release the renderer and the canvas reference; a future mount re-attaches.
  controller.detach()
})
</script>

<template>
  <div class="stage">
    <div ref="container" class="viewport">
      <canvas ref="canvas" class="scene" />
      <div class="vignette" aria-hidden="true" />
    </div>

    <header class="topbar panel">
      <button class="btn ghost small" type="button" title="Load another repository" @click="controller.backToLanding()">
        ← Repository
      </button>
      <div class="repo-info">
        <div class="repo-name">
          <strong>{{ repo?.fullName ?? 'Repository' }}</strong>
          <span class="badge">{{ repo?.provider ?? '—' }}</span>
          <span v-if="store.timelineTruncated" class="badge warn" title="Only part of the history is loaded">partial history</span>
        </div>
        <span class="repo-summary muted">{{ summary }}</span>
      </div>
      <div class="topbar-actions">
        <button
          v-if="store.recording.active"
          class="btn small danger"
          type="button"
          @click="controller.stopRecording()"
        >
          <span class="rec-dot" /> Stop recording
        </button>
        <button class="btn ghost small" type="button" title="Authors (A)" @click="store.ui.authorsOpen = !store.ui.authorsOpen">
          Authors
        </button>
        <button
          class="btn ghost small"
          :class="{ active: store.ui.minimapVisible }"
          type="button"
          title="Minimap (M)"
          @click="store.ui.minimapVisible = !store.ui.minimapVisible"
        >
          Map
        </button>
        <button class="btn ghost small" type="button" title="Settings (S)" @click="store.ui.settingsOpen = !store.ui.settingsOpen">
          Settings
        </button>
        <button class="btn ghost small" type="button" title="Help (?)" @click="store.ui.helpOpen = true">?</button>
        <button class="btn ghost small" type="button" title="Fullscreen (F)" @click="toggleFullscreen">
          {{ fullscreen ? '⤡' : '⛶' }}
        </button>
      </div>
    </header>

    <div v-if="loading.active || loading.streaming" class="loading-strip panel">
      <div class="strip-row">
        <span class="spinner" />
        <span class="grow">{{ loading.status }}</span>
        <span class="muted mono">
          {{ loading.loaded }}/{{ loading.target }} commits · {{ loading.requests }} requests
          <template v-if="loading.rateRemaining !== undefined">· {{ loading.rateRemaining }} left</template>
        </span>
        <button class="btn ghost small" type="button" @click="controller.cancelLoad()">Stop</button>
      </div>
      <div class="bar"><div class="bar-fill" :style="{ width: `${Math.max(3, loadingPercent)}%` }" /></div>
    </div>

    <div v-if="warnings.length > 0 && !loading.active" class="warnings panel">
      <button class="warn-head" type="button" @click="warningsOpen = !warningsOpen">
        <span class="warn-icon">!</span>
        <span class="grow">{{ warnings.length }} note{{ warnings.length === 1 ? '' : 's' }} about this load</span>
        <span class="faint">{{ warningsOpen ? '▲' : '▼' }}</span>
      </button>
      <ul v-if="warningsOpen" class="warn-list scroll">
        <li v-for="warning in warnings" :key="warning">{{ warning }}</li>
      </ul>
    </div>

    <div v-if="loading.error && !loading.active" class="error-banner panel">
      <span class="warn-icon">!</span>
      <div class="grow">
        <strong>Loading stopped</strong>
        <p class="faint">{{ loading.error }}</p>
      </div>
      <button class="btn small" type="button" @click="controller.backToLanding()">Load another repository</button>
      <button class="btn ghost small" type="button" title="Dismiss" @click="loading.error = null">✕</button>
    </div>

    <InfoOverlay />

    <MinimapPanel v-if="store.ui.minimapVisible" />

    <PlaybackBar />

    <AuthorsPanel v-if="store.ui.authorsOpen" @close="store.ui.authorsOpen = false" />
    <SettingsPanel v-if="store.ui.settingsOpen" @close="store.ui.settingsOpen = false" />

    <Transition name="fade">
      <div v-if="store.recording.active" class="recording-overlay">
        <div class="rec-pill panel">
          <span class="rec-dot" />
          <span>Recording {{ store.recording.width }}×{{ store.recording.height }} @ {{ store.recording.fps }}fps</span>
          <span class="mono muted">
            {{ store.recording.progress?.percent.toFixed(0) ?? 0 }}% ·
            {{ ((store.recording.progress?.elapsed ?? 0)).toFixed(0) }}s
          </span>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.viewport {
  position: absolute;
  inset: 0;
  background: #04060c;
}

.scene {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  touch-action: none;
  cursor: grab;
}

.scene:active {
  cursor: grabbing;
}

.vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(circle at 50% 50%, transparent 55%, rgba(0, 0, 0, 0.55) 100%);
}

.topbar {
  position: absolute;
  top: 12px;
  left: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 12px;
  z-index: 6;
}

.repo-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.repo-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  min-width: 0;
}

.repo-name strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-summary {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.rec-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #ff5d6c;
  box-shadow: 0 0 10px rgba(255, 93, 108, 0.9);
  animation: pulse 1.2s ease-in-out infinite;
  flex: none;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.loading-strip {
  position: absolute;
  top: 68px;
  left: 50%;
  transform: translateX(-50%);
  width: min(620px, calc(100vw - 32px));
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 7;
}

.strip-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}

.bar {
  height: 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #2f7de0, #6ad6ff);
  transition: width 0.25s ease;
}

.warnings {
  position: absolute;
  top: 118px;
  left: 50%;
  transform: translateX(-50%);
  width: min(620px, calc(100vw - 32px));
  z-index: 6;
  font-size: 12.5px;
  overflow: hidden;
}

.warn-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  color: var(--text-dim);
  text-align: left;
}

.warn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(255, 200, 87, 0.16);
  color: var(--modify);
  font-weight: 700;
  font-size: 12px;
  flex: none;
}

.warn-list {
  margin: 0;
  padding: 0 16px 12px 40px;
  max-height: 220px;
  color: var(--text-dim);
}

.warn-list li {
  margin-bottom: 6px;
}

.recording-overlay {
  position: absolute;
  top: 68px;
  right: 12px;
  z-index: 8;
}

.error-banner {
  position: absolute;
  top: 68px;
  left: 50%;
  transform: translateX(-50%);
  width: min(680px, calc(100vw - 32px));
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  z-index: 8;
  background: rgba(38, 12, 18, 0.86);
  border-color: rgba(255, 93, 108, 0.4);
}

.error-banner strong {
  font-size: 13px;
}

.error-banner p {
  margin: 2px 0 0;
  font-size: 12px;
}

.rec-pill {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  font-size: 12.5px;
}

@media (max-width: 860px) {
  .repo-summary {
    display: none;
  }

  .topbar-actions .btn {
    padding: 6px 8px;
  }
}
</style>
