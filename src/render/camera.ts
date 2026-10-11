import * as THREE from 'three'

export interface CameraOptions {
  /** Keep the focus point centred on recent activity. */
  followActivity: boolean
  /** Slowly orbit around the focus point. */
  autoRotate: boolean
  /** Adapt the distance to the size of the repository. */
  autoZoom: boolean
  /** Radians per second for the automatic orbit. */
  rotateSpeed: number
}

export interface CameraBounds {
  center: { x: number; y: number; z: number }
  radius: number
}

const MIN_PHI = 0.18
const MAX_PHI = Math.PI - 0.18
const MIN_DISTANCE = 4
const MAX_DISTANCE = 1400
/** Seconds after a manual interaction during which automatic motion pauses. */
const INTERACTION_GRACE = 6

/**
 * Orbit camera with Gource-like automatic behaviour and manual override.
 *
 * Automatic mode keeps the interesting part of the tree in frame: the focus
 * point follows recent activity, the distance adapts to the repository size and
 * the camera slowly orbits. Dragging, pinching or scrolling takes over
 * immediately and hands control back after a few idle seconds.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera
  private target = new THREE.Vector3()
  private desiredTarget = new THREE.Vector3()
  private distance = 60
  private desiredDistance = 60
  private theta = Math.PI * 0.25
  private desiredTheta = Math.PI * 0.25
  private phi = Math.PI * 0.38
  private desiredPhi = Math.PI * 0.38
  private interactionUntil = 0
  private dragging: 'rotate' | 'pan' | null = null
  private lastPointer = { x: 0, y: 0 }
  private panOffset = new THREE.Vector3()
  private disposers: (() => void)[] = []

  constructor(aspect = 16 / 9) {
    this.camera = new THREE.PerspectiveCamera(52, aspect, 0.35, 26000)
    this.camera.position.set(0, 30, 80)
    this.camera.lookAt(0, 0, 0)
  }

  get isUserControlling(): boolean {
    return performance.now() * 0.001 < this.interactionUntil || this.dragging !== null
  }

  get currentDistance(): number {
    return this.distance
  }

  attach(element: HTMLElement): void {
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 2) return
      this.markInteraction()
      this.dragging = event.button === 2 || event.shiftKey ? 'pan' : 'rotate'
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
      if (this.dragging === 'rotate') {
        this.desiredTheta -= dx * 0.005
        this.desiredPhi = clamp(this.desiredPhi - dy * 0.005, MIN_PHI, MAX_PHI)
        this.desiredTheta -= 0
      } else {
        const scale = this.distance * 0.0016
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0)
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1)
        this.panOffset.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale)
        this.desiredTarget.copy(this.target).add(this.panOffset)
      }
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!this.dragging) return
      this.dragging = null
      element.releasePointerCapture?.(event.pointerId)
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      this.markInteraction()
      const factor = Math.exp(event.deltaY * 0.0012)
      this.desiredDistance = clamp(this.desiredDistance * factor, MIN_DISTANCE, MAX_DISTANCE)
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

  /** Zoom/(de)rotate programmatically (keyboard shortcuts). */
  nudge(delta: { theta?: number; phi?: number; distance?: number; panX?: number; panY?: number }): void {
    this.markInteraction()
    if (delta.theta) this.desiredTheta += delta.theta
    if (delta.phi) this.desiredPhi = clamp(this.desiredPhi + delta.phi, MIN_PHI, MAX_PHI)
    if (delta.distance) this.desiredDistance = clamp(this.desiredDistance * delta.distance, MIN_DISTANCE, MAX_DISTANCE)
    if (delta.panX || delta.panY) {
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0)
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1)
      this.panOffset
        .addScaledVector(right, delta.panX ?? 0)
        .addScaledVector(up, delta.panY ?? 0)
      this.desiredTarget.copy(this.target).add(this.panOffset)
    }
  }

  /** Reset the manual pan offset and re-centre on the repository. */
  recenter(bounds: CameraBounds): void {
    this.panOffset.set(0, 0, 0)
    this.desiredTarget.set(bounds.center.x, bounds.center.y, bounds.center.z)
    this.desiredDistance = clamp(bounds.radius * 1.9, 26, MAX_DISTANCE)
    this.markInteraction()
    this.interactionUntil = 0
  }

  /** Frame the repository immediately (used when a repository is loaded). */
  frame(bounds: CameraBounds, immediate = true): void {
    this.target.set(bounds.center.x, bounds.center.y, bounds.center.z)
    this.desiredTarget.copy(this.target)
    const distance = clamp(bounds.radius * 2.2, 30, MAX_DISTANCE)
    this.desiredDistance = distance
    if (immediate) {
      this.distance = distance
      this.theta = this.desiredTheta = Math.PI * 0.25
      this.phi = this.desiredPhi = Math.PI * 0.4
    }
  }

  update(
    dt: number,
    options: CameraOptions,
    focus: { x: number; y: number; z: number } | null,
    bounds: CameraBounds,
  ): void {
    const manual = this.isUserControlling

    if (!manual) {
      if (options.followActivity && focus) {
        this.desiredTarget.set(
          focus.x * 0.75 + bounds.center.x * 0.25,
          focus.y * 0.75 + bounds.center.y * 0.25,
          focus.z * 0.75 + bounds.center.z * 0.25,
        )
        this.panOffset.set(0, 0, 0)
      } else {
        this.desiredTarget.set(bounds.center.x, bounds.center.y, bounds.center.z).add(this.panOffset)
      }
      if (options.autoZoom) {
        const target = options.followActivity && focus
          ? clamp(bounds.radius * 1.05, 30, 260)
          : clamp(bounds.radius * 1.9, 30, MAX_DISTANCE)
        this.desiredDistance = target
      }
      if (options.autoRotate) this.desiredTheta += options.rotateSpeed * dt
    }

    const targetDamping = 1 - Math.exp(-dt * 1.1)
    const distanceDamping = 1 - Math.exp(-dt * 0.85)
    const rotateDamping = 1 - Math.exp(-dt * 6)

    this.target.lerp(this.desiredTarget, this.dragging === 'pan' ? 1 - Math.exp(-dt * 14) : targetDamping)
    this.distance += (this.desiredDistance - this.distance) * distanceDamping
    this.theta += (this.desiredTheta - this.theta) * rotateDamping
    this.phi += (this.desiredPhi - this.phi) * rotateDamping

    const sinPhi = Math.sin(this.phi)
    this.camera.position.set(
      this.target.x + this.distance * sinPhi * Math.cos(this.theta),
      this.target.y + this.distance * Math.cos(this.phi),
      this.target.z + this.distance * sinPhi * Math.sin(this.theta),
    )
    this.camera.lookAt(this.target)
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
  }

  /** World position of the camera target (used for label priority). */
  get focusPoint(): THREE.Vector3 {
    return this.target
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
