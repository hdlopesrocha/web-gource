<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { controller } from '../engine/controller'
import { PACING_PRESETS, providerDescriptors, resolvePacing, store } from '../state/store'
import { RESOLUTION_PRESETS } from '../engine/recorder'
import { formatDuration } from '../timeline/schedule'
import { formatBytes } from '../util/format'
import { fileRadiusForActivity, fileRadiusForBytes } from '../sim/simulation'
import { EXPORT_FPS, planFrames } from '../engine/export/frames'
import { COMMON_IGNORED_FOLDERS, HIDDEN_FOLDER_EXAMPLES, addIgnoredFolder, removeIgnoredFolder } from '../timeline/ignore'
import { formatBytes as formatExportBytes } from '../engine/recorder'
import TokenField from './TokenField.vue'

const emit = defineEmits<{ (event: 'close'): void }>()

const tab = ref<'visual' | 'camera' | 'filters' | 'music' | 'recording' | 'data'>('visual')
const tokenSavedMessage = ref<string | null>(null)

function onTokenSaved(providerId: string | null): void {
  tokenSavedMessage.value = providerId
    ? 'Token stored. Reload to use it for the commits that were skipped.'
    : 'Token stored.'
}
const support = computed(() => controller.recordingSupport())

/* Folder filters (moved here from the authors panel). */
const ignoredInput = ref('')
const ignoredFolders = computed(() => store.ignoredFolders)
const hiddenExamples = HIDDEN_FOLDER_EXAMPLES.join(', ')
const suggestedFolders = computed(() => {
  const active = new Set(ignoredFolders.value.map((entry) => entry.toLowerCase()))
  return COMMON_IGNORED_FOLDERS.filter((name) => !active.has(name))
})
const hiddenSummary = computed(() => {
  const stats = store.timelineStats
  if (!stats) return ''
  const count = stats.ignoredFiles ?? 0
  if (count === 0) return 'Nothing is hidden right now.'
  return `${count.toLocaleString()} file${count === 1 ? '' : 's'} hidden in this window.`
})

function addIgnored(entry: string): void {
  const value = entry.trim()
  ignoredInput.value = ''
  if (!value) return
  const next = addIgnoredFolder(store.ignoredFolders, value)
  if (next.length === store.ignoredFolders.length) return
  controller.applyFilters({ ignoredFolders: next })
}

function removeIgnored(entry: string): void {
  controller.applyFilters({ ignoredFolders: removeIgnoredFolder(store.ignoredFolders, entry) })
}
const exportSupport = computed(() => controller.exportSupport())
const exportState = computed(() => store.export)
const music = computed(() => store.music)
const exportProgress = computed(() => store.export.progress)
/** Deterministic frame-by-frame render (default) or a live real-time capture. */
const exportMode = ref<'render' | 'live'>('render')
const EXPORT_FPS_LABEL = EXPORT_FPS

const exportCodecs = computed(() => {
  void exportState.value.probed
  return exportState.value.codecs
})

const selectedExportCodec = computed(() => store.export.container)
const exportResolution = computed(() => `${store.recording.width}x${store.recording.height}`)

/** The exact plan the exporter will use, so the UI cannot disagree with it. */
const exportPlan = computed(() => planFrames(controller.duration(), EXPORT_FPS, playbackSpeed.value))
const exportFramesEstimate = computed(() => exportPlan.value.totalFrames)

const exportBitrateLabel = computed(() => {
  const value = store.export.bitrate
  if (value <= 0) return 'automatic'
  return `${(value / 1e6).toFixed(1)} Mbps`
})

function updateExport(patch: Partial<typeof store.export>): void {
  Object.assign(store.export, patch)
}

function setExportResolution(value: string): void {
  setResolution(value)
  // Encoder support depends on the resolution, so re-probe.
  void controller.refreshExportSupport()
}

function setExportCodec(value: string): void {
  store.export.container = value === 'mp4' ? 'mp4' : 'webm'
}
const recording = computed(() => store.recording)
const settings = computed(() => store.settings)
const progress = computed(() => store.recording.progress)
const sizeCoverage = computed(() => {
  const stats = store.timelineStats
  const known = stats?.filesWithSize ?? 0
  const total = stats?.files ?? 0
  return { known, total }
})

/** Loaded projects with counts from the current (filtered) timeline. */
const projectRows = computed(() => {
  void store.timelineStats
  return controller.currentTimeline?.projects ?? []
})
const multiProject = computed(() => store.repos.length > 1)
const tokenProviders = computed(() => [...new Set(store.repos.map((repo) => repo.provider))])
const tokenProviderId = ref<string | null>(store.repos[0]?.provider ?? null)
watch(
  tokenProviders,
  (ids) => {
    if (!tokenProviderId.value || !ids.includes(tokenProviderId.value)) tokenProviderId.value = ids[0] ?? null
  },
  { immediate: true },
)
function providerName(id: string): string {
  return providerDescriptors.find((descriptor) => descriptor.id === id)?.name ?? id
}

const sizeSourceLabel = computed(() => {
  switch (store.timelineStats?.sizeSource) {
    case 'git-tree':
      return 'host file listing'
    case 'synthetic':
      return 'synthetic demo data'
    case 'unavailable':
      return 'unavailable'
    default:
      return store.timelineStats?.sizeSource ?? 'unknown'
  }
})

const sizeTotalLabel = computed(() => formatBytes(store.timelineStats?.totalBytes ?? 0))
const referenceBytes = computed(() => Math.max(1024, controller.sizeReference().bytes))

/**
 * Legend circles use the same logarithmic mapping as the renderer, scaled to a
 * comfortable pixel range so the relative sizes are visible.
 */
const sizeLegend = computed(() => {
  const reference = Math.max(1024, controller.sizeReference().bytes)
  const samples = [1024, 16 * 1024, 256 * 1024, reference]
  const unique = [...new Set(samples.map((value) => Math.min(value, reference)))].sort((a, b) => a - b)
  const mode = store.settings.sizeMode
  const activityReference = controller.sizeReference().activity
  return unique.map((bytes) => {
    const radius =
      mode === 'bytes'
        ? fileRadiusForBytes(bytes, reference)
        : mode === 'activity'
          ? fileRadiusForActivity(bytes / 40, activityReference)
          : 0.34
    return {
      label: mode === 'bytes' ? formatBytes(bytes) : `${Math.round(bytes / 40)} lines`,
      pixels: Math.round(Math.max(6, radius * 14 * store.settings.radiusScale)),
    }
  })
})

const pacingValues = computed(() =>
  resolvePacing(store.settings.pacing, {
    secondsPerDay: store.settings.customSecondsPerDay,
    minSpacing: store.settings.customMinSpacing,
  }),
)
const playbackSpeed = computed(() => store.hud?.speed ?? 1)
const estimatedDuration = computed(() => controller.duration() / Math.max(0.05, playbackSpeed.value))

const selectedFormat = computed({
  get: () => recording.value.mimeType,
  set: (value: string) => {
    recording.value.mimeType = value
  },
})

function update(patch: Partial<typeof store.settings>): void {
  controller.updateSettings(patch)
}

function updateRecording(patch: Partial<typeof store.recording>): void {
  Object.assign(store.recording, patch)
}

function setResolution(value: string): void {
  const preset = RESOLUTION_PRESETS.find((entry) => `${entry.width}x${entry.height}` === value)
  if (preset) updateRecording({ width: preset.width, height: preset.height })
}

function chooseMusic(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Allow choosing the same file again after a failure or removal.
  input.value = ''
  if (file) void controller.loadMusic(file)
}

onMounted(() => {
  // Probe the WebCodecs encoders once so the export panel can be honest about
  // what this browser can produce.
  void controller.refreshExportSupport()
  const supported = support.value.formats.filter((format) => format.supported)
  if (supported.length > 0 && !supported.some((format) => format.mimeType === recording.value.mimeType)) {
    updateRecording({ mimeType: supported[0].mimeType })
  }
})
</script>

<template>
  <aside class="settings panel">
    <header class="head">
      <div>
        <h2>Settings</h2>
        <p class="faint">Visualization, camera, filters, music and video export</p>
      </div>
      <button class="btn ghost small" type="button" @click="emit('close')">✕</button>
    </header>

    <nav class="tabs">
      <button class="btn small" :class="{ active: tab === 'visual' }" type="button" @click="tab = 'visual'">Visual</button>
      <button class="btn small" :class="{ active: tab === 'camera' }" type="button" @click="tab = 'camera'">Camera</button>
      <button class="btn small" :class="{ active: tab === 'filters' }" type="button" @click="tab = 'filters'">Filters</button>
      <button class="btn small" :class="{ active: tab === 'music' }" type="button" @click="tab = 'music'">Music</button>
      <button class="btn small" :class="{ active: tab === 'recording' }" type="button" @click="tab = 'recording'">Recording</button>
      <button class="btn small" :class="{ active: tab === 'data' }" type="button" @click="tab = 'data'">Data</button>
    </nav>

    <div class="body scroll">
      <template v-if="tab === 'visual'">
        <section class="group">
          <h3>Colours</h3>
          <div class="field">
            <label for="color-mode">File colouring</label>
            <select id="color-mode" :value="settings.fileColorMode" @change="update({ fileColorMode: ($event.target as HTMLSelectElement).value as typeof settings.fileColorMode })">
              <option value="extension">By file extension</option>
              <option value="activity">By last change type</option>
              <option value="flat">Monochrome</option>
            </select>
          </div>
        </section>

        <section class="group">
          <h3>Sphere sizes</h3>
          <div class="field">
            <label for="size-mode">Size spheres by</label>
            <select id="size-mode" :value="settings.sizeMode" @change="update({ sizeMode: ($event.target as HTMLSelectElement).value as typeof settings.sizeMode })">
              <option value="bytes">File size (from the host)</option>
              <option value="activity">Line activity (additions + deletions)</option>
              <option value="uniform">Uniform (all the same)</option>
            </select>
          </div>
          <div class="size-legend">
            <div v-for="sample in sizeLegend" :key="sample.label" class="legend-item">
              <span class="legend-circle" :style="{ width: `${sample.pixels}px`, height: `${sample.pixels}px` }" />
              <span class="faint mono">{{ sample.label }}</span>
            </div>
          </div>
          <p class="faint note">
            <template v-if="settings.sizeMode === 'bytes'">
              {{ sizeCoverage.known }} of {{ sizeCoverage.total }} file spheres use a real file size
              ({{ sizeSourceLabel }})<template v-if="sizeCoverage.total - sizeCoverage.known > 0">; the rest fall back to line
              activity</template>. The scale is logarithmic against the 95th percentile
              ({{ formatBytes(referenceBytes) }}), so one huge generated file cannot squash everything else. Sizes come
              from the host's file listing for the newest commit in the window, so a file that shrank during the window
              still shows its current size.
            </template>
            <template v-else-if="settings.sizeMode === 'activity'">
              Spheres are scaled by added + removed lines accumulated in the loaded window.
            </template>
            <template v-else>Every file sphere has the same size.</template>
          </p>
          <div class="field">
            <label>Sphere scale · {{ settings.radiusScale.toFixed(2) }}×</label>
            <input type="range" min="0.4" max="2.5" step="0.05" :value="settings.radiusScale" @input="update({ radiusScale: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <label class="switch">
            <input type="checkbox" :checked="settings.dynamicLayout" @change="update({ dynamicLayout: ($event.target as HTMLInputElement).checked })" />
            Dynamic layout
          </label>
          <p class="faint note">
            With the dynamic layout on, files are grouped on rings around their directory (Gource's model): adding a
            file, or a sphere growing with its size, reflows the rings and pushes neighbouring folders outwards
            smoothly instead of overlapping them. Turn it off to pin every file to the position derived from its path.
          </p>
        </section>

        <section class="group">
          <h3>Scene</h3>
          <label class="switch"><input type="checkbox" :checked="settings.showDirs" @change="update({ showDirs: ($event.target as HTMLInputElement).checked })" /> Folders</label>
          <p class="faint note">
            Files and folders are always drawn as real 3D spheres with lighting and world-space scale, so they gain
            depth and parallax as the camera moves.
          </p>
          <label class="switch"><input type="checkbox" :checked="settings.showEdges" @change="update({ showEdges: ($event.target as HTMLInputElement).checked })" /> Branch edges</label>
          <label class="switch"><input type="checkbox" :checked="settings.showGrid" @change="update({ showGrid: ($event.target as HTMLInputElement).checked })" /> Background grid</label>
          <div class="field">
            <label>Edge opacity · {{ settings.edgeOpacity.toFixed(2) }}</label>
            <input type="range" min="0.05" max="1" step="0.05" :value="settings.edgeOpacity" @input="update({ edgeOpacity: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <div class="field">
            <label>Grid spacing · {{ settings.gridSpacing }} units</label>
            <input type="range" min="10" max="120" step="5" :value="settings.gridSpacing" @input="update({ gridSpacing: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <div class="field">
            <label>Activity particles · {{ settings.particleIntensity.toFixed(2) }}×</label>
            <input type="range" min="0" max="2" step="0.05" :value="settings.particleIntensity" @input="update({ particleIntensity: Number(($event.target as HTMLInputElement).value) })" />
          </div>
        </section>

        <section class="group">
          <h3>Plasma</h3>
          <label class="switch"><input type="checkbox" :checked="settings.showPlasma" @change="update({ showPlasma: ($event.target as HTMLInputElement).checked })" /> Activity plasma</label>
          <div class="field">
            <label>Intensity · {{ settings.plasmaIntensity.toFixed(2) }}</label>
            <input type="range" min="0" max="2" step="0.05" :value="settings.plasmaIntensity" @input="update({ plasmaIntensity: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <div class="field">
            <label>Opacity · {{ settings.plasmaOpacity.toFixed(2) }}</label>
            <input type="range" min="0" max="1" step="0.05" :value="settings.plasmaOpacity" @input="update({ plasmaOpacity: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <div class="field">
            <label>Sharpness · {{ settings.plasmaSharpness.toFixed(1) }}</label>
            <input type="range" min="1" max="8" step="0.1" :value="settings.plasmaSharpness" @input="update({ plasmaSharpness: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <div class="field">
            <label>Metaball weight · {{ settings.plasmaWeight.toFixed(2) }}</label>
            <input type="range" min="0" max="2" step="0.05" :value="settings.plasmaWeight" @input="update({ plasmaWeight: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <div class="field">
            <label>Blob radius · {{ settings.plasmaRadius.toFixed(2) }}×</label>
            <input type="range" min="0.5" max="3" step="0.05" :value="settings.plasmaRadius" @input="update({ plasmaRadius: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <div class="field">
            <label>Heat decay · {{ settings.plasmaDecay.toFixed(1) }} s</label>
            <input type="range" min="1" max="30" step="0.5" :value="settings.plasmaDecay" @input="update({ plasmaDecay: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <div class="field">
            <label>Volume height · {{ settings.plasmaHeight.toFixed(2) }}×</label>
            <input type="range" min="0.5" max="4" step="0.1" :value="settings.plasmaHeight" @input="update({ plasmaHeight: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <div class="field">
            <label>March quality · {{ settings.plasmaSteps }} steps</label>
            <input type="range" min="8" max="96" step="8" :value="settings.plasmaSteps" @input="update({ plasmaSteps: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <p class="faint note">
            A ray-marched plasma volume forms around the files with the most recent changes: every file's contribution
            grows with its activity heat and fades as the heat decays (the reheat/decay time is above). The plasma
            follows the audio-reactive hue and brightness, and is depth-tested against the files, folders and branch
            lines, so they always stay in front of it. Opacity sets how much of the volume is added over the scene.
          </p>
        </section>

        <section class="group">
          <h3>Labels</h3>
          <label class="switch"><input type="checkbox" :checked="settings.showLabels" @change="update({ showLabels: ($event.target as HTMLInputElement).checked })" /> Show labels</label>
          <label class="switch"><input type="checkbox" :checked="settings.showDirectoryLabels" @change="update({ showDirectoryLabels: ($event.target as HTMLInputElement).checked })" /> Directory names</label>
          <label class="switch"><input type="checkbox" :checked="settings.showFileLabels" @change="update({ showFileLabels: ($event.target as HTMLInputElement).checked })" /> Recently changed files</label>
          <label class="switch"><input type="checkbox" :checked="settings.showFileSizes" @change="update({ showFileSizes: ($event.target as HTMLInputElement).checked })" /> File sizes in labels</label>
          <label class="switch"><input type="checkbox" :checked="settings.showAuthorNames" @change="update({ showAuthorNames: ($event.target as HTMLInputElement).checked })" /> Author names</label>
        </section>

        <section class="group">
          <h3>Authors</h3>
          <label class="switch"><input type="checkbox" :checked="settings.showAuthorGlow" @change="update({ showAuthorGlow: ($event.target as HTMLInputElement).checked })" /> Author halo</label>
          <label class="switch"><input type="checkbox" :checked="settings.showBeams" @change="update({ showBeams: ($event.target as HTMLInputElement).checked })" /> Beams to changed files</label>
          <div class="field">
            <label for="beam-style">Beam motion</label>
            <select
              id="beam-style"
              :value="settings.beamStyle"
              @change="update({ beamStyle: ($event.target as HTMLSelectElement).value as 'travelling' | 'solid' })"
            >
              <option value="travelling">Travelling head (directional)</option>
              <option value="solid">Solid ray (classic)</option>
            </select>
            <span class="faint hint">
              The travelling beam sends a bright head from the avatar towards the file or folder it changed, with the
              tail following it; the solid ray is the original full-length line.
            </span>
          </div>
          <div v-if="settings.beamStyle === 'travelling'" class="field">
            <label>Travel time · {{ settings.beamTravelSeconds.toFixed(2) }} s</label>
            <input
              type="range"
              min="0.15"
              max="2"
              step="0.05"
              :value="settings.beamTravelSeconds"
              @input="update({ beamTravelSeconds: Number(($event.target as HTMLInputElement).value) })"
            />
            <span class="faint hint">How long the head takes to reach the element.</span>
          </div>
          <div class="field">
            <label>Beam brightness · {{ settings.beamIntensity.toFixed(2) }}×</label>
            <input type="range" min="0.2" max="2" step="0.05" :value="settings.beamIntensity" @input="update({ beamIntensity: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <div class="field">
            <label>Beam width · {{ settings.beamWidth.toFixed(1) }} px</label>
            <input type="range" min="1" max="8" step="0.2" :value="settings.beamWidth" @input="update({ beamWidth: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <div class="field">
            <label>Avatar size · {{ settings.authorScale.toFixed(2) }}×</label>
            <input type="range" min="0.6" max="2" step="0.05" :value="settings.authorScale" @input="update({ authorScale: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <p class="faint note">
            Each commit lights up the files it changed: the node pulses in the change colour and a beam connects it to
            the author for about 1.6 seconds. Authors travel between files with a spring, so movement stays smooth
            even at high playback speeds.
          </p>
        </section>
      </template>

      <template v-else-if="tab === 'camera'">
        <section class="group">
          <h3>Automatic view</h3>
          <label class="switch"><input type="checkbox" :checked="settings.followActivity" @change="update({ followActivity: ($event.target as HTMLInputElement).checked })" /> Follow the most recent activity</label>
          <label class="switch"><input type="checkbox" :checked="settings.autoZoom" @change="update({ autoZoom: ($event.target as HTMLInputElement).checked })" /> Fit the repository automatically</label>
          <button class="btn small" type="button" @click="controller.resetCamera()">Reset to the default view (C)</button>
          <p class="faint note">
            Drag to orbit, right-drag (or Shift-drag) to pan, and scroll to zoom. Reset returns the camera to the
            default 3D angle.
          </p>
        </section>
        <section class="group">
          <h3>Playback pacing</h3>
          <div class="field">
            <label for="pacing">Idle time compression</label>
            <select
              id="pacing"
              :value="settings.pacing"
              @change="update({ pacing: ($event.target as HTMLSelectElement).value as typeof settings.pacing })"
            >
              <option v-for="(preset, key) in PACING_PRESETS" :key="key" :value="key">
                {{ preset.label }} — {{ preset.description }}
              </option>
              <option value="custom">Custom — use the sliders below</option>
            </select>
          </div>
          <div class="field">
            <label>Seconds per day of history · {{ pacingValues.secondsPerDay.toFixed(2) }}s</label>
            <input
              type="range"
              min="0.05"
              max="2"
              step="0.05"
              :value="pacingValues.secondsPerDay"
              @input="update({ pacing: 'custom', customSecondsPerDay: Number(($event.target as HTMLInputElement).value) })"
            />
          </div>
          <div class="field">
            <label>Minimum time per commit · {{ pacingValues.minSpacing.toFixed(2) }}s</label>
            <input
              type="range"
              min="0.05"
              max="1"
              step="0.01"
              :value="pacingValues.minSpacing"
              @input="update({ pacing: 'custom', customMinSpacing: Number(($event.target as HTMLInputElement).value) })"
            />
          </div>
          <p class="faint note">
            Playthrough at 1× lasts about {{ formatDuration(estimatedDuration) }} for the current timeline
            ({{ formatDuration(controller.duration()) }} of simulated time).
          </p>
        </section>
        <section class="group">
          <h3>Gamepad & head tracking</h3>
          <label class="switch">
            <input
              type="checkbox"
              :checked="settings.gamepad"
              @change="controller.setGamepadEnabled(($event.target as HTMLInputElement).checked)"
            />
            Gamepad
          </label>
          <div class="field">
            <label>Gamepad sensitivity · {{ settings.gamepadSensitivity.toFixed(2) }}×</label>
            <input
              type="range"
              min="0.2"
              max="3"
              step="0.05"
              :value="settings.gamepadSensitivity"
              @input="update({ gamepadSensitivity: Number(($event.target as HTMLInputElement).value) })"
            />
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="settings.gyro"
              @change="controller.setGyroEnabled(($event.target as HTMLInputElement).checked)"
            />
            Head tracking (gyroscope)
          </label>
          <button
            v-if="settings.gyro"
            class="btn small"
            type="button"
            @click="controller.recalibrateOrientation()"
          >
            Recalibrate to where I am looking
          </button>
          <p v-if="store.ui.gyroError" class="faint note warn">{{ store.ui.gyroError }}</p>
          <p class="faint note">
            <template v-if="store.ui.gamepadConnected">A gamepad is connected. </template>
            Left stick rotates the camera (yaw and pitch), the right stick rolls it and flies forward and back, the
            D-pad strafes and rises or sinks, and <kbd>A</kbd> recalibrates the head tracking. Head tracking follows
            the device's gyroscope: the camera up vector is the device's up rotated by the gyroscope, and
            <strong>clicking the scene</strong> (or pressing <kbd>A</kbd>) binds the current pose as the reference, so
            the view is calibrated exactly to the orientation of your head. Reset view (or dragging with the mouse)
            hands the camera back to the orbit.
          </p>
        </section>
        <section class="group">
          <h3>Navigation</h3>
          <p class="faint note">
            Drag to spin the 3D tabletop; right-drag (or Shift-drag) pans, and the wheel zooms around the pointer.
            Arrow keys step through commits. Manual input pauses the automatic view for a few seconds; Reset view
            returns to the default 3D angle.
          </p>
        </section>
      </template>

      <template v-else-if="tab === 'filters'">
        <section class="group">
          <h3>Hidden folders</h3>
          <label class="switch">
            <input
              type="checkbox"
              :checked="store.hideHiddenFolders"
              @change="controller.applyFilters({ hideHiddenFolders: ($event.target as HTMLInputElement).checked })"
            />
            Hide hidden folders
          </label>
          <p class="faint note">
            Folders whose name starts with a dot ({{ hiddenExamples }}) are tooling, not code. Hidden
            <em>files</em> such as <code>.gitignore</code> stay visible, because only folder names are tested.
          </p>
        </section>

        <section class="group">
          <h3>Ignored folders</h3>
          <div class="row">
            <input
              v-model="ignoredInput"
              type="text"
              list="ignored-folder-suggestions"
              placeholder="third_party…"
              @keydown.enter.prevent="addIgnored(ignoredInput)"
            />
            <button class="btn small" type="button" @click="addIgnored(ignoredInput)">Hide</button>
          </div>
          <datalist id="ignored-folder-suggestions">
            <option v-for="name in suggestedFolders" :key="name" :value="name" />
          </datalist>
          <ul v-if="ignoredFolders.length > 0" class="chips">
            <li v-for="entry in ignoredFolders" :key="entry">
              <span class="mono">{{ entry }}</span>
              <button class="btn ghost small" type="button" :title="`Stop ignoring ${entry}`" @click="removeIgnored(entry)">✕</button>
            </li>
          </ul>
          <p class="faint note">
            Hides any folder with that name, at any depth and regardless of case. Use <code>*</code> for a glob
            (<code>third*</code>) or <code>src/vendor</code> for one path.
          </p>
          <p class="faint note">
            Ignoring filters file changes, not commits: a commit that only touched hidden trees still plays, it just
            has no files to highlight. {{ hiddenSummary }}
          </p>
          <button class="btn small" type="button" @click="controller.clearFilters()">Clear every filter</button>
        </section>

        <section class="group">
          <h3>Authors and dates</h3>
          <p class="faint note">
            Per-author toggles and the date range live in the Authors panel (<kbd>A</kbd>), together with
            “Clear every filter”.
          </p>
        </section>
      </template>

      <template v-else-if="tab === 'music'">
        <section class="group">
          <h3>Background music</h3>
          <p class="faint note">
            Add an MP3 to loop under the animation, or use the microphone. Audio is faded in at the start and out
            again at the end, and is included in deterministic renders and live captures.
          </p>
          <div class="field">
            <label>Audio source</label>
            <div class="mode-row">
              <button
                class="btn small"
                :class="{ active: music.source === 'file' }"
                type="button"
                @click="controller.setAudioSource('file')"
              >
                MP3 file
              </button>
              <button
                class="btn small"
                :class="{ active: music.source === 'microphone' }"
                type="button"
                @click="controller.setAudioSource('microphone')"
              >
                Microphone
              </button>
            </div>
          </div>
          <p v-if="music.source === 'microphone'" class="faint hint">
            The microphone drives the audio-reactive visuals in real time and is mixed into live recordings with the
            same fade envelope. A deterministic render cannot capture live audio, so it is video-only while the
            microphone is selected.
          </p>
          <div class="field">
            <label for="music-file">Music file</label>
            <input
              id="music-file"
              class="file-input"
              type="file"
              accept="audio/mpeg,audio/mp3,.mp3"
              :disabled="music.loading"
              @change="chooseMusic"
            />
          </div>

          <p v-if="music.loading" class="faint note">Decoding and analysing the track…</p>
          <div v-else-if="music.fileName" class="music-track">
            <span class="music-name" :title="music.fileName">{{ music.fileName }}</span>
            <span class="faint mono">{{ formatDuration(music.duration) }} loop</span>
            <button class="btn ghost small" type="button" title="Remove the background music" @click="controller.clearMusic()">✕</button>
          </div>
          <p v-else class="faint note">No track loaded. The animation plays silently.</p>

          <div class="field">
            <label>Volume · {{ Math.round(music.volume * 100) }}%</label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              :value="music.volume"
              @input="controller.updateMusic({ volume: Number(($event.target as HTMLInputElement).value) })"
            />
          </div>
          <div class="field">
            <label>Fade in · {{ music.fadeInSeconds.toFixed(1) }} s</label>
            <input
              type="range"
              min="0"
              max="10"
              step="0.1"
              :value="music.fadeInSeconds"
              @input="controller.updateMusic({ fadeInSeconds: Number(($event.target as HTMLInputElement).value) })"
            />
          </div>
          <div class="field">
            <label>Fade out · {{ music.fadeOutSeconds.toFixed(1) }} s</label>
            <input
              type="range"
              min="0"
              max="10"
              step="0.1"
              :value="music.fadeOutSeconds"
              @input="controller.updateMusic({ fadeOutSeconds: Number(($event.target as HTMLInputElement).value) })"
            />
            <span class="faint hint">The fade-out ends with the final animation frame.</span>
          </div>

          <p v-if="music.error" class="warn-box">{{ music.error }}</p>

          <label class="switch">
            <input
              type="checkbox"
              :checked="settings.audioReactive"
              @change="controller.updateSettings({ audioReactive: ($event.target as HTMLInputElement).checked })"
            />
            Audio-reactive visuals
          </label>
          <p class="faint hint">
            The bass shifts the plasma hue, claps cycle the file colours, the low mids pulse the folder spheres,
            the midrange brightens the branches, and the vocal range makes the author avatars breathe.
          </p>

          <p class="faint note">
            The uploaded file stays in this browser session only; volume and fade lengths are remembered. Exporting
            music needs WebCodecs audio encoding, and live capture needs the selected recording format to support
            audio.
          </p>
        </section>
      </template>

      <template v-else-if="tab === 'recording'">
        <section class="group">
          <h3>Video export</h3>
          <div class="mode-row">
            <button class="btn small" :class="{ active: exportMode === 'render' }" type="button" @click="exportMode = 'render'">
              Deterministic render
            </button>
            <button class="btn small" :class="{ active: exportMode === 'live' }" type="button" @click="exportMode = 'live'">
              Live capture
            </button>
          </div>

          <template v-if="exportMode === 'render'">
            <p v-if="!exportSupport.supported" class="warn-box">
              This browser cannot encode video frame by frame (WebCodecs is unavailable). Try desktop Chrome, Edge or
              Safari 16.4+.
            </p>
            <template v-else>
              <div class="field">
                <label for="export-format">Format</label>
                <select id="export-format" :value="selectedExportCodec" @change="setExportCodec(($event.target as HTMLSelectElement).value)">
                  <option value="webm">
                    WebM · VP9 (default){{ exportCodecs.some((codec) => codec.container === 'webm') ? '' : ' — unavailable' }}
                  </option>
                  <option value="mp4">
                    MP4 · H.264 (optional){{ exportCodecs.some((codec) => codec.container === 'mp4') ? '' : ' — unavailable' }}
                  </option>
                </select>
                <span v-if="exportCodecs.length" class="faint hint">
                  <span v-for="codec in exportCodecs" :key="codec.codec" class="chip">
                    {{ codec.label }}<span v-if="codec.hardware"> · hardware</span>
                  </span>
                </span>
                <span v-else-if="exportState.probed" class="faint hint">No encoder found for this resolution.</span>
              </div>
              <div class="field">
                <label for="export-resolution">Resolution</label>
                <select id="export-resolution" :value="exportResolution" @change="setExportResolution(($event.target as HTMLSelectElement).value)">
                  <option v-for="preset in RESOLUTION_PRESETS" :key="preset.label" :value="`${preset.width}x${preset.height}`">
                    {{ preset.label }}
                  </option>
                </select>
              </div>
              <div class="field">
                <label>Frame rate · {{ EXPORT_FPS_LABEL }} fps (fixed)</label>
                <span class="faint hint">
                  {{ exportFramesEstimate.toLocaleString() }} frames for
                  {{ formatDuration(controller.duration()) }} of history at {{ playbackSpeed }}× — the export follows the
                  playback speed you selected, so a faster speed means a shorter video.
                </span>
              </div>
              <div class="field">
                <label>Quality · {{ exportBitrateLabel }}</label>
                <input
                  type="range"
                  min="0"
                  max="20000000"
                  step="500000"
                  :value="store.export.bitrate"
                  @input="updateExport({ bitrate: Number(($event.target as HTMLInputElement).value) })"
                />
                <span class="faint hint">Slide to the far left to derive the bitrate from the resolution.</span>
              </div>

              <p class="faint note">
                The render is frame-driven, not clock-driven: every frame advances the simulation by exactly
                {{ playbackSpeed }}/{{ EXPORT_FPS_LABEL }} s and is encoded as soon as it is drawn, so the result does not
                depend on how fast this machine is. Frames are never buffered — only the compressed stream is kept.
                The video includes the info panel, the timeline, the overview, the weekday/hour heatmap and the
                contribution calendar.
              </p>

              <div class="record-row">
                <button v-if="!exportState.active" class="btn primary" type="button" :disabled="!exportSupport.supported" @click="controller.startExport()">
                  ▶ Render animation
                </button>
                <button v-else class="btn danger" type="button" @click="controller.cancelExport()">■ Cancel</button>
              </div>

              <div v-if="exportState.active && exportProgress" class="progress">
                <div class="bar"><div class="bar-fill" :style="{ width: `${exportProgress.percent}%` }" /></div>
                <span class="faint mono">
                  {{ exportProgress.percent.toFixed(0) }}% · {{ exportProgress.frames.toLocaleString() }} /
                  {{ exportProgress.totalFrames.toLocaleString() }} frames · t =
                  {{ exportProgress.simTime.toFixed(2) }}s / {{ exportProgress.duration.toFixed(2) }}s ·
                  {{ formatExportBytes(exportProgress.bytes) }}
                </span>
              </div>

              <p v-if="exportState.error" class="warn-box">{{ exportState.error }}</p>

              <div v-if="exportState.lastUrl" class="result">
                <video :src="exportState.lastUrl" controls playsinline class="preview" />
                <div class="row">
                  <span class="faint mono">
                    {{ exportState.lastLabel }} · {{ formatExportBytes(exportState.lastBytes) }} ·
                    {{ exportState.lastFrames.toLocaleString() }} frames ·
                    {{ formatDuration(exportState.lastSeconds) }} simulated at {{ exportState.lastSpeed }}× ·
                    {{ formatDuration(exportState.lastElapsed) }} to render
                  </span>
                  <button class="btn small primary" type="button" @click="controller.downloadExport()">Download</button>
                </div>
              </div>
            </template>
          </template>

          <template v-else>
            <p v-if="!support.supported" class="warn-box">
              This browser cannot record canvas video. Try a desktop version of Chrome, Edge or Firefox.
            </p>
            <template v-else>
              <div class="field">
                <label for="format">Format</label>
                <select id="format" v-model="selectedFormat">
                  <option v-for="format in support.formats" :key="format.mimeType" :value="format.mimeType" :disabled="!format.supported">
                    {{ format.label }}{{ format.supported ? '' : ' — unsupported' }}
                  </option>
                </select>
              </div>
              <div class="field">
                <label for="resolution">Resolution</label>
                <select id="resolution" :value="`${recording.width}x${recording.height}`" @change="setResolution(($event.target as HTMLSelectElement).value)">
                  <option v-for="preset in RESOLUTION_PRESETS" :key="preset.label" :value="`${preset.width}x${preset.height}`">
                    {{ preset.label }}
                  </option>
                </select>
              </div>
              <div class="field">
                <label>Frame rate · {{ EXPORT_FPS_LABEL }} fps (fixed) · {{ playbackSpeed }}× speed</label>
                <span class="faint hint">
                  Live capture samples in real time at 60 fps and follows the playback speed, so at
                  {{ playbackSpeed }}× the whole timeline takes about {{ formatDuration(estimatedDuration) }} of real time.
                </span>
              </div>
              <label class="switch"><input type="checkbox" :checked="recording.stopAtEnd" @change="updateRecording({ stopAtEnd: ($event.target as HTMLInputElement).checked })" /> Stop at the end of the timeline</label>
              <div class="field">
                <label>Safety limit · {{ Math.round(recording.maxWallSeconds / 60) }} min</label>
                <input type="range" min="60" max="3600" step="30" :value="recording.maxWallSeconds" @input="updateRecording({ maxWallSeconds: Number(($event.target as HTMLInputElement).value) })" />
              </div>

              <p class="faint note">
                Live capture restarts the timeline and samples the composited frame in real time: it can capture manual
                panning and zooming, but the wall clock decides how many frames make it into the file. It includes the
                same panels. Use the deterministic render above when the result has to be reproducible.
              </p>

              <div class="record-row">
                <button v-if="!recording.active" class="btn primary" type="button" :disabled="!support.supported" @click="controller.startRecording()">
                  ● Start recording
                </button>
                <button v-else class="btn danger" type="button" @click="controller.stopRecording()">■ Stop</button>
                <button v-if="recording.active" class="btn small" type="button" @click="controller.cancelRecording()">Discard</button>
              </div>

              <div v-if="recording.active && progress" class="progress">
                <div class="bar"><div class="bar-fill" :style="{ width: `${progress.percent}%` }" /></div>
                <span class="faint mono">
                  {{ progress.percent.toFixed(0) }}% · {{ progress.frames }} frames · {{ progress.elapsed.toFixed(0) }}s ·
                  {{ formatBytes(progress.bytes) }}
                </span>
              </div>

              <p v-if="recording.error" class="warn-box">{{ recording.error }}</p>

              <div v-if="recording.lastUrl" class="result">
                <video :src="recording.lastUrl" controls playsinline class="preview" />
                <div class="row">
                  <span class="faint mono">
                    {{ recording.lastExtension.toUpperCase() }} · {{ formatBytes(recording.lastBytes) }} ·
                    {{ recording.lastFrames }} frames · {{ formatDuration(recording.lastSeconds) }} simulated
                  </span>
                  <button class="btn small primary" type="button" @click="controller.downloadRecording()">Download</button>
                </div>
              </div>
            </template>
          </template>
        </section>

      </template>

      <template v-else>
        <section class="group">
          <h3>Access token</h3>
          <div v-if="tokenProviders.length > 1" class="field">
            <label for="settings-token-provider">Token host</label>
            <select id="settings-token-provider" v-model="tokenProviderId">
              <option v-for="id in tokenProviders" :key="id" :value="id">{{ providerName(id) }}</option>
            </select>
          </div>
          <TokenField :provider-id="tokenProviderId" compact @saved="onTokenSaved" />
          <div class="row">
            <button class="btn small" type="button" :disabled="!store.url || store.loading.active" @click="controller.reload()">
              Reload {{ multiProject ? 'projects' : 'repository' }} with this token
            </button>
          </div>
          <p class="faint note">
            Reloading re-fetches the same window; already cached commits cost no quota, so it mainly fills in the file
            changes that were skipped when the limit was reached. Each host needs its own token.
          </p>
          <p v-if="tokenSavedMessage" class="faint note ok">{{ tokenSavedMessage }}</p>
        </section>

        <section class="group">
          <h3>Loaded data</h3>
          <ul class="facts">
            <template v-if="multiProject">
              <li><span class="faint">Projects</span><span>{{ store.repos.length }}</span></li>
              <li v-for="project in projectRows" :key="project.key">
                <span class="faint">{{ project.repo.fullName }}</span>
                <span>
                  {{ project.commits.toLocaleString() }} commits · {{ project.authors }} authors
                  <template v-if="project.truncated"> · partial</template>
                </span>
              </li>
            </template>
            <template v-else>
              <li><span class="faint">Repository</span><span>{{ store.repo?.fullName ?? '—' }}</span></li>
              <li><span class="faint">Provider</span><span>{{ store.repo?.provider ?? '—' }}</span></li>
            </template>
            <li><span class="faint">History</span><span>{{ store.timelineTruncated ? 'partial' : 'complete window' }}</span></li>
            <li><span class="faint">Commits</span><span>{{ store.timelineStats?.commits.toLocaleString() ?? 0 }}</span></li>
            <li><span class="faint">Authors</span><span>{{ store.timelineStats?.authors ?? 0 }}</span></li>
            <li><span class="faint">Files touched</span><span>{{ store.timelineStats?.files.toLocaleString() ?? 0 }}</span></li>
            <li><span class="faint">File sizes</span><span>{{ store.timelineStats?.filesWithSize.toLocaleString() ?? 0 }} files · {{ sizeTotalLabel }}</span></li>
            <li><span class="faint">Size source</span><span>{{ sizeSourceLabel }}</span></li>
            <li><span class="faint">Merges</span><span>{{ store.timelineStats?.merges ?? 0 }}</span></li>
            <li><span class="faint">Without file data</span><span>{{ store.timelineStats?.withoutFileData ?? 0 }}</span></li>
            <li v-if="store.ignoredFolders.length > 0 || store.hideHiddenFolders">
              <span class="faint">Ignored folders</span>
              <span>
                {{ store.timelineStats?.ignoredFiles ?? 0 }} files ·
                {{ [store.hideHiddenFolders ? 'hidden (dot-prefixed)' : null, store.ignoredFolders.join(', ')].filter(Boolean).join(' · ') }}
              </span>
            </li>
            <li><span class="faint">Line changes</span><span>+{{ (store.timelineStats?.additions ?? 0).toLocaleString() }} / −{{ (store.timelineStats?.deletions ?? 0).toLocaleString() }}</span></li>
          </ul>
          <div v-if="store.timelineStats?.topExtensions.length" class="extensions">
            <span v-for="entry in store.timelineStats.topExtensions" :key="entry.extension" class="chip">
              .{{ entry.extension }} <span class="faint">{{ entry.count }}</span>
            </span>
          </div>
        </section>
        <section class="group">
          <h3>Notes</h3>
          <ul class="facts notes">
            <li v-for="warning in store.warnings" :key="warning">{{ warning }}</li>
            <li v-if="store.warnings.length === 0" class="faint">No warnings: the loaded window is complete.</li>
          </ul>
        </section>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.settings {
  position: absolute;
  right: 12px;
  top: 68px;
  bottom: 200px;
  width: min(380px, calc(100vw - 24px));
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  z-index: 9;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.head h2 {
  font-size: 14px;
}

.head p {
  margin: 2px 0 0;
  font-size: 11.5px;
}

.tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-right: 4px;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--panel-border);
}

.group:last-child {
  border-bottom: none;
}

.group h3 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-faint);
}

.note {
  font-size: 11.5px;
  margin: 0;
}

.note.ok {
  color: var(--add);
}

.warn-box {
  font-size: 12px;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  background: rgba(255, 200, 87, 0.1);
  border: 1px solid rgba(255, 200, 87, 0.32);
  color: #ffe6b3;
  margin: 0;
}

.mode-row {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}

.mode-row .btn.active {
  border-color: var(--accent);
  color: var(--accent);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}

.chips li {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  border: 1px solid var(--panel-border);
  border-radius: 999px;
  background: rgba(94, 200, 255, 0.08);
  font-size: 11px;
}

.chips button {
  padding: 0 4px;
  font-size: 11px;
  line-height: 1.4;
}

.note code,
.note kbd {
  padding: 0 3px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 10.5px;
}

.record-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.file-input {
  width: 100%;
  font-size: 12px;
}

.file-input::file-selector-button {
  margin-right: 8px;
  padding: 6px 9px;
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-sm);
  background: rgba(94, 200, 255, 0.08);
  color: var(--text);
  cursor: pointer;
}

.file-input:disabled {
  opacity: 0.6;
}

.music-track {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-sm);
  background: rgba(94, 200, 255, 0.06);
  font-size: 12px;
}

.music-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bar {
  height: 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #ff5d6c, #ffb86b);
  transition: width 0.25s ease;
}

.result {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.preview {
  width: 100%;
  border-radius: var(--radius-sm);
  border: 1px solid var(--panel-border);
  background: #000;
}

.facts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
}

.facts li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.facts.notes li {
  display: block;
  padding: 6px 0;
  border-bottom: 1px dashed rgba(126, 158, 214, 0.12);
  color: var(--text-dim);
}

.extensions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.size-legend {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  padding: 8px 4px 2px;
}

.legend-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
}

.legend-circle {
  display: block;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #cfe6ff, #4f9ede);
  box-shadow: 0 0 10px rgba(94, 200, 255, 0.35);
}

/*
 * Phones: near-full-width sheet above the playback bar. The header and tab row
 * stay put while only the body scrolls.
 */
@media (max-width: 760px), (max-width: 949px) and (max-height: 480px) {
  .settings {
    left: calc(var(--safe-left) + 8px);
    right: calc(var(--safe-right) + 8px);
    top: calc(var(--safe-top) + 8px);
    bottom: var(--stage-playback-offset);
    width: auto;
    max-width: none;
    max-height: calc(100dvh - var(--safe-top) - var(--stage-playback-offset) - 8px);
    gap: 10px;
    padding: 12px;
    overflow: hidden;
    overscroll-behavior: contain;
    z-index: 9;
  }

  .head {
    flex: none;
  }

  .head .btn {
    min-width: 36px;
    min-height: 36px;
  }

  .tabs {
    flex: none;
    flex-wrap: wrap;
    padding-bottom: 2px;
  }

  .tabs .btn {
    min-height: 34px;
  }

  .body {
    min-height: 0;
    padding-right: 2px;
  }

  .mode-row,
  .record-row {
    flex-wrap: wrap;
  }

  .facts li {
    flex-wrap: wrap;
    gap: 2px 10px;
  }
}
</style>
