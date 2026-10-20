import * as THREE from 'three'

/**
 * Head tracking from the device's gyroscope (`deviceorientation`).
 *
 * The W3C angles already live in a Z-up world (X east, Y north, Z up), which is
 * the same frame the repository plane uses, so the device orientation needs no
 * axis swap: it is the intrinsic Z → X → Y rotation `Rz(alpha) · Rx(beta) ·
 * Ry(gamma)`, with the screen rotation applied last for landscape/portrait.
 *
 * A camera that is used like a window into the scene looks *out of the screen*,
 * which is the device's +Z, while three's camera looks down its own -Z and keeps
 * +Y up: the two frames differ by a half turn about Y, so the camera quaternion
 * is `device · Ry(π)`. Its up vector is therefore the device's screen-up rotated
 * by the gyroscope value, which is what makes the horizon follow the user's head
 * instead of staying glued to the tabletop.
 */

/** A `deviceorientation` reading, in degrees (the spec's units). */
export interface OrientationReading {
  alpha: number
  beta: number
  gamma: number
  /** Screen orientation in radians; 0 is portrait, ±π/2 landscape. */
  screenAngle?: number
}

/** The part of a `DeviceOrientationEvent` we read. */
export interface OrientationLike {
  alpha: number | null
  beta: number | null
  gamma: number | null
}

/** Anything we can subscribe to (a `Window`, or a stub in tests). */
export interface OrientationTarget {
  addEventListener(type: string, listener: (event: OrientationLike) => void): void
  removeEventListener(type: string, listener: (event: OrientationLike) => void): void
}

/** A window-like object that may expose a screen-orientation angle. */
export interface ScreenOrientationSource {
  screen?: { orientation?: { angle?: number } }
  orientation?: number
}

/** A `DeviceOrientationEvent` constructor that may ask for permission (iOS). */
export interface PermissionRequestingEvent {
  requestPermission?: () => Promise<'granted' | 'denied' | string>
}

const DEGREES = Math.PI / 180
const HALF_TURN_Y = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
const SCREEN_AXIS = new THREE.Vector3(0, 0, 1)

const scratchEuler = new THREE.Euler()
const scratchQuaternion = new THREE.Quaternion()

/** Device orientation (scene frame) from one reading. */
export function quaternionFromOrientation(
  reading: OrientationReading,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  const alpha = (reading.alpha || 0) * DEGREES
  const beta = (reading.beta || 0) * DEGREES
  const gamma = (reading.gamma || 0) * DEGREES
  // Intrinsic Z (compass) → X (front tilt) → Y (side tilt).
  scratchEuler.set(beta, gamma, alpha, 'ZXY')
  target.setFromEuler(scratchEuler)
  const screenAngle = reading.screenAngle ?? 0
  if (screenAngle !== 0) {
    scratchQuaternion.setFromAxisAngle(SCREEN_AXIS, -screenAngle)
    target.multiply(scratchQuaternion)
  }
  return target
}

/** Camera orientation for one reading: looking out of the screen. */
export function cameraQuaternionFromOrientation(
  reading: OrientationReading,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  quaternionFromOrientation(reading, target)
  return target.multiply(HALF_TURN_Y)
}

/** Screen rotation of the current viewport, in radians (0 when unknown). */
export function screenAngleRadians(source: ScreenOrientationSource = globalThis as ScreenOrientationSource): number {
  const angle = source.screen?.orientation?.angle
  if (typeof angle === 'number' && Number.isFinite(angle)) return angle * DEGREES
  const legacy = source.orientation
  if (typeof legacy === 'number' && Number.isFinite(legacy)) return legacy * DEGREES
  return 0
}

/** The window to subscribe on, or null outside a DOM (tests, workers). */
function defaultOrientationTarget(): OrientationTarget | null {
  if (typeof window === 'undefined') return null
  const host = window as unknown as OrientationTarget
  return typeof host.addEventListener === 'function' ? host : null
}

/**
 * Subscribes to `deviceorientation` and keeps the latest camera orientation.
 *
 * The controller is deliberately dumb: it reports where the device is pointing,
 * and the camera decides how to follow it (and how to calibrate it). Readings
 * can also be pushed in directly, which is what the tests do.
 */
export class DeviceOrientationController {
  private camera = new THREE.Quaternion()
  private device = new THREE.Quaternion()
  private upVector = new THREE.Vector3(0, 1, 0)
  private hasReading = false
  private screenAngle = 0
  private target: OrientationTarget | null = null
  private listener = (event: OrientationLike) => this.push(event)
  private usingScreenAngle = true

  /** True once a reading has arrived (the device has a gyroscope). */
  get available(): boolean {
    return this.hasReading
  }

  /** True while the controller is subscribed to `deviceorientation`. */
  get attached(): boolean {
    return this.target !== null
  }

  /** Orientation of the device in the scene frame. */
  get deviceQuaternion(): THREE.Quaternion {
    return this.device.clone()
  }

  /** Orientation the camera should have for the current device pose. */
  get cameraQuaternion(): THREE.Quaternion {
    return this.camera.clone()
  }

  /** The camera's up vector for the current pose (rotated by the gyroscope). */
  get up(): THREE.Vector3 {
    return this.upVector.clone()
  }

  /** Override the screen rotation (tests, or a host that reports it late). */
  setScreenAngle(radians: number): void {
    this.screenAngle = Number.isFinite(radians) ? radians : 0
    this.usingScreenAngle = true
  }

  /** Feed one reading (from the event listener or a test). */
  push(event: OrientationLike): void {
    if (event.alpha === null && event.beta === null && event.gamma === null) return
    const screenAngle = this.usingScreenAngle ? this.screenAngle : screenAngleRadians()
    const reading: OrientationReading = {
      alpha: event.alpha ?? 0,
      beta: event.beta ?? 0,
      gamma: event.gamma ?? 0,
      screenAngle,
    }
    quaternionFromOrientation(reading, this.device)
    cameraQuaternionFromOrientation(reading, this.camera)
    this.upVector.set(0, 1, 0).applyQuaternion(this.camera)
    this.hasReading = true
  }

  attach(target?: OrientationTarget | null): void {
    const host = target ?? defaultOrientationTarget()
    if (!host || typeof host.addEventListener !== 'function') return
    if (this.target === host) return
    this.detach()
    this.target = host
    this.screenAngle = screenAngleRadians()
    host.addEventListener('deviceorientation', this.listener)
  }

  detach(): void {
    if (!this.target) return
    this.target.removeEventListener('deviceorientation', this.listener)
    this.target = null
  }

  dispose(): void {
    this.detach()
    this.hasReading = false
  }
}

/**
 * Ask for motion-sensor permission where the browser requires it (iOS 13+).
 *
 * Must be called from a user gesture; everywhere else this resolves true
 * immediately, and a browser without the API is treated as "already allowed".
 */
export async function requestOrientationPermission(
  events: PermissionRequestingEvent | undefined = typeof DeviceOrientationEvent === 'undefined'
    ? undefined
    : (DeviceOrientationEvent as unknown as PermissionRequestingEvent),
): Promise<boolean> {
  const request = events?.requestPermission
  if (typeof request !== 'function') return true
  try {
    const result = await request.call(events)
    return result === 'granted'
  } catch {
    return false
  }
}
