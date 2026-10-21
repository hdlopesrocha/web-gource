/**
 * The complete in-scene interface for immersive WebXR.
 *
 * An immersive session has no DOM, so every piece of the application chrome has
 * to live in the scene. This module draws the whole UI — repository header,
 * commit card, overview, playback bar, activity charts, authors, settings,
 * warnings and help — into one canvas and exposes it as a single plane with a
 * `CanvasTexture`. The middle of the plane is transparent, so the repository
 * tree stays visible through the dashboard.
 *
 * Geometry and state mapping are pure functions ({@link screenLayout},
 * {@link hitTestScreen}, {@link xrScreenAction}), which keeps the gaze hit
 * testing testable without WebGL. Only {@link XrScreenPanel} touches three.js.
 *
 * Interaction is gaze + dwell: the reticle activates whatever it rests on for
 * {@link XR_SCREEN_DWELL_SECONDS}. Pressing an XR controller's trigger (or
 * clicking the mirrored page) is reserved for recentring the view, so a user
 * can always recover their bearings without hunting for a button.
 */

import * as THREE from 'three'
import type { ActivityBucket } from '../timeline/types'
import type { ContributionCalendar, WeekdayHourGrid } from '../timeline/activity'
import type { SizeMode } from '../sim/simulation'
import type { XrCameraMode } from './xr'
import { formatBytes } from '../util/format'
import { drawInfoPanel, fitText, wrapText, type InfoPanelModel } from './info-panel'
import {
  drawActivityBars,
  drawContributionCalendar,
  drawPanel,
  drawWeekdayHour,
  SHADES,
  TEXT_COLOR,
  TEXT_STRONG,
} from './overlays'

/** Seconds the gaze must rest on an element before it activates. */
export const XR_SCREEN_DWELL_SECONDS = 2

/** Canvas resolution of the single UI plane (16:10). */
export const XR_SCREEN_CANVAS_WIDTH = 1600
export const XR_SCREEN_CANVAS_HEIGHT = 1000
export const XR_SCREEN_ASPECT = XR_SCREEN_CANVAS_HEIGHT / XR_SCREEN_CANVAS_WIDTH

/** Physical size of the upright screen, in metres. */
export const XR_SCREEN_WIDTH_METRES = 2.2
export const XR_SCREEN_HEIGHT_METRES = XR_SCREEN_WIDTH_METRES * XR_SCREEN_ASPECT

/** How far in front of the eyes the screen floats, in metres. */
export const XR_SCREEN_DISTANCE = 0.95

/** The flat dashboard shown by the fixed top-down camera. */
export const XR_2D_SCREEN_WIDTH_METRES = 1.25
export const XR_2D_SCREEN_HEIGHT_METRES = XR_2D_SCREEN_WIDTH_METRES * XR_SCREEN_ASPECT
export const XR_2D_SCREEN_CENTER = { x: 0, y: 0.45, z: 0.12 } as const

/** Human-readable camera-mode labels used by the footer button. */
export const XR_SCREEN_CAMERA_LABELS: Record<XrCameraMode, string> = {
  free: 'Standard',
  '2d': '2D',
  center: 'Center',
}

export const XR_SCREEN_VIEWS = ['stage', 'activity', 'authors', 'settings', 'help', 'warnings'] as const
export type XrScreenView = (typeof XR_SCREEN_VIEWS)[number]

export const XR_SETTINGS_TABS = ['visual', 'camera', 'filters', 'music', 'data'] as const
export type XrSettingsTab = (typeof XR_SETTINGS_TABS)[number]

export const XR_SETTINGS_TAB_LABELS: Record<XrSettingsTab, string> = {
  visual: 'Visual',
  camera: 'Camera',
  filters: 'Filters',
  music: 'Music',
  data: 'Data',
}

/** Boolean renderer settings the VR UI can toggle. */
export const XR_TOGGLE_SETTINGS = [
  'showLabels',
  'showDirectoryLabels',
  'showFileLabels',
  'showFileSizes',
  'showAuthorNames',
  'showEdges',
  'showDirs',
  'showGrid',
  'showBeams',
  'showPlasma',
  'audioReactive',
  'followActivity',
  'autoZoom',
  'dynamicLayout',
  'gamepad',
] as const
export type XrToggleSetting = (typeof XR_TOGGLE_SETTINGS)[number] | 'hideHiddenFolders'

/** Settings cycled through one of a short list of values. */
export const XR_CYCLE_SETTINGS = ['sizeMode', 'fileColorMode'] as const
export type XrCycleSetting = (typeof XR_CYCLE_SETTINGS)[number]

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type XrScreenAction =
  | { kind: 'view'; view: XrScreenView }
  | { kind: 'close' }
  | { kind: 'restart' }
  | { kind: 'step'; delta: number }
  | { kind: 'togglePlay' }
  | { kind: 'seek'; ratio: number }
  | { kind: 'cycleSpeed' }
  | { kind: 'cycleCamera' }
  | { kind: 'recenter' }
  | { kind: 'exitVr' }
  | { kind: 'toggleMinimap' }
  | { kind: 'authorPage'; delta: number }
  | { kind: 'toggleAuthor'; id: string }
  | { kind: 'showAllAuthors' }
  | { kind: 'clearFilters' }
  | { kind: 'settingsTab'; tab: XrSettingsTab }
  | { kind: 'toggleSetting'; key: XrToggleSetting }
  | { kind: 'cycleSetting'; key: XrCycleSetting }
  | { kind: 'audioSource'; source: 'file' | 'microphone' }
  | { kind: 'adjustVolume'; delta: number }
  | { kind: 'adjustViewHeight'; delta: number }
  | { kind: 'clearMusic' }
  | { kind: 'jump'; ratio: number }
  | { kind: 'cancelLoad' }

export interface XrAuthorRow {
  id: string
  name: string
  color: string
  commits: number
  project?: string
  hidden: boolean
}

export interface XrScreenSettings {
  showLabels: boolean
  showDirectoryLabels: boolean
  showFileLabels: boolean
  showFileSizes: boolean
  showAuthorNames: boolean
  showEdges: boolean
  showDirs: boolean
  showGrid: boolean
  showBeams: boolean
  showPlasma: boolean
  audioReactive: boolean
  followActivity: boolean
  autoZoom: boolean
  dynamicLayout: boolean
  gamepad: boolean
  hideHiddenFolders: boolean
  sizeMode: SizeMode
  fileColorMode: 'extension' | 'activity' | 'flat'
  /** Height of the VR standard overview above the tabletop, in metres. */
  xrViewHeight: number
}

export interface XrPlaybackState {
  buckets: ActivityBucket[]
  position: number
  duration: number
  date: string
  progress: number
  playing: boolean
  speed: number
  cameraMode: XrCameraMode
  index: number
  total: number
  startDate: string
  endDate: string
  filterLabel: string | null
}

export interface XrLoadingState {
  active: boolean
  streaming: boolean
  status: string
  loaded: number
  target: number
  requests: number
  rateRemaining?: number
  error: string | null
}

export interface XrRecordingState {
  width: number
  height: number
  fps: number
  speed: number
  percent: number
  elapsed: number
}

export interface XrScreenState {
  view: XrScreenView
  settingsTab: XrSettingsTab
  hovered: string | null
  repoLabel: string
  repoTitle: string
  summary: string
  providers: string[]
  partialHistory: boolean
  loading: XrLoadingState
  warnings: string[]
  xrError: string | null
  recording: XrRecordingState | null
  info: InfoPanelModel
  stats: {
    commits: number
    authors: number
    files: number
    dirs: number
    additions: number
    deletions: number
    totalBytes: number
    merges: number
    withoutFileData: number
  }
  playback: XrPlaybackState
  authors: {
    rows: XrAuthorRow[]
    page: number
    pages: number
    total: number
    hiddenCount: number
  }
  activity: {
    grid: WeekdayHourGrid
    calendar: ContributionCalendar
    summary: string
    calendarSummary: string
  }
  settings: XrScreenSettings
  projects: { name: string; commits: number; authors: number }[]
  minimapVisible: boolean
  music: {
    fileName: string | null
    source: 'file' | 'microphone'
    volume: number
    reactive: boolean
  }
  /** Draws the shared minimap into the overview card. */
  drawMinimap?: (ctx: CanvasRenderingContext2D, x: number, y: number, size: number) => void
}

export interface XrScreenControl {
  id: string
  rect: Rect
  action: XrScreenAction
  label: string
  value?: string
  active?: boolean
  disabled?: boolean
  role?: 'button' | 'tab' | 'row' | 'author'
}

export interface XrScreenLayout {
  width: number
  height: number
  header: Rect
  body: Rect
  footer: Rect
  timeline: Rect
  content: Rect | null
  info: Rect | null
  minimap: Rect | null
  controls: XrScreenControl[]
}

export type XrScreenHit =
  | { kind: 'control'; id: string; action: XrScreenAction }
  | { kind: 'timeline'; ratio: number }

const PAD = 24
const HEADER_HEIGHT = 88
const FOOTER_HEIGHT = 260
const BODY_GAP = 12

function addControl(
  controls: XrScreenControl[],
  id: string,
  rect: Rect,
  action: XrScreenAction,
  label: string,
  extra: Partial<Omit<XrScreenControl, 'id' | 'rect' | 'action' | 'label'>> = {},
): void {
  controls.push({ id, rect, action, label, ...extra })
}

function topControls(width: number, state: XrScreenState, controls: XrScreenControl[]): Rect {
  const header: Rect = { x: PAD, y: PAD, width: width - PAD * 2, height: HEADER_HEIGHT }
  const buttonWidth = 104
  const buttonHeight = 56
  const gap = 8
  const actions: { id: string; action: XrScreenAction; label: string; active?: boolean }[] = [
    { id: 'view-activity', action: { kind: 'view', view: 'activity' }, label: 'Activity', active: state.view === 'activity' },
    { id: 'view-authors', action: { kind: 'view', view: 'authors' }, label: 'Authors', active: state.view === 'authors' },
    { id: 'map', action: { kind: 'toggleMinimap' }, label: state.minimapVisible ? 'Map on' : 'Map off', active: state.minimapVisible },
    { id: 'view-settings', action: { kind: 'view', view: 'settings' }, label: 'Settings', active: state.view === 'settings' },
    { id: 'view-help', action: { kind: 'view', view: 'help' }, label: 'Help', active: state.view === 'help' },
    { id: 'recenter', action: { kind: 'recenter' }, label: 'Recenter' },
    { id: 'exit-vr', action: { kind: 'exitVr' }, label: 'Exit VR' },
  ]
  const total = actions.length * buttonWidth + (actions.length - 1) * gap
  let x = header.x + header.width - 16 - total
  for (const entry of actions) {
    addControl(controls, entry.id, { x, y: header.y + 16, width: buttonWidth, height: buttonHeight }, entry.action, entry.label, {
      active: entry.active,
    })
    x += buttonWidth + gap
  }
  return header
}

/** Build every hit rectangle and visible control for the current screen state. */
export function screenLayout(
  state: XrScreenState,
  width = XR_SCREEN_CANVAS_WIDTH,
  height = XR_SCREEN_CANVAS_HEIGHT,
): XrScreenLayout {
  const controls: XrScreenControl[] = []
  const header = topControls(width, state, controls)

  const footer: Rect = { x: PAD, y: height - PAD - FOOTER_HEIGHT, width: width - PAD * 2, height: FOOTER_HEIGHT }
  const timeline: Rect = { x: footer.x + 16, y: footer.y + 14, width: footer.width - 32, height: 126 }
  const transportY = timeline.y + timeline.height + 12
  const transportHeight = footer.y + footer.height - 16 - transportY

  const transport: { id: string; label: string; width: number; action: XrScreenAction; active?: boolean }[] = [
    { id: 'restart', label: 'Restart', width: 100, action: { kind: 'restart' } },
    { id: 'prev', label: 'Prev', width: 92, action: { kind: 'step', delta: -1 } },
    {
      id: 'play',
      label: state.playback.playing ? 'Pause' : 'Play',
      width: 132,
      action: { kind: 'togglePlay' },
      active: state.playback.playing,
    },
    { id: 'next', label: 'Next', width: 92, action: { kind: 'step', delta: 1 } },
    { id: 'speed', label: `Speed ${state.playback.speed}×`, width: 172, action: { kind: 'cycleSpeed' } },
    {
      id: 'camera',
      label: `View ${XR_SCREEN_CAMERA_LABELS[state.playback.cameraMode]}`,
      width: 172,
      action: { kind: 'cycleCamera' },
    },
    { id: 'recenter-footer', label: 'Recenter', width: 154, action: { kind: 'recenter' } },
  ]
  let x = footer.x + 16
  for (const entry of transport) {
    addControl(controls, entry.id, { x, y: transportY, width: entry.width, height: transportHeight }, entry.action, entry.label, {
      active: entry.active,
    })
    x += entry.width + 10
  }

  const jumps: { id: string; label: string; ratio: number }[] = [
    { id: 'jump-start', label: 'Start', ratio: 0 },
    { id: 'jump-25', label: '25%', ratio: 0.25 },
    { id: 'jump-50', label: '50%', ratio: 0.5 },
    { id: 'jump-75', label: '75%', ratio: 0.75 },
    { id: 'jump-end', label: 'End', ratio: 1 },
  ]
  x = Math.max(x + 18, footer.x + 1000)
  for (const entry of jumps) {
    addControl(controls, entry.id, { x, y: transportY, width: 82, height: transportHeight }, { kind: 'jump', ratio: entry.ratio }, entry.label)
    x += 82 + 8
  }

  const body: Rect = {
    x: PAD,
    y: PAD + HEADER_HEIGHT + PAD,
    width: width - PAD * 2,
    height: footer.y - BODY_GAP - (PAD + HEADER_HEIGHT + PAD),
  }

  let info: Rect | null = null
  let minimap: Rect | null = null
  let content: Rect | null = null

  if (state.view === 'stage') {
    info = { x: body.x, y: body.y, width: 504, height: body.height }
    if (state.minimapVisible) {
      minimap = { x: width - PAD - 320, y: body.y, width: 320, height: 372 }
    }
    addStageNoticeControls(state, info, minimap, body, width, controls)
  } else {
    content = { x: body.x, y: body.y, width: body.width, height: body.height }
    addControl(
      controls,
      'close',
      { x: content.x + content.width - 16 - 100, y: content.y + 16, width: 100, height: 52 },
      { kind: 'close' },
      'Close',
    )
    if (state.view === 'authors') addAuthorControls(state, content, controls)
    if (state.view === 'settings') addSettingsControls(state, content, controls)
  }

  return { width, height, header, body, footer, timeline, content, info, minimap, controls }
}

/** Painting the notice cards and their buttons, when there is something to show. */
function addStageNoticeControls(
  state: XrScreenState,
  info: Rect,
  minimap: Rect | null,
  body: Rect,
  width: number,
  controls: XrScreenControl[],
): void {
  const left = info.x + info.width + 24
  const right = (minimap?.x ?? width - PAD) - 24
  const noticeWidth = Math.max(280, right - left)
  let y = body.y
  if (state.loading.active || state.loading.streaming) {
    addControl(
      controls,
      'stop-loading',
      { x: left + noticeWidth - 16 - 104, y: y + 20, width: 104, height: 52 },
      { kind: 'cancelLoad' },
      'Stop',
    )
    y += 96
  }
  if (state.loading.error && !state.loading.active) y += 88
  if (state.warnings.length > 0) {
    addControl(
      controls,
      'warnings',
      { x: left + noticeWidth - 16 - 112, y: y + 10, width: 112, height: 48 },
      { kind: 'view', view: 'warnings' },
      'Details',
    )
    y += 68
  }
  if (state.recording) y += 72
  void y
}

function addAuthorControls(state: XrScreenState, content: Rect, controls: XrScreenControl[]): void {
  addControl(
    controls,
    'authors-show-all',
    { x: content.x + 16, y: content.y + 82, width: 158, height: 52 },
    { kind: 'showAllAuthors' },
    'Show all',
  )
  addControl(
    controls,
    'authors-clear-filters',
    { x: content.x + 186, y: content.y + 82, width: 190, height: 52 },
    { kind: 'clearFilters' },
    'Clear filters',
  )
  const nextX = content.x + content.width - 16 - 92
  const prevX = nextX - 10 - 92
  addControl(
    controls,
    'authors-prev',
    { x: prevX, y: content.y + 82, width: 92, height: 52 },
    { kind: 'authorPage', delta: -1 },
    'Prev',
    { disabled: state.authors.page <= 0 },
  )
  addControl(
    controls,
    'authors-next',
    { x: nextX, y: content.y + 82, width: 92, height: 52 },
    { kind: 'authorPage', delta: 1 },
    'Next',
    { disabled: state.authors.page >= state.authors.pages - 1 },
  )

  const rows = state.authors.rows.slice(state.authors.page * 10, state.authors.page * 10 + 10)
  const columnWidth = (content.width - 48) / 2
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) continue
    const column = index < 5 ? 0 : 1
    const line = index % 5
    const rect = {
      x: content.x + 16 + column * (columnWidth + 16),
      y: content.y + 150 + line * 74,
      width: columnWidth,
      height: 68,
    }
    addControl(
      controls,
      `author:${row.id}`,
      rect,
      { kind: 'toggleAuthor', id: row.id },
      row.name,
      { role: 'author', active: !row.hidden, value: `${row.commits}` },
    )
  }
}

function settingsRow(
  controls: XrScreenControl[],
  content: Rect,
  index: number,
  id: string,
  label: string,
  value: string,
  action: XrScreenAction,
  options: { active?: boolean; disabled?: boolean } = {},
): void {
  const columnWidth = (content.width - 48) / 2
  const column = index < 5 ? 0 : 1
  const line = index % 5
  const rect = {
    x: content.x + 16 + column * (columnWidth + 16),
    y: content.y + 140 + line * 74,
    width: columnWidth,
    height: 68,
  }
  addControl(controls, id, rect, action, label, {
    role: 'row',
    value,
    active: options.active,
    disabled: options.disabled,
  })
}

function addSettingsControls(state: XrScreenState, content: Rect, controls: XrScreenControl[]): void {
  let tabX = content.x + 16
  for (const tab of XR_SETTINGS_TABS) {
    addControl(
      controls,
      `settings-tab:${tab}`,
      { x: tabX, y: content.y + 74, width: 160, height: 48 },
      { kind: 'settingsTab', tab },
      XR_SETTINGS_TAB_LABELS[tab],
      { role: 'tab', active: state.settingsTab === tab },
    )
    tabX += 160 + 8
  }

  const settings = state.settings
  if (state.settingsTab === 'visual') {
    const rows: { key: XrToggleSetting; label: string }[] = [
      { key: 'showLabels', label: 'Labels' },
      { key: 'showDirectoryLabels', label: 'Directory labels' },
      { key: 'showFileLabels', label: 'File labels' },
      { key: 'showFileSizes', label: 'File sizes' },
      { key: 'showAuthorNames', label: 'Author names' },
      { key: 'showEdges', label: 'Branches' },
      { key: 'showDirs', label: 'Directory spheres' },
      { key: 'showGrid', label: 'Grid' },
      { key: 'showBeams', label: 'Beams' },
      { key: 'showPlasma', label: 'Plasma' },
    ]
    rows.forEach((row, index) => {
      settingsRow(controls, content, index, `setting:${row.key}`, row.label, settings[row.key] ? 'On' : 'Off', {
        kind: 'toggleSetting',
        key: row.key,
      }, { active: settings[row.key] })
    })
    return
  }

  if (state.settingsTab === 'camera') {
    settingsRow(controls, content, 0, 'setting:followActivity', 'Follow activity', settings.followActivity ? 'On' : 'Off', { kind: 'toggleSetting', key: 'followActivity' }, { active: settings.followActivity })
    settingsRow(controls, content, 1, 'setting:autoZoom', 'Automatic zoom', settings.autoZoom ? 'On' : 'Off', { kind: 'toggleSetting', key: 'autoZoom' }, { active: settings.autoZoom })
    settingsRow(controls, content, 2, 'setting:dynamicLayout', 'Dynamic layout', settings.dynamicLayout ? 'On' : 'Off', { kind: 'toggleSetting', key: 'dynamicLayout' }, { active: settings.dynamicLayout })
    settingsRow(controls, content, 3, 'setting:gamepad', 'Gamepad', settings.gamepad ? 'On' : 'Off', { kind: 'toggleSetting', key: 'gamepad' }, { active: settings.gamepad })
    settingsRow(controls, content, 4, 'cycle:sizeMode', 'File size source', settings.sizeMode, { kind: 'cycleSetting', key: 'sizeMode' })
    settingsRow(controls, content, 5, 'cycle:fileColorMode', 'File colour', settings.fileColorMode, { kind: 'cycleSetting', key: 'fileColorMode' })
    settingsRow(controls, content, 6, 'cycle:camera', 'Camera view', XR_SCREEN_CAMERA_LABELS[state.playback.cameraMode], { kind: 'cycleCamera' })
    settingsRow(controls, content, 7, 'recenter-settings', 'Recenter view', 'Now', { kind: 'recenter' })
    settingsRow(controls, content, 8, 'camera-height-down', 'VR height −', `${settings.xrViewHeight.toFixed(1)} m`, { kind: 'adjustViewHeight', delta: -0.1 })
    settingsRow(controls, content, 9, 'camera-height-up', 'VR height +', `${settings.xrViewHeight.toFixed(1)} m`, { kind: 'adjustViewHeight', delta: 0.1 })
    return
  }

  if (state.settingsTab === 'filters') {
    settingsRow(controls, content, 0, 'setting:hideHiddenFolders', 'Hide hidden folders', settings.hideHiddenFolders ? 'On' : 'Off', { kind: 'toggleSetting', key: 'hideHiddenFolders' }, { active: settings.hideHiddenFolders })
    settingsRow(controls, content, 1, 'filters-clear', 'Clear every filter', 'Run', { kind: 'clearFilters' })
    settingsRow(controls, content, 2, 'filters-show-all', 'Show all authors', `${state.authors.hiddenCount} hidden`, { kind: 'showAllAuthors' })
    settingsRow(controls, content, 3, 'filters-warnings', 'Notes about this load', String(state.warnings.length), { kind: 'view', view: 'warnings' })
    settingsRow(controls, content, 4, 'filters-date', 'Date filter', state.playback.filterLabel ?? 'off', { kind: 'view', view: 'warnings' }, { disabled: true })
    return
  }

  if (state.settingsTab === 'music') {
    settingsRow(controls, content, 0, 'setting:audioReactive', 'Audio-reactive visuals', settings.audioReactive ? 'On' : 'Off', { kind: 'toggleSetting', key: 'audioReactive' }, { active: settings.audioReactive })
    settingsRow(controls, content, 1, 'audio-source-file', 'Audio source: file', state.music.source === 'file' ? 'On' : 'Off', { kind: 'audioSource', source: 'file' }, { active: state.music.source === 'file' })
    settingsRow(controls, content, 2, 'audio-source-microphone', 'Audio source: microphone', state.music.source === 'microphone' ? 'On' : 'Off', { kind: 'audioSource', source: 'microphone' }, { active: state.music.source === 'microphone' })
    settingsRow(controls, content, 3, 'music-volume-down', 'Volume down', `${Math.round(state.music.volume * 100)}%`, { kind: 'adjustVolume', delta: -0.1 })
    settingsRow(controls, content, 4, 'music-volume-up', 'Volume up', `${Math.round(state.music.volume * 100)}%`, { kind: 'adjustVolume', delta: 0.1 })
    settingsRow(controls, content, 5, 'music-clear', 'Clear loaded track', state.music.fileName ? 'Clear' : 'none', { kind: 'clearMusic' }, { disabled: !state.music.fileName })
    settingsRow(controls, content, 6, 'music-track', 'Track', state.music.fileName ?? 'No file', { kind: 'clearMusic' }, { disabled: true })
    return
  }

  // Data: the tab is informational; drawSettings paints its project and
  // statistics grid directly, so it contributes no setting rows.
}

/** Hit-test the UI plane. Timeline hits return the seek ratio. */
export function hitTestScreen(layout: XrScreenLayout, x: number, y: number): XrScreenHit | null {
  for (let index = layout.controls.length - 1; index >= 0; index -= 1) {
    const control = layout.controls[index]
    if (!control || control.disabled) continue
    const rect = control.rect
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      return { kind: 'control', id: control.id, action: control.action }
    }
  }
  const timeline = layout.timeline
  if (x >= timeline.x && x <= timeline.x + timeline.width && y >= timeline.y && y <= timeline.y + timeline.height) {
    const ratio = timeline.width > 0 ? Math.min(1, Math.max(0, (x - timeline.x) / timeline.width)) : 0
    return { kind: 'timeline', ratio }
  }
  return null
}

/** Stable id for dwell/hover state. */
export function xrScreenTargetId(hit: XrScreenHit | null): string | null {
  if (!hit) return null
  return hit.kind === 'control' ? hit.id : 'timeline'
}

/** The engine action for a hit. */
export function xrScreenAction(hit: XrScreenHit): XrScreenAction {
  return hit.kind === 'timeline' ? { kind: 'seek', ratio: hit.ratio } : hit.action
}

/** Cheap content signature so the canvas texture is only uploaded when needed. */
export function xrScreenKey(state: XrScreenState): string {
  const playback = state.playback
  const loading = state.loading
  return [
    state.view,
    state.settingsTab,
    state.hovered ?? '',
    state.repoLabel,
    state.summary,
    state.providers.join(','),
    state.partialHistory ? 1 : 0,
    loading.active ? 1 : 0,
    loading.streaming ? 1 : 0,
    loading.status,
    loading.loaded,
    loading.target,
    loading.requests,
    loading.rateRemaining ?? '',
    loading.error ?? '',
    state.warnings.length,
    state.warnings.join(';'),
    state.xrError ?? '',
    state.recording
      ? `${state.recording.width}x${state.recording.height}:${Math.round(state.recording.percent)}:${Math.round(state.recording.elapsed)}`
      : '',
    JSON.stringify(state.info),
    state.stats.commits,
    state.stats.authors,
    state.stats.files,
    state.stats.dirs,
    state.stats.additions,
    state.stats.deletions,
    state.stats.totalBytes,
    state.stats.merges,
    state.stats.withoutFileData,
    playback.date,
    Math.round(playback.progress * 2000),
    playback.playing ? 1 : 0,
    playback.speed,
    playback.cameraMode,
    playback.index,
    playback.total,
    playback.startDate,
    playback.endDate,
    playback.filterLabel ?? '',
    state.authors.page,
    state.authors.pages,
    state.authors.total,
    state.authors.hiddenCount,
    state.authors.rows.map((row) => `${row.id}:${row.hidden ? 1 : 0}`).join(','),
    state.activity.grid.total,
    state.activity.grid.max,
    state.activity.calendar.total,
    state.activity.calendar.start,
    state.activity.calendar.end,
    state.activity.summary,
    state.activity.calendarSummary,
    JSON.stringify(state.settings),
    state.projects.map((project) => `${project.name}:${project.commits}:${project.authors}`).join(';'),
    state.minimapVisible ? 1 : 0,
    state.music.fileName ?? '',
    state.music.source,
    Math.round(state.music.volume * 100),
    state.music.reactive ? 1 : 0,
  ].join('|')
}

/* -------------------------------------------------------------------------- *
 * Drawing
 * -------------------------------------------------------------------------- */

const UI_FONT = '"Inter", system-ui, sans-serif'

function font(size: number, weight = ''): string {
  return `${weight ? `${weight} ` : ''}${Math.round(size)}px ${UI_FONT}`
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color = TEXT_COLOR,
  weight = '',
  align: CanvasTextAlign = 'left',
): void {
  ctx.font = font(size, weight)
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y)
}

function buttonFill(active: boolean, hovered: boolean): { background: string; border: string; text: string } {
  if (active) {
    return {
      background: 'rgba(47, 125, 224, 0.30)',
      border: 'rgba(94, 200, 255, 0.85)',
      text: '#eaf7ff',
    }
  }
  if (hovered) {
    return {
      background: 'rgba(94, 200, 255, 0.18)',
      border: 'rgba(94, 200, 255, 0.95)',
      text: '#f4fbff',
    }
  }
  return {
    background: 'rgba(255, 255, 255, 0.045)',
    border: 'rgba(255, 255, 255, 0.10)',
    text: TEXT_COLOR,
  }
}

function drawControl(ctx: CanvasRenderingContext2D, control: XrScreenControl, hovered: boolean): void {
  if (control.role === 'author') return
  const styles = buttonFill(Boolean(control.active), hovered)
  ctx.save()
  if (control.disabled) ctx.globalAlpha = 0.38
  drawPanel(ctx, control.rect.x, control.rect.y, control.rect.width, control.rect.height, {
    radius: control.role === 'row' ? 10 : 12,
    background: styles.background,
    border: styles.border,
  })
  const size = control.role === 'tab' ? 18 : control.role === 'row' ? 19 : 19
  if (control.role === 'row') {
    drawLabel(ctx, control.label, control.rect.x + 16, control.rect.y + control.rect.height / 2, size, styles.text, '600')
    if (control.value) {
      const valueSize = 16
      ctx.font = font(valueSize, '600')
      const valueWidth = Math.max(62, ctx.measureText(control.value).width + 22)
      drawPanel(ctx, control.rect.x + control.rect.width - valueWidth - 14, control.rect.y + 14, valueWidth, control.rect.height - 28, {
        radius: 8,
        background: control.active ? 'rgba(94,200,255,0.18)' : 'rgba(255,255,255,0.06)',
        border: control.active ? 'rgba(94,200,255,0.55)' : 'rgba(255,255,255,0.10)',
      })
      drawLabel(
        ctx,
        control.value,
        control.rect.x + control.rect.width - 14 - valueWidth / 2,
        control.rect.y + control.rect.height / 2,
        valueSize,
        styles.text,
        '600',
        'center',
      )
    }
  } else {
    drawLabel(
      ctx,
      fitText(ctx, control.label, control.rect.width - 16),
      control.rect.x + control.rect.width / 2,
      control.rect.y + control.rect.height / 2,
      size,
      styles.text,
      '600',
      'center',
    )
  }
  ctx.restore()
}

function drawHeader(ctx: CanvasRenderingContext2D, layout: XrScreenLayout, state: XrScreenState): void {
  const header = layout.header
  drawPanel(ctx, header.x, header.y, header.width, header.height, {
    radius: 16,
    background: 'rgba(7, 11, 22, 0.92)',
    border: 'rgba(255,255,255,0.10)',
  })
  drawLabel(ctx, 'WEB GOURCE', header.x + 20, header.y + 32, 17, '#cfeaff', '700')
  drawLabel(ctx, 'IMMERSIVE UI', header.x + 20, header.y + 58, 12, 'rgba(255,255,255,0.35)', '600')
  const infoX = header.x + 190
  const infoWidth = 560
  drawLabel(ctx, fitText(ctx, state.repoLabel, infoWidth), infoX, header.y + 30, 27, '#edf7ff', '650')
  let summary = state.summary
  if (state.loading.active || state.loading.streaming) {
    summary = `${state.loading.status} · ${state.loading.loaded}/${state.loading.target} commits`
  }
  // Keep the summary clear of the action buttons (which start at the right
  // edge of the header), so it truncates instead of running underneath them.
  const prefix = state.partialHistory ? 'partial history · ' : ''
  const summaryText = `${prefix}${summary}`
  drawLabel(ctx, fitText(ctx, summaryText, infoWidth - 10), infoX, header.y + 62, 16, TEXT_COLOR)
}

function drawFooter(ctx: CanvasRenderingContext2D, layout: XrScreenLayout, state: XrScreenState): void {
  const footer = layout.footer
  const timeline = layout.timeline
  const playback = state.playback
  drawPanel(ctx, footer.x, footer.y, footer.width, footer.height, {
    radius: 16,
    background: 'rgba(7, 11, 22, 0.92)',
    border: 'rgba(255,255,255,0.10)',
  })
  drawPanel(ctx, timeline.x, timeline.y, timeline.width, timeline.height, {
    radius: 12,
    background: 'rgba(255,255,255,0.025)',
    border: 'rgba(255,255,255,0.08)',
  })

  const labelY = timeline.y + 20
  drawLabel(ctx, playback.date, timeline.x + 14, labelY, 18, '#e6f4ff', '600')
  drawLabel(
    ctx,
    `${Math.round(playback.progress * 100)}% · ${playback.playing ? 'playing' : 'paused'} · ${playback.speed}×`,
    timeline.x + timeline.width - 14,
    labelY,
    16,
    TEXT_COLOR,
    '',
    'right',
  )

  const hist = {
    x: timeline.x + 14,
    y: timeline.y + 38,
    width: timeline.width - 28,
    height: timeline.height - 66,
  }
  ctx.save()
  ctx.beginPath()
  ctx.rect(hist.x, hist.y, hist.width, hist.height)
  ctx.clip()
  // The histogram draws in its own 0..width/0..height space; move that space
  // into the clipped timeline card.
  ctx.translate(hist.x, hist.y)
  drawActivityBars(ctx, {
    width: hist.width,
    height: hist.height,
    buckets: playback.buckets,
    position: playback.position,
    duration: playback.duration,
    clear: false,
  })
  ctx.restore()

  const meta = [
    `commit ${Math.max(1, playback.index + 1)}/${playback.total}`,
    `${playback.startDate} → ${playback.endDate}`,
  ]
  if (playback.filterLabel) meta.push(`filter ${playback.filterLabel}`)
  drawLabel(ctx, fitText(ctx, meta.join(' · '), timeline.width - 28), timeline.x + 14, timeline.y + timeline.height - 10, 14, TEXT_COLOR)
}

function drawStageBody(ctx: CanvasRenderingContext2D, layout: XrScreenLayout, state: XrScreenState): void {
  if (layout.info) {
    const info = layout.info
    drawInfoPanel(ctx, state.info, {
      x: info.x,
      y: info.y,
      width: info.width,
      height: info.height,
      unit: 18,
      font: font(18),
      smallFont: font(14),
      monoFont: font(15),
      panel: (x, y, width, height) =>
        drawPanel(ctx, x, y, width, height, {
          radius: 16,
          background: 'rgba(7, 11, 22, 0.90)',
          border: 'rgba(255,255,255,0.10)',
        }),
    })
  }

  if (layout.minimap) drawMinimapCard(ctx, layout.minimap, state)
  drawStageNotices(ctx, layout, state)

  const hintX = layout.info && layout.minimap
    ? (layout.info.x + layout.info.width + layout.minimap.x) / 2
    : layout.width / 2
  drawLabel(
    ctx,
    'Gaze for 2 s to activate · trigger or click recenters',
    hintX,
    layout.body.y + layout.body.height - 14,
    14,
    'rgba(255,255,255,0.32)',
    '',
    'center',
  )
}

function drawMinimapCard(ctx: CanvasRenderingContext2D, rect: Rect, state: XrScreenState): void {
  drawPanel(ctx, rect.x, rect.y, rect.width, rect.height, {
    radius: 16,
    background: 'rgba(7, 11, 22, 0.90)',
    border: 'rgba(255,255,255,0.10)',
  })
  drawLabel(ctx, 'OVERVIEW', rect.x + 12, rect.y + 20, 14, TEXT_COLOR, '600')
  const repo = state.providers.length > 1 ? `${state.providers.length} hosts` : state.repoLabel
  drawLabel(ctx, fitText(ctx, repo, rect.width - 120), rect.x + rect.width - 12, rect.y + 20, 13, 'rgba(255,255,255,0.38)', '', 'right')
  const size = Math.min(rect.width - 24, rect.height - 74)
  const map = { x: rect.x + 12, y: rect.y + 36, width: size, height: size }
  if (state.drawMinimap) {
    ctx.save()
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') ctx.roundRect(map.x, map.y, map.width, map.height, 8)
    else ctx.rect(map.x, map.y, map.width, map.height)
    ctx.clip()
    state.drawMinimap(ctx, map.x, map.y, map.width)
    ctx.restore()
  } else {
    drawPanel(ctx, map.x, map.y, map.width, map.height, { radius: 8, background: 'rgba(6,9,18,0.72)' })
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.lineWidth = 1
  ctx.strokeRect(map.x + 0.5, map.y + 0.5, map.width - 1, map.height - 1)

  let legendX = rect.x + 12
  const legendY = rect.y + rect.height - 16
  const items = [
    ['directories', 'rgba(120,170,235,0.75)'],
    ['files', 'rgba(255,235,180,0.9)'],
    ['authors', '#ffffff'],
  ] as const
  for (const [label, color] of items) {
    ctx.fillStyle = color
    ctx.fillRect(legendX, legendY - 4, 8, 8)
    legendX += 12
    drawLabel(ctx, label, legendX, legendY, 12, TEXT_COLOR)
    legendX += Math.max(50, ctx.measureText(label).width + 16)
  }
}

function drawStageNotices(ctx: CanvasRenderingContext2D, layout: XrScreenLayout, state: XrScreenState): void {
  if (!layout.info) return
  const left = layout.info.x + layout.info.width + 24
  const right = (layout.minimap?.x ?? layout.width - PAD) - 24
  const width = Math.max(280, right - left)
  let y = layout.body.y

  if (state.loading.active || state.loading.streaming) {
    drawPanel(ctx, left, y, width, 88, {
      radius: 12,
      background: 'rgba(9, 20, 38, 0.92)',
      border: 'rgba(94,200,255,0.30)',
    })
    ctx.strokeStyle = 'rgba(94,200,255,0.85)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(left + 26, y + 30, 10, -Math.PI / 2, Math.PI * 1.1)
    ctx.stroke()
    drawLabel(ctx, fitText(ctx, state.loading.status, width - 180), left + 48, y + 26, 17, '#dff1ff', '600')
    const progress = state.loading.target > 0 ? Math.min(1, state.loading.loaded / state.loading.target) : 0
    drawLabel(
      ctx,
      `${state.loading.loaded}/${state.loading.target} commits · ${state.loading.requests} requests`,
      left + 48,
      y + 51,
      14,
      TEXT_COLOR,
    )
    drawPanel(ctx, left + 48, y + 66, width - 190, 6, { radius: 3, background: 'rgba(255,255,255,0.08)' })
    ctx.fillStyle = 'rgba(94,200,255,0.9)'
    ctx.fillRect(left + 48, y + 66, Math.max(3, (width - 190) * progress), 6)
    y += 96
  }

  if (state.loading.error && !state.loading.active) {
    drawPanel(ctx, left, y, width, 80, {
      radius: 12,
      background: 'rgba(38, 12, 18, 0.92)',
      border: 'rgba(255,93,108,0.34)',
    })
    drawLabel(ctx, 'Loading stopped', left + 16, y + 26, 17, '#ffb8c0', '650')
    drawLabel(ctx, fitText(ctx, state.loading.error, width - 32), left + 16, y + 52, 14, TEXT_COLOR)
    y += 88
  }

  if (state.warnings.length > 0) {
    drawPanel(ctx, left, y, width, 60, {
      radius: 12,
      background: 'rgba(40, 30, 8, 0.88)',
      border: 'rgba(255,200,87,0.30)',
    })
    drawLabel(ctx, '!', left + 18, y + 30, 20, '#ffc857', '700', 'center')
    drawLabel(
      ctx,
      `${state.warnings.length} note${state.warnings.length === 1 ? '' : 's'} about this load`,
      left + 38,
      y + 30,
      15,
      '#f4e7c0',
      '600',
    )
    y += 68
  }

  if (state.recording) {
    const rec = state.recording
    drawPanel(ctx, left, y, width, 62, {
      radius: 12,
      background: 'rgba(38, 12, 18, 0.90)',
      border: 'rgba(255,93,108,0.35)',
    })
    ctx.fillStyle = '#ff5d6c'
    ctx.beginPath()
    ctx.arc(left + 22, y + 31, 6, 0, Math.PI * 2)
    ctx.fill()
    drawLabel(
      ctx,
      `Recording ${rec.width}×${rec.height} @ ${rec.fps} fps · ${Math.round(rec.percent)}% · ${Math.round(rec.elapsed)}s`,
      left + 40,
      y + 31,
      15,
      '#ffd6da',
      '600',
    )
    y += 70
  }
  void y
}

function drawContentChrome(ctx: CanvasRenderingContext2D, content: Rect): void {
  drawPanel(ctx, content.x, content.y, content.width, content.height, {
    radius: 16,
    background: 'rgba(7, 11, 22, 0.94)',
    border: 'rgba(255,255,255,0.10)',
  })
}

function drawModalTitle(ctx: CanvasRenderingContext2D, content: Rect, title: string, subtitle: string): void {
  drawLabel(ctx, title, content.x + 18, content.y + 28, 26, '#edf7ff', '650')
  drawLabel(ctx, fitText(ctx, subtitle, content.width - 160), content.x + 18, content.y + 54, 15, TEXT_COLOR)
}

function drawActivity(ctx: CanvasRenderingContext2D, layout: XrScreenLayout, state: XrScreenState): void {
  const content = layout.content
  if (!content) return
  drawContentChrome(ctx, content)
  drawModalTitle(ctx, content, 'Activity', state.activity.summary)
  const gap = 16
  const cardWidth = (content.width - 48 - gap) / 2
  const cardHeight = content.height - 100
  const cards = [
    { x: content.x + 16, y: content.y + 84, width: cardWidth, height: cardHeight },
    { x: content.x + 16 + cardWidth + gap, y: content.y + 84, width: cardWidth, height: cardHeight },
  ]

  for (const [index, card] of cards.entries()) {
    drawPanel(ctx, card.x, card.y, card.width, card.height, {
      radius: 12,
      background: 'rgba(255,255,255,0.025)',
      border: 'rgba(255,255,255,0.08)',
    })
    if (index === 0) {
      drawLabel(ctx, 'Commits per weekday and hour', card.x + 14, card.y + 24, 17, TEXT_STRONG, '600')
      drawLabel(ctx, 'Horizontal: hour (UTC) · vertical: weekday', card.x + 14, card.y + 46, 13, TEXT_COLOR)
      ctx.save()
      ctx.translate(card.x + 14, card.y + 62)
      drawWeekdayHour(ctx, {
        width: card.width - 28,
        height: card.height - 76,
        grid: state.activity.grid,
        font: font(12),
        clear: false,
      })
      ctx.restore()
    } else {
      drawLabel(ctx, 'Contributions · last 53 weeks', card.x + 14, card.y + 24, 17, TEXT_STRONG, '600')
      drawLabel(ctx, state.activity.calendarSummary, card.x + 14, card.y + 46, 13, TEXT_COLOR)
      ctx.save()
      ctx.translate(card.x + 14, card.y + 62)
      drawContributionCalendar(ctx, {
        width: card.width - 28,
        height: card.height - 106,
        calendar: state.activity.calendar,
        font: font(12),
        clear: false,
      })
      ctx.restore()
      let legendX = card.x + 14
      const legendY = card.y + card.height - 18
      drawLabel(ctx, 'Less', legendX, legendY, 12, TEXT_COLOR)
      legendX += 38
      for (const shade of SHADES) {
        ctx.fillStyle = shade
        ctx.fillRect(legendX, legendY - 6, 12, 12)
        legendX += 17
      }
      drawLabel(ctx, 'More', legendX, legendY, 12, TEXT_COLOR)
    }
  }
}

function drawAuthors(ctx: CanvasRenderingContext2D, layout: XrScreenLayout, state: XrScreenState): void {
  const content = layout.content
  if (!content) return
  drawContentChrome(ctx, content)
  drawModalTitle(
    ctx,
    content,
    'Authors & filters',
    `${state.authors.total} author${state.authors.total === 1 ? '' : 's'} · ${state.authors.hiddenCount} hidden · page ${state.authors.page + 1}/${state.authors.pages}`,
  )

  const rows = state.authors.rows.slice(state.authors.page * 10, state.authors.page * 10 + 10)
  if (rows.length === 0) {
    drawLabel(ctx, 'No authors in the loaded timeline.', content.x + 24, content.y + 180, 18, TEXT_COLOR)
    return
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) continue
    const column = index < 5 ? 0 : 1
    const line = index % 5
    const columnWidth = (content.width - 48) / 2
    const rect = {
      x: content.x + 16 + column * (columnWidth + 16),
      y: content.y + 150 + line * 74,
      width: columnWidth,
      height: 68,
    }
    const hovered = state.hovered === `author:${row.id}`
    drawPanel(ctx, rect.x, rect.y, rect.width, rect.height, {
      radius: 10,
      background: hovered ? 'rgba(94,200,255,0.20)' : row.hidden ? 'rgba(255,255,255,0.018)' : 'rgba(255,255,255,0.045)',
      border: hovered ? 'rgba(94,200,255,0.9)' : row.hidden ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.10)',
    })
    ctx.globalAlpha = row.hidden ? 0.45 : 1
    ctx.fillStyle = row.color
    ctx.beginPath()
    ctx.arc(rect.x + 20, rect.y + 26, 6, 0, Math.PI * 2)
    ctx.fill()
    drawLabel(ctx, fitText(ctx, row.name, rect.width - 180), rect.x + 34, rect.y + 24, 18, '#e8f4ff', '600')
    const project = row.project ? row.project.split('/').pop() : ''
    drawLabel(
      ctx,
      fitText(ctx, project ? `${project} · ${row.commits} commits` : `${row.commits} commits`, rect.width - 110),
      rect.x + 34,
      rect.y + 47,
      13,
      TEXT_COLOR,
    )
    ctx.font = font(13, '600')
    drawLabel(ctx, row.hidden ? 'hidden' : 'visible', rect.x + rect.width - 16, rect.y + 34, 13, row.hidden ? '#ffb0b8' : '#9fe6c0', '600', 'right')
    ctx.globalAlpha = 1
  }
}

function settingRowsFor(state: XrScreenState): { label: string; value: string }[] {
  if (state.settingsTab !== 'data') return []
  const s = state.stats
  return [
    { label: 'Commits in view', value: s.commits.toLocaleString() },
    { label: 'Authors', value: s.authors.toLocaleString() },
    { label: 'Files in history', value: s.files.toLocaleString() },
    { label: 'Directories', value: s.dirs.toLocaleString() },
    { label: 'Additions / deletions', value: `+${s.additions.toLocaleString()} / −${s.deletions.toLocaleString()}` },
    { label: 'Tracked size', value: formatBytes(s.totalBytes) },
    { label: 'Merge commits', value: s.merges.toLocaleString() },
    { label: 'Without file data', value: s.withoutFileData.toLocaleString() },
    { label: 'Projects', value: String(state.projects.length) },
    { label: 'Size source', value: state.settings.sizeMode },
  ]
}

/** A quiet reminder at the bottom of the settings card, in its spare space. */
function drawSettingsHint(ctx: CanvasRenderingContext2D, content: Rect): void {
  drawLabel(
    ctx,
    'Rest the reticle on a row for 2 s · settings are shared with the desktop UI',
    content.x + 18,
    content.y + content.height - 24,
    13,
    'rgba(255,255,255,0.32)',
  )
}

function drawSettings(ctx: CanvasRenderingContext2D, layout: XrScreenLayout, state: XrScreenState): void {
  const content = layout.content
  if (!content) return
  drawContentChrome(ctx, content)
  drawModalTitle(ctx, content, 'Settings', 'Visualization, camera, filters, music and data — all from the VR screen')

  if (state.settingsTab === 'data') {
    const rows = settingRowsFor(state)
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (!row) continue
      const column = index < 5 ? 0 : 1
      const line = index % 5
      const columnWidth = (content.width - 48) / 2
      const rect = {
        x: content.x + 16 + column * (columnWidth + 16),
        y: content.y + 140 + line * 74,
        width: columnWidth,
        height: 68,
      }
      drawPanel(ctx, rect.x, rect.y, rect.width, rect.height, {
        radius: 10,
        background: 'rgba(255,255,255,0.035)',
        border: 'rgba(255,255,255,0.08)',
      })
      drawLabel(ctx, row.label, rect.x + 16, rect.y + 34, 17, TEXT_COLOR)
      drawLabel(ctx, fitText(ctx, row.value, rect.width - 200), rect.x + rect.width - 16, rect.y + 34, 17, '#e8f4ff', '600', 'right')
    }
    // The project list and warning line live under the grid, in the spare space.
    const projectsY = content.y + 140 + 5 * 74
    drawLabel(ctx, 'PROJECTS', content.x + 18, projectsY, 13, 'rgba(255,255,255,0.4)', '600')
    drawLabel(
      ctx,
      fitText(ctx, state.projects.map((project) => `${project.name} (${project.commits} commits, ${project.authors} authors)`).join(' · '), content.width - 36),
      content.x + 18,
      projectsY + 28,
      14,
      TEXT_COLOR,
    )
    drawSettingsHint(ctx, content)
    return
  }

  if (state.settingsTab === 'filters') {
    const range = state.playback.filterLabel ?? 'No date filter'
    drawLabel(
      ctx,
      fitText(ctx, `Date filter: ${range} · ${state.playback.startDate} → ${state.playback.endDate}`, content.width - 36),
      content.x + 18,
      content.y + 526,
      14,
      TEXT_COLOR,
    )
  }

  if (state.settingsTab === 'music') {
    drawLabel(
      ctx,
      fitText(ctx, state.music.fileName ? `Loaded track: ${state.music.fileName}` : 'No audio file loaded. Pick one in the desktop Settings → Music panel.', content.width - 36),
      content.x + 18,
      content.y + 526,
      14,
      TEXT_COLOR,
    )
  }

  drawSettingsHint(ctx, content)
}

/** The small load summary at the bottom of the warnings page. */
function drawLoadStatus(ctx: CanvasRenderingContext2D, content: Rect, state: XrScreenState): void {
  const top = content.y + content.height - 92
  drawPanel(ctx, content.x + 16, top, content.width - 32, 76, {
    radius: 12,
    background: 'rgba(255,255,255,0.025)',
    border: 'rgba(255,255,255,0.08)',
  })
  drawLabel(ctx, 'LOAD STATUS', content.x + 32, top + 24, 12, 'rgba(255,255,255,0.4)', '600')
  const loading = state.loading
  const status = loading.active ? 'Loading' : loading.error ? 'Stopped' : loading.status || 'Ready'
  const parts = [
    status,
    `${loading.loaded.toLocaleString()}/${loading.target.toLocaleString()} commits`,
    `${loading.requests.toLocaleString()} requests`,
  ]
  if (loading.rateRemaining !== undefined) parts.push(`${loading.rateRemaining.toLocaleString()} quota left`)
  if (state.partialHistory) parts.push('partial history')
  if (state.recording) parts.push(`recording ${Math.round(state.recording.percent)}%`)
  drawLabel(
    ctx,
    fitText(ctx, parts.join(' · '), content.width - 64),
    content.x + 32,
    top + 51,
    15,
    TEXT_COLOR,
  )
}

function drawWarnings(ctx: CanvasRenderingContext2D, layout: XrScreenLayout, state: XrScreenState): void {
  const content = layout.content
  if (!content) return
  drawContentChrome(ctx, content)
  drawModalTitle(ctx, content, 'Warnings & load status', 'Everything the last load wanted to tell you')
  let y = content.y + 100
  const statusTop = content.y + content.height - 108
  const lines: { text: string; color: string }[] = []
  if (state.loading.error) lines.push({ text: `Loading stopped: ${state.loading.error}`, color: '#ffb8c0' })
  if (state.xrError) lines.push({ text: `VR: ${state.xrError}`, color: '#ffb8c0' })
  for (const warning of state.warnings) lines.push({ text: `• ${warning}`, color: TEXT_COLOR })
  if (lines.length === 0) {
    drawLabel(ctx, 'No warnings. Everything loaded cleanly.', content.x + 20, y + 18, 18, TEXT_COLOR)
    drawLoadStatus(ctx, content, state)
    return
  }
  let truncated = false
  for (const line of lines) {
    ctx.font = font(16)
    const wrapped = wrapText(ctx, line.text, content.width - 40, 3)
    for (const part of wrapped) {
      if (y + 20 > statusTop) {
        truncated = true
        break
      }
      drawLabel(ctx, part, content.x + 20, y + 18, 16, line.color)
      y += 25
    }
    if (truncated) break
    y += 10
  }
  if (truncated) {
    drawLabel(ctx, '…more notes are available in the desktop warnings panel.', content.x + 20, y + 16, 13, 'rgba(255,255,255,0.4)')
  }
  drawLoadStatus(ctx, content, state)
}

function drawHelp(ctx: CanvasRenderingContext2D, layout: XrScreenLayout): void {
  const content = layout.content
  if (!content) return
  drawContentChrome(ctx, content)
  drawModalTitle(ctx, content, 'How the immersive screen works', 'Everything is drawn into this one plane — the scene stays visible through the middle')

  const sections = [
    {
      title: 'Gaze & dwell',
      lines: [
        'A circular reticle sits at the centre of your view.',
        'Rest it on a control for two seconds: the ring fills and the control activates.',
        'Look away to cancel before it fires. The hovered control lights up.',
      ],
    },
    {
      title: 'Recenter',
      lines: [
        'Press the controller trigger, or click the mirrored desktop canvas, to recenter.',
        'Your current heading becomes the standard view forward, without leaving the vantage.',
        'The header and footer also have a Recenter button.',
      ],
    },
    {
      title: 'Playback',
      lines: [
        'The bottom strip is the complete history. The bright bars have played.',
        'Rest the reticle anywhere on the strip to seek there.',
        'Restart, Prev, Play/Pause, Next, Speed and View work exactly like their desktop counterparts.',
      ],
    },
    {
      title: 'Camera views',
      lines: [
        'Standard: the Gource overview, looking at the tree from a fixed elevated vantage.',
        'The headset still looks around; Settings → Camera sets how high that vantage sits.',
        '2D: fixed top-down overview with this screen laid flat as a dashboard.',
        'Center: pinned over the table centre at your current eye height while you look around.',
      ],
    },
    {
      title: 'Panels',
      lines: [
        'Activity opens both commit charts.',
        'Authors shows every author instance; touch a row to hide or show it.',
        'Settings contains Visual, Camera, Filters, Music and Data. Exit VR returns to the desktop UI.',
      ],
    },
    {
      title: 'Loading & filters',
      lines: [
        'Loading progress, warnings, recording status and load errors appear in the centre of the stage.',
        'The Map button shows or hides the overview.',
        'Filters persist across sessions and apply to the scene, charts and author list.',
      ],
    },
  ]

  const columnWidth = (content.width - 60) / 2
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]
    if (!section) continue
    const column = index < 3 ? 0 : 1
    const line = index % 3
    const x = content.x + 20 + column * (columnWidth + 20)
    const y = content.y + 92 + line * 145
    drawLabel(ctx, section.title, x, y, 18, TEXT_STRONG, '650')
    let cursor = y + 26
    for (const lineText of section.lines) {
      ctx.font = font(14)
      for (const part of wrapText(ctx, lineText, columnWidth - 8, 2)) {
        drawLabel(ctx, part, x, cursor, 14, TEXT_COLOR)
        cursor += 20
      }
      cursor += 4
    }
  }
}

function drawControls(ctx: CanvasRenderingContext2D, layout: XrScreenLayout, state: XrScreenState): void {
  for (const control of layout.controls) {
    drawControl(ctx, control, state.hovered === control.id)
  }
}

/** Draw the complete UI plane. */
export function drawXrScreen(
  ctx: CanvasRenderingContext2D,
  state: XrScreenState,
  width = XR_SCREEN_CANVAS_WIDTH,
  height = XR_SCREEN_CANVAS_HEIGHT,
): void {
  const layout = screenLayout(state, width, height)
  ctx.clearRect(0, 0, width, height)
  ctx.save()
  ctx.textBaseline = 'middle'
  drawHeader(ctx, layout, state)
  drawFooter(ctx, layout, state)

  switch (state.view) {
    case 'stage':
      drawStageBody(ctx, layout, state)
      break
    case 'activity':
      drawActivity(ctx, layout, state)
      break
    case 'authors':
      drawAuthors(ctx, layout, state)
      break
    case 'settings':
      drawSettings(ctx, layout, state)
      break
    case 'warnings':
      drawWarnings(ctx, layout, state)
      break
    case 'help':
      drawHelp(ctx, layout)
      break
  }

  drawControls(ctx, layout, state)
  ctx.restore()
}

/* -------------------------------------------------------------------------- *
 * Plane placement
 * -------------------------------------------------------------------------- */

export interface XrScreenPose {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
}

/**
 * Place the screen centred in front of the head, oriented like the head.
 *
 * The plane sits dead on the view axis at {@link XR_SCREEN_DISTANCE} and takes
 * the headset's orientation, so it is centred and square to the user at the
 * moment it is placed. It is then fixed in the room, which keeps gaze selection
 * stable while the head looks around.
 */
export function screenPose(
  head: THREE.Matrix4,
  outPosition = new THREE.Vector3(),
  outQuaternion = new THREE.Quaternion(),
): XrScreenPose {
  const forward = new THREE.Vector3(0, 0, -1).transformDirection(head)
  if (forward.lengthSq() < 1e-9) forward.set(0, 1, 0)
  forward.normalize()
  outQuaternion.setFromRotationMatrix(head)
  outPosition.setFromMatrixPosition(head).addScaledVector(forward, XR_SCREEN_DISTANCE)
  return { position: outPosition, quaternion: outQuaternion }
}

/** Physical dimensions of the screen for a camera mode. */
export function screenSizeMetres(mode: XrCameraMode): { width: number; height: number } {
  return mode === '2d'
    ? { width: XR_2D_SCREEN_WIDTH_METRES, height: XR_2D_SCREEN_HEIGHT_METRES }
    : { width: XR_SCREEN_WIDTH_METRES, height: XR_SCREEN_HEIGHT_METRES }
}

/* -------------------------------------------------------------------------- *
 * Mesh
 * -------------------------------------------------------------------------- */

function makeCanvas(width: number, height: number, injected?: HTMLCanvasElement) {
  const canvas = injected ?? document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return { canvas, ctx: canvas.getContext('2d') }
}

/** A single plane carrying the complete UI canvas, readable from either side. */
export class XrScreenPanel {
  readonly mesh: THREE.Mesh
  /** Coplanar twin facing the other way, so the back reads un-mirrored. */
  private readonly back: THREE.Mesh
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly texture: THREE.CanvasTexture
  private lastKey = ''

  constructor(options: { width?: number; height?: number; canvas?: HTMLCanvasElement } = {}) {
    const width = options.width ?? XR_SCREEN_CANVAS_WIDTH
    const height = options.height ?? XR_SCREEN_CANVAS_HEIGHT
    const { canvas, ctx } = makeCanvas(width, height, options.canvas)
    this.canvas = canvas
    this.ctx = ctx
    this.texture = new THREE.CanvasTexture(canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.FrontSide,
      toneMapped: false,
    })
    const geometry = new THREE.PlaneGeometry(1, 1)
    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.renderOrder = 1000
    this.mesh.frustumCulled = false
    // A plane is single-sided, so a DoubleSide material would show a mirrored
    // image from behind. Rotate a twin by 180 degrees instead and front-face
    // both: only one is ever drawn, and both read left-to-right.
    this.back = new THREE.Mesh(geometry, material)
    this.back.rotation.y = Math.PI
    this.back.renderOrder = 1001
    this.back.frustumCulled = false
    this.mesh.add(this.back)
  }

  get canvasElement(): HTMLCanvasElement {
    return this.canvas
  }

  /** Repaint only when the content signature changed. */
  redraw(state: XrScreenState): boolean {
    const key = xrScreenKey(state)
    if (key === this.lastKey) return false
    this.lastKey = key
    if (this.ctx) {
      drawXrScreen(this.ctx, state, this.canvas.width, this.canvas.height)
      this.texture.needsUpdate = true
    }
    return true
  }

  dispose(): void {
    this.texture.dispose()
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}
