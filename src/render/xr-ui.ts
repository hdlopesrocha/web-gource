/**
 * In-scene timeline panel for immersive WebXR.
 *
 * An immersive session has no DOM, so the on-screen timeline has to be drawn
 * into the scene: a `THREE.Mesh` (a plane with a `CanvasTexture`) that floats in
 * front of the user like a HUD above the tabletop. It carries the same commit
 * histogram the on-screen scrubber uses, a progress readout and the playback
 * controls, and it is driven by **gaze**: a circular reticle sits at the centre
 * of the view and whatever it rests on for {@link XR_UI_DWELL_SECONDS} seconds
 * is activated.
 *
 * Everything that can be reasoned about without a headset is kept pure and
 * separate from three.js: {@link panelLayout} (the hit rectangles),
 * {@link hitTest} (canvas point → control or timeline position), {@link dwell}
 * (the 2 s accumulator) and the two `draw*` routines (plain canvas drawing).
 * Only {@link XrTimelinePanel} and {@link XrReticle} touch WebGL, and they do no
 * maths of their own — they just own a canvas and a mesh.
 */

import * as THREE from 'three'
import type { ActivityBucket } from '../timeline/types'
import { drawActivityBars, drawPanel, TEXT_COLOR, TEXT_STRONG } from './overlays'

/** Legacy timeline panel's camera label; the live UI no longer cycles modes. */
export type XrCameraMode = 'free' | 'follow'

/** Seconds the gaze must rest on an element before it activates. */
export const XR_UI_DWELL_SECONDS = 2

/** Panel canvas resolution (4:1, matching the on-screen scrubber's proportions). */
export const XR_PANEL_CANVAS_WIDTH = 1024
export const XR_PANEL_CANVAS_HEIGHT = 256

/** Reticle canvas resolution (square). */
export const XR_RETICLE_CANVAS_SIZE = 128

/** Physical size of the panel in the room, in metres (legible at ~1–1.5 m). */
export const XR_PANEL_WIDTH_METRES = 1.2
export const XR_PANEL_HEIGHT_METRES = (XR_PANEL_WIDTH_METRES * XR_PANEL_CANVAS_HEIGHT) / XR_PANEL_CANVAS_WIDTH

/** How far in front of the headset the panel floats, in metres. */
export const XR_PANEL_DISTANCE = 1.35
/** How far above the eye line the panel centre sits, in metres, so it reads as
 *  a HUD raised into the upper part of the view. */
export const XR_PANEL_RISE = 0.28
/** Distance from the headset the reticle is drawn at, in metres. */
export const XR_RETICLE_DISTANCE = 0.85

/**
 * Where the panel sits when the camera is in the fixed top-down overview.
 *
 * The coordinates are metres in the tabletop frame: the centre of the table is
 * the origin, +Y is the top of the overview and +Z is up. Lying flat near the
 * far edge keeps the controls visible without covering the middle of the tree.
 */
export const XR_2D_PANEL_CENTER = { x: 0, y: 0.55, z: 0.05 } as const

/** Human-readable names for the camera-mode button. */
export const XR_CAMERA_MODE_LABELS: Record<XrCameraMode, string> = {
  free: 'Free',
  follow: 'Follow',
}

/** The controls, in the order they are laid out left to right. */
export const XR_CONTROL_ORDER = ['restart', 'prev', 'play', 'next', 'speed', 'camera'] as const
export type XrControlId = (typeof XR_CONTROL_ORDER)[number]

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface XrControl {
  id: XrControlId
  rect: Rect
}

export interface XrPanelLayout {
  /** The commit histogram / playhead strip. */
  timeline: Rect
  /** The playback buttons. */
  controls: XrControl[]
}

/**
 * Hit rectangles for the panel, as plain data.
 *
 * The timeline strip spans the top of the panel and the six controls sit in a
 * row along the bottom, in {@link XR_CONTROL_ORDER}. Kept separate from the
 * drawing so the geometry (and therefore the gaze hit-testing) can be asserted
 * without a canvas.
 */
export function panelLayout(width = XR_PANEL_CANVAS_WIDTH, height = XR_PANEL_CANVAS_HEIGHT): XrPanelLayout {
  const pad = Math.max(8, Math.round(width * 0.018))
  const controlsHeight = Math.max(28, Math.round(height * 0.3))
  const gap = Math.max(6, Math.round(width * 0.012))
  const timelineHeight = Math.max(16, height - controlsHeight - pad * 3)
  const timeline: Rect = { x: pad, y: pad, width: width - pad * 2, height: timelineHeight }
  const controlsY = height - pad - controlsHeight
  const buttonWidth = (width - pad * 2 - gap * (XR_CONTROL_ORDER.length - 1)) / XR_CONTROL_ORDER.length
  const controls = XR_CONTROL_ORDER.map((id, index) => ({
    id,
    rect: {
      x: pad + index * (buttonWidth + gap),
      y: controlsY,
      width: buttonWidth,
      height: controlsHeight,
    },
  }))
  return { timeline, controls }
}

export interface XrPanelPose {
  /** Centre of the panel, in the room frame. */
  position: THREE.Vector3
  /** Orientation of the panel, in the room frame (+Z faces the user). */
  quaternion: THREE.Quaternion
}

/**
 * Pose the panel ahead of the headset and raised into the upper part of the view.
 *
 * `head` is the head pose in the room frame (three's XR camera world matrix,
 * centred between the eyes). Only the yaw of the headset is used: the panel goes
 * in front of wherever the user is facing when the session starts, while pitch
 * and roll are dropped so it stays upright even if they were looking down. Its
 * +Z normal is turned back towards the user, so the plane faces the eye and the
 * canvas reads the right way round.
 *
 * The panel is placed once and then fixed in the room: that is what makes gaze
 * selection stable, since the reticle moves with the head.
 */
export function panelPose(
  head: THREE.Matrix4,
  outPosition = new THREE.Vector3(),
  outQuaternion = new THREE.Quaternion(),
): XrPanelPose {
  const forward = new THREE.Vector3(0, 0, -1).transformDirection(head)
  // A momentary pitch must not aim the HUD at the floor or the ceiling.
  forward.z = 0
  if (forward.lengthSq() < 1e-9) forward.set(0, 1, 0)
  forward.normalize()
  const up = new THREE.Vector3(0, 0, 1)
  const right = new THREE.Vector3().crossVectors(forward, up).normalize()
  const backward = forward.clone().negate()
  outQuaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, backward))
  outPosition
    .setFromMatrixPosition(head)
    .addScaledVector(forward, XR_PANEL_DISTANCE)
    .addScaledVector(up, XR_PANEL_RISE)
  return { position: outPosition, quaternion: outQuaternion }
}

/** What the gaze is pointing at, in panel terms. */
export type XrHit = { kind: 'control'; id: XrControlId } | { kind: 'timeline'; ratio: number }

/** Hit-test a point in panel canvas pixels. */
export function hitTest(layout: XrPanelLayout, x: number, y: number): XrHit | null {
  for (const control of layout.controls) {
    const rect = control.rect
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      return { kind: 'control', id: control.id }
    }
  }
  const timeline = layout.timeline
  if (x >= timeline.x && x <= timeline.x + timeline.width && y >= timeline.y && y <= timeline.y + timeline.height) {
    const ratio = timeline.width > 0 ? Math.min(1, Math.max(0, (x - timeline.x) / timeline.width)) : 0
    return { kind: 'timeline', ratio }
  }
  return null
}

/** Stable id for a hit, used to drive the dwell accumulator. */
export function hitTargetId(hit: XrHit | null): string | null {
  if (!hit) return null
  return hit.kind === 'control' ? `control:${hit.id}` : 'timeline'
}

/** The engine command a hit maps to (pure, so it can be asserted directly). */
export type XrCommand =
  | { kind: 'restart' }
  | { kind: 'step'; delta: number }
  | { kind: 'togglePlay' }
  | { kind: 'seek'; ratio: number }
  | { kind: 'cycleSpeed' }
  | { kind: 'cycleCamera' }

export function xrCommand(hit: XrHit): XrCommand {
  if (hit.kind === 'timeline') return { kind: 'seek', ratio: hit.ratio }
  switch (hit.id) {
    case 'restart':
      return { kind: 'restart' }
    case 'prev':
      return { kind: 'step', delta: -1 }
    case 'play':
      return { kind: 'togglePlay' }
    case 'next':
      return { kind: 'step', delta: 1 }
    case 'speed':
      return { kind: 'cycleSpeed' }
    case 'camera':
      return { kind: 'cycleCamera' }
  }
}

/** Mutable dwell accumulator: one per session. */
export interface DwellState {
  /** The element the gaze is resting on, or null when it is on nothing. */
  target: string | null
  /** Seconds the gaze has rested on {@link target}. */
  elapsed: number
  /** True once the current dwell has fired, so it only fires once. */
  fired: boolean
}

export function createDwellState(): DwellState {
  return { target: null, elapsed: 0, fired: false }
}

/**
 * Advance the dwell by `dt` seconds on `targetId`.
 *
 * Returns true exactly once per continuous dwell: once the gaze has stayed on
 * the same target for {@link XR_UI_DWELL_SECONDS}. Moving to another target (or
 * off everything, `null`) resets the accumulator.
 */
export function dwell(state: DwellState, targetId: string | null, dt: number): boolean {
  if (targetId !== state.target) {
    state.target = targetId
    state.elapsed = 0
    state.fired = false
  }
  if (targetId === null || state.fired) return false
  state.elapsed += Math.max(0, dt)
  if (state.elapsed >= XR_UI_DWELL_SECONDS) {
    state.fired = true
    return true
  }
  return false
}

/** How far the current dwell has progressed, 0…1. */
export function dwellProgress(state: DwellState): number {
  if (state.target === null) return 0
  return Math.min(1, state.elapsed / XR_UI_DWELL_SECONDS)
}

/** Everything the panel canvas needs to draw one frame. */
export interface XrPanelState {
  /** Commit counts per simulated-time bucket, as the on-screen scrubber uses. */
  buckets: ActivityBucket[]
  /** Playback position in seconds. */
  position: number
  duration: number
  /** Formatted real-world date at the current position. */
  date: string
  /** Playback progress, 0…1. */
  progress: number
  playing: boolean
  /** Current playback speed multiplier. */
  speed: number
  /** Current immersive camera behaviour. */
  cameraMode: XrCameraMode
  /** The element the gaze is resting on (`control:<id>` or `timeline`). */
  hovered: string | null
}

/**
 * The label of a control.
 *
 * Play flips between Play and Pause; the speed and view buttons show their
 * current value so a glance at the panel explains the state.
 */
export function controlLabel(
  id: XrControlId,
  playing: boolean,
  speed = 1,
  cameraMode: XrCameraMode = 'free',
): string {
  switch (id) {
    case 'restart':
      return 'Restart'
    case 'prev':
      return 'Prev'
    case 'play':
      return playing ? 'Pause' : 'Play'
    case 'next':
      return 'Next'
    case 'speed':
      return `Speed ${speed}×`
    case 'camera':
      return `View ${XR_CAMERA_MODE_LABELS[cameraMode]}`
  }
}

/**
 * A cheap signature of the panel content.
 *
 * `redraw` only repaints when this changes, so the panel does not upload a
 * texture every frame while nothing is happening. The position is quantised to
 * a fraction of the duration so a moving playhead still updates smoothly.
 */
export function xrPanelKey(state: XrPanelState): string {
  let commits = 0
  for (const bucket of state.buckets) commits += bucket.commits
  const step = state.duration > 0 ? Math.round((state.position / state.duration) * 512) : 0
  return [
    state.buckets.length,
    commits,
    state.date,
    step,
    state.playing ? 1 : 0,
    state.speed,
    state.cameraMode,
    state.hovered ?? '',
  ].join('|')
}

/** Draw the panel: histogram, playhead, date/progress and the six controls. */
export function drawXrPanel(
  ctx: CanvasRenderingContext2D,
  state: XrPanelState,
  width = XR_PANEL_CANVAS_WIDTH,
  height = XR_PANEL_CANVAS_HEIGHT,
): void {
  const layout = panelLayout(width, height)
  const pad = Math.max(8, Math.round(width * 0.018))
  const unit = Math.max(11, Math.round(Math.min(width, height) * 0.1))
  const font = `${unit}px "Inter", system-ui, sans-serif`
  const controlFont = `${Math.max(10, Math.round(unit * 0.88))}px "Inter", system-ui, sans-serif`

  ctx.clearRect(0, 0, width, height)
  ctx.save()

  // Panel chrome behind everything.
  drawPanel(ctx, 0, 0, width, height, { radius: Math.round(Math.min(width, height) * 0.06) })

  // ---- timeline -------------------------------------------------------
  const timeline = layout.timeline
  ctx.save()
  ctx.translate(timeline.x, timeline.y)
  drawActivityBars(ctx, {
    width: timeline.width,
    height: timeline.height,
    buckets: state.buckets,
    position: state.position,
    duration: state.duration,
  })
  ctx.restore()

  if (state.hovered === 'timeline') {
    ctx.strokeStyle = 'rgba(94, 200, 255, 0.9)'
    ctx.lineWidth = Math.max(2, Math.round(unit * 0.18))
    ctx.strokeRect(timeline.x + 0.5, timeline.y + 0.5, timeline.width - 1, timeline.height - 1)
  }

  // Date on the left, percentage on the right, over the histogram.
  ctx.font = font
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = TEXT_STRONG
  ctx.fillText(state.date, timeline.x + pad, timeline.y + unit * 0.9)
  ctx.textAlign = 'right'
  ctx.fillStyle = TEXT_COLOR
  ctx.fillText(`${Math.round(state.progress * 100)}%`, timeline.x + timeline.width - pad, timeline.y + unit * 0.9)

  // ---- controls -------------------------------------------------------
  for (const control of layout.controls) {
    const rect = control.rect
    const hovered = state.hovered === `control:${control.id}`
    drawPanel(ctx, rect.x, rect.y, rect.width, rect.height, {
      radius: Math.round(Math.min(rect.width, rect.height) * 0.18),
      background: hovered ? 'rgba(94, 200, 255, 0.24)' : 'rgba(255, 255, 255, 0.05)',
      border: hovered ? 'rgba(94, 200, 255, 0.95)' : 'rgba(255, 255, 255, 0.12)',
    })
    ctx.font = controlFont
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = hovered ? TEXT_STRONG : TEXT_COLOR
    ctx.fillText(controlLabel(control.id, state.playing, state.speed, state.cameraMode), rect.x + rect.width / 2, rect.y + rect.height / 2)
  }

  ctx.restore()
}

/** Everything the reticle canvas needs to draw one frame. */
export interface XrReticleState {
  /** Dwell progress, 0…1. */
  progress: number
  /** True while the gaze is on an element (the reticle brightens). */
  hovered: boolean
}

/** A cheap signature of the reticle content (progress is quantised). */
export function xrReticleKey(state: XrReticleState): string {
  return `${Math.round(state.progress * 64)}|${state.hovered ? 1 : 0}`
}

/** Draw the circular crosshair: a ring, a centre dot and the dwell arc. */
export function drawReticle(
  ctx: CanvasRenderingContext2D,
  state: XrReticleState,
  size = XR_RETICLE_CANVAS_SIZE,
): void {
  const centre = size / 2
  const radius = size * 0.3
  const lineWidth = Math.max(2, size * 0.045)

  ctx.clearRect(0, 0, size, size)
  ctx.lineWidth = lineWidth
  ctx.strokeStyle = state.hovered ? 'rgba(120, 205, 255, 0.95)' : 'rgba(255, 255, 255, 0.65)'
  ctx.beginPath()
  ctx.arc(centre, centre, radius, 0, Math.PI * 2)
  ctx.stroke()

  ctx.fillStyle = state.hovered ? 'rgba(120, 205, 255, 0.95)' : 'rgba(255, 255, 255, 0.65)'
  ctx.beginPath()
  ctx.arc(centre, centre, size * 0.03, 0, Math.PI * 2)
  ctx.fill()

  if (state.progress > 0) {
    ctx.strokeStyle = 'rgba(120, 205, 255, 1)'
    ctx.lineWidth = lineWidth
    ctx.beginPath()
    ctx.arc(centre, centre, radius + lineWidth, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * state.progress)
    ctx.stroke()
  }
}

/** A canvas plus the 2D context it drew into (null when jsdom has no canvas). */
function makeCanvas(width: number, height: number, injected?: HTMLCanvasElement) {
  const canvas = injected ?? document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return { canvas, ctx: canvas.getContext('2d') }
}

/** A unit plane carrying the timeline canvas, placed by the engine. */
export class XrTimelinePanel {
  readonly mesh: THREE.Mesh
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly texture: THREE.CanvasTexture
  private lastKey = ''

  constructor(options: { width?: number; height?: number; canvas?: HTMLCanvasElement } = {}) {
    const width = options.width ?? XR_PANEL_CANVAS_WIDTH
    const height = options.height ?? XR_PANEL_CANVAS_HEIGHT
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
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
    this.mesh.renderOrder = 1000
    this.mesh.frustumCulled = false
  }

  get canvasElement(): HTMLCanvasElement {
    return this.canvas
  }

  /** Repaint only when the content actually changed; returns whether it did. */
  redraw(state: XrPanelState): boolean {
    const key = xrPanelKey(state)
    if (key === this.lastKey) return false
    this.lastKey = key
    if (this.ctx) {
      drawXrPanel(this.ctx, state, this.canvas.width, this.canvas.height)
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

/** The circular crosshair, drawn on a quad in front of the headset camera. */
export class XrReticle {
  readonly mesh: THREE.Mesh
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly texture: THREE.CanvasTexture
  private lastKey = ''

  constructor(options: { size?: number; canvas?: HTMLCanvasElement } = {}) {
    const size = options.size ?? XR_RETICLE_CANVAS_SIZE
    const { canvas, ctx } = makeCanvas(size, size, options.canvas)
    this.canvas = canvas
    this.ctx = ctx
    this.texture = new THREE.CanvasTexture(canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
    this.mesh.renderOrder = 1001
    this.mesh.frustumCulled = false
    this.mesh.scale.setScalar(0.09)
  }

  /** Repaint the reticle when its progress or hover state changed. */
  update(state: XrReticleState): boolean {
    const key = xrReticleKey(state)
    if (key === this.lastKey) return false
    this.lastKey = key
    if (this.ctx) {
      drawReticle(this.ctx, state, this.canvas.width)
      this.texture.needsUpdate = true
    }
    return true
  }

  /**
   * Park the reticle at the centre of the view.
   *
   * `headMatrixWorld` is the headset pose in scene coordinates, centred between
   * the eyes (see the engine's head pose); the reticle is put `distance` metres
   * along the head's own -Z and given the head's orientation, so it always faces
   * the user and sits where both eyes converge.
   */
  place(headMatrixWorld: THREE.Matrix4, distance = XR_RETICLE_DISTANCE): void {
    this.mesh.quaternion.setFromRotationMatrix(headMatrixWorld)
    this.mesh.position.set(0, 0, -distance).applyMatrix4(headMatrixWorld)
  }

  dispose(): void {
    this.texture.dispose()
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}
