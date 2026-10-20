import * as THREE from 'three'
import type { AudioLevels } from '../engine/audio/analysis'
import type { SimNode } from '../sim/simulation'
import { activityTint } from './palette'
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
 * nothing at 0.75 of that, and the instance colour carries the tint. Every halo
 * — the root included — takes the {@link activityTint} the plasma uses, so the
 * two layers read as one light instead of two different blues. The halos are
 * background light: they are painted right after the backdrop and before every
 * element, so they neither depth-test against nor brighten the branch lines,
 * circles, beams or avatars drawn on top of them.
 */
export const GLOW_Z = 0.4

/**
 * Render order of the halo layer.
 *
 * The halos are the **first element layer**: they are drawn immediately after
 * the backdrop gradient (`-20`, which must come first or it would paint over
 * them) and before every other layer, with depth testing switched off, so
 * nothing can hide them and they can never hide anything. Everything above
 * them — branches, circles, plasma, particles, beams, avatars, labels — is
 * drawn on top with the depth test on.
 */
export const GLOW_RENDER_ORDER = -19.5

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
  private nodes: readonly SimNode[] = []
  private intensity = DEFAULT_BLOOM_INTENSITY
  private enabled = true
  private matrix = new THREE.Matrix4()
  private position = new THREE.Vector3()
  private quaternion = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  private color = new THREE.Color()
  private cameraQuaternion = new THREE.Quaternion()
  private cameraPosition = new THREE.Vector3(0, 0, 10)
  private cameraDirection = new THREE.Vector3(0, 0, -1)
  private referenceDepth = 10
  private viewScratch = new THREE.Vector3()
  private cameraBound = false
  /** True while the bass is shifting the halos (so one reset pass runs). */
  private audioActive = false

  constructor(capacity = 900) {
    this.capacity = Math.max(1, capacity)
    this.geometry = new THREE.PlaneGeometry(2, 2)
    this.material = new THREE.MeshBasicMaterial({
      map: bloomTexture(),
      // Opaque queue on purpose: the only way to paint underneath the opaque
      // branch lines and circles is to be drawn before them. Additive blending
      // still applies (the bloom's alpha carries the falloff).
      transparent: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // The halos are background light: never test them against the scene.
      depthTest: false,
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
    // First element layer: right after the gradient (opaque, -20) and before
    // every other layer (edges -1, circles 2/3, plasma 4, …).
    mesh.renderOrder = GLOW_RENDER_ORDER
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
    this.nodes = []
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
    this.nodes = nodes
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

  /**
   * Rewrite every halo as a camera-facing billboard.
   *
   * Called each frame with the current camera so the additive quads keep facing
   * it while it orbits. The world scale is compensated by the node's view
   * depth, keeping the halo's apparent size fixed; in the flat top-down view
   * every halo is at the same depth, so this leaves it untouched.
   */
  orient(camera: THREE.Camera, target: THREE.Vector3): void {
    this.cameraBound = true
    this.cameraQuaternion.copy(camera.quaternion)
    this.cameraPosition.copy(camera.position)
    camera.getWorldDirection(this.cameraDirection)
    this.referenceDepth = Math.max(0.001, camera.position.distanceTo(target))
    for (const id of this.ids) {
      const node = this.nodes[id]
      if (node) this.writeNodeMatrix(node)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  private distanceScale(): number {
    if (!this.cameraBound) return 1
    const nodeDepth = this.viewScratch.copy(this.position).sub(this.cameraPosition).dot(this.cameraDirection)
    return Math.min(8, Math.max(0.25, nodeDepth / this.referenceDepth))
  }

  /**
   * Tint the halos from the bass: the hue rotates and the bloom breathes with
   * the low end. Called every frame; when the levels stop the base colours are
   * restored once.
   */
  applyAudio(audio: AudioLevels | null): void {
    if (!audio && !this.audioActive) return
    this.audioActive = audio !== null
    for (const id of this.ids) {
      const node = this.nodes[id]
      if (!node) continue
      const instance = this.instanceOf[id]
      if (instance === undefined) continue
      activityTint(this.intensity, audio, this.color)
      this.mesh.setColorAt(instance, this.color)
    }
    if (this.ids.length > 0 && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  /** Halos inherit the directory's position, cluster radius and colour. */
  private writeNode(node: SimNode): void {
    this.allocate(node)
    this.writeNodeMatrix(node)
    const instance = this.instanceOf[node.id]
    if (instance === undefined) return
    activityTint(this.intensity, null, this.color)
    this.mesh.setColorAt(instance, this.color)
  }

  private writeNodeMatrix(node: SimNode): void {
    const instance = this.instanceOf[node.id]
    if (instance === undefined) return
    this.position.set(node.position.x, node.position.y, GLOW_Z)
    if (!node.visible) {
      this.matrix.compose(this.position, this.cameraBound ? this.cameraQuaternion : this.quaternion, this.scale.set(0, 0, 0))
      this.mesh.setMatrixAt(instance, this.matrix)
      return
    }
    const radius = Math.max(0.01, node.clusterRadius * BLOOM_RADIUS_SCALE) * this.distanceScale()
    this.matrix.compose(
      this.position,
      this.cameraBound ? this.cameraQuaternion : this.quaternion,
      this.scale.set(radius, radius, 1),
    )
    this.mesh.setMatrixAt(instance, this.matrix)
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
