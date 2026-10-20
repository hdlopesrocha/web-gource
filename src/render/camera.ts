import * as THREE from 'three'

export interface CameraOptions {
  /** Keep the centre of interest on recent activity. */
  followActivity: boolean
  /** Adapt the zoom to the size of the repository. */
  autoZoom: boolean
  /** Seconds of smoothing for automatic panning. */
  smoothing: number
  /** Flat top-down 2D view instead of the 3D orbit. */
  flat?: boolean
}

export interface CameraBounds {
  center: { x: number; y: number; z?: number }
  radius: number
}

/** Seconds after a manual interaction during which automatic motion pauses. */
const INTERACTION_GRACE = 5
/** Visible world height at zoom 1, in world units (measured at the target). */
const BASE_VIEW_HEIGHT = 220
const MIN_ZOOM = 0.15
const MAX_ZOOM = 14
/** Vertical field of view. A moderate perspective keeps the tree readable. */
const FIELD_OF_VIEW = 45
const FOV_RADIANS = (FIELD_OF_VIEW * Math.PI) / 180
/**
 * Default azimuth around the plane normal: looking from -Y towards +Y, so the
 * scene's own +Y axis points up the screen and switching to the flat view does
 * not roll the layout.
 */
export const DEFAULT_YAW = -Math.PI / 2
/**
 * Default elevation above the scene plane, in radians. Enough depth to read as
 * 3D, not so steep that the tree hides behind its own labels.
 */
export const DEFAULT_PITCH = 0.92
/** Below the horizon the plane would be seen edge-on; at the normal the camera
 *  up vector becomes parallel to the view direction. The 2D button is the
 *  explicit top-down view. */
const MIN_PITCH = 0.08
const MAX_PITCH = 1.45
/** Radians of orbit per CSS pixel of pointer travel. */
const ORBIT_SPEED = 0.006

const scratchRight = new THREE.Vector3()
const scratchUp = new THREE.Vector3()
const scratchEyeOffset = new THREE.Vector3()
const scratchRay = new THREE.Vector3()
const scratchPlanePoint = new THREE.Vector3()

/**
 * Perspective orbit camera for the 3D scene.
 *
 * The repository layout remains planar (XY), as in Gource, but it is viewed
 * through a perspective camera that can be orbited around its target. The
 * camera up vector is the plane normal (+Z), so the layout behaves like a
 * tabletop: dragging left/right spins around it and dragging up/down changes
 * the elevation, while the ground plane recedes into the distance.
 *
 * Dragging with the left button rotates the camera, dragging with the right or
 * middle button pans, and the wheel zooms. In automatic mode the view follows
 * recent activity and fits the repository, just like the old flat camera; the
 * manual orbit angles are kept unless the view is reset.
 */
export class OrbitCamera {
  readonly camera: THREE.PerspectiveCamera
  /** Point the camera orbits around and looks at. */
  private target = new THREE.Vector3(0, 0, 0)
  private desiredTarget = new THREE.Vector3(0, 0, 0)
  private zoom = 1
  private desiredZoom = 1
  /** Azimuth around the plane normal (radians). */
  private yaw = DEFAULT_YAW
  /** Elevation above the scene plane (radians). */
  private pitch = DEFAULT_PITCH
  private desiredYaw = DEFAULT_YAW
  private desiredPitch = DEFAULT_PITCH
  /** Flat top-down 2D mode: locked above the target, left-drag pans. */
  private flat = false
  private interactionUntil = 0
  private dragging: 'orbit' | 'pan' | null = null
  private lastPointer = { x: 0, y: 0 }
  private viewport = { width: 1, height: 1 }
  private disposers: (() => void)[] = []
  private raycaster = new THREE.Raycaster()

  constructor() {
    this.camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.1, 100000)
    this.camera.up.set(0, 0, 1)
    this.setViewport(16, 9)
  }

  get isUserControlling(): boolean {
    return performance.now() * 0.001 < this.interactionUntil || this.dragging !== null
  }

  /** Visible world height at the orbit target, in world units. */
  get viewHeight(): number {
    return BASE_VIEW_HEIGHT / this.zoom
  }

  /** Distance from the orbit target to the eye. */
  get targetDistance(): number {
    return this.viewHeight / (2 * Math.tan(FOV_RADIANS / 2))
  }

  /** World units per CSS pixel at the orbit target plane. */
  worldPerPixel(viewportHeightPixels: number): number {
    return this.viewHeight / Math.max(1, viewportHeightPixels)
  }

  /** Centre of the view (the point labels and the minimap focus on). */
  get focusPoint(): THREE.Vector3 {
    return this.target.clone()
  }

  get center2D(): { x: number; y: number } {
    return { x: this.target.x, y: this.target.y }
  }

  get currentZoom(): number {
    return this.zoom
  }

  /** True while the flat top-down 2D view is active. */
  get isFlat(): boolean {
    return this.flat
  }

  /**
   * Current orbit angles in radians, mainly for diagnostics and tests:
   * `yaw` is the azimuth around the plane normal, `pitch` the elevation above
   * the scene plane.
   */
  get angles(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch }
  }

  setViewport(width: number, height: number): void {
    this.viewport = { width: Math.max(1, width), height: Math.max(1, height) }
    this.camera.aspect = this.viewport.width / this.viewport.height
    this.applyCamera()
  }

  private applyCamera(): void {
    const distance = this.targetDistance
    if (this.flat) {
      // Straight above the target, looking down the plane normal. The up vector
      // must lie in the plane here (the normal is the view direction), and +Y
      // reproduces the old 2D orientation.
      this.camera.position.set(this.target.x, this.target.y, this.target.z + distance)
      this.camera.up.set(0, 1, 0)
    } else {
      const cosPitch = Math.cos(this.pitch)
      this.camera.position.set(
        this.target.x + Math.cos(this.yaw) * cosPitch * distance,
        this.target.y + Math.sin(this.yaw) * cosPitch * distance,
        this.target.z + Math.sin(this.pitch) * distance,
      )
      // Perpendicular to the plane the scene is rendered on.
      this.camera.up.set(0, 0, 1)
    }
    this.camera.lookAt(this.target)
    this.camera.near = Math.max(0.1, distance / 10000)
    this.camera.far = Math.max(2000, distance * 200)
    this.camera.updateProjectionMatrix()
    // Keep the world matrices current for billboards, projections and picking
    // in the same frame that the camera moves.
    this.camera.updateMatrixWorld()
  }

  attach(element: HTMLElement): void {
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1 && event.button !== 2) return
      this.markInteraction()
      // In the flat 2D view there is no orbit: dragging pans just like the old
      // orthographic camera did.
      const pan = this.flat || event.button !== 0 || event.shiftKey
      this.dragging = pan ? 'pan' : 'orbit'
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
      if (this.dragging === 'orbit') this.orbitBy(dx, dy)
      else this.panByPixels(dx, dy)
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!this.dragging) return
      this.dragging = null
      element.releasePointerCapture?.(event.pointerId)
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      this.markInteraction()
      const rect = element.getBoundingClientRect()
      this.zoomAt(
        event.clientX - rect.left,
        event.clientY - rect.top,
        rect.width,
        rect.height,
        Math.exp(-event.deltaY * 0.0015),
      )
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

  private markInteraction(): void {
    this.interactionUntil = performance.now() * 0.001 + INTERACTION_GRACE
  }

  /**
   * Switch between the 3D orbit view and the flat top-down 2D view.
   *
   * The flat view locks the camera on the +Z axis above the target, which
   * reproduces the old 2D framing, while leaving the orbit angles untouched:
   * leaving it returns to the same 3D view (or to the defaults, if the user
   * reset the camera while in 2D). Both switches snap instead of easing, so the
   * button feels immediate; panning and zooming behave the same in either mode.
   */
  setFlatMode(flat: boolean): void {
    if (flat === this.flat) return
    this.flat = flat
    this.applyCamera()
  }

  /** Orbit the camera by a pointer delta in CSS pixels. */
  orbitBy(dx: number, dy: number): void {
    this.markInteraction()
    // The flat view has no orbit: ignore rotation input so the top-down
    // framing (and the old 2D behaviour) stays intact.
    if (this.flat) return
    this.desiredYaw -= dx * ORBIT_SPEED
    this.desiredPitch = clamp(this.desiredPitch - dy * ORBIT_SPEED, MIN_PITCH, MAX_PITCH)
  }

  /** Pan the orbit target by a pointer delta in CSS pixels. */
  panByPixels(dx: number, dy: number): void {
    this.markInteraction()
    this.camera.updateMatrixWorld()
    scratchRight.setFromMatrixColumn(this.camera.matrixWorld, 0)
    scratchUp.setFromMatrixColumn(this.camera.matrixWorld, 1)
    const worldPerPixel = this.viewHeight / this.viewport.height
    this.desiredTarget.addScaledVector(scratchRight, -dx * worldPerPixel)
    this.desiredTarget.addScaledVector(scratchUp, dy * worldPerPixel)
  }

  /**
   * Zoom around the world point under the pointer, keeping it anchored.
   *
   * Because the ray direction is fixed while only the eye distance changes, the
   * plane intersection moves with the eye offset; shifting the target by the
   * difference keeps that point under the cursor, as in the old flat camera.
   */
  zoomAt(screenX: number, screenY: number, width: number, height: number, factor: number): void {
    const nextZoom = clamp(this.desiredZoom * factor, MIN_ZOOM, MAX_ZOOM)
    if (nextZoom === this.desiredZoom) return
    this.markInteraction()

    this.camera.updateMatrixWorld()
    const ndc = new THREE.Vector2((screenX / Math.max(1, width)) * 2 - 1, -(screenY / Math.max(1, height)) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    scratchRay.copy(this.raycaster.ray.direction)

    const oldDistance = this.targetDistance
    const newDistance = BASE_VIEW_HEIGHT / nextZoom / (2 * Math.tan(FOV_RADIANS / 2))
    let anchored = false
    if (Math.abs(scratchRay.z) > 1e-6) {
      const t = -this.camera.position.z / scratchRay.z
      if (t > 0) {
        scratchPlanePoint.copy(this.camera.position).addScaledVector(scratchRay, t)
        if (this.flat) {
          scratchEyeOffset.set(0, 0, 1)
        } else {
          const cosPitch = Math.cos(this.pitch)
          scratchEyeOffset.set(
            Math.cos(this.yaw) * cosPitch,
            Math.sin(this.yaw) * cosPitch,
            Math.sin(this.pitch),
          )
        }
        // Moving the eye by d*offset moves the ray origin and therefore the
        // plane hit by the same amount, except that the z component is
        // projected out along the ray.
        const deltaDistance = newDistance - oldDistance
        const shiftX = deltaDistance * (scratchEyeOffset.z * (scratchRay.x / scratchRay.z) - scratchEyeOffset.x)
        const shiftY = deltaDistance * (scratchEyeOffset.z * (scratchRay.y / scratchRay.z) - scratchEyeOffset.y)
        this.desiredTarget.set(this.target.x + shiftX, this.target.y + shiftY, this.target.z)
        anchored = true
      }
    }
    if (!anchored) {
      // Fallback for a degenerate ray: zoom towards the target.
      this.desiredTarget.copy(this.target)
    }
    this.desiredZoom = nextZoom
  }

  /** Programmatic pan/zoom/orbit (keyboard shortcuts and tests). */
  nudge(delta: { panX?: number; panY?: number; zoom?: number; orbitX?: number; orbitY?: number }): void {
    this.markInteraction()
    if (delta.panX) this.desiredTarget.x += delta.panX
    if (delta.panY) this.desiredTarget.y += delta.panY
    if (delta.zoom) this.desiredZoom = clamp(this.desiredZoom * delta.zoom, MIN_ZOOM, MAX_ZOOM)
    if (delta.orbitX || delta.orbitY) this.orbitBy(delta.orbitX ?? 0, delta.orbitY ?? 0)
  }

  /** Fit the given bounds, immediately or with smoothing. */
  frame(bounds: CameraBounds, immediate = true): void {
    const zoom = this.zoomForRadius(bounds.radius)
    this.desiredTarget.set(bounds.center.x, bounds.center.y, bounds.center.z ?? 0)
    this.desiredZoom = zoom
    if (immediate) {
      this.target.copy(this.desiredTarget)
      this.zoom = zoom
      this.applyCamera()
    }
  }

  /**
   * Reset pan, zoom and orbit to the default view. In the flat 2D mode the
   * camera stays top-down; the defaults are what the 3D view returns to.
   */
  reset(bounds: CameraBounds, immediate = true): void {
    this.frame(bounds, false)
    this.desiredYaw = DEFAULT_YAW
    this.desiredPitch = DEFAULT_PITCH
    this.interactionUntil = 0
    if (immediate) {
      this.target.copy(this.desiredTarget)
      this.zoom = this.desiredZoom
      this.yaw = this.desiredYaw
      this.pitch = this.desiredPitch
      this.applyCamera()
    }
  }

  /** Leave the flat view if needed and reset to the default 3D camera. */
  reset3D(bounds: CameraBounds, immediate = true): void {
    if (this.flat) this.flat = false
    this.reset(bounds, immediate)
  }

  /** Reset pan/zoom and let the automatic behaviour take over. */
  recenter(bounds: CameraBounds): void {
    this.frame(bounds, false)
    this.desiredYaw = DEFAULT_YAW
    this.desiredPitch = DEFAULT_PITCH
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
    // Keep the mode in sync with the settings. The orbit angles are kept while
    // the flat view is active, so leaving it restores the same 3D view.
    const flat = options.flat ?? false
    if (flat !== this.flat) this.setFlatMode(flat)

    const manual = this.isUserControlling

    if (!manual) {
      // When the whole repository already fits comfortably there is nothing to
      // follow: keep it centred instead of drifting towards activity.
      const wholeTreeFits = bounds.radius * 2 < this.viewHeight * 0.55
      if (options.followActivity && focus && !wholeTreeFits) {
        // Ease towards activity but keep some of the whole-repository context.
        this.desiredTarget.set(
          focus.x * 0.8 + bounds.center.x * 0.2,
          focus.y * 0.8 + bounds.center.y * 0.2,
          bounds.center.z ?? 0,
        )
      } else {
        this.desiredTarget.set(bounds.center.x, bounds.center.y, bounds.center.z ?? 0)
      }
      if (options.autoZoom) this.desiredZoom = this.zoomForRadius(bounds.radius)
    }

    const damping = 1 - Math.exp(-dt * Math.max(0.2, options.smoothing))
    if (this.dragging) {
      // Pointer control must feel direct; only the zoom is eased.
      this.target.copy(this.desiredTarget)
    } else {
      this.target.lerp(this.desiredTarget, damping)
    }
    if (this.dragging === 'orbit') {
      this.yaw = this.desiredYaw
      this.pitch = this.desiredPitch
    } else {
      this.yaw += (this.desiredYaw - this.yaw) * damping
      this.pitch += (this.desiredPitch - this.pitch) * damping
    }
    this.zoom += (this.desiredZoom - this.zoom) * (1 - Math.exp(-dt * (this.dragging ? 12 : 1.6)))
    this.applyCamera()
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** @deprecated The scene is 3D now; use {@link OrbitCamera}. */
export { OrbitCamera as Camera2D }
