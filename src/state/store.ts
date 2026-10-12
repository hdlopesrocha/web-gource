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
  /** Last repository URL, so a reload does not start from an empty field. */
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
    /** How file circles are sized: host-reported bytes, line activity, uniform. */
    sizeMode: SizeMode
    /** Reflow file rings as files appear and circles grow. */
    dynamicLayout: boolean
    pacing: PacingMode
    /** Custom pacing values, used when `pacing === 'custom'`. */
    customSecondsPerDay: number
    customMinSpacing: number
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
    /** Encoders this browser offers, probed by the controller. */
    codecs: ExportCodecInfo[]
    /** True once probing has run (so the UI can say "unavailable"). */
    probed: boolean
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
const FILTER_KEY = 'web-gource:filters:v1'

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
  showBloom: true,
  bloomIntensity: 0.75,
  showBeams: true,
  beamIntensity: 1.15,
  beamWidth: 3.2,
  followActivity: true,
  autoZoom: true,
  sizeMode: 'bytes',
  dynamicLayout: true,
  pacing: 'balanced',
  customSecondsPerDay: CUSTOM_DEFAULTS.secondsPerDay,
  customMinSpacing: CUSTOM_DEFAULTS.minSpacing,
}

const defaultLoadOptions: LoadOptions = {
  maxCommits: 150,
  range: 'latest',
  branch: '',
  tokens: {},
  draftToken: '',
  lastTokenProvider: null,
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

const initialLoadOptions = { ...defaultLoadOptions, ...readJson(LOAD_KEY, defaultLoadOptions) }

export const store = reactive<AppState>({
  view: 'landing',
  url: initialLoadOptions.lastUrl,
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
  },
  warnings: [],
  repo: null,
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
    codecs: [],
    probed: false,
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
  },
})

export function persistSettings(): void {
  persist(SETTINGS_KEY, store.settings)
}

/** The ignore list is a preference, so it survives a reload. */
export function persistFilters(): void {
  persist(FILTER_KEY, { ignoredFolders: store.ignoredFolders, hideHiddenFolders: store.hideHiddenFolders })
}

export function persistLoadOptions(): void {
  persist(LOAD_KEY, {
    maxCommits: store.loadOptions.maxCommits,
    range: store.loadOptions.range,
    branch: store.loadOptions.branch,
    tokens: store.loadOptions.tokens,
    draftToken: store.loadOptions.draftToken,
    lastTokenProvider: store.loadOptions.lastTokenProvider,
    lastUrl: store.loadOptions.lastUrl,
  })
}

/** Remember the URL that was loaded, so a page reload can pre-fill it. */
export function setLastUrl(url: string): void {
  store.loadOptions.lastUrl = url
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
