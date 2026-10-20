import * as THREE from 'three'
import type { ChangeKind } from '../timeline/types'
import type { AudioLevels } from '../engine/audio/analysis'
import type { SimNode } from '../sim/simulation'
import { colorForChange, colorForExtension, DIR_COLOR } from './palette'
import { extensionOf } from '../timeline/builder'

const scratch = new THREE.Color()

/**
 * Branch edges between directories and their children.
 *
 * Two things make the branches read like Gource's tree:
 *
 *  - they are **opaque and depth tested**, drawn in the opaque pass *before* the
 *    nodes, so a line that crosses a file circle or a directory ring disappears
 *    behind it instead of being painted over it (a transparent material would be
 *    rendered after the circles, which is what made lines look like they cut
 *    through them);
 *  - each segment is **trimmed by the radius of both endpoints**, so it starts at
 *    the edge of the parent and stops at the edge of the child rather than
 *    running into the middle of a circle or through the hollow of a ring.
 *
 * One `LineSegments` buffer holds every edge with two vertices per node, written
 * in place; dead nodes collapse to a zero-length segment.
 */
export class EdgeField {
  readonly lines: THREE.LineSegments
  private positions: Float32Array
  private colors: Float32Array
  private capacity: number
  private count = 0
  private opacity = 0.55
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
      // Opaque on purpose: keeps the lines in the opaque pass so the node
      // circles occlude them. The dimming is baked into the vertex colours.
      transparent: false,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
    })
    this.lines = new THREE.LineSegments(geometry, material)
    this.lines.frustumCulled = false
    // Behind the nodes in the opaque queue.
    this.lines.renderOrder = -1
  }

  /**
   * Dimming factor for the branch lines. Because the material is opaque, the
   * value is baked into the vertex colours, so changing it needs a full rewrite
   * (the renderer requests one).
   */
  setOpacity(opacity: number): void {
    this.opacity = Math.max(0.05, Math.min(1, opacity))
  }

  get currentOpacity(): number {
    return this.opacity
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
  /** Drop every segment (see `NodeField.reset`). */
  reset(): void {
    this.count = 0
    this.lines.geometry.setDrawRange(0, 0)
  }

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

  private collapse(index: number): void {
    for (let offset = 0; offset < 6; offset += 1) {
      this.positions[index + offset] = 0
      this.colors[index + offset] = 0
    }
  }

  private writeEdge(node: SimNode, nodes: readonly SimNode[]): void {
    const index = node.id * 6
    const parent = node.parent >= 0 ? nodes[node.parent] : undefined
    if (!node.visible || !parent || parent.kind === 'file' || !parent.visible) {
      this.collapse(index)
      return
    }

    let dx = node.position.x - parent.position.x
    let dy = node.position.y - parent.position.y
    const length = Math.hypot(dx, dy)
    if (length < 0.0001) {
      this.collapse(index)
      return
    }
    dx /= length
    dy /= length

    // Trim both ends by the radius of the node they belong to (plus a hair of
    // margin), so a branch starts at the parent's edge and stops at the child's
    // edge instead of running into a circle or through the hollow of a ring.
    const startOffset = Math.max(0, parent.radius) + 0.02
    const endOffset = Math.max(0, node.radius) + 0.02
    // If the two circles already cover the gap there is no visible branch to
    // draw: collapsing avoids a stub that would sit inside a circle.
    if (startOffset + endOffset > length * 0.92) {
      this.collapse(index)
      return
    }
    const ax = parent.position.x + dx * startOffset
    const ay = parent.position.y + dy * startOffset
    const bx = node.position.x - dx * endOffset
    const by = node.position.y - dy * endOffset

    const color = this.baseColor(node)
    this.positions[index] = ax
    this.positions[index + 1] = ay
    this.positions[index + 2] = 0
    this.positions[index + 3] = bx
    this.positions[index + 4] = by
    this.positions[index + 5] = 0

    // Dim at the parent end, brighter at the child end, all scaled by the
    // configured opacity.
    const near = this.opacity * 0.45
    const far = this.opacity
    this.colors[index] = color.r * near
    this.colors[index + 1] = color.g * near
    this.colors[index + 2] = color.b * near
    this.colors[index + 3] = color.r * far
    this.colors[index + 4] = color.g * far
    this.colors[index + 5] = color.b * far
  }

  private baseColor(node: SimNode): THREE.Color {
    if (node.kind === 'dir' || node.kind === 'root') return DIR_COLOR
    return colorForExtension(extensionOf(node.path), scratch)
  }

  /**
   * Brighten and cool the branches with the midrange. The tint multiplies the
   * baked vertex colours, so this is a single material update per frame rather
   * than a rewrite of every segment.
   */
  applyAudio(audio: AudioLevels | null): void {
    const material = this.lines.material as THREE.LineBasicMaterial
    if (!audio) {
      material.color.setRGB(1, 1, 1)
      return
    }
    const level = audio.mid
    material.color.setRGB(1 + level * 0.15, 1 + level * 0.25, 1 + level * 0.4)
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
          this.colors[index] = base.r * this.opacity * 0.45
          this.colors[index + 1] = base.g * this.opacity * 0.45
          this.colors[index + 2] = base.b * this.opacity * 0.45
          this.colors[index + 3] = base.r * this.opacity
          this.colors[index + 4] = base.g * this.opacity
          this.colors[index + 5] = base.b * this.opacity
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
