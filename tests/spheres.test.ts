import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { NODE_Z, NodeField } from '../src/render/nodes'
import { SceneRenderer } from '../src/render/renderer'
import { DIR_COLOR, ROOT_COLOR, colorForExtension } from '../src/render/palette'
import type { SimNode } from '../src/sim/simulation'

/**
 * Sphere-only node field: both files and directories are real instanced
 * geometry with a lit material. Like the other renderer tests this exercises
 * the GPU bookkeeping without a WebGL context — three's data structures are
 * plain JavaScript until something is rendered.
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

function directory(id: number, overrides: Partial<SimNode> = {}): SimNode {
  return node(id, { kind: 'dir', path: `src/dir-${id}`, name: `dir-${id}`, ...overrides })
}

function fileMesh(field: NodeField): THREE.InstancedMesh {
  return (field as unknown as { fileMesh: THREE.InstancedMesh }).fileMesh
}

function dirMesh(field: NodeField): THREE.InstancedMesh {
  return (field as unknown as { dirMesh: THREE.InstancedMesh }).dirMesh
}

function lights(field: NodeField): THREE.Light[] {
  return (field as unknown as { lights: THREE.Light[] }).lights
}

describe('NodeField spheres', () => {
  it('renders files and directories as lit instanced spheres', () => {
    const field = new NodeField({ maxFiles: 8, maxDirs: 4, colorMode: 'extension' })
    const nodes = [node(0, { kind: 'root', path: '' }), node(1), directory(2)]
    field.sync(nodes, true)

    expect(fileMesh(field).geometry.type).toBe('SphereGeometry')
    expect(dirMesh(field).geometry.type).toBe('SphereGeometry')
    expect((fileMesh(field).material as THREE.Material).type).toBe('MeshLambertMaterial')
    expect((dirMesh(field).material as THREE.Material).type).toBe('MeshLambertMaterial')

    // Both kinds keep their existing depth order.
    expect(fileMesh(field).renderOrder).toBe(2)
    expect(dirMesh(field).renderOrder).toBe(3)
    expect(fileMesh(field).count).toBe(1)
    expect(dirMesh(field).count).toBe(2)

    // Ambient + key light live in the field's group so both meshes are shaded.
    const kinds = lights(field).map((light) => light.type)
    expect(kinds).toContain('AmbientLight')
    expect(kinds).toContain('DirectionalLight')
    for (const light of lights(field)) expect(light.parent).toBe(field.group)

    field.dispose()
  })

  it('writes world-scaled transforms with no billboard rotation or perspective compensation', () => {
    const field = new NodeField({ maxFiles: 8, maxDirs: 4, colorMode: 'extension' })
    const root = node(0, { kind: 'root', path: '', radius: 0.6 })
    const near = node(1, { position: { x: 0, y: 0, z: 0 }, radius: 0.2 })
    const far = node(2, { position: { x: 80, y: 0, z: 0 }, radius: 0.2 })
    const nodes = [root, near, far]
    field.sync(nodes, true)

    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    const identity = new THREE.Quaternion()

    // Near file: no billboard rotation and its true world radius.
    fileMesh(field).getMatrixAt(0, matrix)
    matrix.decompose(position, quaternion, scale)
    expect(quaternion.angleTo(identity)).toBeLessThan(1e-6)
    expect(scale.x).toBeCloseTo(0.2, 6)
    expect(scale.y).toBeCloseTo(0.2, 6)
    expect(scale.z).toBeCloseTo(0.2, 6)
    expect(position.z).toBeCloseTo(NODE_Z, 6)

    // The far file keeps the same world size: perspective does the shrinking,
    // which is the parallax the old billboards were cancelling.
    fileMesh(field).getMatrixAt(1, matrix)
    matrix.decompose(position, quaternion, scale)
    expect(quaternion.angleTo(identity)).toBeLessThan(1e-6)
    expect(scale.x).toBeCloseTo(0.2, 6)

    // The radius scale applies to files only; directories keep their radius.
    field.setRadiusScale(2)
    field.sync(nodes, true)
    fileMesh(field).getMatrixAt(0, matrix)
    matrix.decompose(position, quaternion, scale)
    expect(scale.x).toBeCloseTo(0.4, 6)
    dirMesh(field).getMatrixAt(0, matrix)
    matrix.decompose(position, quaternion, scale)
    expect(quaternion.angleTo(identity)).toBeLessThan(1e-6)
    expect(scale.x).toBeCloseTo(0.6, 6)

    field.dispose()
  })

  it('keeps palette colours and touch highlights for files and directories', () => {
    const field = new NodeField({ maxFiles: 8, maxDirs: 4, colorMode: 'extension' })
    const nodes = [node(0, { kind: 'root', path: '' }), node(1, { path: 'src/a.ts' }), directory(2)]
    field.sync(nodes, true)

    const fileBase = colorForExtension('ts').getHex()
    const color = new THREE.Color()
    fileMesh(field).getColorAt(0, color)
    expect(color.getHex()).toBe(fileBase)
    dirMesh(field).getColorAt(0, color)
    expect(color.getHex()).toBe(ROOT_COLOR.getHex())
    dirMesh(field).getColorAt(1, color)
    expect(color.getHex()).toBe(DIR_COLOR.getHex())

    // The change highlight blends over the palette colour on both kinds.
    field.touch(1, 'delete', 0)
    field.touch(2, 'modify', 0)
    field.update(0.2, nodes)
    fileMesh(field).getColorAt(0, color)
    expect(color.getHex()).not.toBe(fileBase)
    const rootBase = ROOT_COLOR.getHex()
    dirMesh(field).getColorAt(1, color)
    expect(color.getHex()).not.toBe(DIR_COLOR.getHex())

    // Once the touch expires, the palette colours come back.
    field.update(2, nodes)
    fileMesh(field).getColorAt(0, color)
    expect(color.getHex()).toBe(fileBase)
    dirMesh(field).getColorAt(0, color)
    expect(color.getHex()).toBe(rootBase)
    field.dispose()
  })

  it('modulates both node kinds with audio and restores the palette', () => {
    const field = new NodeField({ maxFiles: 4, maxDirs: 4, colorMode: 'extension' })
    const nodes = [node(0, { kind: 'root', path: '' }), node(1, { path: 'src/a.ts' })]
    field.sync(nodes, true)

    const color = new THREE.Color()
    const fileBase = colorForExtension('ts').getHex()
    fileMesh(field).getColorAt(0, color)
    expect(color.getHex()).toBe(fileBase)
    const rootBase = ROOT_COLOR.getHex()

    field.update(0, nodes, {
      bass: 0,
      low: 1,
      mid: 0,
      voice: 0,
      clap: 0.5,
      clapCount: 4,
    })
    fileMesh(field).getColorAt(0, color)
    expect(color.getHex()).not.toBe(fileBase)
    dirMesh(field).getColorAt(0, color)
    expect(color.getHex()).not.toBe(rootBase)

    field.update(0, nodes, null)
    fileMesh(field).getColorAt(0, color)
    expect(color.getHex()).toBe(fileBase)
    dirMesh(field).getColorAt(0, color)
    expect(color.getHex()).toBe(rootBase)
    field.dispose()
  })

  it('collapses hidden nodes, grows capacity and resets both meshes', () => {
    const field = new NodeField({ maxFiles: 4, maxDirs: 2, colorMode: 'extension' })
    const nodes: SimNode[] = [node(0, { kind: 'root', path: '' })]
    for (let index = 1; index <= 30; index += 1) nodes.push(node(index))
    for (let index = 31; index <= 36; index += 1) nodes.push(directory(index))

    field.sync(nodes, true)
    expect(field.stats).toEqual({ files: 30, dirs: 7 })
    expect(field.drawn).toEqual({ files: 30, dirs: 7 })
    // Capacity growth must keep the sphere geometry for both kinds.
    expect(fileMesh(field).geometry.type).toBe('SphereGeometry')
    expect(dirMesh(field).geometry.type).toBe('SphereGeometry')

    const matrix = new THREE.Matrix4()
    // File id 4 owns file instance 3.
    nodes[4].visible = false
    field.sync(nodes, false, [4])
    fileMesh(field).getMatrixAt(3, matrix)
    expect(matrix.elements[0]).toBe(0)
    // Directory id 31 owns directory instance 1 (the root is slot 0).
    nodes[31].visible = false
    field.sync(nodes, false, [31])
    dirMesh(field).getMatrixAt(1, matrix)
    expect(matrix.elements[0]).toBe(0)
    expect(field.drawn).toEqual({ files: 29, dirs: 6 })

    field.reset()
    expect(field.stats).toEqual({ files: 0, dirs: 0 })
    expect(field.drawn).toEqual({ files: 0, dirs: 0 })
    expect(fileMesh(field).count).toBe(0)
    expect(dirMesh(field).count).toBe(0)
    field.dispose()
  })
})

describe('sphere-only renderer wiring', () => {
  it('builds sphere node fields and applies radius scale without a mode switch', () => {
    const renderer = new SceneRenderer(stubCanvas(), { gl: fakeGl() })
    const field = (renderer as unknown as { nodes: NodeField }).nodes

    expect(fileMesh(field).geometry.type).toBe('SphereGeometry')
    expect(dirMesh(field).geometry.type).toBe('SphereGeometry')
    expect('renderSpheres' in renderer.currentSettings).toBe(false)

    renderer.applySettings({ radiusScale: 2 })
    expect(fileMesh(field).geometry.type).toBe('SphereGeometry')
    expect(dirMesh(field).geometry.type).toBe('SphereGeometry')
    renderer.dispose()
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
