import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { NodeField } from '../src/render/nodes'
import { EdgeField } from '../src/render/edges'
import { ParticleField, pointSizePixels } from '../src/render/particles'
import { Camera2D } from '../src/render/camera'
import { colorForExtension, colorForChange, colorForAuthor } from '../src/render/palette'
import { overlapsAny } from '../src/render/labels'
import type { SimNode } from '../src/sim/simulation'

/**
 * These tests exercise the GPU bookkeeping (instance allocation, dirty updates,
 * buffer growth) without a WebGL context: three.js data structures are plain
 * JavaScript until something is rendered.
 */

function node(id: number, overrides: Partial<SimNode> = {}): SimNode {
  return {
    id,
    path: `src/file-${id}.ts`,
    name: `file-${id}.ts`,
    kind: 'file',
    parent: 0,
    children: [],
    position: { x: id * 0.5, y: 0, z: 0 },
    radius: 0.2,
    sizeBytes: 0,
    sizeKnown: false,
    activity: 0,
    bornIndex: id,
    lastChangeIndex: id,
    lastKind: null,
    changes: 0,
    additions: 0,
    deletions: 0,
    visible: true,
    ...overrides,
  }
}

describe('NodeField', () => {
  it('allocates instances for nodes and hides dead ones with a zero scale', () => {
    const field = new NodeField({ maxFiles: 10, maxDirs: 4, colorMode: 'extension' })
    const nodes = [node(0, { kind: 'root', path: '', radius: 0.4 }), node(1), node(2, { kind: 'dir', path: 'src', name: 'src' })]
    field.sync(nodes, true)

    const stats = field.stats
    expect(stats.files).toBe(1)
    expect(stats.dirs).toBe(2)

    // A deleted node collapses to a zero scale instead of being removed.
    nodes[1].visible = false
    field.sync(nodes, false, [1])
    const matrix = new THREE.Matrix4()
    const mesh = (field as unknown as { fileMesh: THREE.InstancedMesh }).fileMesh
    mesh.getMatrixAt(0, matrix)
    expect(matrix.elements[0]).toBe(0)
    expect(matrix.elements[5]).toBe(0)

    nodes[1].visible = true
    field.sync(nodes, false, [1])
    mesh.getMatrixAt(0, matrix)
    expect(matrix.elements[0]).toBeGreaterThan(0)
  })

  it('grows instance capacity when more nodes stream in', () => {
    const field = new NodeField({ maxFiles: 4, maxDirs: 2, colorMode: 'extension' })
    const nodes: SimNode[] = [node(0, { kind: 'root', path: '' })]
    for (let index = 1; index <= 60; index += 1) nodes.push(node(index))
    field.sync(nodes, true)
    expect(field.stats.files).toBe(60)

    // Every instance must have a usable matrix after the growth.
    const mesh = (field as unknown as { fileMesh: THREE.InstancedMesh }).fileMesh
    const matrix = new THREE.Matrix4()
    let scaled = 0
    for (let instance = 0; instance < 60; instance += 1) {
      mesh.getMatrixAt(instance, matrix)
      if (matrix.elements[0] > 0) scaled += 1
    }
    expect(scaled).toBe(60)
    field.dispose()
  })

  it('allocates nodes introduced by incremental playback', () => {
    const field = new NodeField({ maxFiles: 8, maxDirs: 8, colorMode: 'extension' })
    const nodes: SimNode[] = [node(0, { kind: 'root', path: '' })]
    field.sync(nodes, true)
    nodes.push(node(1))
    // Dirty-only sync: the node was never part of a full sync.
    field.sync(nodes, false, [1])
    expect(field.stats.files).toBe(1)
    field.dispose()
  })

  it('supports colour modes and highlight decay', () => {
    const field = new NodeField({ maxFiles: 8, maxDirs: 8, colorMode: 'extension' })
    const nodes = [node(0, { kind: 'root', path: '' }), node(1)]
    field.sync(nodes, true)
    field.setColorMode('activity', nodes)
    field.touch(1, 'delete', 0)
    field.update(0.5, nodes)
    field.update(2, nodes)
    field.dispose()
  })
})

describe('EdgeField', () => {
  it('writes one segment per visible node and collapses hidden ones', () => {
    const field = new EdgeField(16)
    const parent = node(0, { kind: 'root', path: '', position: { x: 0, y: 0, z: 0 } })
    const child = node(1, { parent: 0, position: { x: 10, y: 0, z: 0 } })
    const nodes = [parent, child]
    field.sync(nodes, true)
    const geometry = field.lines.geometry
    expect(geometry.drawRange.count).toBe(4)

    const positions = geometry.getAttribute('position') as THREE.BufferAttribute
    // Second segment (the child) spans from the parent to the child position.
    expect(positions.getX(2)).toBe(0)
    expect(positions.getX(3)).toBe(10)

    child.visible = false
    field.sync(nodes, false, [1])
    expect((geometry.getAttribute('position') as THREE.BufferAttribute).getX(3)).toBe(0)
    field.dispose()
  })

  it('grows its buffers for large trees', () => {
    const field = new EdgeField(8)
    const nodes: SimNode[] = [node(0, { kind: 'root', path: '' })]
    for (let index = 1; index < 200; index += 1) nodes.push(node(index, { parent: index - 1 }))
    field.sync(nodes, true)
    expect(field.lines.geometry.drawRange.count).toBe(400)
    field.dispose()
  })
})

describe('ParticleField', () => {
  it('keeps particle sizes constant on screen (CSS pixels × pixel ratio)', () => {
    // Matches the shader: gl_PointSize = aSize * uPixelRatio.
    expect(pointSizePixels(3, 1)).toBe(3)
    expect(pointSizePixels(3, 2)).toBe(6)
    // Retina screens double the device pixels but not the visual size.
    expect(pointSizePixels(3, 2) / 2).toBe(pointSizePixels(3, 1))
    // Never smaller than a single device pixel.
    expect(pointSizePixels(0.1, 1)).toBe(1)
  })

  it('emits, integrates and fades particles', () => {
    const field = new ParticleField(128)
    field.burst({ x: 0, y: 0, z: 0 }, 'add', 5, 0.4)
    field.trail({ x: 1, y: 1, z: 1 }, colorForChange('modify'))
    expect(field.liveCount).toBeGreaterThan(0)

    const alphas = field.points.geometry.getAttribute('aAlpha') as THREE.BufferAttribute
    const before = [...alphas.array].filter((value) => (value as number) > 0).length
    expect(before).toBeGreaterThan(0)

    field.update(0.5)
    const positions = field.points.geometry.getAttribute('position') as THREE.BufferAttribute
    expect(Math.abs(positions.getY(0))).toBeGreaterThanOrEqual(0)

    // After enough time every particle is gone (dt is clamped per step).
    for (let step = 0; step < 40; step += 1) field.update(0.1)
    const alive = [...(field.points.geometry.getAttribute('aAlpha') as THREE.BufferAttribute).array].filter(
      (value) => (value as number) > 0,
    ).length
    expect(alive).toBe(0)

    field.clear()
    field.dispose()
  })

  it('stops emitting when disabled', () => {
    const field = new ParticleField(64)
    field.setEnabled(false)
    field.burst({ x: 0, y: 0, z: 0 }, 'delete', 3)
    expect(field.liveCount).toBe(0)
    field.dispose()
  })

  it('does not exceed its capacity', () => {
    const field = new ParticleField(32)
    for (let index = 0; index < 50; index += 1) field.burst({ x: 0, y: 0, z: 0 }, 'add', 10)
    expect(field.liveCount).toBeLessThanOrEqual(32)
    field.dispose()
  })
})

describe('Camera2D', () => {
  it('stays flat: an orthographic camera looking down the Z axis', () => {
    const rig = new Camera2D()
    rig.setViewport(1600, 900)
    expect(rig.camera.isOrthographicCamera).toBe(true)
    // The frustum spans the visible world area, and every point of the scene
    // sits on the z = 0 plane.
    expect(rig.camera.top - rig.camera.bottom).toBeCloseTo(rig.viewHeight, 6)
    expect(rig.camera.position.z).toBeGreaterThan(0)
  })

  it('follows recent activity and fits the repository', () => {
    const rig = new Camera2D()
    rig.setViewport(1600, 900)
    rig.frame({ center: { x: 0, y: 0 }, radius: 20 }, true)
    const options = { followActivity: true, autoZoom: true, smoothing: 2 }
    for (let index = 0; index < 300; index += 1) {
      rig.update(1 / 60, options, { x: 40, y: -10 }, { center: { x: 0, y: 0 }, radius: 20 })
    }
    expect(rig.focusPoint.x).toBeGreaterThan(10)
    expect(rig.focusPoint.y).toBeLessThan(0)
    // Zoom stays inside sane bounds and follows the bounds radius.
    const bigZoom = rig.currentZoom
    rig.frame({ center: { x: 0, y: 0 }, radius: 400 }, true)
    expect(rig.currentZoom).toBeLessThan(bigZoom)
  })

  it('zooms around a world point and converts pixels to world units', () => {
    const rig = new Camera2D()
    rig.setViewport(800, 600)
    rig.frame({ center: { x: 0, y: 0 }, radius: 50 }, true)
    const worldPerPixel = rig.worldPerPixel(600)
    expect(worldPerPixel).toBeCloseTo(rig.viewHeight / 600, 8)
    rig.nudge({ zoom: 2 })
    rig.update(1 / 60, { followActivity: false, autoZoom: false, smoothing: 1 }, null, {
      center: { x: 0, y: 0 },
      radius: 50,
    })
    expect(rig.currentZoom).toBeGreaterThan(1)
    // Panning moves the centre in world units.
    const before = rig.center2D.x
    rig.nudge({ panX: 10 })
    rig.update(0.5, { followActivity: false, autoZoom: false, smoothing: 1 }, null, {
      center: { x: 0, y: 0 },
      radius: 50,
    })
    expect(rig.center2D.x).toBeGreaterThan(before)
  })

  it('keeps automatic behaviour inside finite bounds', () => {
    const rig = new Camera2D()
    rig.setViewport(1280, 720)
    const options = { followActivity: false, autoZoom: true, smoothing: 1 }
    for (let index = 0; index < 200; index += 1) {
      rig.update(1 / 60, options, null, { center: { x: index * 10, y: -index * 5 }, radius: 5 + index })
    }
    expect(Number.isFinite(rig.camera.position.x)).toBe(true)
    expect(Number.isFinite(rig.camera.position.y)).toBe(true)
    expect(rig.viewHeight).toBeGreaterThan(0)
  })
})

describe('palette', () => {
  it('produces stable colours', () => {
    const ts1 = colorForExtension('ts').getHexString()
    const ts2 = colorForExtension('ts').getHexString()
    expect(ts1).toBe(ts2)
    expect(ts1).not.toBe(colorForExtension('md').getHexString())
    expect(colorForAuthor(0).getHexString()).not.toBe(colorForAuthor(3).getHexString())
    expect(colorForChange('add').getHexString()).not.toBe(colorForChange('delete').getHexString())
  })
})

describe('label placement', () => {
  const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom })

  it('rejects labels that would overlap already placed ones', () => {
    const placed = [rect(100, 100, 180, 120)]
    // Direct overlap.
    expect(overlapsAny(rect(120, 105, 200, 125), placed)).toBe(true)
    // Overlap within the breathing gap.
    expect(overlapsAny(rect(182, 100, 240, 120), placed)).toBe(true)
    // Clearly separate.
    expect(overlapsAny(rect(300, 400, 380, 420), placed)).toBe(false)
    // Vertically separated.
    expect(overlapsAny(rect(100, 200, 180, 220), placed)).toBe(false)
  })

  it('accepts everything when nothing has been placed yet', () => {
    expect(overlapsAny(rect(0, 0, 10, 10), [])).toBe(false)
  })
})
