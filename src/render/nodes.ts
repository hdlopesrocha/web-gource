import * as THREE from 'three'
import type { ChangeKind } from '../timeline/types'
import type { SimNode } from '../sim/simulation'
import { extensionOf } from '../timeline/builder'
import { colorForChange, colorForExtension, DIR_COLOR, ROOT_COLOR } from './palette'

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
 * Instanced renderer for tree nodes.
 *
 * One InstancedMesh holds every file (icosahedra) and one holds every directory
 * (octahedra). Node ids map to stable instance slots, so incremental updates
 * only touch the instances that changed and a full sync is only needed after a
 * seek. Dead nodes are hidden by scaling their matrix to zero.
 */
export class NodeField {
  readonly group = new THREE.Group()
  private fileMesh: THREE.InstancedMesh
  private dirMesh: THREE.InstancedMesh
  private fileGeometry: THREE.IcosahedronGeometry
  private dirGeometry: THREE.OctahedronGeometry
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
  private fileSizeScale = 1
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

    this.fileGeometry = new THREE.IcosahedronGeometry(1, 0)
    this.dirGeometry = new THREE.OctahedronGeometry(1, 0)
    this.fileMaterial = new THREE.MeshBasicMaterial({ toneMapped: false })
    this.dirMaterial = new THREE.MeshBasicMaterial({ toneMapped: false })

    this.fileMesh = this.createMesh(this.fileGeometry, this.fileMaterial, this.fileCapacity)
    this.dirMesh = this.createMesh(this.dirGeometry, this.dirMaterial, this.dirCapacity)
    this.dirMesh.renderOrder = 1
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

  setFileSizeScale(scale: number): void {
    this.fileSizeScale = scale
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
      // `instanceColor` is allocated lazily on the first setColorAt call.
      replacement.setColorAt(0, new THREE.Color(0, 0, 0))
      replacement.instanceColor?.array.set(mesh.instanceColor.array)
      if (replacement.instanceColor) replacement.instanceColor.needsUpdate = true
    }
    this.group.remove(mesh)
    if (kind === 'file') {
      this.fileMesh = replacement
      this.fileCapacity = next
      const colors = new Float32Array(next * 3)
      colors.set(this.baseFileColors)
      this.baseFileColors = colors
    } else {
      this.dirMesh = replacement
      this.dirMesh.renderOrder = 1
      this.dirCapacity = next
      const colors = new Float32Array(next * 3)
      colors.set(this.baseDirColors)
      this.baseDirColors = colors
    }
    // The old InstancedMesh only owns its instance buffers; geometry and
    // material are shared with the replacement, so nothing else is disposed.
    mesh.dispose()
  }

  private baseColorFor(node: SimNode): THREE.Color {
    if (this.colorMode === 'flat') return scratchColor.setRGB(0.85, 0.9, 1)
    if (this.colorMode === 'activity') {
      const kind = node.lastKind ?? 'modify'
      return colorForChange(kind)
    }
    return colorForExtension(extensionOf(node.path), scratchColor)
  }

  /** Write one node's transform, colour and visibility. */
  private writeNode(node: SimNode, updateColor: boolean): void {
    const isFile = node.kind === 'file'
    // Incremental updates can introduce nodes that were never synced before.
    if (isFile) this.allocateFile(node)
    else this.allocateDir(node)
    const instance = isFile ? this.fileInstanceOf[node.id] : this.dirInstanceOf[node.id]
    if (instance === undefined) return
    const mesh = isFile ? this.fileMesh : this.dirMesh

    this.position.set(node.position.x, node.position.y, node.position.z)
    this.matrix.compose(this.position, this.quaternion, this.scale.set(0, 0, 0))
    mesh.setMatrixAt(instance, this.matrix)

    if (!node.visible) {
      if (updateColor) {
        const base = isFile ? this.baseFileColors : this.baseDirColors
        const r = base[instance * 3] * 0.16
        const g = base[instance * 3 + 1] * 0.16
        const b = base[instance * 3 + 2] * 0.16
        this.setInstanceColor(mesh, instance, r, g, b)
      }
      return
    }

    const growth = isFile ? 1 + Math.min(0.65, Math.log1p(node.changes) * 0.16) : 1
    const radius = node.radius * growth * (isFile ? this.fileSizeScale : 1) * (this.showDirs || isFile ? 1 : 0)
    this.matrix.compose(this.position, this.quaternion, this.scale.set(radius, radius, radius))
    mesh.setMatrixAt(instance, this.matrix)

    if (updateColor) {
      if (isFile) {
        const base = this.baseFileColors
        this.setInstanceColor(mesh, instance, base[instance * 3], base[instance * 3 + 1], base[instance * 3 + 2])
      } else {
        const base = this.baseDirColors
        this.setInstanceColor(mesh, instance, base[instance * 3], base[instance * 3 + 1], base[instance * 3 + 2])
      }
    }
  }

  private setInstanceColor(mesh: THREE.InstancedMesh, instance: number, r: number, g: number, b: number): void {
    scratchColor.setRGB(r, g, b)
    mesh.setColorAt(instance, scratchColor)
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
      if (remaining <= 0) {
        // Restore the base colour once the highlight has faded out.
        const isFile = node.kind === 'file'
        const instance = isFile ? this.fileInstanceOf[node.id] : this.dirInstanceOf[node.id]
        if (instance !== undefined) {
          const base = isFile ? this.baseFileColors : this.baseDirColors
          this.setInstanceColor(isFile ? this.fileMesh : this.dirMesh, instance, base[instance * 3], base[instance * 3 + 1], base[instance * 3 + 2])
          if (isFile) colorDirtyFiles = true
          else colorDirtyDirs = true
        }
        this.recent.delete(nodeId)
        continue
      }
      const amount = Math.min(1, Math.max(0, remaining)) ** 0.7
      const isFile = node.kind === 'file'
      const instance = isFile ? this.fileInstanceOf[node.id] : this.dirInstanceOf[node.id]
      if (instance === undefined) continue
      const base = isFile ? this.baseFileColors : this.baseDirColors
      const change = colorForChange(touch.kind)
      const r = base[instance * 3] + (change.r - base[instance * 3]) * amount * HIGHLIGHT_THRESHOLD
      const g = base[instance * 3 + 1] + (change.g - base[instance * 3 + 1]) * amount * HIGHLIGHT_THRESHOLD
      const b = base[instance * 3 + 2] + (change.b - base[instance * 3 + 2]) * amount * HIGHLIGHT_THRESHOLD
      this.setInstanceColor(isFile ? this.fileMesh : this.dirMesh, instance, r, g, b)
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
