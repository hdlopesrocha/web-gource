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
  /** Let a connected gamepad fly the camera. */
  gamepad?: boolean
  /** Multiplier on the gamepad's rotation and translation speeds. */
  gamepadSensitivity?: number
  /** Follow the device's gyroscope (head tracking). */
  gyro?: boolean
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
const scratchBasis = new THREE.Matrix4()
const scratchForward = new THREE.Vector3()
const scratchEuler = new THREE.Euler()
const scratchDelta = new THREE.Quaternion()
const scratchLookAt = new THREE.Vector3()

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
  /**
   * Free 6-DOF mode: a gamepad or the device gyroscope drives the camera, which
   * then keeps its own position and orientation instead of orbiting a target.
   * The orbit state above is left untouched, so leaving free mode (or pressing
   * Reset) returns to exactly the view the user had.
   */
  private free = false
  private freePosition = new THREE.Vector3()
  private freeQuaternion = new THREE.Quaternion()
  /** Camera pose and device pose captured by the last head-tracking calibration. */
  private orientationBase = new THREE.Quaternion()
  private orientationReference = new THREE.Quaternion()
  private hasOrientationReference = false

  constructor() {
    this.camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.1, 100000)
    this.camera.up.set(0, 0, 1)
    this.setViewport(16, 9)
  }

  get isUserControlling(): boolean {
    return this.free || performance.now() * 0.001 < this.interactionUntil || this.dragging !== null
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
    if (!this.free) return this.target.clone()
    // In free mode the view centre is wherever the camera looks on the plane.
    const origin = this.camera.position
    scratchForward.set(0, 0, -1).applyQuaternion(this.freeQuaternion)
    const dz = scratchForward.z
    if (Math.abs(dz) < 1e-6) return this.target.clone()
    const t = (this.target.z - origin.z) / dz
    if (t <= 0) return this.target.clone()
    return scratchLookAt.copy(origin).addScaledVector(scratchForward, t)
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
    if (this.free) {
      this.camera.position.copy(this.freePosition)
      this.camera.quaternion.copy(this.freeQuaternion)
      // The up vector is the camera's own +Y rotated by the same orientation, so
      // head tracking tilts the horizon exactly as much as the user's head does.
      this.camera.up.set(0, 1, 0).applyQuaternion(this.freeQuaternion)
      const distance = Math.max(0.1, this.freePosition.distanceTo(this.target))
      this.camera.near = Math.max(0.1, distance / 10000)
      this.camera.far = Math.max(2000, distance * 200)
      this.camera.updateProjectionMatrix()
      this.camera.updateMatrixWorld()
      return
    }
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
    // The flat view is a fixed top-down framing: flying the camera and a locked
    // plan view are mutually exclusive, so entering 2D gives the camera back.
    if (flat) this.leaveFreeMode()
    this.flat = flat
    this.applyCamera()
  }

  /** True while a gamepad or the gyroscope is flying the camera. */
  get isFree(): boolean {
    return this.free
  }

  /**
   * Take manual 6-DOF control, starting from wherever the camera is now, so the
   * switch never moves the view.
   */
  enterFreeMode(): void {
    if (this.free) return
    this.camera.updateMatrixWorld()
    this.freePosition.copy(this.camera.position)
    this.freeQuaternion.copy(this.camera.quaternion)
    this.free = true
    this.markInteraction()
    this.applyCamera()
  }

  /** Hand the camera back to the automatic orbit view. */
  leaveFreeMode(): void {
    if (!this.free) return
    this.free = false
    this.hasOrientationReference = false
    this.applyCamera()
  }

  /**
   * Rotate the free camera around its own axes.
   *
   * The three rates (radians per second) are composed into one quaternion delta
   * and applied in the camera's local frame, which is what makes a stick feel
   * like a head rotation — and what allows roll, which an orbit cannot express.
   */
  rotateLocal(yaw: number, pitch: number, roll: number, dt: number): void {
    if (yaw === 0 && pitch === 0 && roll === 0) return
    this.enterFreeMode()
    const seconds = Math.max(0, dt)
    scratchEuler.set(pitch * seconds, yaw * seconds, roll * seconds, 'YXZ')
    scratchDelta.setFromEuler(scratchEuler)
    this.freeQuaternion.multiply(scratchDelta)
    this.markInteraction()
    this.applyCamera()
  }

  /**
   * Translate the free camera along its own axes (world units per second):
   * forward is the view direction, side the camera's right, up its own up.
   */
  translateLocal(forward: number, side: number, up: number, dt: number): void {
    if (forward === 0 && side === 0 && up === 0) return
    this.enterFreeMode()
    const seconds = Math.max(0, dt)
    scratchBasis.makeRotationFromQuaternion(this.freeQuaternion)
    scratchForward.set(0, 0, -1).applyMatrix4(scratchBasis)
    scratchRight.set(1, 0, 0).applyMatrix4(scratchBasis)
    scratchUp.set(0, 1, 0).applyMatrix4(scratchBasis)
    this.freePosition
      .addScaledVector(scratchForward, forward * seconds)
      .addScaledVector(scratchRight, side * seconds)
      .addScaledVector(scratchUp, up * seconds)
    this.markInteraction()
    this.applyCamera()
  }

  /**
   * Follow a device orientation.
   *
   * The camera keeps the offset it had when tracking started (or was last
   * calibrated): the device rotation since the reference pose is applied to the
   * camera's local frame, so a rotation of the user's head rotates the view by
   * exactly the same amount.
   */
  applyOrientation(cameraQuaternion: THREE.Quaternion): void {
    this.enterFreeMode()
    if (!this.hasOrientationReference) this.calibrateOrientation(cameraQuaternion)
    scratchDelta.copy(this.orientationReference).invert().multiply(cameraQuaternion)
    this.freeQuaternion.copy(this.orientationBase).multiply(scratchDelta)
    this.markInteraction()
    this.applyCamera()
  }

  /**
   * Bind the current device pose to the current camera pose.
   *
   * This is the "click to reset the gyroscope" step: the view does not move, and
   * every later rotation is measured from here — which is how the camera is
   * calibrated exactly to the orientation of the user's head.
   */
  calibrateOrientation(cameraQuaternion: THREE.Quaternion): void {
    this.orientationReference.copy(cameraQuaternion)
    this.orientationBase.copy(this.free ? this.freeQuaternion : this.camera.quaternion)
    this.hasOrientationReference = true
  }

  /** True once a gyroscope pose has been bound as the reference. */
  get isOrientationCalibrated(): boolean {
    return this.hasOrientationReference
  }

  /** Orbit the camera by a pointer delta in CSS pixels. */
  orbitBy(dx: number, dy: number): void {
    this.markInteraction()
    // Dragging with the mouse means the orbit model again.
    if (this.free) this.leaveFreeMode()
    // The flat view has no orbit: ignore rotation input so the top-down
    // framing (and the old 2D behaviour) stays intact.
    if (this.flat) return
    this.desiredYaw -= dx * ORBIT_SPEED
    this.desiredPitch = clamp(this.desiredPitch - dy * ORBIT_SPEED, MIN_PITCH, MAX_PITCH)
  }

  /** Pan the orbit target by a pointer delta in CSS pixels. */
  panByPixels(dx: number, dy: number): void {
    this.markInteraction()
    if (this.free) this.leaveFreeMode()
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
    this.leaveFreeMode()
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
    this.leaveFreeMode()
    this.reset(bounds, immediate)
  }

  /** Reset pan/zoom and let the automatic behaviour take over. */
  recenter(bounds: CameraBounds): void {
    this.frame(bounds, false)
    this.desiredYaw = DEFAULT_YAW
    this.desiredPitch = DEFAULT_PITCH
    this.interactionUntil = 0
  }

  /** Keep the free camera within a generous box around the repository. */
  private clampFreePosition(bounds: CameraBounds): void {
    const limit = Math.max(400, bounds.radius * 12)
    const centerZ = bounds.center.z ?? 0
    this.freePosition.x = clamp(this.freePosition.x, bounds.center.x - limit, bounds.center.x + limit)
    this.freePosition.y = clamp(this.freePosition.y, bounds.center.y - limit, bounds.center.y + limit)
    this.freePosition.z = clamp(this.freePosition.z, centerZ - limit, centerZ + limit)
  }

  private zoomForRadius(radius: number): number {    const aspect = this.viewport.width / this.viewport.height
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

    if (this.free) {
      // A gamepad or the gyroscope owns the camera: no automatic panning, no
      // auto-zoom and no orbit damping. Only the position is kept in range of
      // the repository, so it is impossible to fly off into the void.
      this.clampFreePosition(bounds)
      this.applyCamera()
      return
    }

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
