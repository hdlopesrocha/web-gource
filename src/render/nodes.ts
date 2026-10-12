import * as THREE from 'three'
import type { ChangeKind } from '../timeline/types'
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

/**
 * Instanced renderer for the 2D tree.
 *
 * Files are flat discs and directories are rings, both on the XY plane facing
 * the orthographic camera. Node ids map to stable instance slots, so
 * incremental updates only touch the instances that changed and a full sync is
 * only needed after a seek. Hidden nodes are collapsed to a zero scale.
 */
export class NodeField {
  readonly group = new THREE.Group()
  private fileMesh: THREE.InstancedMesh
  private dirMesh: THREE.InstancedMesh
  private fileGeometry: THREE.BufferGeometry
  private dirGeometry: THREE.BufferGeometry
  private fileMaterial: THREE.MeshBasicMaterial
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
  private matrix = new THREE.Matrix4()
  private position = new THREE.Vector3()
  private quaternion = new THREE.Quaternion()
  private scale = new THREE.Vector3()

  constructor(options: NodeFieldOptions) {
    this.colorMode = options.colorMode
    this.fileCapacity = options.maxFiles
    this.dirCapacity = options.maxDirs
    this.baseFileColors = new Float32Array(options.maxFiles * 3)
    this.baseDirColors = new Float32Array(options.maxDirs * 3)

    // Flat shapes: Gource's lit ball sprites for files, rings for directories.
    this.fileGeometry = new THREE.PlaneGeometry(2, 2)
    this.dirGeometry = new THREE.RingGeometry(0.58, 1, 26)
    this.fileMaterial = new THREE.MeshBasicMaterial({
      // Gource's file.png: a ball lit from above-left, tinted per instance.
      map: ballTexture(),
      transparent: true,
      depthWrite: true,
      toneMapped: false,
    })
    this.dirMaterial = new THREE.MeshBasicMaterial({ toneMapped: false, side: THREE.DoubleSide })

    this.fileMesh = this.createMesh(this.fileGeometry, this.fileMaterial, this.fileCapacity)
    this.dirMesh = this.createMesh(this.dirGeometry, this.dirMaterial, this.dirCapacity)
    this.fileMesh.renderOrder = 2
    this.dirMesh.renderOrder = 3
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
    if (full) {
      for (const node of nodes) {
        if (node.kind === 'file') this.allocateFile(node)
        else this.allocateDir(node)
      }
      for (const node of nodes) {
        if (!node.visible) continue
        this.writeNode(node, true)
      }
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

  /** Write one node's transform, colour and visibility. */
  private writeNode(node: SimNode, updateColor: boolean): void {
    const isFile = node.kind === 'file'
    if (isFile) this.allocateFile(node)
    else this.allocateDir(node)
    const instance = isFile ? this.fileInstanceOf[node.id] : this.dirInstanceOf[node.id]
    if (instance === undefined) return
    const mesh = isFile ? this.fileMesh : this.dirMesh

    this.position.set(node.position.x, node.position.y, NODE_Z)
    if (!node.visible) {
      this.matrix.compose(this.position, this.quaternion, this.scale.set(0, 0, 0))
      mesh.setMatrixAt(instance, this.matrix)
      if (updateColor) {
        const base = isFile ? this.baseFileColors : this.baseDirColors
        this.setInstanceColor(mesh, instance, base[instance * 3] * 0.16, base[instance * 3 + 1] * 0.16, base[instance * 3 + 2] * 0.16)
      }
      return
    }

    // The radius comes from the simulation: it encodes the file-size scale.
    const radius = Math.max(0.02, node.radius * (isFile ? this.radiusScale : 1))
    this.matrix.compose(this.position, this.quaternion, this.scale.set(radius, radius, 1))
    mesh.setMatrixAt(instance, this.matrix)

    if (updateColor) {
      const base = isFile ? this.baseFileColors : this.baseDirColors
      this.setInstanceColor(mesh, instance, base[instance * 3], base[instance * 3 + 1], base[instance * 3 + 2])
    }
  }

  private setInstanceColor(mesh: THREE.InstancedMesh, instance: number, r: number, g: number, b: number): void {
    scratchColor.setRGB(r, g, b)
    mesh.setColorAt(instance, scratchColor)
  }

  /** Scale a recently touched node up while its highlight lasts. */
  private applyPulse(node: SimNode, instance: number, isFile: boolean, amount: number): void {
    if (!node.visible) return
    const mesh = isFile ? this.fileMesh : this.dirMesh
    const pulse = 1 + 0.45 * amount
    const radius = Math.max(0.02, node.radius * (isFile ? this.radiusScale : 1) * pulse)
    this.position.set(node.position.x, node.position.y, NODE_Z)
    this.matrix.compose(this.position, this.quaternion, this.scale.set(radius, radius, 1))
    mesh.setMatrixAt(instance, this.matrix)
    mesh.instanceMatrix.needsUpdate = true
  }

  /** Mark a node as recently touched so it pulses with the change colour. */
  touch(nodeId: number, kind: ChangeKind, now: number, duration = 1.1): void {
    this.recent.set(nodeId, { kind, until: now + duration, start: now })
  }

  /** Animate highlights for recently touched nodes (called once per frame). */
  update(now: number, nodes: readonly SimNode[]): void {
    if (this.recent.size === 0) return
    let colorDirtyFiles = false
    let colorDirtyDirs = false
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
      this.applyPulse(node, instance, isFile, amount)
      const base = isFile ? this.baseFileColors : this.baseDirColors
      const change = colorForChange(touch.kind)
      const r = base[instance * 3] + (change.r - base[instance * 3]) * amount * HIGHLIGHT_THRESHOLD
      const g = base[instance * 3 + 1] + (change.g - base[instance * 3 + 1]) * amount * HIGHLIGHT_THRESHOLD
      const b = base[instance * 3 + 2] + (change.b - base[instance * 3 + 2]) * amount * HIGHLIGHT_THRESHOLD
      this.setInstanceColor(mesh, instance, r, g, b)
      if (isFile) colorDirtyFiles = true
      else colorDirtyDirs = true
    }
    if (colorDirtyFiles && this.fileMesh.instanceColor) this.fileMesh.instanceColor.needsUpdate = true
    if (colorDirtyDirs && this.dirMesh.instanceColor) this.dirMesh.instanceColor.needsUpdate = true
  }

  dispose(): void {
    this.fileGeometry.dispose()
    this.dirGeometry.dispose()
    this.fileMaterial.dispose()
    this.dirMaterial.dispose()
    this.group.clear()
    this.recent.clear()
  }
}
