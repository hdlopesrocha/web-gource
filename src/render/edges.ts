import * as THREE from 'three'
import type { ChangeKind } from '../timeline/types'
import type { SimNode } from '../sim/simulation'
import { colorForChange, colorForExtension, DIR_COLOR } from './palette'
import { extensionOf } from '../timeline/builder'

const scratch = new THREE.Color()

/**
 * Branch edges between directories and their children.
 *
 * Implemented as a single `LineSegments` buffer with two vertices per node,
 * written in place. Dead nodes collapse to a zero-length segment, so the buffer
 * never has to be rebuilt while scrubbing through history.
 */
export class EdgeField {
  readonly lines: THREE.LineSegments
  private positions: Float32Array
  private colors: Float32Array
  private capacity: number
  private count = 0
  private recent = new Map<number, { kind: ChangeKind; until: number; start: number }>()

  constructor(capacity: number) {
    this.capacity = Math.max(1024, capacity)
    this.positions = new Float32Array(this.capacity * 6)
    this.colors = new Float32Array(this.capacity * 6)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3))
    geometry.setDrawRange(0, 0)
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      toneMapped: false,
    })
    this.lines = new THREE.LineSegments(geometry, material)
    this.lines.frustumCulled = false
  }

  setOpacity(opacity: number): void {
    ;(this.lines.material as THREE.LineBasicMaterial).opacity = opacity
  }

  private ensureCapacity(nodes: number): void {
    if (nodes <= this.capacity) return
    const next = Math.max(nodes, Math.floor(this.capacity * 1.75))
    const positions = new Float32Array(next * 6)
    const colors = new Float32Array(next * 6)
    positions.set(this.positions)
    colors.set(this.colors)
    this.positions = positions
    this.colors = colors
    const geometry = this.lines.geometry
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.capacity = next
  }

  /** Rewrite edges, either fully or only for the dirty node ids. */
  sync(nodes: readonly SimNode[], full: boolean, dirty?: readonly number[]): void {
    this.ensureCapacity(nodes.length)
    if (full) {
      this.count = nodes.length
      for (const node of nodes) this.writeEdge(node, nodes)
    } else if (dirty) {
      for (const id of dirty) {
        const node = nodes[id]
        if (node) this.writeEdge(node, nodes)
      }
      if (nodes.length > this.count) this.count = nodes.length
    }
    const geometry = this.lines.geometry
    ;(geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
    geometry.setDrawRange(0, this.count * 2)
  }

  private writeEdge(node: SimNode, nodes: readonly SimNode[]): void {
    const index = node.id * 6
    const parent = node.parent >= 0 ? nodes[node.parent] : undefined
    if (!node.visible || !parent || parent.kind === 'file') {
      for (let offset = 0; offset < 6; offset += 1) {
        this.positions[index + offset] = 0
        this.colors[index + offset] = 0
      }
      return
    }
    const color = this.baseColor(node)
    this.positions[index] = parent.position.x
    this.positions[index + 1] = parent.position.y
    this.positions[index + 2] = parent.position.z
    this.positions[index + 3] = node.position.x
    this.positions[index + 4] = node.position.y
    this.positions[index + 5] = node.position.z
    this.colors[index] = color.r * 0.3
    this.colors[index + 1] = color.g * 0.3
    this.colors[index + 2] = color.b * 0.3
    this.colors[index + 3] = color.r
    this.colors[index + 4] = color.g
    this.colors[index + 5] = color.b
  }

  private baseColor(node: SimNode): THREE.Color {
    if (node.kind === 'dir' || node.kind === 'root') return DIR_COLOR
    return colorForExtension(extensionOf(node.path), scratch)
  }

  touch(nodeId: number, kind: ChangeKind, now: number, duration = 1.2): void {
    this.recent.set(nodeId, { kind, until: now + duration, start: now })
  }

  /** Brighten recently touched edges, fading back to their base colour. */
  update(now: number, nodes: readonly SimNode[]): void {
    if (this.recent.size === 0) return
    let dirty = false
    for (const [nodeId, touch] of this.recent) {
      const node = nodes[nodeId]
      if (!node) {
        this.recent.delete(nodeId)
        continue
      }
      const total = Math.max(0.0001, touch.until - touch.start)
      const remaining = (touch.until - now) / total
      const index = node.id * 6
      if (remaining <= 0) {
        this.recent.delete(nodeId)
        if (node.visible && node.parent >= 0) {
          const base = this.baseColor(node)
          this.colors[index] = base.r * 0.3
          this.colors[index + 1] = base.g * 0.3
          this.colors[index + 2] = base.b * 0.3
          this.colors[index + 3] = base.r
          this.colors[index + 4] = base.g
          this.colors[index + 5] = base.b
          dirty = true
        }
        continue
      }
      if (!node.visible) continue
      const amount = Math.min(1, remaining) ** 0.6
      const change = colorForChange(touch.kind)
      this.colors[index + 3] = change.r * amount + this.colors[index + 3] * (1 - amount)
      this.colors[index + 4] = change.g * amount + this.colors[index + 4] * (1 - amount)
      this.colors[index + 5] = change.b * amount + this.colors[index + 5] * (1 - amount)
      dirty = true
    }
    if (dirty) (this.lines.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
  }

  dispose(): void {
    this.lines.geometry.dispose()
    ;(this.lines.material as THREE.Material).dispose()
    this.recent.clear()
  }
}
