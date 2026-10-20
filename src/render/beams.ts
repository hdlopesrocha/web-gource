import * as THREE from 'three'
import type { ChangeKind } from '../timeline/types'
import type { SimAuthor, SimNode, SimTether } from '../sim/simulation'
import { colorForChange } from './palette'

const scratchDirection = new THREE.Vector3()
const scratchToCamera = new THREE.Vector3()
const scratchSide = new THREE.Vector3()

/**
 * Beams between an author and the files it just changed.
 *
 * This is the Gource "tether": a glowing line from the avatar to every file
 * touched by the current commit, which fades out shortly after. Beams are
 * emitted as camera-facing quads (not `LineSegments`, which most drivers clamp
 * to one pixel) so the width is controllable, with the author end brighter than
 * the file end and additive blending turning the overlap into a bright core.
 *
 * The geometry is rebuilt each frame — a few hundred vertices — so the
 * endpoints can follow both the moving avatar and its target node.
 *
 * Two styles are available: `travelling` (the default) sends a bright head from
 * the avatar towards the element, with a comet-like tail following it and the
 * far end of the soft glow brightening as it arrives; `solid` is the original
 * full-length ray, kept so the older look is one setting away.
 */
export type BeamStyle = 'travelling' | 'solid'

export class BeamField {
  readonly mesh: THREE.Mesh
  private capacity: number
  private positions: Float32Array
  private colors: Float32Array
  private geometry: THREE.BufferGeometry
  private material: THREE.MeshBasicMaterial
  private enabled = true
  private intensity = 1
  private widthPixels = 3.2
  private style: BeamStyle = 'travelling'
  private travelSeconds = 0.55
  /** Fraction of the beam the bright head covers while it travels. */
  private readonly cometLength = 0.45
  private lastSegments = 0
  /** Vertical offset applied to the author end so beams start at the avatar. */
  private readonly authorLift = 2.5
  private scratch = new THREE.Color()

  constructor(capacity = 160) {
    this.capacity = capacity
    // Twelve vertices per beam: a wide soft glow quad plus a bright core quad.
    this.positions = new Float32Array(capacity * 12 * 3)
    this.colors = new Float32Array(capacity * 12 * 3)
    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3))
    this.geometry.setDrawRange(0, 0)
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // The rays are scene geometry, not an overlay: a beam that passes behind
      // a file circle or a folder ring is occluded by it, exactly like the
      // particles. Only the halo layer below them skips the depth test.
      depthTest: true,
      toneMapped: false,
    })
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 12
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.mesh.visible = enabled
  }

  setIntensity(intensity: number): void {
    this.intensity = Math.max(0, intensity)
  }

  /** Beam width in CSS pixels (for an average change). */
  setWidthPixels(pixels: number): void {
    this.widthPixels = Math.max(0.5, pixels)
  }

  /** How the beam is drawn: a travelling head, or the original solid ray. */
  setStyle(style: BeamStyle): void {
    this.style = style
  }

  /** Seconds the bright head takes to travel from the avatar to the element. */
  setTravelSeconds(seconds: number): void {
    this.travelSeconds = Math.min(3, Math.max(0.1, seconds))
  }

  get currentStyle(): BeamStyle {
    return this.style
  }

  /**
   * Strength multiplier for a tether: a commit that changed a file a lot gets a
   * wider, brighter beam than a one-line tweak. Normalised against the largest
   * change in the loaded window, so it stays meaningful across repositories.
   */
  private strengthScale(tether: SimTether): number {
    const reference = Math.max(1, tether.reference)
    const ratio = Math.min(1, Math.max(0, tether.strength / reference))
    // A gentle curve: small changes stay visible, big ones stand out.
    return 0.55 + 0.85 * Math.pow(ratio, 0.6)
  }

  /** Number of beams drawn in the last update (diagnostics). */
  get segmentCount(): number {
    return this.lastSegments
  }

  /** Vertex data of the first beam, for diagnostics. */
  sample(): Record<string, number> | null {
    if (this.lastSegments === 0) return null
    return {
      segments: this.lastSegments,
      ax: round(this.positions[0]),
      ay: round(this.positions[1]),
      bx: round(this.positions[12]),
      by: round(this.positions[13]),
      red: round(this.colors[0], 3),
      green: round(this.colors[1], 3),
      blue: round(this.colors[2], 3),
      fileRed: round(this.colors[12], 3),
      drawCount: this.geometry.drawRange.count,
      visible: this.mesh.visible ? 1 : 0,
      widthPixels: this.widthPixels,
      style: this.style === 'travelling' ? 1 : 0,
      /** Leading edge of the bright core (where the head is). */
      headX: round(this.positions[24]),
      headY: round(this.positions[25]),
      /** Trailing edge of the bright core. */
      coreX: round(this.positions[18]),
      coreY: round(this.positions[19]),
    }
  }

  /**
   * Rewrite the beam geometry for the current frame.
   *
   * @param time simulated time (tethers carry simulated timestamps)
   * @param worldPerPixel projection scale, so the width stays constant on screen
   */
  update(
    time: number,
    authors: readonly SimAuthor[],
    nodes: readonly SimNode[],
    worldPerPixel: number,
    camera?: THREE.Camera,
  ): void {
    if (!this.enabled) {
      this.lastSegments = 0
      this.geometry.setDrawRange(0, 0)
      return
    }

    const halfWidth = (this.widthPixels * worldPerPixel) / 2
    let segment = 0

    for (const author of authors) {
      if (!author.visible || author.tethers.length === 0) continue
      for (const tether of author.tethers) {
        if (segment >= this.capacity) break
        const node = nodes[tether.nodeId]
        if (!node || !node.visible) continue

        // Fade in quickly, hold, then fade out towards the end of the tether.
        const life = Math.max(0.001, tether.until - tether.start)
        const age = Math.max(0, time - tether.start)
        const remaining = 1 - age / life
        if (remaining <= 0) continue
        // Appear almost immediately: commits can arrive faster than a long
        // fade-in, which would keep beams permanently dim.
        const fadeIn = Math.min(1, age / 0.04)
        const alpha = Math.min(1, remaining * 1.5) * fadeIn * this.intensity
        if (alpha <= 0.02) continue

        const ax = author.position.x
        const ay = author.position.y + this.authorLift
        const az = author.position.z
        const bx = node.position.x
        const by = node.position.y
        const bz = node.position.z

        // Stronger changes get a wider, brighter beam.
        const scale = this.strengthScale(tether)
        const dx = bx - ax
        const dy = by - ay
        const dz = bz - az
        const length = Math.hypot(dx, dy, dz)
        if (length < 0.001) continue
        // The glow quad is always perpendicular to the view direction, so it
        // presents its width to the camera from any orbit angle. In the old
        // headless/2D call path there is no camera: use the XY perpendicular.
        let nx: number
        let ny: number
        let nz: number
        if (camera) {
          scratchDirection.set(dx, dy, dz).normalize()
          scratchToCamera.set(
            camera.position.x - ax,
            camera.position.y - ay,
            camera.position.z - az,
          )
          scratchSide.crossVectors(scratchDirection, scratchToCamera)
          if (scratchSide.lengthSq() < 1e-8) scratchSide.set(-dy, dx, 0)
          scratchSide.normalize().multiplyScalar(halfWidth * scale)
          nx = scratchSide.x
          ny = scratchSide.y
          nz = scratchSide.z
        } else {
          nx = (-dy / length) * halfWidth * scale
          ny = (dx / length) * halfWidth * scale
          nz = 0
        }
        // Slightly narrower at the file end.
        const taper = 0.62

        const offset = segment * 36
        const put = (index: number, x: number, y: number, z: number, brightness: number): void => {
          const base = offset + index * 3
          this.positions[base] = x
          this.positions[base + 1] = y
          this.positions[base + 2] = z
          const value = alpha * brightness
          this.colors[base] = this.scratch.r * value
          this.colors[base + 1] = this.scratch.g * value
          this.colors[base + 2] = this.scratch.b * value
        }

        this.scratch.copy(colorForChange(tether.kind))

        // Directional travel: the bright head starts at the avatar and reaches
        // the element after `travelSeconds`; the tail follows it, so once it
        // arrives the whole beam is lit. The solid style is a full-length ray
        // from the first frame, exactly as before.
        const travelling = this.style === 'travelling'
        const head = travelling ? Math.min(1, age / this.travelSeconds) : 1
        const coreStart = travelling ? (head >= 1 ? 0 : Math.max(0, head - this.cometLength)) : 0
        const startBrightness = travelling ? 0.7 : 2.1
        const headBrightness = travelling ? 2.4 : 0.95
        // The far end of the glow brightens as the head approaches it.
        const farGlow = travelling ? 0.22 * (0.35 + 0.65 * head) : 0.22

        const pointX = (t: number): number => ax + dx * t
        const pointY = (t: number): number => ay + dy * t
        const pointZ = (t: number): number => az + dz * t
        const sx = pointX(coreStart)
        const sy = pointY(coreStart)
        const sz = pointZ(coreStart)
        const hx = pointX(head)
        const hy = pointY(head)
        const hz = pointZ(head)

        // 1. Soft glow: a wider, dimmer quad that makes the beam read even on a
        //    busy background.
        const glowX = nx * 2.6
        const glowY = ny * 2.6
        const glowZ = nz * 2.6
        put(0, ax + glowX, ay + glowY, az + glowZ, 0.5 * scale)
        put(1, ax - glowX, ay - glowY, az - glowZ, 0.5 * scale)
        put(2, bx + glowX * taper, by + glowY * taper, bz + glowZ * taper, farGlow * scale)
        put(3, ax - glowX, ay - glowY, az - glowZ, 0.5 * scale)
        put(4, bx + glowX * taper, by + glowY * taper, bz + glowZ * taper, farGlow * scale)
        put(5, bx - glowX * taper, by - glowY * taper, bz - glowZ * taper, farGlow * scale)

        // 2. Core: the bright head travelling towards the element, with the tail
        //    trailing it (a full-length line once it has arrived).
        put(6, sx + nx, sy + ny, sz + nz, startBrightness * scale)
        put(7, sx - nx, sy - ny, sz - nz, startBrightness * scale)
        put(8, hx + nx * taper, hy + ny * taper, hz + nz * taper, headBrightness * scale)
        put(9, sx - nx, sy - ny, sz - nz, startBrightness * scale)
        put(10, hx + nx * taper, hy + ny * taper, hz + nz * taper, headBrightness * scale)
        put(11, hx - nx * taper, hy - ny * taper, hz - nz * taper, headBrightness * scale)
        segment += 1
      }
    }

    this.lastSegments = segment
    this.geometry.setDrawRange(0, segment * 12)
    ;(this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export type { ChangeKind }
