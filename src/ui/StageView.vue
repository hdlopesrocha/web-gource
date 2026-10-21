<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { controller } from '../engine/controller'
import { store } from '../state/store'
import PlaybackBar from './PlaybackBar.vue'
import InfoOverlay from './InfoOverlay.vue'
import SettingsPanel from './SettingsPanel.vue'
import ActivityPanel from './ActivityPanel.vue'
import AuthorsPanel from './AuthorsPanel.vue'
import MinimapPanel from './MinimapPanel.vue'
import { loadingPercent } from '../state/store'
import { EXPORT_FPS } from '../engine/export/frames'
import { PLAYBACK_SPEEDS } from '../engine/speeds'
import { isXrSupported } from '../render/xr'

const canvas = ref<HTMLCanvasElement | null>(null)
const container = ref<HTMLDivElement | null>(null)
const warningsOpen = ref(false)
const fullscreen = ref(false)

const repo = computed(() => store.repo)
const repos = computed(() => store.repos)
const stats = computed(() => store.timelineStats)
const loading = computed(() => store.loading)
const warnings = computed(() => store.warnings)
const exportFps = EXPORT_FPS
/** The recording follows the playback speed, so show what that is right now. */
const speedLabel = computed(() => store.hud?.speed ?? 1)

const multiProject = computed(() => repos.value.length > 1)
const repoLabel = computed(() => {
  if (multiProject.value) return `${repos.value.length} repositories`
  return repo.value?.fullName ?? 'Repository'
})
const repoTitle = computed(() => repos.value.map((entry) => entry.fullName).join('\n') || 'Repository')
const providers = computed(() => [...new Set(repos.value.map((entry) => entry.provider))])

/**
 * Why the VR button is (un)available. The button stays visible but disabled when
 * the browser exposes no immersive device, so the feature is discoverable.
 */
const vrTitle = computed(() => {
  if (!store.ui.xrSupported) return 'Immersive VR needs a WebXR headset and a browser that supports it (Chrome/Edge on desktop, or a standalone headset browser)'
  return store.ui.xrActive ? 'Leave the immersive VR session' : 'View the scene in VR (WebXR)'
})

const summary = computed(() => {
  if (!stats.value) return ''
  const parts = [
    ...(multiProject.value ? [`${repos.value.length} projects`] : []),
    `${stats.value.commits.toLocaleString()} commits`,
    `${stats.value.authors.toLocaleString()} ${multiProject.value ? 'author instances' : 'authors'}`,
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

  const speedSteps = PLAYBACK_SPEEDS
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
      if (store.ui.settingsOpen) store.ui.activityOpen = false
      break
    case 'h':
    case 'H':
      store.ui.activityOpen = !store.ui.activityOpen
      if (store.ui.activityOpen) store.ui.settingsOpen = false
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

/**
 * A tap on the scene (as opposed to a drag) recalibrates the head tracking:
 * the current device pose becomes the reference and the view does not move.
 */
const TAP_SLOP = 6
let tapStart: { x: number; y: number; pointerId: number } | null = null

function onViewportPointerDown(event: PointerEvent): void {
  tapStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
}

function onViewportPointerUp(event: PointerEvent): void {
  const start = tapStart
  tapStart = null
  if (!start || start.pointerId !== event.pointerId) return
  if (!store.settings.gyro || !store.ui.gyroActive) return
  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP) return
  controller.recalibrateOrientation()
}

watch(canvas, (element) => {
  if (element && container.value) controller.attach(element, container.value)
})
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  if (canvas.value && container.value) controller.attach(canvas.value, container.value)
  // Detected once per mount: the answer does not change while the page lives.
  void isXrSupported().then((supported) => {
    store.ui.xrSupported = supported
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  // Release the renderer and the canvas reference; a future mount re-attaches.
  controller.detach()
})
</script>

<template>
  <div class="stage" :class="{ 'recording-active': store.recording.active }">
    <div ref="container" class="viewport" @pointerdown="onViewportPointerDown" @pointerup="onViewportPointerUp">
      <canvas ref="canvas" class="scene" />
      <div class="vignette" aria-hidden="true" />
      <div v-if="store.ui.gyroActive || store.ui.gamepadConnected" class="controls-hint panel">
        <template v-if="store.ui.gyroActive">Head tracking · click to recalibrate</template>
        <template v-else>Gamepad connected</template>
      </div>
    </div>

    <div class="top-stack">
      <header class="topbar panel">
        <button class="btn ghost small back" type="button" title="Load repositories" @click="controller.backToLanding()">
          ← {{ multiProject ? 'Repositories' : 'Repository' }}
        </button>
        <div class="repo-info">
          <div class="repo-name" :title="repoTitle">
            <strong>{{ repoLabel }}</strong>
            <span v-for="provider in providers" :key="provider" class="badge">{{ provider }}</span>
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
          <button
            class="btn ghost small"
            :class="{ active: store.ui.activityOpen }"
            type="button"
            title="Commit activity heatmaps (H)"
            @click="store.ui.activityOpen = !store.ui.activityOpen; if (store.ui.activityOpen) store.ui.settingsOpen = false"
          >
            Activity
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
          <button
            class="btn ghost small"
            :class="{ active: store.ui.xrActive }"
            type="button"
            :disabled="!store.ui.xrSupported"
            :title="vrTitle"
            @click="controller.toggleVr()"
          >
            {{ store.ui.xrActive ? 'Exit VR' : 'VR' }}
          </button>
          <button
            class="btn ghost small"
            type="button"
            title="Reset the 3D camera view (C)"
            @click="controller.resetCamera()"
          >
            Reset
          </button>
          <button
            class="btn ghost small"
            type="button"
            title="Settings (S)"
            @click="store.ui.settingsOpen = !store.ui.settingsOpen; if (store.ui.settingsOpen) store.ui.activityOpen = false"
          >
            Settings
          </button>
          <button class="btn ghost small" type="button" title="Help (?)" @click="store.ui.helpOpen = true">?</button>
          <button class="btn ghost small" type="button" title="Fullscreen (F)" @click="toggleFullscreen">
            {{ fullscreen ? '⤡' : '⛶' }}
          </button>
        </div>
      </header>

      <div class="notices">
        <div v-if="loading.active || loading.streaming" class="loading-strip panel">
          <div class="strip-row">
            <span class="spinner" />
            <span class="grow">{{ loading.status }}</span>
            <span class="muted mono strip-meta">
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

        <div v-if="store.ui.xrError" class="xr-error panel">
          <span class="warn-icon">!</span>
          <span class="grow">{{ store.ui.xrError }}</span>
          <button class="btn ghost small" type="button" title="Dismiss" @click="store.ui.xrError = null">✕</button>
        </div>
      </div>
    </div>

    <InfoOverlay />

    <MinimapPanel v-if="store.ui.minimapVisible" />

    <PlaybackBar />

    <AuthorsPanel v-if="store.ui.authorsOpen" @close="store.ui.authorsOpen = false" />
    <SettingsPanel v-if="store.ui.settingsOpen" @close="store.ui.settingsOpen = false" />
    <ActivityPanel v-if="store.ui.activityOpen" @close="store.ui.activityOpen = false" />

    <Transition name="fade">
      <div v-if="store.recording.active" class="recording-overlay">
        <div class="rec-pill panel">
          <span class="rec-dot" />
          <span>Recording {{ store.recording.width }}×{{ store.recording.height }} @ {{ exportFps }}fps · {{ speedLabel }}×</span>
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

/*
 * On desktop the topbar and notices keep their individual absolute positions;
 * on phones the wrappers become one column so notices always sit below the
 * topbar regardless of how many action rows it needs (see the media query).
 */
.top-stack,
.notices {
  display: contents;
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

/* Live camera-control status: gamepad connected, or head tracking on. */
.controls-hint {
  position: absolute;
  left: 12px;
  bottom: 12px;
  padding: 5px 10px;
  font-size: 11.5px;
  color: var(--text-dim);
  pointer-events: none;
  z-index: 8;
}

.xr-error {
  position: absolute;
  top: 68px;
  right: 12px;
  width: min(420px, calc(100vw - 32px));
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  font-size: 12.5px;
  z-index: 9;
}

.topbar-actions .btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
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

/*
 * Phones: two topbar rows (identity, then actions), and every transient notice
 * stacked below the bar instead of floating over it.
 */
@media (max-width: 760px), (max-width: 949px) and (max-height: 480px) {
  .stage {
    height: 100dvh;
  }

  .top-stack {
    position: absolute;
    top: calc(var(--safe-top) + 8px);
    left: calc(var(--safe-left) + 8px);
    right: calc(var(--safe-right) + 8px);
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: calc(100dvh - var(--safe-top) - var(--stage-playback-offset) - 8px);
    z-index: 7;
    pointer-events: none;
  }

  .topbar {
    position: relative;
    top: auto;
    left: auto;
    right: auto;
    flex: none;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 6px 8px;
    padding: 8px 10px;
    pointer-events: auto;
  }

  .topbar > .back {
    grid-column: 1;
  }

  .repo-info {
    grid-column: 2;
    min-width: 0;
  }

  .repo-name {
    gap: 6px;
    font-size: 13px;
  }

  .repo-summary {
    display: none;
  }

  .topbar-actions {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .topbar-actions::-webkit-scrollbar {
    display: none;
  }

  .topbar-actions .btn {
    flex: none;
    min-height: 32px;
    padding: 5px 9px;
  }

  /* One stack below the topbar, never under the playback bar. */
  .notices {
    position: static;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
    overflow-y: auto;
    pointer-events: none;
  }

  .notices > * {
    position: static;
    top: auto;
    right: auto;
    left: auto;
    width: 100%;
    max-width: none;
    transform: none;
    pointer-events: auto;
  }

  .strip-row {
    flex-wrap: wrap;
    gap: 6px 8px;
    font-size: 12px;
  }

  .strip-row .grow {
    flex: 1 1 120px;
    min-width: 0;
  }

  .strip-row .btn {
    order: 2;
  }

  .strip-meta {
    order: 3;
    flex: 1 1 100%;
    line-height: 1.35;
  }

  .warn-list {
    max-height: 26dvh;
  }

  .error-banner {
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px;
  }

  .error-banner .grow {
    flex: 1 1 calc(100% - 32px);
  }

  .error-banner .btn:not(.ghost) {
    flex: 1 1 auto;
  }

  .xr-error {
    flex-wrap: wrap;
    align-items: flex-start;
  }

  .xr-error .grow {
    flex: 1 1 calc(100% - 32px);
  }

  .recording-overlay {
    top: auto;
    right: calc(var(--safe-right) + 8px);
    bottom: calc(var(--stage-playback-offset) + 8px);
    left: calc(var(--safe-left) + 8px);
    display: flex;
    justify-content: center;
  }

  .rec-pill {
    flex: 1;
    flex-wrap: wrap;
    justify-content: center;
    gap: 2px 10px;
    padding: 7px 10px;
    font-size: 12px;
    text-align: center;
  }

  /* Keep the recording pill and the minimap/notices from sharing the same space. */
  .recording-active .top-stack {
    max-height: calc(100dvh - var(--safe-top) - var(--stage-playback-offset) - 64px);
  }

  .recording-active :deep(.minimap) {
    display: none;
  }

  .controls-hint {
    left: calc(var(--safe-left) + 8px);
    right: auto;
    bottom: calc(var(--stage-playback-offset) + 8px);
    max-width: calc(100% - 150px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recording-active .controls-hint {
    display: none;
  }
}
</style>
