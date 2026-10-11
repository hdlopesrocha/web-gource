import { reactive, computed } from 'vue'
import type { RepoInfo } from '../git/types'
import type { TimelineStats } from '../timeline/types'
import type { HudState } from '../engine/engine'
import type { RendererSettings } from '../render/renderer'
import type { RecordingProgress } from '../engine/recorder'
import { listProviderDescriptors } from '../git/providers'

export type ViewName = 'landing' | 'stage'
export type PacingPreset = 'compact' | 'balanced' | 'relaxed'
export type PacingMode = PacingPreset | 'custom'

/** Scheduling values a pacing mode resolves to. */
export interface PacingValues {
  minSpacing: number
  secondsPerDay: number
  maxGapSeconds: number
  idleBudget: number
  tail: number
}

const CUSTOM_DEFAULTS: PacingValues = {
  minSpacing: 0.26,
  secondsPerDay: 0.35,
  maxGapSeconds: 12,
  idleBudget: 240,
  tail: 2.4,
}

/** Resolve the pacing mode (preset or custom sliders) to schedule values. */
export function resolvePacing(
  mode: PacingMode,
  custom: { secondsPerDay?: number; minSpacing?: number } = {},
): PacingValues {
  if (mode === 'custom') {
    return {
      ...CUSTOM_DEFAULTS,
      minSpacing: clampNumber(custom.minSpacing ?? CUSTOM_DEFAULTS.minSpacing, 0.05, 1),
      secondsPerDay: clampNumber(custom.secondsPerDay ?? CUSTOM_DEFAULTS.secondsPerDay, 0.05, 2),
    }
  }
  const preset = PACING_PRESETS[mode]
  return {
    minSpacing: preset.minSpacing,
    secondsPerDay: preset.secondsPerDay,
    maxGapSeconds: preset.maxGapSeconds,
    idleBudget: preset.idleBudget,
    tail: preset.tail,
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min
}

/** Scheduling presets exposed in the settings panel. */
export const PACING_PRESETS: Record<
  PacingPreset,
  { minSpacing: number; secondsPerDay: number; maxGapSeconds: number; idleBudget: number; tail: number; label: string; description: string }
> = {
  compact: {
    minSpacing: 0.13,
    secondsPerDay: 0.15,
    maxGapSeconds: 6,
    idleBudget: 120,
    tail: 2,
    label: 'Compact',
    description: 'Brisk pace, idle periods compressed hard.',
  },
  balanced: {
    minSpacing: 0.26,
    secondsPerDay: 0.35,
    maxGapSeconds: 12,
    idleBudget: 240,
    tail: 2.4,
    label: 'Balanced',
    description: 'Gource-like pacing with visible quiet periods.',
  },
  relaxed: {
    minSpacing: 0.45,
    secondsPerDay: 0.7,
    maxGapSeconds: 20,
    idleBudget: 420,
    tail: 3.2,
    label: 'Relaxed',
    description: 'Slow pace, long pauses between activities.',
  },
}

export interface LoadOptions {
  /** Snapshot size: how many commits to load. */
  maxCommits: number
  /** Which end of history to start from. */
  range: 'latest' | 'earliest'
  branch: string
  /** Per-provider personal access tokens. */
  tokens: Record<string, string>
}

export interface RecordingSettings {
  width: number
  height: number
  fps: number
  /** Playback speed multiplier used while recording. */
  speed: number
  mimeType: string
  /** Stop automatically at the end of the timeline. */
  stopAtEnd: boolean
  /** Hard limit for the recording length, in wall-clock seconds. */
  maxWallSeconds: number
}

export interface UiState {
  settingsOpen: boolean
  helpOpen: boolean
  authorsOpen: boolean
  minimapVisible: boolean
  timelineOpen: boolean
}

export interface AppState {
  view: ViewName
  url: string
  /** Provider explicitly chosen by the user (used by the demo entry point). */
  forcedProvider: string | null
  loadOptions: LoadOptions
  loading: {
    active: boolean
    status: string
    /** Commits whose file changes are loaded. */
    loaded: number
    target: number
    requests: number
    rateRemaining?: number
    rateLimit?: number
    error: string | null
    /** True once the first batch reached the visualization. */
    streaming: boolean
  }
  warnings: string[]
  repo: RepoInfo | null
  timelineStats: TimelineStats | null
  timelineTruncated: boolean
  hud: HudState | null
  /** Author ids excluded from the visualization. */
  hiddenAuthors: string[]
  /** Date range filter (epoch ms), null means unbounded. */
  dateRange: { from: number | null; to: number | null }
  settings: RendererSettings & {
    followActivity: boolean
    autoRotate: boolean
    autoZoom: boolean
    pacing: PacingMode
    /** Custom pacing values, used when `pacing === 'custom'`. */
    customSecondsPerDay: number
    customMinSpacing: number
  }
  recording: RecordingSettings & {
    active: boolean
    progress: RecordingProgress | null
    error: string | null
    /** Finished recording, ready to download or preview. */
    lastUrl: string | null
    lastExtension: string
    lastBytes: number
    lastFrames: number
    lastSeconds: number
  }
  ui: UiState
}

const SETTINGS_KEY = 'web-gource:settings:v1'
const LOAD_KEY = 'web-gource:load-options:v1'

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return { ...fallback, ...(JSON.parse(raw) as T) }
  } catch {
    return fallback
  }
}

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage can be unavailable (private mode); settings simply do not persist */
  }
}

const defaultSettings: AppState['settings'] = {
  fileColorMode: 'extension',
  showEdges: true,
  edgeOpacity: 0.45,
  showDirs: true,
  fileSize: 1,
  particleIntensity: 1,
  showLabels: true,
  showDirectoryLabels: true,
  showFileLabels: true,
  showAuthorNames: true,
  showAuthorGlow: true,
  authorScale: 1,
  showStars: true,
  fogDensity: 0.0011,
  followActivity: true,
  autoRotate: true,
  autoZoom: true,
  pacing: 'balanced',
  customSecondsPerDay: CUSTOM_DEFAULTS.secondsPerDay,
  customMinSpacing: CUSTOM_DEFAULTS.minSpacing,
}

const defaultLoadOptions: LoadOptions = {
  maxCommits: 150,
  range: 'latest',
  branch: '',
  tokens: {},
}

const defaultRecording: RecordingSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  speed: 1,
  mimeType: 'video/webm;codecs=vp9',
  stopAtEnd: true,
  maxWallSeconds: 1800,
}

export const store = reactive<AppState>({
  view: 'landing',
  url: '',
  forcedProvider: null,
  loadOptions: readJson(LOAD_KEY, defaultLoadOptions),
  loading: {
    active: false,
    status: '',
    loaded: 0,
    target: 0,
    requests: 0,
    error: null,
    streaming: false,
  },
  warnings: [],
  repo: null,
  timelineStats: null,
  timelineTruncated: false,
  hud: null,
  hiddenAuthors: [],
  dateRange: { from: null, to: null },
  settings: readJson(SETTINGS_KEY, defaultSettings),
  recording: {
    ...defaultRecording,
    active: false,
    progress: null,
    error: null,
    lastUrl: null,
    lastExtension: 'webm',
    lastBytes: 0,
    lastFrames: 0,
    lastSeconds: 0,
  },
  ui: {
    settingsOpen: false,
    helpOpen: false,
    authorsOpen: false,
    minimapVisible: true,
    timelineOpen: true,
  },
})

export function persistSettings(): void {
  persist(SETTINGS_KEY, store.settings)
}

export function persistLoadOptions(): void {
  persist(LOAD_KEY, {
    maxCommits: store.loadOptions.maxCommits,
    range: store.loadOptions.range,
    branch: store.loadOptions.branch,
    tokens: store.loadOptions.tokens,
  })
}

export function tokenFor(providerId: string): string {
  return store.loadOptions.tokens[providerId] ?? ''
}

export function setToken(providerId: string, token: string): void {
  if (token) store.loadOptions.tokens[providerId] = token
  else delete store.loadOptions.tokens[providerId]
  persistLoadOptions()
}

export const providerDescriptors = listProviderDescriptors()

export const isFiltered = computed(
  () => store.hiddenAuthors.length > 0 || store.dateRange.from !== null || store.dateRange.to !== null,
)

export const loadingPercent = computed(() => {
  const { loaded, target } = store.loading
  if (target <= 0) return 0
  return Math.min(100, Math.round((loaded / target) * 100))
})

export function resetRunState(): void {
  store.warnings = []
  store.hud = null
  store.hiddenAuthors = []
  store.dateRange = { from: null, to: null }
  store.timelineStats = null
  store.timelineTruncated = false
  store.loading = {
    active: false,
    status: '',
    loaded: 0,
    target: 0,
    requests: 0,
    error: null,
    streaming: false,
  }
}
