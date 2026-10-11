import * as THREE from 'three'

export interface CameraOptions {
  /** Keep the centre of interest on recent activity. */
  followActivity: boolean
  /** Adapt the zoom to the size of the repository. */
  autoZoom: boolean
  /** Seconds of smoothing for automatic panning. */
  smoothing: number
}

export interface CameraBounds {
  center: { x: number; y: number; z?: number }
  radius: number
}

/** Seconds after a manual interaction during which automatic motion pauses. */
const INTERACTION_GRACE = 5
/** Visible world height at zoom 1, in world units. */
const BASE_VIEW_HEIGHT = 220
const MIN_ZOOM = 0.15
const MAX_ZOOM = 14

/**
 * Flat, orthographic camera for the 2D scene.
 *
 * Dragging pans, the wheel zooms around the pointer, and in automatic mode the
 * view follows the centre of recent activity and fits the repository. There is
 * no rotation or perspective: everything stays on the XY plane.
 */
export class Camera2D {
  readonly camera: THREE.OrthographicCamera
  /** Centre of the view in world coordinates. */
  private center = new THREE.Vector2(0, 0)
  private desiredCenter = new THREE.Vector2(0, 0)
  private zoom = 1
  private desiredZoom = 1
  private interactionUntil = 0
  private dragging = false
  private lastPointer = { x: 0, y: 0 }
  private viewport = { width: 1, height: 1 }
  private disposers: (() => void)[] = []

  constructor() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    this.camera.position.set(0, 0, 10)
    this.camera.lookAt(0, 0, 0)
    this.setViewport(16, 9)
  }

  get isUserControlling(): boolean {
    return performance.now() * 0.001 < this.interactionUntil || this.dragging
  }

  /** Visible world height, in world units. */
  get viewHeight(): number {
    return BASE_VIEW_HEIGHT / this.zoom
  }

  /** World units per device pixel (used for constant-size effects and text). */
  worldPerPixel(viewportHeightPixels: number): number {
    return this.viewHeight / Math.max(1, viewportHeightPixels)
  }

  /** Centre of the view (the point labels and the minimap focus on). */
  get focusPoint(): THREE.Vector3 {
    return new THREE.Vector3(this.center.x, this.center.y, 0)
  }

  get center2D(): { x: number; y: number } {
    return { x: this.center.x, y: this.center.y }
  }

  get currentZoom(): number {
    return this.zoom
  }

  setViewport(width: number, height: number): void {
    this.viewport = { width: Math.max(1, width), height: Math.max(1, height) }
    this.applyFrustum()
  }

  private applyFrustum(): void {
    const aspect = this.viewport.width / this.viewport.height
    const halfHeight = this.viewHeight / 2
    const halfWidth = halfHeight * aspect
    this.camera.left = this.center.x - halfWidth
    this.camera.right = this.center.x + halfWidth
    this.camera.top = this.center.y + halfHeight
    this.camera.bottom = this.center.y - halfHeight
    this.camera.position.set(this.center.x, this.center.y, 10)
    this.camera.updateProjectionMatrix()
  }

  attach(element: HTMLElement): void {
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1 && event.button !== 2) return
      this.markInteraction()
      this.dragging = true
      this.lastPointer = { x: event.clientX, y: event.clientY }
      element.setPointerCapture?.(event.pointerId)
      event.preventDefault()
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!this.dragging) return
      const dx = event.clientX - this.lastPointer.x
      const dy = event.clientY - this.lastPointer.y
      this.lastPointer = { x: event.clientX, y: event.clientY }
      this.markInteraction()
      const scale = this.worldPerPixel(this.viewport.height)
      // Drag the world with the pointer.
      this.desiredCenter.x -= dx * scale
      this.desiredCenter.y += dy * scale
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!this.dragging) return
      this.dragging = false
      element.releasePointerCapture?.(event.pointerId)
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      this.markInteraction()
      const rect = element.getBoundingClientRect()
      const pointerX = event.clientX - rect.left
      const pointerY = event.clientY - rect.top
      // World position under the pointer, kept fixed while zooming.
      const before = this.screenToWorld(pointerX, pointerY, rect.width, rect.height)
      const factor = Math.exp(-event.deltaY * 0.0015)
      this.desiredZoom = clamp(this.desiredZoom * factor, MIN_ZOOM, MAX_ZOOM)
      // Solve for the centre that keeps `before` under the pointer.
      const scale = BASE_VIEW_HEIGHT / this.desiredZoom / Math.max(1, rect.height)
      this.desiredCenter.x = before.x - (pointerX - rect.width / 2) * scale
      this.desiredCenter.y = before.y + (pointerY - rect.height / 2) * scale
    }
    const onContextMenu = (event: MouseEvent) => event.preventDefault()

    element.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    element.addEventListener('wheel', onWheel, { passive: false })
    element.addEventListener('contextmenu', onContextMenu)
    this.disposers.push(() => {
      element.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('contextmenu', onContextMenu)
    })
  }

  /** Convert a screen position (CSS pixels inside the canvas) to world space. */
  private screenToWorld(screenX: number, screenY: number, width: number, height: number): { x: number; y: number } {
    const scale = this.viewHeight / Math.max(1, height)
    return {
      x: this.center.x + (screenX - width / 2) * scale,
      y: this.center.y - (screenY - height / 2) * scale,
    }
  }

  private markInteraction(): void {
    this.interactionUntil = performance.now() * 0.001 + INTERACTION_GRACE
  }

  /** Programmatic pan/zoom (keyboard shortcuts). */
  nudge(delta: { panX?: number; panY?: number; zoom?: number }): void {
    this.markInteraction()
    if (delta.panX) this.desiredCenter.x += delta.panX
    if (delta.panY) this.desiredCenter.y += delta.panY
    if (delta.zoom) this.desiredZoom = clamp(this.desiredZoom * delta.zoom, MIN_ZOOM, MAX_ZOOM)
  }

  /** Fit the given bounds, immediately or with smoothing. */
  frame(bounds: CameraBounds, immediate = true): void {
    const zoom = this.zoomForRadius(bounds.radius)
    this.desiredCenter.set(bounds.center.x, bounds.center.y)
    this.desiredZoom = zoom
    if (immediate) {
      this.center.copy(this.desiredCenter)
      this.zoom = zoom
      this.applyFrustum()
    }
  }

  /** Reset pan/zoom and let the automatic behaviour take over. */
  recenter(bounds: CameraBounds): void {
    this.frame(bounds, false)
    this.interactionUntil = 0
  }

  private zoomForRadius(radius: number): number {
    const aspect = this.viewport.width / this.viewport.height
    // Fit a square of side 2*radius in the smaller viewport dimension.
    const neededHeight = radius * 2
    const neededWidth = radius * 2 * (aspect < 1 ? 1 / Math.max(0.2, aspect) : 1)
    const height = Math.max(neededHeight, neededWidth / Math.max(0.2, aspect))
    return clamp(BASE_VIEW_HEIGHT / Math.max(20, height), MIN_ZOOM, MAX_ZOOM)
  }

  update(dt: number, options: CameraOptions, focus: { x: number; y: number } | null, bounds: CameraBounds): void {
    const manual = this.isUserControlling

    if (!manual) {
      // When the whole repository already fits comfortably there is nothing to
      // follow: keep it centred instead of drifting towards activity.
      const wholeTreeFits = bounds.radius * 2 < this.viewHeight * 0.55
      if (options.followActivity && focus && !wholeTreeFits) {
        // Ease towards activity but keep some of the whole-repository context.
        this.desiredCenter.set(
          focus.x * 0.8 + bounds.center.x * 0.2,
          focus.y * 0.8 + bounds.center.y * 0.2,
        )
      } else {
        this.desiredCenter.set(bounds.center.x, bounds.center.y)
      }
      if (options.autoZoom) this.desiredZoom = this.zoomForRadius(bounds.radius)
    }

    const damping = 1 - Math.exp(-dt * Math.max(0.2, options.smoothing))
    if (this.dragging) {
      this.center.copy(this.desiredCenter)
      this.zoom += (this.desiredZoom - this.zoom) * (1 - Math.exp(-dt * 12))
    } else {
      this.center.lerp(this.desiredCenter, damping)
      this.zoom += (this.desiredZoom - this.zoom) * (1 - Math.exp(-dt * 1.6))
    }
    this.applyFrustum()
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
