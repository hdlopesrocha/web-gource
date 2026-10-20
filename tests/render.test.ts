import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { NODE_Z, NodeField } from '../src/render/nodes'
import { EdgeField } from '../src/render/edges'
import { ParticleField, pointSizePixels } from '../src/render/particles'
import { DEFAULT_PITCH, DEFAULT_YAW, OrbitCamera } from '../src/render/camera'
import { cameraQuaternionFromOrientation } from '../src/render/orientation'
import { colorForExtension, colorForChange, colorForAuthor } from '../src/render/palette'
import { overlapsAny } from '../src/render/labels'
import { buildInfoPanelModel, fitText, wrapText } from '../src/render/info-panel'
import { chartLabelSize } from '../src/engine/export/overlay'
import { BeamField } from '../src/render/beams'
import { PlasmaField } from '../src/render/plasma'
import { SceneRenderer } from '../src/render/renderer'
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

  it('draws both node kinds as lit spheres that write depth', () => {
    const field = new NodeField({ maxFiles: 4, maxDirs: 4, colorMode: 'extension' })
    const internals = field as unknown as {
      fileMesh: THREE.InstancedMesh
      dirMesh: THREE.InstancedMesh
      fileMaterial: THREE.MeshLambertMaterial
      dirMaterial: THREE.MeshLambertMaterial
      lights: THREE.Light[]
    }
    // Real geometry, not a textured quad: files and directories share the lit
    // material path, so they occlude the branches behind them.
    expect(internals.fileMesh.geometry.type).toBe('SphereGeometry')
    expect(internals.dirMesh.geometry.type).toBe('SphereGeometry')
    for (const material of [internals.fileMaterial, internals.dirMaterial]) {
      expect(material.type).toBe('MeshLambertMaterial')
      expect(material.transparent).toBe(false)
      expect(material.depthWrite).toBe(true)
      expect(material.toneMapped).toBe(false)
    }

    // The field owns the ambient + key light, so both meshes are shaded.
    expect(internals.lights.some((light) => light instanceof THREE.AmbientLight)).toBe(true)
    expect(internals.lights.some((light) => light instanceof THREE.DirectionalLight)).toBe(true)

    field.dispose()
    expect(internals.lights).toHaveLength(0)
    expect(field.group.children.some((child) => (child as THREE.Light).isLight)).toBe(false)
  })

  it('cycles file colours with claps and restores them when the track stops', () => {
    const field = new NodeField({ maxFiles: 4, maxDirs: 4, colorMode: 'extension' })
    const nodes = [node(0, { kind: 'root', path: '' }), node(1, { path: 'src/a.ts' })]
    field.sync(nodes, true)
    const mesh = (field as unknown as { fileMesh: THREE.InstancedMesh }).fileMesh
    const color = new THREE.Color()
    mesh.getColorAt(0, color)
    const base = color.getHex()

    field.update(0, nodes, {
      bass: 0,
      low: 0,
      mid: 0,
      voice: 0,
      clap: 0.5,
      clapCount: 4,
    })
    mesh.getColorAt(0, color)
    expect(color.getHex()).not.toBe(base)

    field.update(0, nodes, null)
    mesh.getColorAt(0, color)
    expect(color.getHex()).toBe(base)
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

  it('brightens the branches with the midrange and resets to neutral', () => {
    const field = new EdgeField(8)
    const material = field.lines.material as THREE.LineBasicMaterial
    expect(material.color.getHex()).toBe(0xffffff)
    field.applyAudio({ bass: 0, low: 0, mid: 1, voice: 0, clap: 0, clapCount: 0 })
    expect(material.color.r).toBeGreaterThan(1)
    expect(material.color.b).toBeGreaterThan(material.color.r)
    field.applyAudio(null)
    expect(material.color.getHex()).toBe(0xffffff)
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

describe('OrbitCamera', () => {
  it('is a perspective camera orbiting a tabletop with the plane normal up', () => {
    const rig = new OrbitCamera()
    rig.setViewport(1600, 900)
    rig.frame({ center: { x: 0, y: 0 }, radius: 20 }, true)
    expect(rig.camera.isPerspectiveCamera).toBe(true)
    expect(rig.camera.fov).toBeGreaterThan(20)
    // The eye sits on a sphere around the target; the default elevation lifts
    // it above the XY plane so the flat layout gains visible perspective.
    expect(rig.camera.position.distanceTo(rig.focusPoint)).toBeCloseTo(rig.targetDistance, 5)
    expect(rig.camera.position.z).toBeGreaterThan(0)
    expect(rig.camera.up.x).toBeCloseTo(0, 6)
    expect(rig.camera.up.y).toBeCloseTo(0, 6)
    expect(rig.camera.up.z).toBeCloseTo(1, 6)
    expect(rig.angles.yaw).toBeCloseTo(DEFAULT_YAW, 5)
    expect(rig.angles.pitch).toBeCloseTo(DEFAULT_PITCH, 5)
  })

  it('follows recent activity and fits the repository', () => {
    const rig = new OrbitCamera()
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

  it('zooms and pans while keeping the orbit target under control', () => {
    const rig = new OrbitCamera()
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
    // Panning moves the orbit target in world units.
    const before = rig.center2D.x
    rig.nudge({ panX: 10 })
    rig.update(0.5, { followActivity: false, autoZoom: false, smoothing: 1 }, null, {
      center: { x: 0, y: 0 },
      radius: 50,
    })
    expect(rig.center2D.x).toBeGreaterThan(before)
  })

  it('orbits with the mouse and restores the default angle on reset', () => {
    const rig = new OrbitCamera()
    rig.setViewport(1000, 700)
    const bounds = { center: { x: 0, y: 0 }, radius: 40 }
    rig.frame(bounds, true)
    const before = rig.angles
    rig.orbitBy(120, -60)
    rig.update(1 / 60, { followActivity: true, autoZoom: true, smoothing: 1 }, null, bounds)
    expect(rig.angles.yaw).not.toBeCloseTo(before.yaw, 5)
    expect(rig.angles.pitch).toBeGreaterThan(before.pitch)

    rig.reset(bounds, true)
    expect(rig.angles.yaw).toBeCloseTo(DEFAULT_YAW, 6)
    expect(rig.angles.pitch).toBeCloseTo(DEFAULT_PITCH, 6)
    expect(rig.camera.position.z).toBeGreaterThan(0)
  })

  it('switches to a flat top-down 2D view with pan-only controls', () => {
    const rig = new OrbitCamera()
    rig.setViewport(1000, 700)
    const bounds = { center: { x: 0, y: 0 }, radius: 40 }
    const flatOptions = { followActivity: false, autoZoom: false, smoothing: 1, flat: true }
    rig.frame(bounds, true)
    rig.setFlatMode(true)
    expect(rig.isFlat).toBe(true)
    for (let index = 0; index < 240; index += 1) rig.update(1 / 60, flatOptions, null, bounds)

    // The eye is straight above the target, looking down the Z axis. Up must
    // lie in the plane for this view; +Y preserves the old 2D orientation.
    expect(rig.angles.yaw).toBeCloseTo(DEFAULT_YAW, 4)
    expect(rig.angles.pitch).toBeCloseTo(DEFAULT_PITCH, 4)
    expect(rig.camera.position.x).toBeCloseTo(rig.focusPoint.x, 3)
    expect(rig.camera.position.y).toBeCloseTo(rig.focusPoint.y, 3)
    expect(rig.camera.position.z).toBeGreaterThan(rig.focusPoint.z)
    expect(rig.camera.up.y).toBeCloseTo(1, 6)
    expect(rig.camera.up.z).toBeCloseTo(0, 6)

    // Orbit input is ignored, panning and zooming still work.
    rig.orbitBy(100, -50)
    rig.update(1 / 60, flatOptions, null, bounds)
    expect(rig.angles.yaw).toBeCloseTo(DEFAULT_YAW, 6)
    expect(rig.angles.pitch).toBeCloseTo(DEFAULT_PITCH, 6)
    const zoomBefore = rig.currentZoom
    rig.nudge({ zoom: 1.5 })
    rig.update(0.5, flatOptions, null, bounds)
    expect(rig.currentZoom).toBeGreaterThan(zoomBefore)
    const centerX = rig.center2D.x
    rig.nudge({ panX: 12 })
    rig.update(0.5, flatOptions, null, bounds)
    expect(rig.center2D.x).toBeGreaterThan(centerX)
  })

  it('restores the 3D orbit when leaving the flat view and resets to 3D explicitly', () => {
    const rig = new OrbitCamera()
    rig.setViewport(1000, 700)
    const bounds = { center: { x: 0, y: 0 }, radius: 40 }
    const autoOptions = { followActivity: false, autoZoom: false, smoothing: 1 }
    const flatOptions = { ...autoOptions, flat: true }
    rig.frame(bounds, true)
    rig.orbitBy(40, -20)
    for (let index = 0; index < 1000; index += 1) rig.update(1 / 60, autoOptions, null, bounds)
    const orbit = rig.angles

    rig.setFlatMode(true)
    // Entering the flat view does not alter the orbit; the camera just looks
    // down the plane normal instead.
    expect(rig.angles.yaw).toBeCloseTo(orbit.yaw, 6)
    expect(rig.angles.pitch).toBeCloseTo(orbit.pitch, 6)
    for (let index = 0; index < 60; index += 1) rig.update(1 / 60, flatOptions, null, bounds)
    rig.setFlatMode(false)
    // The angle the user had before switching to 2D comes back.
    expect(rig.angles.yaw).toBeCloseTo(orbit.yaw, 6)
    expect(rig.angles.pitch).toBeCloseTo(orbit.pitch, 6)

    rig.setFlatMode(true)
    rig.update(1 / 60, flatOptions, null, bounds)
    rig.reset3D(bounds, true)
    expect(rig.isFlat).toBe(false)
    expect(rig.angles.yaw).toBeCloseTo(DEFAULT_YAW, 6)
    expect(rig.angles.pitch).toBeCloseTo(DEFAULT_PITCH, 6)
    expect(rig.camera.position.z).toBeGreaterThan(0)
    expect(rig.camera.up.z).toBeCloseTo(1, 6)
  })

  it('keeps automatic behaviour inside finite bounds', () => {
    const rig = new OrbitCamera()
    rig.setViewport(1280, 720)
    const options = { followActivity: false, autoZoom: true, smoothing: 1 }
    for (let index = 0; index < 200; index += 1) {
      rig.update(1 / 60, options, null, { center: { x: index * 10, y: -index * 5 }, radius: 5 + index })
    }
    expect(Number.isFinite(rig.camera.position.x)).toBe(true)
    expect(Number.isFinite(rig.camera.position.y)).toBe(true)
    expect(Number.isFinite(rig.camera.position.z)).toBe(true)
    expect(rig.viewHeight).toBeGreaterThan(0)
  })
})

describe('info panel model', () => {
  const commit = {
    sha: 'abcdef1234567890',
    shortSha: 'abcdef1',
    subject: 'fix: make the parser handle empty input',
    author: 'Ada',
    authorColor: '#5ec8ff',
    isMerge: false,
    filesKnown: true,
    filesTruncated: false,
    changes: Array.from({ length: 12 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      kind: 'modify' as const,
      size: 1024 * (index + 1),
    })),
    additions: 42,
    deletions: 7,
    timestamp: 0,
  }

  it('builds the same content the on-screen panel shows', () => {
    const model = buildInfoPanelModel({
      date: Date.UTC(2024, 2, 6, 14, 30),
      time: 60,
      duration: 240,
      fps: 60,
      commit,
      visibleFiles: 12,
      visibleDirs: 3,
      totalFiles: 1234,
      totalBytes: 5_000_000,
      authors: 8,
      activeAuthors: [{ id: 'a', name: 'Ada', color: '#fff', commits: 3, lastActiveAt: 0 }],
    })
    expect(model.dateLabel).toBe('2024-03-06 14:30')
    expect(model.timeLabel).toBe('1:00 / 4:00')
    expect(model.fpsLabel).toBe('60 fps')
    expect(model.subject).toContain('parser')
    expect(model.author).toEqual({
      name: 'Ada',
      color: '#5ec8ff',
      shortSha: 'abcdef1',
      additions: 42,
      deletions: 7,
    })
    // Only nine files are listed, the rest are summarised.
    expect(model.changes).toHaveLength(9)
    expect(model.changes[0]).toEqual({ kind: 'modify', label: 'modified', path: 'src/file-0.ts', size: 1024 })
    expect(model.moreFiles).toBe(3)
    expect(model.missing).toBeNull()
    expect(model.stats.map((stat) => stat.label)).toEqual([
      'files in tree',
      'directories',
      'files in history',
      'tracked size',
      'authors',
    ])
    expect(model.stats[0].value).toBe('12')
    expect(model.stats[3].value).toBe('4.8 MB')
    expect(model.workingNow).toHaveLength(1)
  })

  it('explains a commit without file data and keeps merge marks', () => {
    const model = buildInfoPanelModel({
      date: 0,
      time: 0,
      duration: 0,
      fps: 30,
      commit: { ...commit, filesKnown: false, filesMissingReason: 'rate-limit', isMerge: true, changes: [] },
      visibleFiles: 0,
      visibleDirs: 0,
      totalFiles: 0,
      totalBytes: 0,
      authors: 0,
      activeAuthors: [],
    })
    expect(model.dateLabel).toBe('—')
    expect(model.isMerge).toBe(true)
    expect(model.missing).toBe('File list unavailable: API quota exhausted')
    expect(model.changes).toEqual([])
  })

  it('wraps and truncates text to fit the panel', () => {
    // A stub context with a fixed character width, enough for measuring.
    const ctx = {
      measureText: (text: string) => ({ width: text.length * 10 }),
    } as unknown as CanvasRenderingContext2D
    expect(fitText(ctx, 'short', 200)).toBe('short')
    const truncated = fitText(ctx, 'a-very-long-path/file.ts', 100)
    expect(truncated.endsWith('…')).toBe(true)
    // The longest prefix that fits, plus the ellipsis.
    expect(truncated.length * 10).toBeLessThanOrEqual(100)
    const lines = wrapText(ctx, 'one two three four five six seven', 100, 2)
    expect(lines).toHaveLength(2)
    expect(lines[1].endsWith('…')).toBe(true)
  })
})

describe('export overlay', () => {
  it('keeps the chart labels legible at every export size', () => {
    // The labels scale with the panel, so 720p is as readable as 1080p.
    expect(chartLabelSize(15)).toBeGreaterThanOrEqual(13) // 1080p
    expect(chartLabelSize(10)).toBeGreaterThanOrEqual(9) // 720p
    expect(chartLabelSize(8)).toBeGreaterThanOrEqual(9) // 360p
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
    // The grid sits behind the branches (z = 0) and the nodes (+0.25). The
    // screen-space backdrop is a full-frame shader, so its old world depth is
    // kept only for callers that still refer to it.
    expect(GRID_Z).toBeLessThan(0)
    expect(BACKGROUND_Z).toBeLessThan(GRID_Z)
  })
})

describe('layer ordering', () => {
  it('paints the backdrop first and depth tests every element above it', () => {
    const renderer = new SceneRenderer(stubCanvas(), { gl: fakeGl() })
    const backdrop = renderer.scene.children[0] as THREE.Mesh
    const backdropMaterial = backdrop.material as THREE.ShaderMaterial

    // The backdrop gradient is drawn first: it is opaque (so it fills the
    // frame), it does not test depth, and its render order sits below every
    // element layer.
    expect(backdrop.renderOrder).toBe(-20)
    expect(backdropMaterial.transparent).toBe(false)
    expect(backdropMaterial.depthTest).toBe(false)
    expect(backdropMaterial.depthWrite).toBe(false)

    const internals = renderer as unknown as {
      edges: EdgeField
      nodes: NodeField
      plasma: PlasmaField
      particles: ParticleField
      beams: BeamField
    }
    const nodeMeshes = internals.nodes as unknown as {
      fileMesh: THREE.InstancedMesh
      dirMesh: THREE.InstancedMesh
    }
    const plasmaMesh = (internals.plasma as unknown as { mesh: THREE.Mesh }).mesh

    // Every element layer — branches, files, dirs, plasma, particles, beams —
    // is drawn above the backdrop and tests depth against what is already in
    // the buffer, so nearer geometry occludes it.
    const layers: THREE.Object3D[] = [
      internals.edges.lines,
      nodeMeshes.fileMesh,
      nodeMeshes.dirMesh,
      plasmaMesh,
      internals.particles.points,
      internals.beams.mesh,
    ]
    for (const layer of layers) {
      expect(layer.renderOrder).toBeGreaterThan(backdrop.renderOrder)
      expect(((layer as THREE.Mesh).material as THREE.Material).depthTest).toBe(true)
    }

    renderer.dispose()
  })

  it('flies the camera in free mode without disturbing the orbit view', () => {
    const rig = new OrbitCamera()
    const bounds = { center: { x: 0, y: 0, z: 0 }, radius: 40 }
    rig.frame(bounds, true)
    const orbitPosition = rig.camera.position.clone()
    const orbitQuaternion = rig.camera.quaternion.clone()

    // Rotation is a quaternion delta around the camera's own axes: the view
    // turns without the camera moving.
    rig.rotateLocal(Math.PI / 2, 0, 0, 1)
    expect(rig.isFree).toBe(true)
    expect(rig.camera.quaternion.angleTo(orbitQuaternion)).toBeGreaterThan(0.5)
    expect(rig.camera.position.distanceTo(orbitPosition)).toBeLessThan(1e-6)

    // Roll is expressible (an orbit cannot roll), so the up vector tilts.
    const beforeRoll = rig.camera.quaternion.clone()
    const upBefore = rig.camera.up.clone()
    rig.rotateLocal(0, 0, Math.PI / 2, 1)
    expect(rig.camera.quaternion.angleTo(beforeRoll)).toBeGreaterThan(0.5)
    expect(rig.camera.up.angleTo(upBefore)).toBeGreaterThan(0.5)

    // Translation goes along the camera's own forward / side / up axes.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion)
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(rig.camera.quaternion)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rig.camera.quaternion)

    const fromForward = rig.camera.position.clone()
    rig.translateLocal(10, 0, 0, 1)
    const forwardMove = rig.camera.position.clone().sub(fromForward)
    expect(forwardMove.length()).toBeCloseTo(10, 4)
    expect(forwardMove.angleTo(forward)).toBeCloseTo(0, 4)

    const fromSide = rig.camera.position.clone()
    rig.translateLocal(0, 4, 0, 1)
    const sideMove = rig.camera.position.clone().sub(fromSide)
    expect(sideMove.length()).toBeCloseTo(4, 4)
    expect(sideMove.angleTo(side)).toBeCloseTo(0, 4)

    const fromUp = rig.camera.position.clone()
    rig.translateLocal(0, 0, 2, 1)
    const upMove = rig.camera.position.clone().sub(fromUp)
    expect(upMove.length()).toBeCloseTo(2, 4)
    expect(upMove.angleTo(up)).toBeCloseTo(0, 4)

    // The automatic follow never fights the free camera.
    rig.update(0.5, { followActivity: true, autoZoom: true, smoothing: 2 }, { x: 500, y: 500 }, bounds)
    expect(rig.isFree).toBe(true)
    expect(rig.camera.position.distanceTo(orbitPosition)).toBeGreaterThan(1)

    // Handing the camera back restores the orbit framing exactly.
    rig.leaveFreeMode()
    expect(rig.isFree).toBe(false)
    rig.update(0.5, { followActivity: false, autoZoom: false, smoothing: 2 }, null, bounds)
    expect(rig.camera.position.distanceTo(orbitPosition)).toBeLessThan(1e-3)
    rig.dispose()
  })

  it('follows the gyroscope relative to the calibrated pose', () => {
    const rig = new OrbitCamera()
    const bounds = { center: { x: 0, y: 0, z: 0 }, radius: 40 }
    rig.frame(bounds, true)

    // Switching head tracking on never snaps the view: the first pose becomes
    // the reference.
    const poseA = cameraQuaternionFromOrientation({ alpha: 0, beta: 0, gamma: 0 })
    rig.applyOrientation(poseA)
    expect(rig.isFree).toBe(true)
    expect(rig.isOrientationCalibrated).toBe(true)
    const calibrated = rig.camera.quaternion.clone()
    const upCalibrated = rig.camera.up.clone()

    // Recalibrating leaves the camera exactly where it is.
    rig.calibrateOrientation(poseA)
    expect(rig.camera.quaternion.angleTo(calibrated)).toBeCloseTo(0, 6)

    // A 90° compass turn of a flat device still looks at the ceiling, but its
    // up vector — and therefore the camera's — turns by exactly 90°, which is
    // what keeps the horizon calibrated to the user's head.
    const poseB = cameraQuaternionFromOrientation({ alpha: 90, beta: 0, gamma: 0 })
    rig.applyOrientation(poseB)
    expect(rig.camera.quaternion.angleTo(calibrated)).toBeCloseTo(Math.PI / 2, 4)
    expect(rig.camera.up.angleTo(upCalibrated)).toBeCloseTo(Math.PI / 2, 4)
    expect(rig.camera.up.length()).toBeCloseTo(1, 6)

    // Mouse orbiting hands the camera back to the orbit model.
    rig.orbitBy(10, 0)
    expect(rig.isFree).toBe(false)
    rig.dispose()
  })

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

/* -------------------------------------------------------------------------- *
 * WebGL stubs: the only way to build a SceneRenderer without a GL context.
 * -------------------------------------------------------------------------- */

function stubCanvas(): HTMLCanvasElement {
  return { dataset: {} } as unknown as HTMLCanvasElement
}

function fakeGl(): THREE.WebGLRenderer {
  return {
    domElement: stubCanvas(),
    autoClear: true,
    setClearColor: () => undefined,
    setPixelRatio: () => undefined,
    setSize: () => undefined,
    render: () => undefined,
    dispose: () => undefined,
    xr: {
      enabled: false,
      isPresenting: false,
      getCamera: () => new THREE.PerspectiveCamera(),
      setReferenceSpaceType: () => undefined,
      setSession: async () => undefined,
    },
  } as unknown as THREE.WebGLRenderer
}
