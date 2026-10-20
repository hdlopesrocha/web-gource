import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  DEFAULT_PLASMA_SETTINGS,
  MAX_PLASMA_SOURCES,
  PLASMA_RENDER_ORDER,
  PlasmaField,
  heatBump,
} from '../src/render/plasma'
import { NodeField } from '../src/render/nodes'
import { EdgeField } from '../src/render/edges'
import { ParticleField } from '../src/render/particles'
import { BeamField } from '../src/render/beams'
import { DIR_COLOR, activityTint } from '../src/render/palette'
import type { SimNode } from '../src/sim/simulation'

/**
 * The plasma field is pure bookkeeping on the CPU side: heat, source
 * selection, the scattered density texture and the shader uniforms. three.js
 * data structures are plain JavaScript until something is rendered, so the
 * whole class is testable without a WebGL context.
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

function internals(field: PlasmaField): {
  mesh: THREE.Mesh
  material: THREE.ShaderMaterial
  geometry: THREE.PlaneGeometry
  texture: THREE.DataTexture
} {
  return field as unknown as {
    mesh: THREE.Mesh
    material: THREE.ShaderMaterial
    geometry: THREE.PlaneGeometry
    texture: THREE.DataTexture
  }
}

describe('PlasmaField heat', () => {
  it('accumulates heat on touch, clamped to 1', () => {
    const field = new PlasmaField()
    expect(field.heatFor(1)).toBe(0)
    field.touch(1, 1)
    expect(field.heatFor(1)).toBeCloseTo(heatBump(1), 6)
    // A strong change bumps the heat further, but never past 1.
    field.touch(1, 500)
    expect(field.heatFor(1)).toBe(1)
    field.touch(1, 500)
    expect(field.heatFor(1)).toBe(1)
    field.dispose()
  })

  it('decays exponentially with the frame dt', () => {
    const field = new PlasmaField()
    field.applySettings({ decay: 8 })
    field.touch(1, 500)
    field.update(4, [], null, 220)
    expect(field.heatFor(1)).toBeCloseTo(Math.exp(-0.5), 3)
    field.update(4, [], null, 220)
    expect(field.heatFor(1)).toBeCloseTo(Math.exp(-1), 3)
    // Two 4 s steps equal one 8 s step: the decay is a pure function of time.
    const other = new PlasmaField()
    other.applySettings({ decay: 8 })
    other.touch(1, 500)
    other.update(8, [], null, 220)
    expect(field.heatFor(1)).toBeCloseTo(other.heatFor(1), 6)

    // A shorter decay time forgets activity faster.
    other.applySettings({ decay: 2 })
    other.update(4, [], null, 220)
    expect(other.heatFor(1)).toBeCloseTo(Math.exp(-1) * Math.exp(-2), 3)

    // After long enough the entry is pruned entirely (heat 0).
    field.update(200, [], null, 220)
    expect(field.heatFor(1)).toBe(0)
    field.dispose()
    other.dispose()
  })

  it('starts empty and forgets every file when the history is rebuilt', () => {
    const field = new PlasmaField()
    const nodes = [node(1), node(2)]
    field.touch(1, 100)
    field.touch(2, 100)
    field.sync(nodes, false, [1, 2])
    expect(field.stats.heat).toBe(2)
    field.reset()
    expect(field.stats.heat).toBe(0)
    expect(field.heatFor(1)).toBe(0)
    expect(field.stats.sources).toBe(0)
    field.dispose()
  })

  it('prunes heat for nodes that no longer exist on a full sync', () => {
    const field = new PlasmaField()
    // Simulation node id = array index, as in the sim (so a full sync can
    // resolve a heat entry to its node).
    const nodes: SimNode[] = []
    nodes[1] = node(1)
    nodes[2] = node(2)
    field.touch(1, 100)
    field.touch(2, 100)
    const remaining: SimNode[] = []
    remaining[1] = nodes[1]
    field.sync(remaining, true)
    expect(field.heatFor(1)).toBeGreaterThan(0)
    expect(field.heatFor(2)).toBe(0)
    field.dispose()
  })
})

describe('PlasmaField sources', () => {
  it('selects only the hottest K files for the field', () => {
    const field = new PlasmaField()
    const nodes: SimNode[] = []
    for (let id = 1; id <= 80; id += 1) {
      nodes.push(node(id, { position: { x: id * 2, y: 0, z: 0 } }))
      // Strength rises with the id, so the heat (0.4004…0.432) rises too.
      field.touch(id, id * 0.05)
    }
    field.update(1 / 60, nodes, null, 220)
    const stats = field.stats
    expect(stats.sources).toBe(MAX_PLASMA_SOURCES)
    // Hottest first: file 80 is at 1, file 17 is the coldest of the kept ones.
    expect(stats.sourceIds[0]).toBe(80)
    expect(stats.sourceIds[MAX_PLASMA_SOURCES - 1]).toBe(17)
    field.dispose()
  })

  it('omits files with no heat and hidden files entirely', () => {
    const field = new PlasmaField()
    const nodes = [
      node(1, { position: { x: 0, y: 0, z: 0 } }),
      node(2, { position: { x: 20, y: 0, z: 0 } }),
      node(3, { position: { x: -20, y: 0, z: 0 }, visible: false }),
      node(4, { kind: 'dir', path: 'src', name: 'src', position: { x: 5, y: 0, z: 0 } }),
    ]
    field.touch(1, 100)
    field.touch(3, 100)
    field.touch(4, 100)
    field.update(1 / 60, nodes, null, 220)
    // File 1 is hot, file 2 was never touched, file 3 is hidden and 4 is a
    // directory: only file 1 contributes.
    expect(field.stats.sourceIds).toEqual([1])
    field.dispose()
  })

  it('scatters a metaball around a hot file and nothing at a cold one', () => {
    const field = new PlasmaField()
    const hot = node(1, { position: { x: 0, y: 0, z: 0 } })
    const cold = node(2, { position: { x: 60, y: 0, z: 0 } })
    const nodes = [hot, cold]
    field.touch(1, 100)
    field.update(1 / 60, nodes, null, 220)
    // The density peaks at the file and falls off to zero at the blob radius.
    expect(field.sampleField(0, 0)).toBeGreaterThan(0.5)
    expect(field.sampleField(60, 0)).toBe(0)

    // Moving the file and re-running the field moves the density with it.
    hot.position.x = 30
    field.update(1 / 60, nodes, null, 220)
    expect(field.sampleField(30, 0)).toBeGreaterThan(0.5)
    field.dispose()
  })

  it('produces an empty texture when no file has heat', () => {
    const field = new PlasmaField()
    const nodes = [node(1), node(2)]
    field.update(1 / 60, nodes, null, 220)
    expect(field.stats.sources).toBe(0)
    const { texture } = internals(field)
    // The texture was written (a version bump) even though nothing is in it.
    expect(texture.version).toBeGreaterThan(0)
    const data = (texture.image as { data: Uint8Array }).data
    let nonZero = 0
    for (const value of data) if (value > 0) nonZero += 1
    expect(nonZero).toBe(0)
    expect(field.stats.visible).toBe(false)
    field.dispose()
  })
})

describe('PlasmaField material and ordering', () => {
  it('renders as an additive, depth-tested quad after the circles and before the particles', () => {
    const field = new PlasmaField()
    const { mesh, material } = internals(field)
    expect(material.transparent).toBe(true)
    expect(material.blending).toBe(THREE.AdditiveBlending)
    expect(material.depthWrite).toBe(false)
    expect(material.depthTest).toBe(true)
    expect(material.vertexShader).toContain('vec4(position.xy, 1.0, 1.0)')
    expect(mesh.frustumCulled).toBe(false)

    // After the opaque layers (branch lines, file and directory circles), so
    // the depth test can clip the volume against their silhouettes …
    expect(PLASMA_RENDER_ORDER).toBeGreaterThan(new EdgeField(4).lines.renderOrder)
    const nodes = new NodeField({ maxFiles: 4, maxDirs: 4, colorMode: 'extension' })
    expect(PLASMA_RENDER_ORDER).toBeGreaterThan(2)
    expect(PLASMA_RENDER_ORDER).toBeGreaterThan(3)
    // … and before every later transparent one (particles, beams, avatars,
    // labels), so those stay on top of the plasma.
    expect(PLASMA_RENDER_ORDER).toBeLessThan(new ParticleField(8).points.renderOrder)
    expect(PLASMA_RENDER_ORDER).toBeLessThan(new BeamField(4).mesh.renderOrder)
    expect(PLASMA_RENDER_ORDER).toBeLessThan(20)
    expect(PLASMA_RENDER_ORDER).toBeLessThan(30)
    expect(mesh.renderOrder).toBe(PLASMA_RENDER_ORDER)

    nodes.dispose()
    field.dispose()
  })

  it('hides the volume while the toggle is off or the intensity is 0', () => {
    const field = new PlasmaField()
    const nodes = [node(1, { position: { x: 0, y: 0, z: 0 } })]
    field.touch(1, 100)
    field.update(1 / 60, nodes, null, 220)
    expect(field.stats.visible).toBe(true)

    field.setEnabled(false)
    expect(field.stats.visible).toBe(false)
    field.update(1 / 60, nodes, null, 220)
    expect(field.stats.visible).toBe(false)

    field.setEnabled(true)
    field.update(1 / 60, nodes, null, 220)
    expect(field.stats.visible).toBe(true)
    field.applySettings({ intensity: 0 })
    expect(field.stats.visible).toBe(false)
    field.dispose()
  })

  it('hides the volume when the opacity is 0', () => {
    const field = new PlasmaField()
    const nodes = [node(1, { position: { x: 0, y: 0, z: 0 } })]
    field.touch(1, 100)
    field.update(1 / 60, nodes, null, 220)
    expect(field.stats.visible).toBe(true)

    // A zero opacity contributes nothing: skip the volume entirely.
    field.applySettings({ opacity: 0 })
    expect(field.stats.visible).toBe(false)
    field.update(1 / 60, nodes, null, 220)
    expect(field.stats.visible).toBe(false)

    // Restoring any opacity brings it back (the heat is still there).
    field.applySettings({ opacity: 0.5 })
    field.update(1 / 60, nodes, null, 220)
    expect(field.stats.visible).toBe(true)
    field.dispose()
  })

  it('clamps every setting to its documented range', () => {
    const field = new PlasmaField()
    const { material } = internals(field)
    field.applySettings({
      intensity: 99,
      opacity: 5,
      sharpness: 0,
      weight: -3,
      radius: 12,
      decay: 0,
      height: 100,
      steps: 1000,
    })
    const settings = (field as unknown as { settings: typeof DEFAULT_PLASMA_SETTINGS }).settings
    expect(settings).toEqual({
      intensity: 2,
      opacity: 1,
      sharpness: 1,
      weight: 0,
      radius: 3,
      decay: 1,
      height: 4,
      steps: 96,
    })
    expect(material.uniforms.uSharpness.value).toBe(1)
    expect(material.uniforms.uWeight.value).toBe(0)
    expect(material.uniforms.uSteps.value).toBe(96)
    expect(material.uniforms.uOpacity.value).toBe(1)

    // Non-finite input keeps the previous value instead of poisoning the field.
    field.applySettings({ intensity: Number.NaN })
    expect(settings.intensity).toBe(2)
    field.dispose()
  })

  it('clamps the opacity to 0…1 and writes it to the shader uniform', () => {
    const field = new PlasmaField()
    const { material } = internals(field)
    expect(material.uniforms.uOpacity.value).toBe(DEFAULT_PLASMA_SETTINGS.opacity)

    field.applySettings({ opacity: 99 })
    expect(material.uniforms.uOpacity.value).toBe(1)
    field.applySettings({ opacity: -1 })
    expect(material.uniforms.uOpacity.value).toBe(0)
    field.applySettings({ opacity: 0.25 })
    expect(material.uniforms.uOpacity.value).toBe(0.25)
    field.dispose()
  })

  it('keeps the furthest default settings inside their limits', () => {
    for (const [key, [min, max]] of Object.entries({
      intensity: [0, 2],
      opacity: [0, 1],
      sharpness: [1, 8],
      weight: [0, 2],
      radius: [0.5, 3],
      decay: [1, 30],
      height: [0.5, 4],
      steps: [8, 96],
    })) {
      const value = DEFAULT_PLASMA_SETTINGS[key as keyof typeof DEFAULT_PLASMA_SETTINGS]
      expect(value).toBeGreaterThanOrEqual(min)
      expect(value).toBeLessThanOrEqual(max)
    }
  })
})

describe('PlasmaField audio colour', () => {
  it('follows the shared activity tint exactly', () => {
    const field = new PlasmaField()
    const { material } = internals(field)
    const color = material.uniforms.uColor.value as THREE.Color
    const base = color.clone()

    const audio = { bass: 1, low: 0, mid: 0, voice: 0, clap: 0, clapCount: 0 }
    field.applyAudio(audio)
    // `activityTint` is the single source of truth for the plasma colour: the
    // directory colour scaled by the intensity and the bass gain, with the hue
    // rotated by the bass.
    const expected = activityTint(DEFAULT_PLASMA_SETTINGS.intensity, audio)
    expect(color.r).toBeCloseTo(expected.r, 6)
    expect(color.g).toBeCloseTo(expected.g, 6)
    expect(color.b).toBeCloseTo(expected.b, 6)
    expect(color.getHex()).not.toBe(base.getHex())

    // When the track stops, the static tint comes back.
    field.applyAudio(null)
    expect(color.getHex()).toBe(base.getHex())
    field.dispose()
  })

  it('bakes the intensity into the shader colour', () => {
    const field = new PlasmaField()
    const { material } = internals(field)
    const color = material.uniforms.uColor.value as THREE.Color
    field.applySettings({ intensity: 0.5 })
    expect(color.r).toBeCloseTo(DIR_COLOR.r * 0.5, 6)
    field.dispose()
  })
})

describe('PlasmaField robustness', () => {
  it('handles zero nodes and zero heat without crashing', () => {
    const field = new PlasmaField()
    field.sync([], true)
    field.update(1 / 60, [], null, 0)
    expect(field.stats).toEqual({ sources: 0, sourceIds: [], heat: 0, visible: false })
    field.update(0, [], undefined, 220)
    field.applyAudio(null)
    field.dispose()
  })

  it('keeps the camera matrices current for the ray reconstruction', () => {
    const field = new PlasmaField()
    const nodes = [node(1, { position: { x: 0, y: 0, z: 0 } })]
    field.touch(1, 100)
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 1000)
    camera.position.set(40, 30, 60)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    camera.updateProjectionMatrix()
    field.update(1 / 60, nodes, camera, 220)
    const { material } = internals(field)
    expect((material.uniforms.uCameraMatrix.value as THREE.Matrix4).elements).toEqual(
      expect.arrayContaining([...camera.matrixWorld.elements]),
    )
    expect((material.uniforms.uProjectionInverse.value as THREE.Matrix4).elements).toEqual(
      expect.arrayContaining([...camera.projectionMatrixInverse.elements]),
    )
    expect((material.uniforms.uOrigin.value as THREE.Vector3).distanceTo(camera.position)).toBeLessThan(1e-9)
    field.dispose()
  })

  /**
   * While presenting, three draws the plasma quad once per eye with the eye
   * camera, whose pose is in room coordinates while the volume is in the
   * tabletop's frame. The hook must map the eye into that frame and use the
   * eye's own (asymmetric) projection, otherwise the volume lands in the wrong
   * place — and slightly differently in each eye.
   */
  it('reconstructs the headset ray in the tabletop frame, per eye', () => {
    const field = new PlasmaField()
    const nodes = [node(1, { position: { x: 10, y: 4, z: 0 } })]
    field.touch(1, 100)
    field.sync(nodes, true)
    field.update(1 / 60, nodes, null, 220)

    // The VR framing scales, tips and moves the tabletop group into the room.
    const tabletop = new THREE.Group()
    tabletop.position.set(-0.5, 0.25, -1.5)
    tabletop.rotation.set(Math.PI / 2, 0, 0)
    tabletop.scale.setScalar(0.01)
    tabletop.add(field.group)
    tabletop.updateMatrixWorld(true)

    const centre = field.volume.center.clone()
    const roomCentre = tabletop.localToWorld(centre.clone())
    const eye = (offset: number, asymmetric: boolean): THREE.PerspectiveCamera => {
      const camera = new THREE.PerspectiveCamera()
      camera.position.copy(roomCentre).add(new THREE.Vector3(0, 0.1, 0.9))
      camera.position.x += offset
      camera.lookAt(roomCentre)
      if (asymmetric) {
        // A stereo eye sees an off-centre frustum, like WebXR's per-view matrix.
        camera.projectionMatrix.makePerspective(-0.05 + offset, 0.05 + offset, 0.04, -0.04, 0.1, 100)
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
      } else {
        camera.updateProjectionMatrix()
      }
      camera.updateMatrixWorld()
      return camera
    }
    const matrixClose = (actual: THREE.Matrix4, expected: THREE.Matrix4): void => {
      for (let i = 0; i < 16; i += 1) expect(actual.elements[i]).toBeCloseTo(expected.elements[i], 9)
    }

    const { mesh, material } = internals(field)
    const draw = (camera: THREE.Camera): void => {
      mesh.onBeforeRender(
        null as unknown as THREE.WebGLRenderer,
        tabletop as unknown as THREE.Scene,
        camera,
        mesh.geometry,
        mesh.material as THREE.Material,
        field.group,
      )
    }
    const left = eye(-0.032, false)
    draw(left)

    const tabletopInverse = new THREE.Matrix4().copy(tabletop.matrixWorld).invert()
    const expected = new THREE.Vector3()
      .setFromMatrixPosition(left.matrixWorld)
      .applyMatrix4(tabletopInverse)
    const origin = (material.uniforms.uOrigin.value as THREE.Vector3).clone()
    expect(origin.distanceTo(expected)).toBeLessThan(1e-9)
    matrixClose(material.uniforms.uCameraMatrix.value as THREE.Matrix4, tabletopInverse.clone().multiply(left.matrixWorld))
    matrixClose(material.uniforms.uProjectionInverse.value as THREE.Matrix4, left.projectionMatrixInverse)

    // The centre pixel reconstructs a ray that hits the volume, not the room.
    const farPoint = new THREE.Vector4(0, 0, 1, 1).applyMatrix4(
      material.uniforms.uProjectionInverse.value as THREE.Matrix4,
    )
    farPoint.divideScalar(farPoint.w)
    const direction = new THREE.Vector3(farPoint.x, farPoint.y, farPoint.z).transformDirection(
      material.uniforms.uCameraMatrix.value as THREE.Matrix4,
    )
    expect(direction.dot(centre.clone().sub(origin).normalize())).toBeGreaterThan(0.999)

    // The second eye gets its own projection, not the first eye's or the union.
    const right = eye(0.032, true)
    draw(right)
    matrixClose(material.uniforms.uProjectionInverse.value as THREE.Matrix4, right.projectionMatrixInverse)
    expect((material.uniforms.uOrigin.value as THREE.Vector3).distanceTo(origin)).toBeGreaterThan(1e-6)
    field.dispose()
  })

  it('scales the volume with the camera height and the settings', () => {
    const field = new PlasmaField()
    const nodes = [node(1, { position: { x: 0, y: 0, z: 0 } })]
    field.touch(1, 100)
    field.update(1 / 60, nodes, null, 100)
    const near = field.volume
    field.update(1 / 60, nodes, null, 400)
    const far = field.volume
    expect(far.half.x).toBeGreaterThan(near.half.x)
    expect(far.halfZ).toBeGreaterThan(near.halfZ)

    field.applySettings({ height: 0.5 })
    field.update(1 / 60, nodes, null, 400)
    expect(field.volume.halfZ).toBeLessThan(far.halfZ)
    field.dispose()
  })

  it('releases the geometry, material and texture on dispose', () => {
    const field = new PlasmaField()
    const { mesh, material, geometry, texture } = internals(field)
    expect(mesh.parent).toBe(field.group)
    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')
    const textureDispose = vi.spyOn(texture, 'dispose')
    field.dispose()
    expect(geometryDispose).toHaveBeenCalledTimes(1)
    expect(materialDispose).toHaveBeenCalledTimes(1)
    expect(textureDispose).toHaveBeenCalledTimes(1)
    expect(field.group.children).toHaveLength(0)
  })
})
