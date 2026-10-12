import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { NODE_Z, NodeField } from '../src/render/nodes'
import { EdgeField } from '../src/render/edges'
import { GlowField, GLOW_Z } from '../src/render/glow'
import { ParticleField, pointSizePixels } from '../src/render/particles'
import { Camera2D } from '../src/render/camera'
import { colorForExtension, colorForChange, colorForAuthor } from '../src/render/palette'
import { overlapsAny } from '../src/render/labels'
import { BeamField } from '../src/render/beams'
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
    targetPosition: { x: id * 0.5, y: 0, z: 0 },
    radius: 0.2,
    clusterRadius: 0.2,
    ownDiscRadius: 0.2,
    contentRadius: 0.2,
    subtreeArea: 0,
    positionInitialized: true,
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

  it('collapses hidden nodes on a full sync, not just on a dirty one', () => {
    // Regression: a full sync used to skip invisible nodes, so a seek or a
    // restart left the previous frame's circles on screen.
    const field = new NodeField({ maxFiles: 8, maxDirs: 4, colorMode: 'extension' })
    const nodes = [
      node(0, { kind: 'root', path: '' }),
      node(1),
      node(2),
      node(3, { kind: 'dir', path: 'src', name: 'src' }),
    ]
    field.sync(nodes, true)
    expect(field.drawn).toEqual({ files: 2, dirs: 2 })

    // Everything hidden (a restart seeks before the first commit).
    for (const entry of nodes) entry.visible = false
    field.sync(nodes, true)
    expect(field.drawn).toEqual({ files: 0, dirs: 0 })

    // A backward seek that hides a single node collapses only that one.
    for (const entry of nodes) entry.visible = true
    field.sync(nodes, true)
    nodes[1].visible = false
    field.sync(nodes, true)
    expect(field.drawn).toEqual({ files: 1, dirs: 2 })
    field.dispose()
  })

  it('drops every instance when the history is rebuilt', () => {
    // Node ids are per simulation: a filter change rebuilds it, so the layers
    // must forget the previous instances or the old tree keeps rendering.
    const field = new NodeField({ maxFiles: 8, maxDirs: 4, colorMode: 'extension' })
    const nodes = [node(0, { kind: 'root', path: '' }), node(1), node(2, { kind: 'dir', path: 'src', name: 'src' })]
    field.sync(nodes, true)
    expect(field.stats).toEqual({ files: 1, dirs: 2 })
    field.reset()
    expect(field.stats).toEqual({ files: 0, dirs: 0 })
    expect(field.drawn).toEqual({ files: 0, dirs: 0 })

    // The next sync allocates fresh instances for the new simulation.
    const rebuilt = [node(0, { kind: 'root', path: '' }), node(1, { kind: 'dir', path: 'lib', name: 'lib' })]
    field.sync(rebuilt, true)
    expect(field.stats).toEqual({ files: 0, dirs: 2 })
    expect(field.drawn).toEqual({ files: 0, dirs: 2 })
    field.dispose()
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

describe('GlowField', () => {
  it('draws one halo per directory, sized from the cluster radius', () => {
    const field = new GlowField(8)
    const nodes = [
      node(0, { kind: 'root', path: '', radius: 0.5, clusterRadius: 12 }),
      node(1),
      node(2, { kind: 'dir', path: 'src', name: 'src', clusterRadius: 4 }),
    ]
    field.sync(nodes, true)
    // Only the root and the directory get a halo: Gource blooms directories.
    expect(field.stats).toBe(2)

    const mesh = (field as unknown as { mesh: THREE.InstancedMesh }).mesh
    const matrix = new THREE.Matrix4()
    mesh.getMatrixAt(1, matrix)
    // Gource: bloom_radius = dir_radius * 2.0 * bloom_multiplier.
    expect(matrix.elements[0]).toBeCloseTo(8, 5)
    // Halos sit in front of the circles (z) but behind the beams and avatars.
    expect(matrix.elements[14]).toBeCloseTo(GLOW_Z, 5)

    // A hidden directory collapses its halo.
    nodes[2].visible = false
    field.sync(nodes, false, [2])
    mesh.getMatrixAt(1, matrix)
    expect(matrix.elements[0]).toBe(0)
    field.dispose()
  })

  it('drops every halo when the history is rebuilt', () => {
    const field = new GlowField(8)
    const nodes = [node(0, { kind: 'root', path: '' }), node(1, { kind: 'dir', path: 'src', name: 'src' })]
    field.sync(nodes, true)
    expect(field.drawn).toBe(2)
    field.reset()
    expect(field.stats).toBe(0)
    expect(field.drawn).toBe(0)
    field.dispose()
  })

  it('collapses hidden halos on a full sync', () => {
    const field = new GlowField(8)
    const nodes = [node(0, { kind: 'root', path: '' }), node(1, { kind: 'dir', path: 'src', name: 'src' })]
    field.sync(nodes, true)
    expect(field.drawn).toBe(2)
    nodes[1].visible = false
    field.sync(nodes, true)
    expect(field.drawn).toBe(1)
    for (const entry of nodes) entry.visible = false
    field.sync(nodes, true)
    expect(field.drawn).toBe(0)
    field.dispose()
  })

  it('bakes the intensity into the instance colours and hides at zero', () => {
    const field = new GlowField(8)
    const nodes = [node(0, { kind: 'root', path: '' }), node(1, { kind: 'dir', path: 'src', name: 'src' })]
    field.setIntensity(0.75, nodes)
    field.sync(nodes, true)
    const mesh = (field as unknown as { mesh: THREE.InstancedMesh }).mesh
    const color = new THREE.Color()
    mesh.getColorAt(1, color)
    const full = color.r

    field.setIntensity(0.375, nodes)
    mesh.getColorAt(1, color)
    expect(color.r).toBeCloseTo(full / 2, 5)

    field.setIntensity(0, nodes)
    expect(mesh.visible).toBe(false)
    field.dispose()
  })

  it('allocates halos introduced by incremental playback and grows capacity', () => {
    const field = new GlowField(2)
    const nodes: SimNode[] = [node(0, { kind: 'root', path: '' })]
    field.sync(nodes, true)
    for (let index = 1; index <= 8; index += 1) {
      nodes.push(node(index, { kind: 'dir', path: `dir-${index}`, name: `dir-${index}` }))
      field.sync(nodes, false, [index])
    }
    expect(field.stats).toBe(9)
    field.dispose()
  })
})

describe('EdgeField', () => {
  it('draws one trimmed segment per visible node and collapses hidden ones', () => {
    const field = new EdgeField(16)
    const parent = node(0, { kind: 'root', path: '', radius: 0.5, position: { x: 0, y: 0, z: 0 } })
    const child = node(1, { parent: 0, radius: 0.2, position: { x: 10, y: 0, z: 0 } })
    const nodes = [parent, child]
    field.sync(nodes, true)
    const geometry = field.lines.geometry
    expect(geometry.drawRange.count).toBe(4)

    const positions = geometry.getAttribute('position') as THREE.BufferAttribute
    // The branch starts at the parent's edge and stops at the child's edge, so
    // it never runs into a circle (a 0.02 margin keeps it off the outline).
    expect(positions.getX(2)).toBeCloseTo(0.52, 5)
    expect(positions.getX(3)).toBeCloseTo(9.78, 5)
    expect(positions.getY(2)).toBeCloseTo(0, 5)
    expect(positions.getY(3)).toBeCloseTo(0, 5)

    // Hidden nodes collapse to a zero-length segment.
    child.visible = false
    field.sync(nodes, false, [1])
    expect((geometry.getAttribute('position') as THREE.BufferAttribute).getX(3)).toBe(0)
    field.dispose()
  })

  it('drops every branch when the history is rebuilt', () => {
    const field = new EdgeField(8)
    const parent = node(0, { kind: 'root', path: '', radius: 0.5 })
    const child = node(1, { parent: 0, radius: 0.2, position: { x: 6, y: 0, z: 0 } })
    field.sync([parent, child], true)
    expect(field.lines.geometry.drawRange.count).toBe(4)
    field.reset()
    expect(field.lines.geometry.drawRange.count).toBe(0)
    field.dispose()
  })

  it('collapses hidden branches on a full sync', () => {
    const field = new EdgeField(8)
    const parent = node(0, { kind: 'root', path: '', radius: 0.5 })
    const child = node(1, { parent: 0, radius: 0.2, position: { x: 6, y: 0, z: 0 } })
    const nodes = [parent, child]
    field.sync(nodes, true)
    const positions = field.lines.geometry.getAttribute('position') as THREE.BufferAttribute
    expect(positions.getX(3)).toBeGreaterThan(0)
    child.visible = false
    field.sync(nodes, true)
    expect(positions.getX(3)).toBe(0)
    field.dispose()
  })

  it('sits behind the node circles and is opaque so they occlude it', () => {
    const field = new EdgeField(8)
    const material = field.lines.material as THREE.LineBasicMaterial
    // A transparent material would be rendered after the circles, which is what
    // made lines look like they crossed them.
    expect(material.transparent).toBe(false)
    expect(material.depthTest).toBe(true)
    expect(field.lines.renderOrder).toBeLessThan(0)

    const parent = node(0, { kind: 'root', path: '', radius: 0.4, position: { x: 0, y: 0, z: 0 } })
    const child = node(1, { parent: 0, radius: 0.3, position: { x: 8, y: 0, z: 0 } })
    field.sync([parent, child], true)
    const positions = field.lines.geometry.getAttribute('position') as THREE.BufferAttribute
    // Branch lines live on the z = 0 plane, the nodes in front of them.
    expect(positions.getZ(0)).toBe(0)
    expect(positions.getZ(1)).toBe(0)
    expect(NODE_Z).toBeGreaterThan(0)
    field.dispose()
  })

  it('bakes the configured dimming into the vertex colours', () => {
    const field = new EdgeField(8)
    const parent = node(0, { kind: 'root', path: '', radius: 0.4, position: { x: 0, y: 0, z: 0 } })
    const child = node(1, { parent: 0, radius: 0.3, position: { x: 8, y: 0, z: 0 } })

    // Node 1 owns vertex slots 2 and 3; slot 3 is the (brighter) child end.
    field.setOpacity(1)
    field.sync([parent, child], true)
    const bright = (field.lines.geometry.getAttribute('color') as THREE.BufferAttribute).getX(3)

    field.setOpacity(0.2)
    field.sync([parent, child], true)
    const dim = (field.lines.geometry.getAttribute('color') as THREE.BufferAttribute).getX(3)
    expect(dim).toBeLessThan(bright * 0.4)
    expect(field.currentOpacity).toBeCloseTo(0.2, 6)
    field.dispose()
  })

  it('drops a branch when the two circles already touch', () => {
    const field = new EdgeField(4)
    const parent = node(0, { kind: 'root', path: '', radius: 1.2, position: { x: 0, y: 0, z: 0 } })
    const child = node(1, { parent: 0, radius: 1.2, position: { x: 1, y: 0, z: 0 } })
    field.sync([parent, child], true)
    const positions = field.lines.geometry.getAttribute('position') as THREE.BufferAttribute
    // Both vertices collapsed: no stub inside the circles.
    expect(positions.getX(2)).toBe(0)
    expect(positions.getX(3)).toBe(0)
    field.dispose()
  })

  it('keeps every endpoint outside the circle it belongs to', () => {
    const field = new EdgeField(32)
    const nodes: SimNode[] = [node(0, { kind: 'root', path: '', radius: 0.5, position: { x: 0, y: 0, z: 0 } })]
    for (let index = 1; index < 24; index += 1) {
      nodes.push(
        node(index, {
          parent: 0,
          radius: 0.4 + (index % 5) * 0.25,
          position: { x: Math.cos(index) * (3 + (index % 4)), y: Math.sin(index) * (3 + (index % 4)), z: 0 },
        }),
      )
    }
    field.sync(nodes, true)
    const positions = field.lines.geometry.getAttribute('position') as THREE.BufferAttribute
    for (const entry of nodes) {
      if (entry.parent < 0) continue
      const index = entry.id * 6
      const ax = positions.getX(index / 3 + 0)
      const ay = positions.getY(index / 3 + 0)
      const bx = positions.getX(index / 3 + 1)
      const by = positions.getY(index / 3 + 1)
      if (ax === 0 && ay === 0 && bx === 0 && by === 0) continue
      const childClearance = Math.hypot(bx - entry.position.x, by - entry.position.y) - entry.radius
      expect(childClearance).toBeGreaterThan(0)
      const parentNode = nodes[entry.parent]
      const parentClearance = Math.hypot(ax - parentNode.position.x, ay - parentNode.position.y) - parentNode.radius
      expect(parentClearance).toBeGreaterThan(0)
    }
    field.dispose()
  })

  it('grows its buffers for large trees', () => {
    const field = new EdgeField(8)
    const nodes: SimNode[] = [node(0, { kind: 'root', path: '', radius: 0.4 })]
    for (let index = 1; index < 200; index += 1) {
      nodes.push(node(index, { parent: index - 1, radius: 0.3, position: { x: index * 2, y: 0, z: 0 } }))
    }
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

describe('background layers', () => {
  it('keeps the grid behind the tree', async () => {
    const { GRID_Z, BACKGROUND_Z } = await import('../src/render/renderer')
    // The grid sits behind the branches (z = 0) and the nodes (+0.25), in front
    // of the backdrop.
    expect(GRID_Z).toBeLessThan(0)
    expect(BACKGROUND_Z).toBeLessThan(GRID_Z)
  })
})

describe('layer ordering', () => {
  it('draws branches behind the circles and effects above them', () => {
    const edges = new EdgeField(4)
    const nodes = new NodeField({ maxFiles: 4, maxDirs: 4, colorMode: 'extension' })
    const particles = new ParticleField(8)
    const beams = new BeamField(4)

    // Branches render before the opaque circles (negative renderOrder).
    expect(edges.lines.renderOrder).toBeLessThan(0)
    // Effects and beams sit above the circles, beams above particles.
    expect(particles.points.renderOrder).toBeGreaterThan(3)
    expect(beams.mesh.renderOrder).toBeGreaterThan(particles.points.renderOrder)

    edges.dispose()
    nodes.dispose()
    particles.dispose()
    beams.dispose()
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
