import { reactive, computed } from 'vue'
import type { RepoInfo } from '../git/types'
import type { TimelineStats } from '../timeline/types'
import type { HudState } from '../engine/engine'
import type { RendererSettings } from '../render/renderer'
import type { SizeMode } from '../sim/simulation'
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
  /** Token typed or pasted before a provider could be resolved. */
  draftToken: string
  /** Provider that received the most recent token (keeps the field populated). */
  lastTokenProvider: string | null
  /** Last loaded repository URLs (multiple projects), in load order. */
  urls: string[]
  /**
   * First loaded URL. Kept for the single-repository flows and for migrating
   * profiles saved before multiple projects were supported.
   */
  lastUrl: string
}

export interface RecordingSettings {
  width: number
  height: number
  mimeType: string
  /** Stop automatically at the end of the timeline. */
  stopAtEnd: boolean
  /** Hard limit for the recording length, in wall-clock seconds. */
  maxWallSeconds: number
}

/**
 * Deterministic export settings: the animation is rendered frame by frame from
 * `t = 0` at exactly 30 frames per simulated second, independent of the machine.
 */
export interface ExportSettings {
  /** Container preference; WebM (VP9) is the default, MP4 (H.264) optional. */
  container: 'webm' | 'mp4'
  /** Bitrate override in bits per second; 0 derives it from the resolution. */
  bitrate: number
}

export interface ExportProgressState {
  frames: number
  totalFrames: number
  simTime: number
  duration: number
  percent: number
  bytes: number
  queue: number
}

/** Background music uploaded for the current session. */
export interface MusicSettings {
  /** Where the audible/reactive audio comes from for this session. */
  source: 'file' | 'microphone'
  /** File name of the loaded track; null when no track is loaded. */
  fileName: string | null
  /** Duration of one loop of the track in seconds. */
  duration: number
  /** Playback and export volume, 0…1. */
  volume: number
  /** Fade-in length in video seconds. */
  fadeInSeconds: number
  /** Fade-out length in video seconds, ending at the end of the animation. */
  fadeOutSeconds: number
  /** True while the file is being decoded. */
  loading: boolean
  error: string | null
}

export interface ExportCodecInfo {
  container: 'webm' | 'mp4'
  label: string
  codec: string
  supported: boolean
  hardware: boolean
}

export interface UiState {
  settingsOpen: boolean
  helpOpen: boolean
  activityOpen: boolean
  authorsOpen: boolean
  minimapVisible: boolean
  timelineOpen: boolean
  /** True when the browser exposes an immersive WebXR device. */
  xrSupported: boolean
  /** True while an immersive WebXR session is running. */
  xrActive: boolean
  /** Last WebXR failure, shown next to the VR button. */
  xrError: string | null
  /** Selected VR camera view, shared by the headset menu and the desktop toolbar. */
  xrCameraView: 'origin' | 'top' | 'gource'
  /** True while a gamepad the browser reports is connected. */
  gamepadConnected: boolean
  /** True while the gyroscope is enabled and reporting. */
  gyroActive: boolean
  /** Why head tracking could not start (permission, or no sensor). */
  gyroError: string | null
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
    /** Commits whose file changes are loaded (current project). */
    loaded: number
    target: number
    requests: number
    rateRemaining?: number
    rateLimit?: number
    error: string | null
    /** True once the first batch reached the visualization. */
    streaming: boolean
    /** 1-based index of the project being loaded, and how many are queued. */
    index: number
    total: number
    /** `owner/name` (or the raw input) of the project being loaded. */
    project: string | null
  }
  warnings: string[]
  /** Primary repository (the first successfully loaded project). */
  repo: RepoInfo | null
  /** Every loaded project, in load order. */
  repos: RepoInfo[]
  timelineStats: TimelineStats | null
  timelineTruncated: boolean
  hud: HudState | null
  /** Author ids excluded from the visualization. */
  hiddenAuthors: string[]
  /**
   * Folder names to ignore (vendored dependencies, generated output...). Each
   * entry hides that folder at any depth; see `timeline/ignore.ts`.
   */
  ignoredFolders: string[]
  /**
   * Hide hidden folders — any folder whose name starts with a dot (`.github`,
   * `.vscode`, `.husky`, ...). On by default: they are tooling, not code.
   */
  hideHiddenFolders: boolean
  /** Date range filter (epoch ms), null means unbounded. */
  dateRange: { from: number | null; to: number | null }
  settings: RendererSettings & {
    followActivity: boolean
    autoZoom: boolean
    /** Let the background track drive the plasma hue, file colours and pulses. */
    audioReactive: boolean
    /** How file circles are sized: host-reported bytes, line activity, uniform. */
    sizeMode: SizeMode
    /** Reflow file rings as files appear and circles grow. */
    dynamicLayout: boolean
    pacing: PacingMode
    /** Custom pacing values, used when `pacing === 'custom'`. */
    customSecondsPerDay: number
    customMinSpacing: number
    /** Let a connected gamepad fly the camera (see the help overlay). */
    gamepad: boolean
    /** Multiplier on the gamepad's rotation and translation speeds. */
    gamepadSensitivity: number
    /** Follow the device's gyroscope (head tracking). */
    gyro: boolean
    /**
     * Height of the VR Top and Gource views above the tabletop, in metres.
     * Keep in sync with `XR_VIEW_DEFAULT_HEIGHT` in `render/xr.ts`.
     */
    xrViewHeight: number
    /** Camera dolly along the view direction in VR, in metres. */
    xrViewZoom: number
  }
  export: ExportSettings & {
    active: boolean
    progress: ExportProgressState | null
    error: string | null
    /** Finished export, ready to download or preview. */
    lastUrl: string | null
    lastExtension: string
    lastLabel: string
    lastBytes: number
    lastFrames: number
    lastSeconds: number
    lastElapsed: number
    /** Playback speed the last export followed. */
    lastSpeed: number
    /** True when the last export used a hardware encoder. */
    lastHardware: boolean
    /** True when the last export contains the background music track. */
    lastMusic: boolean
    /** Encoders this browser offers, probed by the controller. */
    codecs: ExportCodecInfo[]
    /** True once probing has run (so the UI can say "unavailable"). */
    probed: boolean
  }
  music: MusicSettings
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
const FILTER_KEY = 'web-gource:filters:v1'
const MUSIC_KEY = 'web-gource:music:v1'

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
  edgeOpacity: 0.6,
  showDirs: true,
  radiusScale: 1,
  particleIntensity: 1,
  showLabels: true,
  showDirectoryLabels: true,
  showFileLabels: true,
  showFileSizes: true,
  showAuthorNames: true,
  showAuthorGlow: true,
  authorScale: 1,
  showGrid: true,
  gridSpacing: 40,
  showBeams: true,
  beamStyle: 'travelling',
  beamTravelSeconds: 0.55,
  beamIntensity: 1.15,
  beamWidth: 3.2,
  showPlasma: true,
  plasmaIntensity: 0.5,
  plasmaOpacity: 1,
  plasmaSharpness: 2,
  plasmaWeight: 1,
  plasmaRadius: 1,
  plasmaDecay: 5,
  plasmaHeight: 1.5,
  plasmaSteps: 48,
  followActivity: true,
  autoZoom: true,
  audioReactive: true,
  sizeMode: 'bytes',
  dynamicLayout: true,
  pacing: 'balanced',
  customSecondsPerDay: CUSTOM_DEFAULTS.secondsPerDay,
  customMinSpacing: CUSTOM_DEFAULTS.minSpacing,
  gamepad: false,
  gamepadSensitivity: 1,
  gyro: false,
  xrViewHeight: 4,
  xrViewZoom: 0,
}

const defaultLoadOptions: LoadOptions = {
  maxCommits: 150,
  range: 'latest',
  branch: '',
  tokens: {},
  draftToken: '',
  lastTokenProvider: null,
  urls: [],
  lastUrl: '',
}

const defaultRecording: RecordingSettings = {
  width: 1920,
  height: 1080,
  mimeType: 'video/webm;codecs=vp9',
  stopAtEnd: true,
  maxWallSeconds: 1800,
}

const defaultExport: ExportSettings = {
  container: 'webm',
  bitrate: 0,
}

const defaultMusicPreferences = {
  volume: 0.7,
  fadeInSeconds: 2,
  fadeOutSeconds: 2,
}

const initialLoadOptions = { ...defaultLoadOptions, ...readJson(LOAD_KEY, defaultLoadOptions) }
// Profiles saved before multiple projects only have `lastUrl`: migrate it into
// the new list so the landing page pre-fills exactly as it used to.
if (!Array.isArray(initialLoadOptions.urls) || initialLoadOptions.urls.length === 0) {
  initialLoadOptions.urls = initialLoadOptions.lastUrl ? [initialLoadOptions.lastUrl] : []
} else {
  initialLoadOptions.urls = initialLoadOptions.urls.filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
}
if (!initialLoadOptions.lastUrl) initialLoadOptions.lastUrl = initialLoadOptions.urls[0] ?? ''

export const store = reactive<AppState>({
  view: 'landing',
  url: initialLoadOptions.urls[0] ?? '',
  forcedProvider: null,
  loadOptions: initialLoadOptions,
  loading: {
    active: false,
    status: '',
    loaded: 0,
    target: 0,
    requests: 0,
    error: null,
    streaming: false,
    index: 0,
    total: 0,
    project: null,
  },
  warnings: [],
  repo: null,
  repos: [],
  timelineStats: null,
  timelineTruncated: false,
  hud: null,
  hiddenAuthors: [],
  ignoredFolders: readJson(FILTER_KEY, { ignoredFolders: [] as string[] }).ignoredFolders,
  hideHiddenFolders: readJson(FILTER_KEY, { hideHiddenFolders: true }).hideHiddenFolders ?? true,
  dateRange: { from: null, to: null },
  settings: readJson(SETTINGS_KEY, defaultSettings),
  export: {
    ...defaultExport,
    active: false,
    progress: null,
    error: null,
    lastUrl: null,
    lastExtension: 'webm',
    lastLabel: '',
    lastBytes: 0,
    lastFrames: 0,
    lastSeconds: 0,
    lastElapsed: 0,
    lastSpeed: 1,
    lastHardware: false,
    lastMusic: false,
    codecs: [],
    probed: false,
  },
  music: {
    ...defaultMusicPreferences,
    ...readJson(MUSIC_KEY, defaultMusicPreferences),
    // The source is a session choice: a persisted microphone would never be
    // granted permission without a click anyway.
    source: 'file',
    fileName: null,
    duration: 0,
    loading: false,
    error: null,
  },
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
    activityOpen: false,
    authorsOpen: false,
    minimapVisible: true,
    timelineOpen: true,
    xrSupported: false,
    xrActive: false,
    xrError: null,
    xrCameraView: 'gource',
    gamepadConnected: false,
    gyroActive: false,
    gyroError: null,
  },
})

export function persistSettings(): void {
  persist(SETTINGS_KEY, store.settings)
}

/** The ignore list is a preference, so it survives a reload. */
export function persistFilters(): void {
  persist(FILTER_KEY, { ignoredFolders: store.ignoredFolders, hideHiddenFolders: store.hideHiddenFolders })
}

/** Music levels and fade lengths are preferences; the file itself is not persisted. */
export function persistMusic(): void {
  persist(MUSIC_KEY, {
    volume: store.music.volume,
    fadeInSeconds: store.music.fadeInSeconds,
    fadeOutSeconds: store.music.fadeOutSeconds,
  })
}

export function persistLoadOptions(): void {
  persist(LOAD_KEY, {
    maxCommits: store.loadOptions.maxCommits,
    range: store.loadOptions.range,
    branch: store.loadOptions.branch,
    tokens: store.loadOptions.tokens,
    draftToken: store.loadOptions.draftToken,
    lastTokenProvider: store.loadOptions.lastTokenProvider,
    urls: store.loadOptions.urls,
    lastUrl: store.loadOptions.lastUrl,
  })
}

/** Remember the URL that was loaded, so a page reload can pre-fill it. */
export function setLastUrl(url: string): void {
  store.loadOptions.urls = url ? [url] : []
  store.loadOptions.lastUrl = url
  persistLoadOptions()
}

/** Remember the projects that were loaded, in order. */
export function setLastUrls(urls: string[]): void {
  const clean = urls.map((url) => url.trim()).filter(Boolean)
  store.loadOptions.urls = clean
  store.loadOptions.lastUrl = clean[0] ?? ''
  store.url = clean[0] ?? ''
  persistLoadOptions()
}

/* -------------------------------------------------------------------------- *
 * Personal access tokens
 *
 * Tokens can be typed or pasted at any time — including before a repository URL
 * is known. Such a token is kept as a *draft* and is attached to a provider as
 * soon as one can be identified (from the URL, or from the token's own prefix).
 * A draft that is clearly meant for another host is never sent to a different
 * one, so a GitHub token can never leak to GitLab.
 * -------------------------------------------------------------------------- */

/** Token prefixes used by the supported hosts. */
const TOKEN_PREFIXES: { prefix: string; providerId: string }[] = [
  { prefix: 'ghp_', providerId: 'github' },
  { prefix: 'github_pat_', providerId: 'github' },
  { prefix: 'gho_', providerId: 'github' },
  { prefix: 'ghu_', providerId: 'github' },
  { prefix: 'ghs_', providerId: 'github' },
  { prefix: 'ghr_', providerId: 'github' },
  { prefix: 'glpat-', providerId: 'gitlab' },
  { prefix: 'gldt-', providerId: 'gitlab' },
  { prefix: 'glrt-', providerId: 'gitlab' },
  { prefix: 'glcbt-', providerId: 'gitlab' },
]

/** Strip whitespace, newlines and an accidental `Bearer `/`token ` prefix. */
export function sanitizeToken(value: string): string {
  return value
    .trim()
    .replace(/^(?:bearer|token)\s*[:|]?\s*/i, '')
    .replace(/[\s\u200b]+/g, '')
}

/** Identify the host a token belongs to from its prefix, when possible. */
export function detectTokenProvider(token: string): string | null {
  const clean = sanitizeToken(token).toLowerCase()
  if (!clean) return null
  for (const entry of TOKEN_PREFIXES) {
    if (clean.startsWith(entry.prefix)) return entry.providerId
  }
  return null
}

/**
 * Token to use for a provider: the saved token, or a draft token that either
 * has no recognisable prefix or belongs to this provider.
 */
export function tokenFor(providerId: string): string {
  const saved = store.loadOptions.tokens[providerId]
  if (saved) return saved
  const draft = store.loadOptions.draftToken
  if (!draft) return ''
  const owner = detectTokenProvider(draft)
  if (owner && owner !== providerId) return ''
  return draft
}

/** True when a usable token exists for the provider. */
export function hasToken(providerId: string): boolean {
  return tokenFor(providerId).length > 0
}

export function setToken(providerId: string, token: string): void {
  const clean = sanitizeToken(token)
  if (clean) {
    store.loadOptions.tokens[providerId] = clean
    store.loadOptions.lastTokenProvider = providerId
  } else {
    delete store.loadOptions.tokens[providerId]
    if (store.loadOptions.lastTokenProvider === providerId) store.loadOptions.lastTokenProvider = null
  }
  persistLoadOptions()
}

/** Store a token whose provider is not known yet. */
export function setDraftToken(token: string): void {
  store.loadOptions.draftToken = sanitizeToken(token)
  persistLoadOptions()
}

export function clearToken(providerId: string): void {
  delete store.loadOptions.tokens[providerId]
  if (store.loadOptions.lastTokenProvider === providerId) store.loadOptions.lastTokenProvider = null
  persistLoadOptions()
}

/**
 * Current value to display in a token field.
 *
 * With a known host: that host's token, else the pending draft. Without one: the
 * draft, else the token that was stored most recently — so a token that was
 * pasted before a URL never disappears from the field.
 */
export function displayToken(providerId: string | null): string {
  if (providerId) {
    const stored = store.loadOptions.tokens[providerId]
    if (stored) return stored
    return store.loadOptions.draftToken
  }
  if (store.loadOptions.draftToken) return store.loadOptions.draftToken
  const last = store.loadOptions.lastTokenProvider
  if (last) return store.loadOptions.tokens[last] ?? ''
  return ''
}

/** Every provider id whose stored token matches the given value (plus the draft). */
export function tokenHoldersFor(providerId: string | null, currentValue: string): string[] {
  const holders = new Set<string>()
  const clean = sanitizeToken(currentValue)
  if (providerId) holders.add(providerId)
  const owner = detectTokenProvider(clean)
  if (owner) holders.add(owner)
  if (clean) {
    for (const [id, token] of Object.entries(store.loadOptions.tokens)) {
      if (token === clean) holders.add(id)
    }
  }
  // The displayed value is usually the most recently touched provider's token.
  const last = store.loadOptions.lastTokenProvider
  if (last) holders.add(last)
  return [...holders]
}

/**
 * Attach a pending draft token to a provider once it is known.
 * Returns true when the draft was moved.
 */
export function applyDraftToken(providerId: string): boolean {
  const draft = store.loadOptions.draftToken
  if (!draft) return false
  const owner = detectTokenProvider(draft)
  if (owner && owner !== providerId) return false
  store.loadOptions.tokens[providerId] = draft
  store.loadOptions.draftToken = ''
  store.loadOptions.lastTokenProvider = providerId
  persistLoadOptions()
  return true
}

/**
 * Record a token that was typed or pasted, attaching it to `providerId` when
 * known and keeping it as a draft otherwise.
 */
export function acceptToken(value: string, providerId: string | null): { providerId: string | null; draft: boolean } {
  const clean = sanitizeToken(value)
  if (!clean) {
    setDraftToken('')
    if (providerId) clearToken(providerId)
    return { providerId: null, draft: false }
  }
  const target = providerId ?? detectTokenProvider(clean)
  if (target) {
    setToken(target, clean)
    // A new, attributable token supersedes a pending draft: the latest input is
    // what the field represents.
    if (store.loadOptions.draftToken) setDraftToken('')
    return { providerId: target, draft: false }
  }
  setDraftToken(clean)
  return { providerId: null, draft: true }
}

export const providerDescriptors = listProviderDescriptors()

export const isFiltered = computed(
  () =>
    store.hiddenAuthors.length > 0 ||
    store.ignoredFolders.length > 0 ||
    store.hideHiddenFolders ||
    store.dateRange.from !== null ||
    store.dateRange.to !== null,
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
  store.repo = null
  store.repos = []
  store.loading = {
    active: false,
    status: '',
    loaded: 0,
    target: 0,
    requests: 0,
    error: null,
    streaming: false,
    index: 0,
    total: 0,
    project: null,
  }
}
