import * as THREE from 'three'
import { store } from '../state/store'

/**
 * WebXR session management.
 *
 * The visualizer is an ordinary three.js scene, so "VR support" is three's own
 * WebXR manager plus a little bookkeeping: request an immersive session, hand it
 * to the renderer, and place the tabletop in front of the user. Every
 * dependency (`xr`, `renderer`, `framing`) is injected, so the whole flow can be
 * unit-tested in jsdom, where neither WebXR nor WebGL exists.
 *
 * Scope note: the backdrop is a clip-space gradient, so it keeps filling each
 * eye while presenting. A real skybox / room environment is out of scope here;
 * the scene sits in an otherwise empty void.
 */

/** Minimal structural view of `navigator.xr` (kept structural so tests can fake it). */
export interface XrSystemLike {
  isSessionSupported(mode: string): Promise<boolean>
  requestSession(mode: string, options?: { optionalFeatures?: readonly string[] }): Promise<XrSessionLike>
}

/** Minimal structural view of an `XRSession`: the parts this module uses. */
export interface XrSessionLike {
  addEventListener(type: 'end' | 'select', listener: () => void): void
  removeEventListener(type: 'end' | 'select', listener: () => void): void
  end?(): Promise<void>
}

/** Minimal structural view of `THREE.WebGLRenderer.xr` (three's WebXRManager). */
export interface XrManagerLike {
  enabled: boolean
  isPresenting: boolean
  setReferenceSpaceType(type: string): void
  setSession(session: XrSessionLike | null): Promise<void>
}

export interface XrRendererLike {
  xr: XrManagerLike
}

/** Bounds of the current repository, in the tabletop's own coordinates. */
export interface XrBounds {
  center: { x: number; y: number; z?: number }
  radius: number
}

/**
 * What the session moves around: the camera is parented to a rig group for the
 * duration of the session (three poses it from the headset relative to that
 * parent), and the tabletop root is moved and scaled into the room.
 */
export interface XrFramingTarget {
  /** Group the camera is parented to while presenting. */
  rig: THREE.Object3D
  /** Scene the rig is added to. */
  scene: THREE.Object3D
  /** Camera handed to `renderer.render()`; three re-poses it from the headset. */
  camera: THREE.Object3D
  /** Root of the tabletop: moved and scaled to sit in front of the user. */
  root: THREE.Object3D
  /** Current repository bounds, used to fit the tabletop. */
  bounds(): XrBounds
}

export interface XrSessionOptions {
  /** three's WebGL renderer (its `xr` manager is what we drive). */
  renderer: XrRendererLike
  /** The scene transform and camera parent to borrow while presenting. */
  framing?: XrFramingTarget | null
  /** Injectable `navigator.xr`; omit to read the real one, pass `null` for none. */
  xr?: XrSystemLike | null
  /**
   * Called when a controller's primary action fires (`select`). The app uses
   * this to recenter the view, matching a click on the mirrored desktop canvas.
   */
  onSelect?: () => void
  /**
   * Height of the VR follow camera above the tabletop, in metres. Read on every
   * frame so the Settings slider takes effect immediately.
   */
  viewHeight?: () => number
}

/** Reference space type: the floor is the origin, so the user has a real height. */
export const XR_REFERENCE_SPACE = 'local-floor'
/** Features we ask for; both are optional, so a headset may refuse either. */
export const XR_OPTIONAL_FEATURES = ['local-floor', 'bounded-floor'] as const
/** The tree is scaled to fit inside this many metres. */
export const XR_TABLE_SIZE = 1.5

/**
 * The vantage the VR `follow` camera watches the action from.
 *
 * It sits on an orbit of {@link XR_OVERVIEW_RADIUS} around the followed point,
 * tilted by whatever height the `VR view height` setting picks, and always
 * looks at that point. The headset orientation still rotates the view around
 * that base, so the user can look around while the camera tracks the action.
 */
export const XR_OVERVIEW_RADIUS = XR_TABLE_SIZE * 1.5
/** Bounds of the `VR view height` setting, in metres above the tabletop. */
export const XR_OVERVIEW_MIN_HEIGHT = 0.35
export const XR_OVERVIEW_MAX_HEIGHT = XR_OVERVIEW_RADIUS * 0.98
/** Default height, matching the desktop default angle of ~53 degrees. */
export const XR_OVERVIEW_DEFAULT_HEIGHT = 1.8

/** Clamp a `VR view height` value to the supported orbit range. */
export function clampXrViewHeight(value: number): number {
  if (!Number.isFinite(value)) return XR_OVERVIEW_DEFAULT_HEIGHT
  return Math.min(XR_OVERVIEW_MAX_HEIGHT, Math.max(XR_OVERVIEW_MIN_HEIGHT, value))
}

/** The table's up axis, in the tree's own Z-up frame. */
const XR_UP = new THREE.Vector3(0, 0, 1)

/**
 * Rotation that makes the tree's own frame read as a room.
 *
 * The scene is authored Z-up (the camera's up vector is the plane normal), while
 * WebXR's `local-floor` space is Y-up. The tree stays in its own frame and the
 * *rig* is tipped instead, so the scene keeps its on-screen orientation and the
 * user stands inside it rather than next to a moved copy of it.
 */
const XR_RIG_TILT = new THREE.Euler(Math.PI / 2, 0, 0)

/** `navigator.xr`, or null where WebXR is not exposed at all. */
export function navigatorXr(): XrSystemLike | null {
  if (typeof navigator === 'undefined') return null
  const xr = (navigator as unknown as { xr?: XrSystemLike | null }).xr
  return xr ?? null
}

/**
 * Whether an immersive VR device is available.
 *
 * Never throws: a missing `navigator.xr` (the common case in a desktop browser)
 * and a rejected `isSessionSupported` both report "unsupported".
 */
export async function isXrSupported(xr: XrSystemLike | null | undefined = navigatorXr()): Promise<boolean> {
  if (!xr) return false
  try {
    return await xr.isSessionSupported('immersive-vr')
  } catch {
    return false
  }
}

/** Turn a WebXR failure into a sentence the UI can show. */
export function describeXrError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'VR access was denied. Allow immersive sessions in the browser, then try again.'
  }
  if (name === 'NotSupportedError') {
    return 'This browser or device cannot start an immersive VR session.'
  }
  const message = error instanceof Error && error.message ? error.message : ''
  return message ? `Could not start the VR session: ${message}` : 'Could not start the VR session.'
}

interface SavedTransform {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  scale: THREE.Vector3
}

interface SavedState {
  enabled: boolean
  rig: SavedTransform | null
  root: SavedTransform | null
  camera: SavedTransform | null
  cameraParent: THREE.Object3D | null
  cameraUp: THREE.Vector3 | null
  cameraNear: number | null
  cameraFar: number | null
}

/**
 * One immersive WebXR session at a time.
 *
 * `enter()` never throws: every failure path records a human sentence in
 * `store.ui.xrError` and leaves the app exactly as it was. While a session is
 * running the camera is parented to an XR rig group and the rig is tipped and
 * placed at the local-floor origin (see {@link frameTabletop}), so three can
 * pose the camera from the headset. The camera watches the recent activity from
 * the height picked by the `VR view height` setting, with the headset adding
 * look-around. `end` (or `exit()`) restores the previous scene, rig and camera
 * transforms.
 */
export class XrSession {
  private readonly renderer: XrRendererLike
  private readonly framing: XrFramingTarget | null
  private readonly xr: XrSystemLike | null
  private readonly onSelect: (() => void) | null
  private readonly viewHeight: () => number
  private session: XrSessionLike | null = null
  private saved: SavedState | null = null
  private cameraHeightFitted = false
  private disposed = false
  /** Headset orientation treated as the camera's forward reference. */
  private readonly headReference = new THREE.Quaternion()
  private readonly headReferenceInverse = new THREE.Quaternion()
  private hasHeadReference = false
  /** Scene point the camera watches; set by the engine each frame. */
  private readonly followTarget = new THREE.Vector3()
  private hasFollowTarget = false
  private readonly rigPosition = new THREE.Vector3()
  private readonly rigQuaternion = new THREE.Quaternion()
  private readonly rotatedPosition = new THREE.Vector3()
  private readonly overviewEye = new THREE.Vector3()
  private readonly overviewTarget = new THREE.Vector3()
  private readonly overviewBase = new THREE.Quaternion()
  private readonly overviewMatrix = new THREE.Matrix4()

  constructor(options: XrSessionOptions) {
    this.renderer = options.renderer
    this.framing = options.framing ?? null
    this.xr = 'xr' in options ? (options.xr ?? null) : navigatorXr()
    this.onSelect = options.onSelect ?? null
    this.viewHeight = options.viewHeight ?? (() => XR_OVERVIEW_DEFAULT_HEIGHT)
  }

  /** True while an immersive session is running. */
  get active(): boolean {
    return this.session !== null
  }

  private readonly onEnd = (): void => {
    this.restore()
  }

  private readonly onSelectEvent = (): void => {
    this.onSelect?.()
  }

  /**
   * Request and attach an immersive session.
   *
   * Resolves either way: on failure `store.ui.xrError` explains what went wrong
   * and `store.ui.xrActive` stays false.
   */
  async enter(): Promise<void> {
    if (this.session || this.disposed) return
    store.ui.xrError = null
    this.cameraHeightFitted = false
    this.hasFollowTarget = false

    const xr = this.xr
    if (!xr) {
      store.ui.xrError = 'Immersive VR is not available in this browser: no WebXR device was found.'
      return
    }

    let session: XrSessionLike
    try {
      session = await xr.requestSession('immersive-vr', { optionalFeatures: [...XR_OPTIONAL_FEATURES] })
    } catch (error) {
      store.ui.xrError = describeXrError(error)
      return
    }

    const manager = this.renderer.xr
    this.saved = {
      enabled: manager.enabled,
      rig: this.framing ? saveTransform(this.framing.rig) : null,
      root: this.framing ? saveTransform(this.framing.root) : null,
      camera: this.framing ? saveTransform(this.framing.camera) : null,
      cameraParent: this.framing ? this.framing.camera.parent : null,
      cameraUp: this.framing && this.framing.camera instanceof THREE.PerspectiveCamera ? this.framing.camera.up.clone() : null,
      cameraNear: this.framing && this.framing.camera instanceof THREE.PerspectiveCamera ? this.framing.camera.near : null,
      cameraFar: this.framing && this.framing.camera instanceof THREE.PerspectiveCamera ? this.framing.camera.far : null,
    }

    try {
      // The reference space must be chosen before the session is attached:
      // three resolves it inside `setSession`.
      manager.enabled = true
      manager.setReferenceSpaceType(XR_REFERENCE_SPACE)
      this.attachRig()
      this.frameTabletop()
      await manager.setSession(session)
    } catch (error) {
      store.ui.xrError = describeXrError(error)
      this.restore()
      await endSession(session)
      return
    }

    this.session = session
    session.addEventListener('end', this.onEnd)
    // A controller trigger (or a hand/pointer select) recenters the view. It is
    // deliberately not an activation for the gaze UI: recentring must remain
    // available from anywhere, even when the reticle is not on a control.
    session.addEventListener('select', this.onSelectEvent)
    store.ui.xrActive = true
  }

  /** Leave the current session (a no-op when none is running). */
  async exit(): Promise<void> {
    const session = this.session
    if (!session) return
    await endSession(session)
    // Browsers fire `end` asynchronously; restore defensively in case the fake
    // session (or a hostile implementation) never does.
    this.restore()
  }

  /** Forget the session and put the scene back. Safe to call more than once. */
  dispose(): void {
    this.disposed = true
    const session = this.session
    this.restore()
    if (session) void endSession(session)
  }

  /* ------------------------------------------------------------------ *
   * Framing
   * ------------------------------------------------------------------ */

  /** Parent the camera to the rig so three poses it relative to the rig. */
  private attachRig(): void {
    const framing = this.framing
    if (!framing) return
    if (framing.rig.parent !== framing.scene) framing.scene.add(framing.rig)
    if (framing.camera.parent !== framing.rig) framing.rig.add(framing.camera)
  }

  /**
   * Stand the user on the local floor at the scene origin.
   *
   * Instead of moving the tree in front of the user, the *user* is moved onto
   * the scene: the rig is tipped so the tree's Z-up frame reads as the room's
   * floor and placed at `(0, 0, 0)`. The tree keeps its tabletop scale but is
   * scaled and centred on the origin, so walking around it in the room orbits
   * the real thing rather than a moved copy.
   *
   * The rig starts on the floor; the `local-floor` headset pose carries the
   * real eye height. {@link fitCameraHeight} then moves the rig down once that
   * height is known, so the tabletop is not left far below the eyes.
   */
  private frameTabletop(): void {
    const framing = this.framing
    if (!framing) return
    const { center, radius } = framing.bounds()
    const scale = XR_TABLE_SIZE / Math.max(0.001, radius * 2)
    const cz = center.z ?? 0

    // The tree is scaled to the room and centred on the scene origin (no more
    // "table in front" offset).
    framing.root.quaternion.identity()
    framing.root.scale.setScalar(scale)
    framing.root.position.set(-center.x * scale, -center.y * scale, -cz * scale)
    framing.root.updateMatrixWorld(true)

    // The user stands at the local-floor origin, with the tree's +Z as "up".
    // The headset pose supplies the real eye height.
    framing.rig.quaternion.setFromEuler(XR_RIG_TILT)
    framing.rig.position.set(0, 0, 0)
    framing.rig.updateMatrixWorld(true)
    this.hasHeadReference = false
    this.hasFollowTarget = false
  }

  /**
   * Anchor the camera to the first real headset pose.
   *
   * Call after three has updated the XR camera. Returns true once a valid pose
   * has been seen, so the caller can re-pose the XR camera before drawing.
   */
  fitCameraHeight(): boolean {
    if (!this.session || !this.framing || this.cameraHeightFitted) return false
    const eyeHeight = this.framing.camera.position.y
    // Ignore the first pose before tracking starts (or an origin-only pose).
    if (!Number.isFinite(eyeHeight) || eyeHeight < 0.25) return false
    this.captureHeadReference()
    this.cameraHeightFitted = true
    return true
  }

  /** Remember the headset orientation the camera treats as forward. */
  private captureHeadReference(): void {
    const framing = this.framing
    if (!framing) return
    this.headReference.copy(framing.camera.quaternion)
    this.headReferenceInverse.copy(this.headReference).invert()
    this.hasHeadReference = true
  }

  /**
   * Scene point the camera watches. The engine sets this each frame to the
   * damped focus of recent activity, so the camera tracks the users.
   */
  setFollowTarget(target: THREE.Vector3): void {
    this.followTarget.copy(target)
    this.hasFollowTarget = true
  }

  /**
   * Apply the camera behaviour to the rig.
   *
   * The headset pose itself is never changed: instead the rig is moved and
   * rotated so that `rig * headsetPose` is the view we want. The camera flies
   * to a vantage over the followed point and looks at it, with the headset
   * orientation rotating the view around that base. Returns true when the rig
   * changed, so the caller can re-pose the XR camera before drawing the panel
   * and gaze.
   */
  applyCameraPose(): boolean {
    const framing = this.framing
    if (!this.session || !framing) return false
    return this.applyFollow()
  }

  /**
   * The follow camera: watch the action from an elevated vantage.
   *
   * The eye sits on an orbit around the followed point, at the `VR view height`
   * setting, and always faces it. The headset rotation is applied on top of that
   * base and its translation is cancelled, so the user looks around while the
   * camera tracks the users.
   */
  private applyFollow(): boolean {
    const framing = this.framing
    if (!framing) return false
    if (!this.hasHeadReference) this.captureHeadReference()

    const height = clampXrViewHeight(this.viewHeight())
    const horizontal = Math.sqrt(Math.max(0, XR_OVERVIEW_RADIUS * XR_OVERVIEW_RADIUS - height * height))
    if (this.hasFollowTarget) this.overviewTarget.copy(this.followTarget)
    else this.overviewTarget.set(0, 0, 0)
    const target = this.overviewTarget
    // Standard direction: from -Y (the desktop default yaw), looking at the
    // followed point.
    this.overviewEye.set(target.x, target.y - horizontal, target.z + height)
    this.overviewMatrix.lookAt(this.overviewEye, target, XR_UP)
    this.overviewBase.setFromRotationMatrix(this.overviewMatrix)

    // `world = base * (reference⁻¹ * headset)`, so the reference orientation
    // faces the action and head rotation is relative to it.
    this.rigQuaternion.copy(this.overviewBase).multiply(this.headReferenceInverse)
    this.rotatedPosition.copy(framing.camera.position).applyQuaternion(this.rigQuaternion)
    this.rigPosition.copy(this.overviewEye).sub(this.rotatedPosition)
    return this.applyRigPose(this.rigPosition, this.rigQuaternion)
  }

  private applyRigPose(position: THREE.Vector3, quaternion: THREE.Quaternion): boolean {
    const rig = this.framing?.rig
    if (!rig) return false
    const unchanged =
      rig.position.distanceToSquared(position) < 1e-12 && rig.quaternion.angleTo(quaternion) < 1e-7
    if (unchanged) return false
    rig.position.copy(position)
    rig.quaternion.copy(quaternion)
    rig.updateMatrixWorld(true)
    return true
  }

  /** Restore the flags, the scene transform and the camera parent. */
  private restore(): void {
    const saved = this.saved
    const session = this.session
    this.saved = null
    this.session = null
    this.cameraHeightFitted = false
    this.hasHeadReference = false
    this.hasFollowTarget = false
    if (session) {
      session.removeEventListener('end', this.onEnd)
      session.removeEventListener('select', this.onSelectEvent)
    }
    store.ui.xrActive = false
    if (!saved) return

    this.renderer.xr.enabled = saved.enabled

    const framing = this.framing
    if (!framing) return

    const camera = framing.camera
    if (camera.parent === framing.rig) framing.rig.remove(camera)
    if (saved.cameraParent) saved.cameraParent.add(camera)
    if (saved.camera) restoreTransform(camera, saved.camera)
    if (camera instanceof THREE.PerspectiveCamera) {
      if (saved.cameraUp) camera.up.copy(saved.cameraUp)
      if (saved.cameraNear !== null) camera.near = saved.cameraNear
      if (saved.cameraFar !== null) camera.far = saved.cameraFar
      camera.updateProjectionMatrix()
    }
    if (saved.rig) restoreTransform(framing.rig, saved.rig)
    if (saved.root) restoreTransform(framing.root, saved.root)
  }
}

function saveTransform(object: THREE.Object3D): SavedTransform {
  return {
    position: object.position.clone(),
    quaternion: object.quaternion.clone(),
    scale: object.scale.clone(),
  }
}

function restoreTransform(object: THREE.Object3D, saved: SavedTransform): void {
  object.position.copy(saved.position)
  object.quaternion.copy(saved.quaternion)
  object.scale.copy(saved.scale)
  object.updateMatrix()
  object.updateMatrixWorld(true)
}

/** End a session without letting a hostile implementation break the caller. */
async function endSession(session: XrSessionLike): Promise<void> {
  try {
    await session.end?.()
  } catch {
    // The session is already gone: nothing left to clean up here.
  }
}
