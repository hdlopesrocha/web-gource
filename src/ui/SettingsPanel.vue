<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { controller } from '../engine/controller'
import { PACING_PRESETS, resolvePacing, store } from '../state/store'
import { RESOLUTION_PRESETS } from '../engine/recorder'
import { formatDuration } from '../timeline/schedule'
import { formatBytes } from '../util/format'
import { fileRadiusForActivity, fileRadiusForBytes } from '../sim/simulation'
import TokenField from './TokenField.vue'

const emit = defineEmits<{ (event: 'close'): void }>()

const tab = ref<'visual' | 'camera' | 'recording' | 'data'>('visual')
const tokenSavedMessage = ref<string | null>(null)

function onTokenSaved(providerId: string | null): void {
  tokenSavedMessage.value = providerId
    ? 'Token stored. Reload to use it for the commits that were skipped.'
    : 'Token stored.'
}
const support = computed(() => controller.recordingSupport())
const recording = computed(() => store.recording)
const settings = computed(() => store.settings)
const progress = computed(() => store.recording.progress)
const sizeCoverage = computed(() => {
  const stats = store.timelineStats
  const known = stats?.filesWithSize ?? 0
  const total = stats?.files ?? 0
  return { known, total }
})

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
const estimatedDuration = computed(() => {
  const duration = controller.duration()
  const speed = recording.value.speed || 1
  return duration / speed
})

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

onMounted(() => {
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
        <p class="faint">Visualization, camera, pacing and video export</p>
      </div>
      <button class="btn ghost small" type="button" @click="emit('close')">✕</button>
    </header>

    <nav class="tabs">
      <button class="btn small" :class="{ active: tab === 'visual' }" type="button" @click="tab = 'visual'">Visual</button>
      <button class="btn small" :class="{ active: tab === 'camera' }" type="button" @click="tab = 'camera'">Camera</button>
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
          <h3>Circle sizes</h3>
          <div class="field">
            <label for="size-mode">Size circles by</label>
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
              {{ sizeCoverage.known }} of {{ sizeCoverage.total }} file circles use a real file size
              ({{ sizeSourceLabel }})<template v-if="sizeCoverage.total - sizeCoverage.known > 0">; the rest fall back to line
              activity</template>. The scale is logarithmic against the 95th percentile
              ({{ formatBytes(referenceBytes) }}), so one huge generated file cannot squash everything else. Sizes come
              from the host's file listing for the newest commit in the window, so a file that shrank during the window
              still shows its current size.
            </template>
            <template v-else-if="settings.sizeMode === 'activity'">
              Circles are scaled by added + removed lines accumulated in the loaded window.
            </template>
            <template v-else>Every file circle has the same size.</template>
          </p>
          <div class="field">
            <label>Circle scale · {{ settings.radiusScale.toFixed(2) }}×</label>
            <input type="range" min="0.4" max="2.5" step="0.05" :value="settings.radiusScale" @input="update({ radiusScale: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <label class="switch">
            <input type="checkbox" :checked="settings.dynamicLayout" @change="update({ dynamicLayout: ($event.target as HTMLInputElement).checked })" />
            Dynamic layout
          </label>
          <p class="faint note">
            With the dynamic layout on, files are packed onto rings around their directory: adding a file, or a circle
            growing with its size, pushes its neighbours outwards smoothly instead of overlapping them. Turn it off to
            pin every file to the position derived from its path.
          </p>
        </section>

        <section class="group">
          <h3>Scene</h3>
          <label class="switch"><input type="checkbox" :checked="settings.showDirs" @change="update({ showDirs: ($event.target as HTMLInputElement).checked })" /> Directory rings</label>
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
          <button class="btn small" type="button" @click="controller.resetCamera()">Reset view (C)</button>
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
          <h3>Navigation</h3>
          <p class="faint note">
            The scene is flat: drag to pan, scroll to zoom (the pointer stays anchored), arrow keys step through
            commits. Manual input pauses the automatic view for a few seconds.
          </p>
        </section>
      </template>

      <template v-else-if="tab === 'recording'">
        <section class="group">
          <h3>Video export</h3>
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
              <label>Frame rate · {{ recording.fps }} fps</label>
              <input type="range" min="15" max="60" step="1" :value="recording.fps" @input="updateRecording({ fps: Number(($event.target as HTMLInputElement).value) })" />
            </div>
            <div class="field">
              <label>Playback speed while recording · {{ recording.speed }}×</label>
              <input type="range" min="0.25" max="16" step="0.25" :value="recording.speed" @input="updateRecording({ speed: Number(($event.target as HTMLInputElement).value) })" />
            </div>
            <label class="switch"><input type="checkbox" :checked="recording.stopAtEnd" @change="updateRecording({ stopAtEnd: ($event.target as HTMLInputElement).checked })" /> Stop at the end of the timeline</label>
            <div class="field">
              <label>Safety limit · {{ Math.round(recording.maxWallSeconds / 60) }} min</label>
              <input type="range" min="60" max="3600" step="30" :value="recording.maxWallSeconds" @input="updateRecording({ maxWallSeconds: Number(($event.target as HTMLInputElement).value) })" />
            </div>

            <p class="faint note">
              Recording restarts the timeline at the beginning, advances by exactly one frame step per captured frame,
              and renders at the chosen resolution. At {{ recording.speed }}× the whole timeline needs about
              {{ formatDuration(estimatedDuration) }} of real time ({{ formatDuration(controller.duration()) }} simulated).
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
        </section>
      </template>

      <template v-else>
        <section class="group">
          <h3>Access token</h3>
          <TokenField :provider-id="store.repo?.provider ?? null" compact @saved="onTokenSaved" />
          <div class="row">
            <button class="btn small" type="button" :disabled="!store.url || store.loading.active" @click="controller.reload()">
              Reload repository with this token
            </button>
          </div>
          <p class="faint note">
            Reloading re-fetches the same window; already cached commits cost no quota, so it mainly fills in the file
            changes that were skipped when the limit was reached.
          </p>
          <p v-if="tokenSavedMessage" class="faint note ok">{{ tokenSavedMessage }}</p>
        </section>

        <section class="group">
          <h3>Loaded data</h3>
          <ul class="facts">
            <li><span class="faint">Repository</span><span>{{ store.repo?.fullName ?? '—' }}</span></li>
            <li><span class="faint">Provider</span><span>{{ store.repo?.provider ?? '—' }}</span></li>
            <li><span class="faint">History</span><span>{{ store.timelineTruncated ? 'partial' : 'complete window' }}</span></li>
            <li><span class="faint">Commits</span><span>{{ store.timelineStats?.commits.toLocaleString() ?? 0 }}</span></li>
            <li><span class="faint">Authors</span><span>{{ store.timelineStats?.authors ?? 0 }}</span></li>
            <li><span class="faint">Files touched</span><span>{{ store.timelineStats?.files.toLocaleString() ?? 0 }}</span></li>
            <li><span class="faint">File sizes</span><span>{{ store.timelineStats?.filesWithSize.toLocaleString() ?? 0 }} files · {{ sizeTotalLabel }}</span></li>
            <li><span class="faint">Size source</span><span>{{ sizeSourceLabel }}</span></li>
            <li><span class="faint">Merges</span><span>{{ store.timelineStats?.merges ?? 0 }}</span></li>
            <li><span class="faint">Without file data</span><span>{{ store.timelineStats?.withoutFileData ?? 0 }}</span></li>
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

.record-row {
  display: flex;
  gap: 8px;
  align-items: center;
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
</style>
