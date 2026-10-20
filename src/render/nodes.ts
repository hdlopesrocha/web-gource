import * as THREE from 'three'
import type { ChangeKind } from '../timeline/types'
import type { AudioLevels } from '../engine/audio/analysis'
import type { SimNode } from '../sim/simulation'
import { extensionOf } from '../timeline/builder'
import { colorForChange, colorForExtension, DIR_COLOR, ROOT_COLOR } from './palette'
import { ballTexture } from './textures'

export type FileColorMode = 'extension' | 'activity' | 'flat'

export interface NodeFieldOptions {
  maxFiles: number
  maxDirs: number
  colorMode: FileColorMode
}

interface RecentTouch {
  kind: ChangeKind
  until: number
  start: number
}

const HIGHLIGHT_THRESHOLD = 0.92
const scratchColor = new THREE.Color()

/**
 * Depth offsets that keep the layers unambiguous with the orthographic camera
 * (which looks down the -Z axis): nodes sit in front of the branch lines, and
 * effects sit in front of the nodes.
 */
export const NODE_Z = 0.25
export const EFFECT_Z = 0.5

/** Flat sphere resolution: low enough for thousands of instances, still round. */
const SPHERE_SEGMENTS = 20
const SPHERE_RINGS = 14

/**
 * Instanced renderer for the tree.
 *
 * Files are discs and directories are rings drawn as camera-facing billboards.
 * Their world scale is compensated for perspective distance, so a file keeps
 * the same apparent size whether it sits near or far from the camera (the
 * radius still carries the file-size encoding). Node ids map to stable instance
 * slots, so incremental updates only touch the instances that changed and a
 * full sync is only needed after a seek. Hidden nodes are collapsed to a zero
 * scale.
 *
 * In sphere mode ({@link setSphereMode}) files become real instanced spheres
 * with a lit material: they keep their world radius instead of compensating for
 * perspective, so near files are genuinely bigger and the tree gains parallax.
 * That is what makes them read correctly in an immersive WebXR session, and it
 * is also available as a normal 3D view setting. Directories keep their rings.
 *
 * The flat top-down 2D view is left alone: every node sits at one view depth
 * there, so the compensated billboard radius and the true world radius coincide
 * and a sphere looks the same size as the ball sprite. The only visible
 * difference in 2D is the lighting, so the setting does not need a special case.
 */
export class NodeField {
  readonly group = new THREE.Group()
  private fileMesh: THREE.InstancedMesh
  private dirMesh: THREE.InstancedMesh
  private fileGeometry: THREE.BufferGeometry
  private dirGeometry: THREE.BufferGeometry
  private fileMaterial: THREE.Material
  private dirMaterial: THREE.MeshBasicMaterial
  private fileCapacity: number
  private dirCapacity: number
  private fileInstanceOf: number[] = []
  private dirInstanceOf: number[] = []
  private fileIds: number[] = []
  private dirIds: number[] = []
  private baseFileColors: Float32Array
  private baseDirColors: Float32Array
  private recent = new Map<number, RecentTouch>()
  private colorMode: FileColorMode
  private showDirs = true
  private radiusScale = 1
  /** Files drawn as lit spheres instead of camera-facing ball billboards. */
  private spheres = false
  /** Ambient + key light, added to the field's group only in sphere mode. */
  private lights: THREE.Light[] = []
  /** Last node list handed to {@link sync}, so a mode switch can rewrite it. */
  private lastNodes: readonly SimNode[] = []
  private matrix = new THREE.Matrix4()
  private position = new THREE.Vector3()
  private quaternion = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  /** Camera state used to billboard the glyphs and compensate perspective. */
  private cameraQuaternion = new THREE.Quaternion()
  private cameraPosition = new THREE.Vector3(0, 0, 10)
  private cameraDirection = new THREE.Vector3(0, 0, -1)
  private referenceDepth = 10
  private viewScratch = new THREE.Vector3()
  private cameraBound = false
  /** True while a music track is driving the colours (so one reset pass runs). */
  private audioActive = false

  constructor(options: NodeFieldOptions) {
    this.colorMode = options.colorMode
    this.fileCapacity = options.maxFiles
    this.dirCapacity = options.maxDirs
    this.baseFileColors = new Float32Array(options.maxFiles * 3)
    this.baseDirColors = new Float32Array(options.maxDirs * 3)

    // Flat shapes: Gource's lit ball sprites for files, rings for directories.
    this.fileGeometry = new THREE.PlaneGeometry(2, 2)
    this.dirGeometry = new THREE.RingGeometry(0.58, 1, 26)
    this.fileMaterial = this.createBillboardMaterial()
    this.dirMaterial = new THREE.MeshBasicMaterial({
      // The annulus is pure geometry, but it still goes through the alpha
      // pipeline: an opaque material ignores `opacity`, so a faded ring would
      // stay fully bright. Alpha-testing the almost-transparent fragments also
      // keeps them from writing depth, exactly like the ball's margin.
      transparent: true,
      alphaTest: 0.05,
      // Keep the depth write so branches stay hidden behind the rings.
      depthWrite: true,
      toneMapped: false,
      side: THREE.DoubleSide,
    })

    this.fileMesh = this.createMesh(this.fileGeometry, this.fileMaterial, this.fileCapacity)
    this.dirMesh = this.createMesh(this.dirGeometry, this.dirMaterial, this.dirCapacity)
    this.fileMesh.renderOrder = 2
    this.dirMesh.renderOrder = 3
  }

  /**
   * Gource's file.png: a ball lit from above-left, tinted per instance.
   *
   * The ball only covers a circle of the square quad. Discarding the
   * transparent margin keeps it out of the depth buffer, so later depth-tested
   * effects are not cut into a dark square around the ball.
   */
  private createBillboardMaterial(): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      map: ballTexture(),
      transparent: true,
      alphaTest: 0.05,
      depthWrite: true,
      toneMapped: false,
    })
  }

  /**
   * Lit sphere material.
   *
   * `MeshLambertMaterial` shades from the ambient + key light the field adds to
   * its own group, and multiplies the instance colour into the diffuse term, so
   * the palette (and the change highlight, and the audio modulation) still drive
   * the colour. The rest of the scene is unlit (basic/shader materials), so the
   * lights only affect these spheres.
   */
  private createSphereMaterial(): THREE.MeshLambertMaterial {
    return new THREE.MeshLambertMaterial({ toneMapped: false })
  }

  /** True while files are drawn as lit spheres rather than ball billboards. */
  get sphereMode(): boolean {
    return this.spheres
  }

  /**
   * Draw files as real 3D spheres (or go back to the ball billboards).
   *
   * The instanced mesh is rebuilt against the new geometry and material, then
   * every instance is rewritten: spheres use their true world radius and no
   * billboard rotation, so they gain real parallax. The caller may hand over the
   * node list; otherwise the one from the last {@link sync} is reused so the
   * transform swap is complete even mid-frame.
   */
  setSphereMode(enabled: boolean, nodes?: readonly SimNode[]): void {
    if (enabled === this.spheres) return
    this.spheres = enabled
    this.swapFileMesh()
    this.sync(nodes && nodes.length > 0 ? nodes : this.lastNodes, true)
  }

  /**
   * Replace the file mesh with one built for the current mode.
   *
   * `InstancedMesh` bakes its geometry and material at construction, so a mode
   * switch has to build a new mesh and carry the instance buffers over. Node ids
   * map to the same slots, so only the buffers move.
   */
  private swapFileMesh(): void {
    this.fileGeometry.dispose()
    this.fileMaterial.dispose()
    this.fileGeometry = this.spheres
      ? new THREE.SphereGeometry(1, SPHERE_SEGMENTS, SPHERE_RINGS)
      : new THREE.PlaneGeometry(2, 2)
    this.fileMaterial = this.spheres ? this.createSphereMaterial() : this.createBillboardMaterial()

    const previous = this.fileMesh
    const replacement = this.createMesh(this.fileGeometry, this.fileMaterial, this.fileCapacity)
    replacement.count = previous.count
    replacement.instanceMatrix.array.set(previous.instanceMatrix.array)
    replacement.instanceMatrix.needsUpdate = true
    if (previous.instanceColor) {
      replacement.setColorAt(0, scratchColor.setRGB(0, 0, 0))
      replacement.instanceColor?.array.set(previous.instanceColor.array)
      if (replacement.instanceColor) replacement.instanceColor.needsUpdate = true
    }
    replacement.renderOrder = 2
    this.group.remove(previous)
    previous.dispose()
    this.fileMesh = replacement

    this.setLights(this.spheres)
  }

  /**
   * Add or remove the sphere lighting.
   *
   * The lights live in the field's own group and are only present in sphere
   * mode; nothing else in the scene is lit, so toggling them cannot change any
   * other layer. The key light comes from above-left-front in the tree's own
   * frame, matching the highlight baked into the ball sprite.
   */
  private setLights(on: boolean): void {
    if (on && this.lights.length === 0) {
      const ambient = new THREE.AmbientLight(0xffffff, 0.6)
      const key = new THREE.DirectionalLight(0xffffff, 1.4)
      key.position.set(-0.6, 0.8, 1)
      this.group.add(ambient, key)
      this.lights = [ambient, key]
      return
    }
    if (!on && this.lights.length > 0) {
      for (const light of this.lights) {
        this.group.remove(light)
        light.dispose()
      }
      this.lights = []
    }
  }

  private createMesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity)
    mesh.frustumCulled = false
    mesh.count = 0
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.group.add(mesh)
    return mesh
  }

  /** Number of instances currently allocated in each mesh. */
  get stats(): { files: number; dirs: number } {
    return { files: this.fileIds.length, dirs: this.dirIds.length }
  }

  /** Instances actually drawn (non-zero scale). Must match the visible nodes. */
  get drawn(): { files: number; dirs: number } {
    return {
      files: this.countDrawn(this.fileMesh, this.fileIds.length),
      dirs: this.countDrawn(this.dirMesh, this.dirIds.length),
    }
  }

  private countDrawn(mesh: THREE.InstancedMesh, count: number): number {
    let drawn = 0
    for (let instance = 0; instance < count; instance += 1) {
      mesh.getMatrixAt(instance, this.matrix)
      if (this.matrix.elements[0] > 0) drawn += 1
    }
    return drawn
  }

  /**
   * Drop every instance.
   *
   * Node ids are per simulation, so a rebuilt history (filters, a new
   * repository) reuses ids for different nodes: without this the instances of
   * the previous simulation would stay on screen, still drawn, because nothing
   * ever writes them again.
   */
  reset(): void {
    this.fileIds = []
    this.dirIds = []
    this.fileInstanceOf = []
    this.dirInstanceOf = []
    this.recent.clear()
    this.fileMesh.count = 0
    this.dirMesh.count = 0
    this.fileMesh.instanceMatrix.needsUpdate = true
    this.dirMesh.instanceMatrix.needsUpdate = true
  }

  setColorMode(mode: FileColorMode, nodes: readonly SimNode[]): void {
    if (mode === this.colorMode) return
    this.colorMode = mode
    this.sync(nodes, true)
  }

  setRadiusScale(scale: number): void {
    this.radiusScale = scale
  }

  setDirsVisible(visible: boolean, nodes: readonly SimNode[]): void {
    if (visible === this.showDirs) return
    this.showDirs = visible
    this.dirMesh.visible = visible
    this.sync(nodes, true)
  }

  /**
   * Write instance transforms and colours.
   *
   * @param full rewrite every instance (after a seek or a settings change)
   * @param dirty node ids touched since the last sync (incremental playback)
   */
  sync(nodes: readonly SimNode[], full: boolean, dirty?: readonly number[]): void {
    this.lastNodes = nodes
    if (full) {
      for (const node of nodes) {
        if (node.kind === 'file') this.allocateFile(node)
        else this.allocateDir(node)
      }
      // Every allocated node is written, hidden ones included: `writeNode`
      // collapses an invisible node to a zero scale. Skipping them would leave
      // the previous frame's circles on screen after a seek or a restart.
      for (const node of nodes) this.writeNode(node, true)
    } else if (dirty) {
      for (const id of dirty) {
        const node = nodes[id]
        if (node) this.writeNode(node, true)
      }
    }
    this.fileMesh.count = this.fileIds.length
    this.dirMesh.count = this.dirIds.length
    this.fileMesh.instanceMatrix.needsUpdate = true
    this.dirMesh.instanceMatrix.needsUpdate = true
    if (this.fileMesh.instanceColor) this.fileMesh.instanceColor.needsUpdate = true
    if (this.dirMesh.instanceColor) this.dirMesh.instanceColor.needsUpdate = true
  }

  private allocateFile(node: SimNode): void {
    if (this.fileInstanceOf[node.id] !== undefined) return
    if (this.fileIds.length >= this.fileCapacity) this.grow('file', 1)
    if (this.fileIds.length >= this.fileCapacity) return
    const instance = this.fileIds.length
    this.fileInstanceOf[node.id] = instance
    this.fileIds.push(node.id)
    const color = this.baseColorFor(node)
    this.baseFileColors[instance * 3] = color.r
    this.baseFileColors[instance * 3 + 1] = color.g
    this.baseFileColors[instance * 3 + 2] = color.b
  }

  private allocateDir(node: SimNode): void {
    if (this.dirInstanceOf[node.id] !== undefined) return
    if (this.dirIds.length >= this.dirCapacity) this.grow('dir', 1)
    if (this.dirIds.length >= this.dirCapacity) return
    const instance = this.dirIds.length
    this.dirInstanceOf[node.id] = instance
    this.dirIds.push(node.id)
    const color = node.kind === 'root' ? ROOT_COLOR : DIR_COLOR
    this.baseDirColors[instance * 3] = color.r
    this.baseDirColors[instance * 3 + 1] = color.g
    this.baseDirColors[instance * 3 + 2] = color.b
  }

  /**
   * Reallocate an instanced mesh with a larger capacity.
   *
   * History is loaded incrementally, so the number of nodes is not known when
   * the engine starts. Growing (and copying the instance buffers) keeps the
   * scene complete without a full rebuild.
   */
  private grow(kind: 'file' | 'dir', needed: number): void {
    const mesh = kind === 'file' ? this.fileMesh : this.dirMesh
    const capacity = kind === 'file' ? this.fileCapacity : this.dirCapacity
    const used = kind === 'file' ? this.fileIds.length : this.dirIds.length
    const next = Math.max(capacity * 2, used + needed)
    const replacement = this.createMesh(
      kind === 'file' ? this.fileGeometry : this.dirGeometry,
      kind === 'file' ? this.fileMaterial : this.dirMaterial,
      next,
    )
    replacement.count = used
    replacement.instanceMatrix.array.set(mesh.instanceMatrix.array)
    replacement.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) {
      replacement.setColorAt(0, new THREE.Color(0, 0, 0))
      replacement.instanceColor?.array.set(mesh.instanceColor.array)
      if (replacement.instanceColor) replacement.instanceColor.needsUpdate = true
    }
    this.group.remove(mesh)
    if (kind === 'file') {
      this.fileMesh = replacement
      this.fileMesh.renderOrder = 2
      this.fileCapacity = next
      const colors = new Float32Array(next * 3)
      colors.set(this.baseFileColors)
      this.baseFileColors = colors
    } else {
      this.dirMesh = replacement
      this.dirMesh.renderOrder = 3
      this.dirCapacity = next
      const colors = new Float32Array(next * 3)
      colors.set(this.baseDirColors)
      this.baseDirColors = colors
    }
    mesh.dispose()
  }

  private baseColorFor(node: SimNode): THREE.Color {
    if (this.colorMode === 'flat') return scratchColor.setRGB(0.85, 0.9, 1)
    if (this.colorMode === 'activity') return colorForChange(node.lastKind ?? 'modify')
    return colorForExtension(extensionOf(node.path), scratchColor)
  }

  /**
   * Adopt the current camera pose.
   *
   * `target` is the orbit target. Perspective size attenuation depends on the
   * depth along the view axis, not the straight-line distance: scaling a
   * billboard by its own depth over the target's depth cancels it exactly, so
   * the simulation radius stays fixed on screen. On the flat top-down view the
   * whole scene sits at one depth, which makes the compensation a no-op and
   * re-creates the original 2D framing.
   */
  private useCamera(camera?: THREE.Camera, target?: THREE.Vector3): void {
    if (!camera) return
    this.cameraBound = true
    this.cameraQuaternion.copy(camera.quaternion)
    this.cameraPosition.copy(camera.position)
    camera.getWorldDirection(this.cameraDirection)
    this.referenceDepth = target
      ? Math.max(0.001, camera.position.distanceTo(target))
      : Math.max(0.001, camera.position.length())
  }

  /** Perspective compensation for the view depth of one node from the camera. */
  private distanceScale(): number {
    if (!this.cameraBound) return 1
    const nodeDepth = this.viewScratch.copy(this.position).sub(this.cameraPosition).dot(this.cameraDirection)
    const scale = nodeDepth / this.referenceDepth
    return Math.min(8, Math.max(0.25, scale))
  }

  /** Write one node's transform, colour and visibility. */
  private writeNode(node: SimNode, updateColor: boolean): void {
    const isFile = node.kind === 'file'
    if (isFile) this.allocateFile(node)
    else this.allocateDir(node)
    const instance = isFile ? this.fileInstanceOf[node.id] : this.dirInstanceOf[node.id]
    if (instance === undefined) return
    const mesh = isFile ? this.fileMesh : this.dirMesh
    this.writeTransform(node, instance, isFile, 1)

    if (updateColor) {
      const base = isFile ? this.baseFileColors : this.baseDirColors
      if (node.visible) {
        this.setInstanceColor(mesh, instance, base[instance * 3], base[instance * 3 + 1], base[instance * 3 + 2])
      } else {
        this.setInstanceColor(mesh, instance, base[instance * 3] * 0.16, base[instance * 3 + 1] * 0.16, base[instance * 3 + 2] * 0.16)
      }
    }
  }

  /**
   * Write the instance matrix for one node.
   *
   * Billboards: the glyph plane is rotated to the camera's orientation and its
   * world radius is scaled by its distance from the camera relative to the orbit
   * target, which cancels perspective size attenuation so the fixed radius set
   * by the simulation stays fixed on screen.
   *
   * Spheres (files only): no rotation and no perspective compensation. The
   * world radius is the node radius times the radius scale, so a file near the
   * head genuinely fills more of the view than one far away.
   */
  private writeTransform(node: SimNode, instance: number, isFile: boolean, pulse: number): void {
    const mesh = isFile ? this.fileMesh : this.dirMesh
    const spheres = this.spheres && isFile
    this.position.set(node.position.x, node.position.y, NODE_Z)
    if (!node.visible) {
      this.matrix.compose(
        this.position,
        this.cameraBound ? this.cameraQuaternion : this.quaternion,
        this.scale.set(0, 0, 0),
      )
      mesh.setMatrixAt(instance, this.matrix)
      return
    }
    // The radius comes from the simulation: it encodes the file-size scale.
    const radius = Math.max(0.02, node.radius * (isFile ? this.radiusScale : 1) * pulse)
    if (spheres) {
      this.matrix.compose(this.position, this.quaternion, this.scale.set(radius, radius, radius))
    } else {
      const scale = radius * this.distanceScale()
      this.matrix.compose(
        this.position,
        this.cameraBound ? this.cameraQuaternion : this.quaternion,
        this.scale.set(scale, scale, 1),
      )
    }
    mesh.setMatrixAt(instance, this.matrix)
  }

  private setInstanceColor(mesh: THREE.InstancedMesh, instance: number, r: number, g: number, b: number): void {
    scratchColor.setRGB(r, g, b)
    mesh.setColorAt(instance, scratchColor)
  }

  /** Mark a node as recently touched so it pulses with the change colour. */
  touch(nodeId: number, kind: ChangeKind, now: number, duration = 1.1): void {
    this.recent.set(nodeId, { kind, until: now + duration, start: now })
  }

  /**
   * Animate highlights for recently touched nodes and refresh billboards.
   *
   * A new camera pose changes the orientation of every glyph, so all instances
   * are rewritten when a camera is supplied (the normal render path). Without
   * one the field keeps the old cheap incremental behaviour, which is useful for
   * headless bookkeeping and tests.
   */
  update(
    now: number,
    nodes: readonly SimNode[],
    camera?: THREE.Camera,
    target?: THREE.Vector3,
    audio: AudioLevels | null = null,
  ): void {
    this.useCamera(camera, target)
    // When the track stops reacting, one more pass restores the base colours.
    const audioPass = audio !== null || this.audioActive
    if (this.recent.size === 0 && !this.cameraBound && !audioPass) return
    let colorDirtyFiles = false
    let colorDirtyDirs = false
    const pulses = new Map<number, number>()
    for (const [nodeId, touch] of this.recent) {
      const node = nodes[nodeId]
      if (!node) {
        this.recent.delete(nodeId)
        continue
      }
      const total = Math.max(0.0001, touch.until - touch.start)
      const remaining = (touch.until - now) / total
      const isFile = node.kind === 'file'
      const instance = isFile ? this.fileInstanceOf[node.id] : this.dirInstanceOf[node.id]
      if (instance === undefined) continue
      const mesh = isFile ? this.fileMesh : this.dirMesh
      if (remaining <= 0) {
        const base = isFile ? this.baseFileColors : this.baseDirColors
        this.setInstanceColor(mesh, instance, base[instance * 3], base[instance * 3 + 1], base[instance * 3 + 2])
        if (isFile) colorDirtyFiles = true
        else colorDirtyDirs = true
        this.recent.delete(nodeId)
        continue
      }
      const amount = Math.min(1, Math.max(0, remaining)) ** 0.7
      // Briefly grow the node so the changed file is unmistakable.
      pulses.set(nodeId, amount)
      const base = isFile ? this.baseFileColors : this.baseDirColors
      const change = colorForChange(touch.kind)
      const r = base[instance * 3] + (change.r - base[instance * 3]) * amount * HIGHLIGHT_THRESHOLD
      const g = base[instance * 3 + 1] + (change.g - base[instance * 3 + 1]) * amount * HIGHLIGHT_THRESHOLD
      const b = base[instance * 3 + 2] + (change.b - base[instance * 3 + 2]) * amount * HIGHLIGHT_THRESHOLD
      this.setInstanceColor(mesh, instance, r, g, b)
      if (isFile) colorDirtyFiles = true
      else colorDirtyDirs = true
    }

    if (this.cameraBound) {
      // Camera movement requires rewriting every billboard, including pulses.
      for (const node of nodes) {
        const isFile = node.kind === 'file'
        const instance = isFile ? this.fileInstanceOf[node.id] : this.dirInstanceOf[node.id]
        if (instance === undefined) continue
        const amount = pulses.get(node.id) ?? 0
        this.writeTransform(node, instance, isFile, 1 + 0.45 * amount)
      }
      this.fileMesh.instanceMatrix.needsUpdate = true
      this.dirMesh.instanceMatrix.needsUpdate = true
    } else {
      for (const [nodeId, amount] of pulses) {
        const node = nodes[nodeId]
        const isFile = node.kind === 'file'
        const instance = isFile ? this.fileInstanceOf[node.id] : this.dirInstanceOf[node.id]
        if (instance === undefined) continue
        this.writeTransform(node, instance, isFile, 1 + 0.45 * amount)
        if (isFile) this.fileMesh.instanceMatrix.needsUpdate = true
        else this.dirMesh.instanceMatrix.needsUpdate = true
      }
    }

    if (audioPass) {
      // Claps cycle the file palette (and flash it); low-mid energy tints the
      // folder rings. The modulation is applied on top of the change highlight,
      // so recent commits remain visible while the track plays.
      const clapHue = audio ? (audio.clapCount % 12) * 0.03 + audio.clap * 0.06 : 0
      const clapLight = audio ? audio.clap * 0.12 : 0
      const folder = audio ? audio.low : 0
      for (const node of nodes) {
        const isFile = node.kind === 'file'
        const instance = isFile ? this.fileInstanceOf[node.id] : this.dirInstanceOf[node.id]
        if (instance === undefined) continue
        const base = isFile ? this.baseFileColors : this.baseDirColors
        let red = base[instance * 3]
        let green = base[instance * 3 + 1]
        let blue = base[instance * 3 + 2]

        const amount = pulses.get(node.id) ?? 0
        const touch = amount > 0 ? this.recent.get(node.id) : undefined
        if (touch) {
          const change = colorForChange(touch.kind)
          const blend = amount * HIGHLIGHT_THRESHOLD
          red += (change.r - red) * blend
          green += (change.g - green) * blend
          blue += (change.b - blue) * blend
        }

        if (isFile) {
          if (clapHue !== 0 || clapLight !== 0) {
            scratchColor.setRGB(red, green, blue).offsetHSL(clapHue, 0, clapLight)
            red = scratchColor.r
            green = scratchColor.g
            blue = scratchColor.b
          }
        } else if (folder > 0) {
          scratchColor.setRGB(red, green, blue).offsetHSL(folder * 0.18, folder * 0.18, folder * 0.12)
          red = scratchColor.r
          green = scratchColor.g
          blue = scratchColor.b
        }

        if (!node.visible) {
          red *= 0.16
          green *= 0.16
          blue *= 0.16
        }

        const mesh = isFile ? this.fileMesh : this.dirMesh
        this.setInstanceColor(mesh, instance, red, green, blue)
        if (isFile) colorDirtyFiles = true
        else colorDirtyDirs = true
      }
      this.audioActive = audio !== null
    }

    if (colorDirtyFiles && this.fileMesh.instanceColor) this.fileMesh.instanceColor.needsUpdate = true
    if (colorDirtyDirs && this.dirMesh.instanceColor) this.dirMesh.instanceColor.needsUpdate = true
  }

  dispose(): void {
    this.setLights(false)
    this.fileGeometry.dispose()
    this.dirGeometry.dispose()
    this.fileMaterial.dispose()
    this.dirMaterial.dispose()
    this.group.clear()
    this.recent.clear()
  }
}
