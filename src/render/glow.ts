import * as THREE from 'three'
import type { SimNode } from '../sim/simulation'
import { DIR_COLOR, ROOT_COLOR } from './palette'
import { bloomTexture } from './textures'

/**
 * Gource's bloom layer.
 *
 * Gource draws one additive halo per directory, sized `dir_radius * 2.0 *
 * bloom_multiplier` and tinted `colour * bloom_intensity` (default 0.75), from a
 * soft radial texture: the "gourceian blur" around a folder's file cluster.
 * Files have no halo of their own — the folder's glow is what makes the whole
 * cluster read as luminous.
 *
 * Here the same halo is an instanced additive quad per directory: the quad's
 * half-extent is `clusterRadius * BLOOM_RADIUS_SCALE`, the texture fades to
 * nothing at 0.75 of that, and the instance colour carries the tint. It is drawn
 * in front of the circles (additively, so the dots stay crisp) and behind the
 * beams and avatars.
 */
export const GLOW_Z = 0.4

/** Gource: `bloom_radius = dir_radius * 2.0 * bloom_multiplier`. */
export const BLOOM_RADIUS_SCALE = 2

/** Gource's default `bloom_intensity` when it is not configured. */
export const DEFAULT_BLOOM_INTENSITY = 0.75

export class GlowField {
  readonly group = new THREE.Group()
  private mesh: THREE.InstancedMesh
  private geometry: THREE.PlaneGeometry
  private material: THREE.MeshBasicMaterial
  private capacity: number
  private instanceOf: number[] = []
  private ids: number[] = []
  private intensity = DEFAULT_BLOOM_INTENSITY
  private enabled = true
  private matrix = new THREE.Matrix4()
  private position = new THREE.Vector3()
  private quaternion = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  private color = new THREE.Color()

  constructor(capacity = 900) {
    this.capacity = Math.max(1, capacity)
    this.geometry = new THREE.PlaneGeometry(2, 2)
    this.material = new THREE.MeshBasicMaterial({
      map: bloomTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    })
    this.mesh = this.createMesh(this.capacity)
    this.group.add(this.mesh)
  }

  private createMesh(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity)
    mesh.frustumCulled = false
    mesh.count = 0
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // After the circles (2 files, 3 directories), before the beams (12), the
    // particles (10) and the avatars (20).
    mesh.renderOrder = 5
    return mesh
  }

  get stats(): number {
    return this.ids.length
  }

  /** Halos actually drawn (non-zero scale). */
  get drawn(): number {
    let drawn = 0
    for (let instance = 0; instance < this.ids.length; instance += 1) {
      this.mesh.getMatrixAt(instance, this.matrix)
      if (this.matrix.elements[0] > 0) drawn += 1
    }
    return drawn
  }

  /** Bloom intensity (Gource's `bloom_intensity`); 0 hides the layer entirely. */
  /** Drop every halo (see `NodeField.reset`). */
  reset(): void {
    this.ids = []
    this.instanceOf = []
    this.mesh.count = 0
    this.mesh.instanceMatrix.needsUpdate = true
  }

  setIntensity(intensity: number, nodes: readonly SimNode[] = []): void {
    const next = Math.max(0, intensity)
    if (next === this.intensity) return
    this.intensity = next
    this.mesh.visible = this.enabled && next > 0
    // The intensity is baked into the instance colours.
    if (nodes.length > 0) this.sync(nodes, true)
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.mesh.visible = enabled && this.intensity > 0
  }

  /**
   * Write halo transforms and colours.
   *
   * @param full rewrite every instance (after a seek or a settings change)
   * @param dirty node ids touched since the last sync (incremental playback)
   */
  sync(nodes: readonly SimNode[], full: boolean, dirty?: readonly number[]): void {
    if (full) {
      for (const node of nodes) {
        if (node.kind === 'file') continue
        this.allocate(node)
      }
      // Hidden directories are written too, so their halo collapses instead of
      // lingering from the previous frame.
      for (const node of nodes) {
        if (node.kind === 'file') continue
        this.writeNode(node)
      }
    } else if (dirty) {
      for (const id of dirty) {
        const node = nodes[id]
        if (node && node.kind !== 'file') this.writeNode(node)
      }
    }
    this.mesh.count = this.ids.length
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  private allocate(node: SimNode): void {
    if (this.instanceOf[node.id] !== undefined) return
    if (this.ids.length >= this.capacity) this.grow(this.ids.length + 1)
    if (this.ids.length >= this.capacity) return
    this.instanceOf[node.id] = this.ids.length
    this.ids.push(node.id)
  }

  /** Halos inherit the directory's position, cluster radius and colour. */
  private writeNode(node: SimNode): void {
    this.allocate(node)
    const instance = this.instanceOf[node.id]
    if (instance === undefined) return
    this.position.set(node.position.x, node.position.y, GLOW_Z)
    if (!node.visible) {
      this.matrix.compose(this.position, this.quaternion, this.scale.set(0, 0, 0))
      this.mesh.setMatrixAt(instance, this.matrix)
      return
    }
    const radius = Math.max(0.01, node.clusterRadius * BLOOM_RADIUS_SCALE)
    this.matrix.compose(this.position, this.quaternion, this.scale.set(radius, radius, 1))
    this.mesh.setMatrixAt(instance, this.matrix)
    const base = node.kind === 'root' ? ROOT_COLOR : DIR_COLOR
    this.color.setRGB(base.r * this.intensity, base.g * this.intensity, base.b * this.intensity)
    this.mesh.setColorAt(instance, this.color)
  }

  /** Reallocate the mesh with a larger capacity, copying the instance buffers. */
  private grow(needed: number): void {
    const next = Math.max(this.capacity * 2, needed)
    const replacement = this.createMesh(next)
    replacement.count = this.ids.length
    replacement.instanceMatrix.array.set(this.mesh.instanceMatrix.array)
    replacement.instanceMatrix.needsUpdate = true
    replacement.setColorAt(0, this.color.setRGB(0, 0, 0))
    if (this.mesh.instanceColor) replacement.instanceColor?.array.set(this.mesh.instanceColor.array)
    if (replacement.instanceColor) replacement.instanceColor.needsUpdate = true
    this.group.remove(this.mesh)
    this.group.add(replacement)
    this.mesh.dispose()
    this.mesh = replacement
    this.capacity = next
    this.mesh.visible = this.enabled && this.intensity > 0
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.mesh.dispose()
    this.group.clear()
    this.ids = []
    this.instanceOf = []
  }
}
