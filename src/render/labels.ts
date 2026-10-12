import * as THREE from 'three'
import type { SimNode } from '../sim/simulation'
import { labelTextures, labelAspect } from './textures'
import { formatBytes } from '../util/format'

export interface LabelRenderOptions {
  enabled: boolean
  /** Show directory names. */
  directories: boolean
  /** Show file names for recently changed files. */
  files: boolean
  /** Append the file size to file labels when the host reported it. */
  fileSizes: boolean
  /** Maximum number of simultaneous labels. */
  maxLabels: number
  /** Pixel height of a label on screen; keeps text readable at any zoom. */
  pixelHeight: number
}

export interface LabelViewport {
  width: number
  height: number
  /** World units covered by one device pixel (orthographic projection). */
  worldPerPixel: number
}

interface LabelSlot {
  sprite: THREE.Sprite
  material: THREE.SpriteMaterial
  textureKey: string | null
  nodeId: number
}

/**
 * World-space text labels for directories and recently changed files.
 *
 * Labels are drawn on canvases (cached by text) and reused through a small
 * sprite pool. Selection is throttled and prioritises shallow directories plus
 * whatever was just modified, so the scene stays readable instead of turning
 * into a wall of text.
 */
export class LabelField {
  readonly group = new THREE.Group()
  private slots: LabelSlot[] = []
  private current: { nodeId: number; textureKey: string }[] = []
  private assignmentAge = 0
  private maxLabels: number

  constructor(maxLabels = 96) {
    this.maxLabels = maxLabels
  }

  private acquire(index: number): LabelSlot {
    const existing = this.slots[index]
    if (existing) return existing
    const material = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false, toneMapped: false })
    const sprite = new THREE.Sprite(material)
    sprite.renderOrder = 30
    const slot: LabelSlot = { sprite, material, textureKey: null, nodeId: -1 }
    this.group.add(sprite)
    this.slots[index] = slot
    return slot
  }

  /**
   * Refresh label assignment and placement.
   *
   * Labels are placed in priority order and rejected when they would overlap an
   * already placed label in screen space, which keeps dense repositories
   * readable. `dt` throttles the (relatively expensive) selection pass.
   */
  update(
    dt: number,
    camera: THREE.Camera,
    focus: THREE.Vector3,
    nodes: readonly SimNode[],
    currentIndex: number,
    options: LabelRenderOptions,
    viewport: LabelViewport,
  ): void {
    if (!options.enabled) {
      for (const slot of this.slots) {
        slot.sprite.visible = false
        slot.nodeId = -1
      }
      return
    }

    this.assignmentAge += dt
    if (this.assignmentAge > 0.3 || this.current.length === 0) {
      this.assignmentAge = 0
      this.current = this.select(nodes, currentIndex, focus, options)
    }

    const height = Math.max(1, viewport.height)
    const placed: ScreenRect[] = []
    let index = 0

    for (const entry of this.current) {
      if (index >= Math.min(options.maxLabels, this.maxLabels)) break
      const node = nodes[entry.nodeId]
      if (!node || !node.visible) continue
      const lift = node.kind === 'file' ? 1.1 : node.radius + 1.6
      const worldPosition = new THREE.Vector3(node.position.x, node.position.y + lift, node.position.z)
      const projected = worldPosition.clone().project(camera)
      // Behind the camera or far outside the viewport: not worth a slot.
      if (projected.z > 1 || Math.abs(projected.x) > 1.1 || Math.abs(projected.y) > 1.1) continue

      // Constant screen size: the world height of a label only depends on the
      // projection scale, not on any distance.
      const worldHeight = options.pixelHeight * viewport.worldPerPixel
      const texture = labelTextures.get(entry.textureKey, JSON.stringify(labelStyleFor(node)))
      const aspect = labelAspect(texture)
      const screenWidth = options.pixelHeight * aspect
      const screenX = (projected.x * 0.5 + 0.5) * viewport.width
      const screenY = (1 - (projected.y * 0.5 + 0.5)) * height
      const rect: ScreenRect = {
        left: screenX - screenWidth / 2,
        top: screenY - options.pixelHeight / 2,
        right: screenX + screenWidth / 2,
        bottom: screenY + options.pixelHeight / 2,
      }
      if (overlapsAny(rect, placed)) continue
      placed.push(rect)

      const slot = this.acquire(index)
      index += 1
      if (slot.textureKey !== entry.textureKey) {
        slot.textureKey = entry.textureKey
        slot.material.map = texture
        slot.material.needsUpdate = true
      }
      slot.sprite.scale.set(worldHeight * aspect, worldHeight, 1)
      slot.sprite.position.copy(worldPosition)
      slot.sprite.visible = true
      slot.nodeId = node.id
    }

    for (let slotIndex = index; slotIndex < this.slots.length; slotIndex += 1) {
      const slot = this.slots[slotIndex]
      if (!slot) continue
      slot.sprite.visible = false
      slot.nodeId = -1
    }
  }

  /** Pick which nodes deserve a label right now. */
  private select(
    nodes: readonly SimNode[],
    currentIndex: number,
    focus: THREE.Vector3,
    options: LabelRenderOptions,
  ): { nodeId: number; textureKey: string }[] {
    const budget = Math.min(options.maxLabels, this.maxLabels)
    const directoryBudget = options.directories ? Math.floor(budget * 0.7) : 0
    const fileBudget = options.files ? budget - directoryBudget : 0
    const result: { nodeId: number; textureKey: string }[] = []

    if (directoryBudget > 0) {
      const dirs: SimNode[] = []
      for (const node of nodes) {
        if (node.kind !== 'dir' || !node.visible) continue
        dirs.push(node)
      }
      dirs.sort((a, b) => {
        const depthA = depth(a.path)
        const depthB = depth(b.path)
        if (depthA !== depthB) return depthA - depthB
        const distanceA = (a.position.x - focus.x) ** 2 + (a.position.y - focus.y) ** 2 + (a.position.z - focus.z) ** 2
        const distanceB = (b.position.x - focus.x) ** 2 + (b.position.y - focus.y) ** 2 + (b.position.z - focus.z) ** 2
        return distanceA - distanceB
      })
      for (const node of dirs.slice(0, directoryBudget)) {
        result.push({ nodeId: node.id, textureKey: `${node.name}/` })
      }
    }

    if (fileBudget > 0) {
      const files: SimNode[] = []
      for (const node of nodes) {
        if (node.kind !== 'file' || !node.visible) continue
        if (currentIndex - node.lastChangeIndex > 4) continue
        files.push(node)
      }
      files.sort((a, b) => b.lastChangeIndex - a.lastChangeIndex)
      for (const node of files.slice(0, fileBudget)) {
        result.push({ nodeId: node.id, textureKey: labelTextFor(node, options.fileSizes) })
      }
    }
    return result
  }

  dispose(): void {
    for (const slot of this.slots) slot.material.dispose()
    this.slots = []
    this.group.clear()
  }
}

function depth(path: string): number {
  let count = 0
  for (let index = 0; index < path.length; index += 1) if (path.charCodeAt(index) === 47) count += 1
  return count
}

interface ScreenRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** True when `rect` intersects any placed label (with a small breathing gap). */
export function overlapsAny(rect: ScreenRect, placed: readonly ScreenRect[], gap = 6): boolean {
  for (const other of placed) {
    if (
      rect.left - gap < other.right &&
      rect.right + gap > other.left &&
      rect.top - gap < other.bottom &&
      rect.bottom + gap > other.top
    ) {
      return true
    }
  }
  return false
}

/** File label text, optionally with the host-reported size. */
function labelTextFor(node: SimNode, showSize: boolean): string {
  if (!showSize || !node.sizeKnown || node.sizeBytes <= 0) return node.name
  return `${node.name} · ${formatBytes(node.sizeBytes)}`
}

function labelStyleFor(node: SimNode): {
  color: string
  background: string
  font: string
  padding: number
  radius: number
} {
  if (node.kind === 'file') {
    return {
      color: 'rgba(255,255,255,0.92)',
      background: 'rgba(10,14,24,0.55)',
      font: '500 26px "Inter", "Segoe UI", system-ui, sans-serif',
      padding: 8,
      radius: 6,
    }
  }
  return {
    color: 'rgba(190,220,255,0.95)',
    background: 'rgba(8,12,22,0.62)',
    font: '600 28px "Inter", "Segoe UI", system-ui, sans-serif',
    padding: 9,
    radius: 8,
  }
}
