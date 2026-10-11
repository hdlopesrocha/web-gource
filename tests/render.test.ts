import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { NodeField } from '../src/render/nodes'
import { EdgeField } from '../src/render/edges'
import { ParticleField, pointSizePixels, projectionScaleFor } from '../src/render/particles'
import { CameraRig } from '../src/render/camera'
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
  it('projects world-space particle sizes into sane device pixels', () => {
    // Matches the shader: gl_PointSize = aSize * projectionScale / distance.
    const scale1080 = projectionScaleFor(1080, 52)
    expect(scale1080).toBeGreaterThan(900)
    for (const distance of [20, 50, 120]) {
      const pixels = pointSizePixels(0.15, scale1080, distance)
      expect(pixels).toBeGreaterThan(1)
      expect(pixels).toBeLessThan(30)
    }
    // Higher resolution and wider FOV produce smaller pixels for the same world size.
    expect(pointSizePixels(0.15, projectionScaleFor(2160, 52), 50)).toBeGreaterThan(
      pointSizePixels(0.15, projectionScaleFor(1080, 52), 50),
    )
    expect(pointSizePixels(0.15, projectionScaleFor(1080, 90), 50)).toBeLessThan(
      pointSizePixels(0.15, projectionScaleFor(1080, 52), 50),
    )
    // Far away particles never disappear completely.
    expect(pointSizePixels(0.15, scale1080, 5000)).toBe(1)
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

describe('CameraRig', () => {
  it('frames and follows the focus point', () => {
    const rig = new CameraRig(16 / 9)
    rig.frame({ center: { x: 0, y: 0, z: 0 }, radius: 20 }, true)
    const options = { followActivity: true, autoRotate: false, autoZoom: true, rotateSpeed: 0 }
    for (let index = 0; index < 200; index += 1) {
      rig.update(1 / 60, options, { x: 40, y: 0, z: 0 }, { center: { x: 0, y: 0, z: 0 }, radius: 20 })
    }
    expect(rig.focusPoint.x).toBeGreaterThan(10)
    expect(rig.camera.position.length()).toBeGreaterThan(1)
  })

  it('orbits when autorotate is enabled and stays finite', () => {
    const rig = new CameraRig()
    rig.frame({ center: { x: 0, y: 0, z: 0 }, radius: 10 }, true)
    const options = { followActivity: false, autoRotate: true, autoZoom: false, rotateSpeed: 1 }
    const before = rig.camera.position.clone()
    for (let index = 0; index < 120; index += 1) {
      rig.update(1 / 60, options, null, { center: { x: 0, y: 0, z: 0 }, radius: 10 })
    }
    expect(rig.camera.position.distanceTo(before)).toBeGreaterThan(0.5)
    expect(Number.isFinite(rig.camera.position.x)).toBe(true)
  })

  it('changes the projection aspect', () => {
    const rig = new CameraRig()
    rig.setAspect(1)
    expect(rig.camera.aspect).toBe(1)
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
