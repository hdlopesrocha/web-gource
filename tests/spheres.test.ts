import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { NodeField } from '../src/render/nodes'
import { SceneRenderer, effectiveSphereMode } from '../src/render/renderer'
import { colorForExtension } from '../src/render/palette'
import type { SimNode } from '../src/sim/simulation'

/**
 * Sphere mode: files as real instanced geometry instead of camera-facing ball
 * billboards. Like the rest of `render.test.ts` this exercises the GPU
 * bookkeeping without a WebGL context — three's data structures are plain
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

/** The file mesh is replaced on every mode switch, so always re-read it. */
function fileMesh(field: NodeField): THREE.InstancedMesh {
  return (field as unknown as { fileMesh: THREE.InstancedMesh }).fileMesh
}

function dirMesh(field: NodeField): THREE.InstancedMesh {
  return (field as unknown as { dirMesh: THREE.InstancedMesh }).dirMesh
}

describe('NodeField sphere mode', () => {
  it('swaps the file geometry and material for lit spheres and back', () => {
    const field = new NodeField({ maxFiles: 8, maxDirs: 4, colorMode: 'extension' })
    const nodes = [node(0, { kind: 'root', path: '' }), node(1)]
    field.sync(nodes, true)

    expect(fileMesh(field).geometry.type).toBe('PlaneGeometry')
    expect((fileMesh(field).material as THREE.Material).type).toBe('MeshBasicMaterial')

    field.setSphereMode(true)
    expect(fileMesh(field).geometry.type).toBe('SphereGeometry')
    expect((fileMesh(field).material as THREE.Material).type).toBe('MeshLambertMaterial')
    // Spheres keep the file slot in the depth/render order.
    expect(fileMesh(field).renderOrder).toBe(2)

    // Directories keep their rings: the spheres are a file-only feature.
    expect(dirMesh(field).geometry.type).toBe('RingGeometry')
    expect((dirMesh(field).material as THREE.Material).type).toBe('MeshBasicMaterial')

    field.setSphereMode(false)
    expect(fileMesh(field).geometry.type).toBe('PlaneGeometry')
    expect((fileMesh(field).material as THREE.Material).type).toBe('MeshBasicMaterial')
    field.dispose()
  })

  it('writes world-scaled transforms with no billboard rotation', () => {
    const field = new NodeField({ maxFiles: 8, maxDirs: 4, colorMode: 'extension' })
    const target = new THREE.Vector3(0, 0, 0)
    const near = node(1, { position: { x: 0, y: 0, z: 0 }, radius: 0.2 })
    const far = node(2, { position: { x: 80, y: 0, z: 0 }, radius: 0.2 })
    const nodes = [node(0, { kind: 'root', path: '' }), near, far]
    field.sync(nodes, true)

    const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 1000)
    camera.position.set(120, 80, 160)
    camera.lookAt(target)
    camera.updateMatrixWorld()

    field.setSphereMode(true)
    field.update(0, nodes, camera, target)

    const mesh = fileMesh(field)
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()

    // Near file: no billboard rotation at all...
    mesh.getMatrixAt(0, matrix)
    matrix.decompose(position, quaternion, scale)
    expect(quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6)
    // ...and a true world radius (node radius × radius scale), with no
    // perspective compensation.
    expect(scale.x).toBeCloseTo(0.2, 6)
    expect(scale.y).toBeCloseTo(0.2, 6)
    expect(scale.z).toBeCloseTo(0.2, 6)

    // The far file is the same world size: the perspective does the shrinking,
    // which is exactly the parallax the billboards were cancelling.
    mesh.getMatrixAt(1, matrix)
    matrix.decompose(position, quaternion, scale)
    expect(scale.x).toBeCloseTo(0.2, 6)
    field.dispose()
  })

  it('keeps the palette colours and the touch highlight', () => {
    const field = new NodeField({ maxFiles: 8, maxDirs: 4, colorMode: 'extension' })
    const nodes = [node(0, { kind: 'root', path: '' }), node(1, { path: 'src/a.ts' })]
    field.sync(nodes, true)
    const expected = colorForExtension('ts').getHex()

    field.setSphereMode(true)
    const color = new THREE.Color()
    fileMesh(field).getColorAt(0, color)
    expect(color.getHex()).toBe(expected)

    // The change highlight still blends over the palette colour.
    field.touch(1, 'delete', 0)
    field.update(0.2, nodes)
    fileMesh(field).getColorAt(0, color)
    expect(color.getHex()).not.toBe(expected)
    field.dispose()
  })

  it('collapses hidden nodes, grows capacity and resets in sphere mode', () => {
    const field = new NodeField({ maxFiles: 4, maxDirs: 2, colorMode: 'extension' })
    const nodes: SimNode[] = [node(0, { kind: 'root', path: '' })]
    for (let index = 1; index <= 30; index += 1) nodes.push(node(index))

    field.setSphereMode(true)
    field.sync(nodes, true)
    expect(field.stats.files).toBe(30)
    expect(field.drawn.files).toBe(30)

    // Capacity growth must reuse the sphere geometry, not the billboard plane.
    const mesh = fileMesh(field)
    expect(mesh.geometry.type).toBe('SphereGeometry')
    const matrix = new THREE.Matrix4()
    mesh.getMatrixAt(3, matrix)
    expect(matrix.elements[0]).toBeGreaterThan(0)

    // Node 4 owns file instance 3 (the root takes the first directory slot).
    nodes[4].visible = false
    field.sync(nodes, false, [4])
    mesh.getMatrixAt(3, matrix)
    expect(matrix.elements[0]).toBe(0)
    expect(field.drawn.files).toBe(29)

    field.reset()
    expect(field.stats.files).toBe(0)
    expect(fileMesh(field).count).toBe(0)
    field.dispose()
  })
})

describe('sphere mode wiring', () => {
  it('documents the effective-mode rule', () => {
    expect(effectiveSphereMode(false, false)).toBe(false)
    expect(effectiveSphereMode(true, false)).toBe(true)
    // A running immersive session implies spheres even when the setting is off.
    expect(effectiveSphereMode(false, true)).toBe(true)
    expect(effectiveSphereMode(true, true)).toBe(true)
  })

  it('switches through SceneRenderer.applySettings and follows the XR manager', () => {
    const renderer = new SceneRenderer(stubCanvas(), { gl: fakeGl() })
    const field = (renderer as unknown as { nodes: NodeField }).nodes
    const xr = (renderer.webgl as unknown as { xr: { isPresenting: boolean } }).xr

    expect(field.sphereMode).toBe(false)
    renderer.applySettings({ renderSpheres: true })
    expect(field.sphereMode).toBe(true)
    expect(fileMesh(field).geometry.type).toBe('SphereGeometry')

    renderer.applySettings({ renderSpheres: false })
    expect(field.sphereMode).toBe(false)
    expect(fileMesh(field).geometry.type).toBe('PlaneGeometry')

    // While an immersive session runs the spheres are forced on...
    xr.isPresenting = true
    renderer.applySettings({})
    expect(field.sphereMode).toBe(true)

    // ...and the setting takes over again when it ends.
    xr.isPresenting = false
    renderer.applySettings({})
    expect(field.sphereMode).toBe(false)
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
