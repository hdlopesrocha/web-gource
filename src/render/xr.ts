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
  addEventListener(type: 'end', listener: () => void): void
  removeEventListener(type: 'end', listener: () => void): void
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
}

/** Reference space type: the floor is the origin, so a tabletop has a real height. */
export const XR_REFERENCE_SPACE = 'local-floor'
/** Features we ask for; both are optional, so a headset may refuse either. */
export const XR_OPTIONAL_FEATURES = ['local-floor', 'bounded-floor'] as const
/** How far in front of the user the centre of the tree sits, in metres. */
export const XR_TABLE_DISTANCE = 1.35
/** Height of the tabletop above the floor, in metres. */
export const XR_TABLE_HEIGHT = 0.95
/** The tree is scaled to fit inside this many metres. */
export const XR_TABLE_SIZE = 1.5

/** The tree lies in its own XY plane; tip it flat so it reads as a tabletop. */
const XR_TILT = new THREE.Euler(-Math.PI / 2, 0, 0)

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
 * running the tabletop is tipped flat in front of the user (see
 * {@link XR_TABLE_HEIGHT}) and the camera is parented to an XR rig group, so
 * three can pose it from the headset; `end` (or `exit()`) restores the previous
 * scene and camera transforms.
 */
export class XrSession {
  private readonly renderer: XrRendererLike
  private readonly framing: XrFramingTarget | null
  private readonly xr: XrSystemLike | null
  private session: XrSessionLike | null = null
  private saved: SavedState | null = null
  private disposed = false

  constructor(options: XrSessionOptions) {
    this.renderer = options.renderer
    this.framing = options.framing ?? null
    this.xr = 'xr' in options ? (options.xr ?? null) : navigatorXr()
  }

  /** True while an immersive session is running. */
  get active(): boolean {
    return this.session !== null
  }

  private readonly onEnd = (): void => {
    this.restore()
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
   * Tip the tabletop flat and place it in front of the user.
   *
   * `local-floor` puts the origin on the floor where the session started, with
   * the user looking down -Z, so the tree centre lands
   * `XR_TABLE_DISTANCE` metres ahead at `XR_TABLE_HEIGHT`, scaled so the whole
   * repository fits in `XR_TABLE_SIZE` metres.
   */
  private frameTabletop(): void {
    const framing = this.framing
    if (!framing) return
    const { center, radius } = framing.bounds()
    const scale = XR_TABLE_SIZE / Math.max(0.001, radius * 2)
    const cz = center.z ?? 0
    framing.root.quaternion.setFromEuler(XR_TILT)
    framing.root.scale.setScalar(scale)
    framing.root.position.set(
      -center.x * scale,
      XR_TABLE_HEIGHT - cz * scale,
      -XR_TABLE_DISTANCE + center.y * scale,
    )
    framing.root.updateMatrixWorld(true)
  }

  /** Restore the flags, the scene transform and the camera parent. */
  private restore(): void {
    const saved = this.saved
    const session = this.session
    this.saved = null
    this.session = null
    if (session) session.removeEventListener('end', this.onEnd)
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
