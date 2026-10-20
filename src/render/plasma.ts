import * as THREE from 'three'
import type { AudioLevels } from '../engine/audio/analysis'
import type { SimNode } from '../sim/simulation'
import { activityTint } from './palette'

/**
 * The plasma volume: a ray-marched density field that forms around the files
 * with the most recent activity.
 *
 * Every file carries a heat value in 0…1. `touch` bumps it on an activity
 * event, `update` decays it with the frame time, and the hottest files become
 * the metaball sources of the field: contribution strength and radius both
 * scale with heat, so a cold file contributes nothing and a hot one contributes
 * the full blob. The sum of the contributions is rasterized (scattered) into a
 * small CPU-side density texture each frame; the fragment shader marches the
 * slab that covers those sources and samples that texture, which keeps the
 * per-pixel cost bounded instead of looping over every file per march step.
 *
 * The mesh is a full-screen quad forced to the far plane
 * (`gl_Position = vec4(position.xy, 1.0, 1.0)`). It is drawn *after* the opaque
 * geometry (branch lines -1, file circles 2, directory rings 3), so the depth
 * test rejects it wherever those already wrote depth and their silhouettes clip
 * the volume instead of the glow washing over them. Every later transparent
 * layer (particles 10, beams 12, avatars 20/21, labels 30) still draws on top,
 * so files, folders, lines, labels and avatars stay above the plasma.
 *
 * `opacity` scales the fragment alpha; with additive blending the fragment
 * alpha is how much is added, so it dims the volume without changing its shape.
 * `1` is the old full strength, and `0` hides the volume entirely.
 */
export const PLASMA_RENDER_ORDER = 4

/** Largest number of file contributions that reach the density field. */
export const MAX_PLASMA_SOURCES = 64

/** March steps per pixel; the loop in the shader is capped at this. */
export const DEFAULT_PLASMA_STEPS = 48

/** Resolution of the CPU-side density texture (PLASMA_FIELD_SIZE² texels). */
export const PLASMA_FIELD_SIZE = 128

/** Blob radius, in world units, per unit of camera view height. */
export const PLASMA_RADIUS_SCALE = 0.08

/** Heat below this is pruned: it can no longer show up in the field. */
const HEAT_EPSILON = 0.002

/**
 * Heat a single activity event adds, given its change strength.
 *
 * Even a one-line edit leaves a small, visible blob (the minimum is above the
 * surface threshold in the shader); repeated or larger changes quickly build
 * towards a full-strength blob.
 */
export function heatBump(strength: number): number {
  const safe = Number.isFinite(strength) ? Math.max(0, strength) : 0
  return Math.min(1, Math.max(0.4, 0.4 + safe * 0.008))
}

export interface PlasmaSettings {
  /** Overall brightness multiplier. */
  intensity: number
  /** Opacity of the volume: scales how much it adds over the scene (0…1, `1` is full strength). */
  opacity: number
  /** Density threshold width: higher is a crisper surface (1…8). */
  sharpness: number
  /** Metaball strength: how much each contribution counts (0…2). */
  weight: number
  /** Blob radius multiplier (0.5…3). */
  radius: number
  /** Seconds for a heat value to fall to 1/e (1…30). */
  decay: number
  /** Volume height multiplier (0.5…4). */
  height: number
  /** March steps per pixel (8…96). */
  steps: number
}

export const DEFAULT_PLASMA_SETTINGS: PlasmaSettings = {
  intensity: 0.6,
  // Subtle by default: full strength (1) reads as a bright wash over the tree,
  // so the shipped default keeps the glow faint. 1 is the old full strength.
  opacity: 0.35,
  sharpness: 2,
  weight: 0.8,
  radius: 1,
  decay: 4,
  height: 1.5,
  steps: DEFAULT_PLASMA_STEPS,
}

/** Clamp ranges for the settings (also used by the tests). */
export const PLASMA_LIMITS: Record<keyof PlasmaSettings, readonly [number, number]> = {
  intensity: [0, 2],
  opacity: [0, 1],
  sharpness: [1, 8],
  weight: [0, 2],
  radius: [0.5, 3],
  decay: [1, 30],
  height: [0.5, 4],
  steps: [8, 96],
}

/** One file's contribution to the metaball field. */
export interface PlasmaSource {
  id: number
  x: number
  y: number
  /** World-space blob radius (heat-scaled). */
  radius: number
  heat: number
}

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // Force the far plane: the plasma only survives where nothing opaque has
    // written depth, and every transparent layer drawn after it stays on top.
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uField;
  uniform mat4 uProjectionInverse;
  uniform mat4 uCameraMatrix;
  uniform vec3 uCenter;
  uniform vec2 uHalf;
  uniform float uHalfZ;
  uniform float uWeight;
  uniform float uSharpness;
  uniform int uSteps;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;

  /** Density at which the plasma surface sits. */
  const float ISO = 0.34;
  const int MAX_STEPS = ${DEFAULT_PLASMA_STEPS};

  void main() {
    // Reconstruct the world-space ray through this pixel from the camera
    // matrices (the quad itself is in clip space).
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 farPoint = uProjectionInverse * vec4(ndc, 1.0, 1.0);
    farPoint /= farPoint.w;
    vec3 rayDirection = normalize((uCameraMatrix * vec4(farPoint.xyz, 0.0)).xyz);
    vec3 rayOrigin = cameraPosition;

    // Clip the ray against the volume box (the plasma height around the plane).
    vec3 boxMin = uCenter - vec3(uHalf, uHalfZ);
    vec3 boxMax = uCenter + vec3(uHalf, uHalfZ);
    vec3 invDir = 1.0 / rayDirection;
    vec3 tSmall = (boxMin - rayOrigin) * invDir;
    vec3 tLarge = (boxMax - rayOrigin) * invDir;
    vec3 tNear3 = min(tSmall, tLarge);
    vec3 tFar3 = max(tSmall, tLarge);
    float tNear = max(max(tNear3.x, tNear3.y), max(tNear3.z, 0.0));
    float tFar = min(min(tFar3.x, tFar3.y), tFar3.z);
    if (tFar <= tNear) discard;

    float stepLength = (tFar - tNear) / float(uSteps);
    float glow = 0.0;
    float empty = 0.0;
    for (int i = 0; i < MAX_STEPS; i++) {
      if (i >= uSteps) break;
      vec3 point = rayOrigin + rayDirection * (tNear + (float(i) + 0.5) * stepLength);
      // The density texture covers the volume's XY extent: it holds the sum of
      // every file's spherical metaball contribution (heat-weighted).
      vec2 uv = (point.xy - (uCenter.xy - uHalf)) / (2.0 * uHalf);
      float density = texture2D(uField, uv).r;
      if (density <= 0.004) {
        // Long empty stretch: nothing is ahead of this sample either.
        empty += 1.0;
        if (empty > 6.0) break;
        continue;
      }
      empty = 0.0;
      // Blobs are rounded: denser (bigger) areas also reach further vertically.
      float halfZ = max(0.001, uHalfZ * (0.25 + 0.75 * min(density, 1.0)));
      float z = (point.z - uCenter.z) / halfZ;
      float profile = 1.0 - z * z;
      if (profile <= 0.0) continue;
      glow = max(glow, density * profile * profile);
      // Stop once the brightest core is saturated: more marching cannot make it
      // brighter. Stopping at the surface instead would clip away the core.
      if (glow * uWeight >= ISO + (ISO / max(1.0, uSharpness)) * 4.0) break;
    }

    float weighted = glow * uWeight;
    // Sharpness narrows the threshold band, turning the soft cloud into a
    // surface with a defined edge.
    float band = ISO / max(1.0, uSharpness);
    float edge = smoothstep(ISO - band, ISO + band, weighted);
    // A faint halo around the surface makes the field read as a volume rather
    // than as a flat ring, without softening the surface itself.
    float haze = smoothstep(ISO * 0.12, ISO, weighted) * (1.0 - edge);
    // A brighter core inside the surface keeps the shape crisp instead of
    // reading as one uniform sheet of fog.
    float core = smoothstep(ISO + band, ISO + band * 4.0, weighted);
    float alpha = min(1.0, edge * (0.75 + 0.65 * core) + haze * 0.16);
    if (alpha <= 0.003) discard;
    // Additive blending adds src.rgb * src.a: scaling the alpha by the opacity
    // dims the whole volume without changing the shape it carves out.
    gl_FragColor = vec4(uColor * (0.3 + 0.7 * edge + 0.55 * core + 0.2 * haze), alpha * uOpacity);
  }
`

/** Diagnostics + test hooks for the field. */
export interface PlasmaStats {
  /** Number of file contributions in the current field. */
  sources: number
  /** File ids of those contributions, hottest first. */
  sourceIds: number[]
  /** Live heat entries (files decaying towards zero). */
  heat: number
  /** True while the volume is drawn. */
  visible: boolean
}

export class PlasmaField {
  readonly group = new THREE.Group()
  private mesh: THREE.Mesh
  private geometry: THREE.PlaneGeometry
  private material: THREE.ShaderMaterial
  private texture: THREE.DataTexture
  private fieldData: Uint8Array
  private fieldSize: number
  /** Heat per file node id, in 0…1. */
  private heat = new Map<number, number>()
  private sources: PlasmaSource[] = []
  private nodes: readonly SimNode[] = []
  private settings: PlasmaSettings = { ...DEFAULT_PLASMA_SETTINGS }
  private enabled = true
  private color = new THREE.Color()
  private audio: AudioLevels | null = null
  private audioActive = false
  /** Scratch used by the scatter rasterizer so no per-frame garbage is made. */
  private scratch: PlasmaSource[] = []
  private center = new THREE.Vector3()
  private half = new THREE.Vector2(1, 1)
  private halfZ = 1

  constructor(fieldSize = PLASMA_FIELD_SIZE) {
    this.fieldSize = Math.max(8, Math.floor(fieldSize))
    this.fieldData = new Uint8Array(this.fieldSize * this.fieldSize)
    this.texture = new THREE.DataTexture(
      this.fieldData,
      this.fieldSize,
      this.fieldSize,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    )
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.wrapS = THREE.ClampToEdgeWrapping
    this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.generateMipmaps = false
    this.texture.needsUpdate = true

    this.geometry = new THREE.PlaneGeometry(2, 2)
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
      uniforms: {
        uField: { value: this.texture },
        uProjectionInverse: { value: new THREE.Matrix4() },
        uCameraMatrix: { value: new THREE.Matrix4() },
        uCenter: { value: this.center },
        uHalf: { value: this.half },
        uHalfZ: { value: this.halfZ },
        uWeight: { value: this.settings.weight },
        uSharpness: { value: this.settings.sharpness },
        uSteps: { value: Math.round(this.settings.steps) },
        uColor: { value: this.color },
        uOpacity: { value: this.settings.opacity },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
    })

    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    // After the opaque layers (-1 edges, 2/3 circles), so the depth test clips
    // the volume against their silhouettes, and before every later transparent
    // one (10 particles, 12 beams, 20/21 avatars, 30 labels).
    this.mesh.renderOrder = PLASMA_RENDER_ORDER
    this.mesh.visible = false
    this.group.add(this.mesh)
    this.refreshColor()
  }

  get stats(): PlasmaStats {
    return {
      sources: this.sources.length,
      sourceIds: this.sources.map((source) => source.id),
      heat: this.heat.size,
      visible: this.mesh.visible,
    }
  }

  /** Current heat of a file (0 when it has none). */
  heatFor(nodeId: number): number {
    return this.heat.get(nodeId) ?? 0
  }

  /** The metaball sources of the current field, hottest first. */
  get plasmaSources(): readonly PlasmaSource[] {
    return this.sources
  }

  /**
   * Register activity on a file: the heat bump is weighted by the change
   * strength and clamped to 1.
   */
  touch(nodeId: number, strength = 1): void {
    const next = Math.min(1, (this.heat.get(nodeId) ?? 0) + heatBump(strength))
    this.heat.set(nodeId, next)
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.mesh.visible = enabled && this.sources.length > 0 && this.isDrawable()
  }

  applySettings(settings: Partial<PlasmaSettings>): void {
    const next = { ...this.settings }
    for (const key of Object.keys(next) as (keyof PlasmaSettings)[]) {
      const value = settings[key]
      if (value === undefined) continue
      const [min, max] = PLASMA_LIMITS[key]
      next[key] = Math.min(max, Math.max(min, Number.isFinite(value) ? value : this.settings[key]))
    }
    this.settings = next
    this.material.uniforms.uWeight.value = next.weight
    this.material.uniforms.uSharpness.value = next.sharpness
    this.material.uniforms.uSteps.value = Math.round(next.steps)
    this.material.uniforms.uOpacity.value = next.opacity
    this.mesh.visible = this.enabled && this.sources.length > 0 && this.isDrawable()
    this.refreshColor()
  }

  /** False when the settings make the volume invisible (brightness or opacity 0). */
  private isDrawable(): boolean {
    return this.settings.intensity > 0 && this.settings.opacity > 0
  }

  /**
   * Tint from the bass exactly like the folder glow: the hue rotates and the
   * brightness breathes with the low end.
   */
  applyAudio(audio: AudioLevels | null): void {
    if (!audio && !this.audioActive) return
    this.audioActive = audio !== null
    this.audio = audio
    this.refreshColor()
  }

  /** Bake the intensity and the audio modulation into the shader colour. */
  private refreshColor(): void {
    activityTint(this.settings.intensity, this.audio, this.color)
  }

  /**
   * Drop every contribution (a rebuilt history: node ids are per simulation).
   */
  reset(): void {
    this.heat.clear()
    this.sources = []
    this.nodes = []
    this.fieldData.fill(0)
    this.texture.needsUpdate = true
    this.mesh.visible = false
  }

  /** Keep the node list current; a full sync also prunes dead heat entries. */
  sync(nodes: readonly SimNode[], full: boolean, dirty?: readonly number[]): void {
    this.nodes = nodes
    if (full) {
      for (const id of [...this.heat.keys()]) {
        const node = nodes[id]
        if (!node || node.kind !== 'file') this.heat.delete(id)
      }
    }
    void dirty
  }

  /**
   * Decay the heat and rebuild the density field for this frame.
   *
   * `viewHeight` is the camera's visible world height at the orbit target (the
   * same scale the billboards compensate against), so the plasma keeps its
   * apparent size while zooming.
   */
  update(
    dt: number,
    nodes: readonly SimNode[] = this.nodes,
    camera?: THREE.Camera | null,
    viewHeight = 220,
  ): void {
    this.decayHeat(dt)
    const baseRadius = Math.max(0.5, viewHeight * PLASMA_RADIUS_SCALE)
    this.selectSources(nodes, baseRadius)
    if (!this.enabled || !this.isDrawable() || this.sources.length === 0) {
      this.mesh.visible = false
      return
    }
    this.computeVolume(baseRadius)
    this.rasterize(baseRadius)
    if (camera) {
      ;(this.material.uniforms.uProjectionInverse.value as THREE.Matrix4).copy(camera.projectionMatrixInverse)
      ;(this.material.uniforms.uCameraMatrix.value as THREE.Matrix4).copy(camera.matrixWorld)
    }
    ;(this.material.uniforms.uCenter.value as THREE.Vector3).copy(this.center)
    ;(this.material.uniforms.uHalf.value as THREE.Vector2).copy(this.half)
    this.material.uniforms.uHalfZ.value = this.halfZ
    this.mesh.visible = true
  }

  private decayHeat(dt: number): void {
    if (this.heat.size === 0) return
    const factor = Math.exp(-Math.max(0, dt) / this.settings.decay)
    for (const [id, value] of this.heat) {
      const next = value * factor
      if (next <= HEAT_EPSILON) this.heat.delete(id)
      else this.heat.set(id, next)
    }
  }

  /**
   * Pick the hottest visible files for the field.
   *
   * Only files with heat survive (heat 0 contributes nothing at all), and the
   * list is capped at {@link MAX_PLASMA_SOURCES} so the fragment work stays
   * bounded.
   */
  private selectSources(nodes: readonly SimNode[], baseRadius: number): void {
    const candidates = this.scratch
    candidates.length = 0
    for (const node of nodes) {
      if (node.kind !== 'file' || !node.visible) continue
      const heat = this.heat.get(node.id)
      if (heat === undefined || heat <= HEAT_EPSILON) continue
      // Radius and strength both grow with the heat: a cold file shrinks to
      // nothing instead of popping out of the field.
      candidates.push({
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        radius: baseRadius * this.settings.radius * (0.35 + 0.65 * heat),
        heat,
      })
    }
    if (candidates.length > MAX_PLASMA_SOURCES) {
      candidates.sort((a, b) => b.heat - a.heat)
      candidates.length = MAX_PLASMA_SOURCES
    }
    this.sources = candidates.slice()
  }

  /** Bounding box of the sources, expanded to a usable volume. */
  private computeVolume(baseRadius: number): void {
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const source of this.sources) {
      minX = Math.min(minX, source.x - source.radius)
      maxX = Math.max(maxX, source.x + source.radius)
      minY = Math.min(minY, source.y - source.radius)
      maxY = Math.max(maxY, source.y + source.radius)
    }
    const minHalf = Math.max(1, baseRadius * 0.6)
    const halfX = Math.max(minHalf, (maxX - minX) * 0.5)
    const halfY = Math.max(minHalf, (maxY - minY) * 0.5)
    this.center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, 0)
    this.half.set(halfX, halfY)
    this.halfZ = Math.max(0.5, baseRadius * this.settings.height * 0.5)
  }

  /** Scatter every source into the density texture (additive, clamped). */
  private rasterize(baseRadius: number): void {
    void baseRadius
    const size = this.fieldSize
    const data = this.fieldData
    data.fill(0)
    const minX = this.center.x - this.half.x
    const minY = this.center.y - this.half.y
    const texelX = (this.half.x * 2) / size
    const texelY = (this.half.y * 2) / size
    for (const source of this.sources) {
      const radius = Math.max(0.001, source.radius)
      const left = Math.max(0, Math.floor((source.x - radius - minX) / texelX))
      const right = Math.min(size - 1, Math.ceil((source.x + radius - minX) / texelX))
      const bottom = Math.max(0, Math.floor((source.y - radius - minY) / texelY))
      const top = Math.min(size - 1, Math.ceil((source.y + radius - minY) / texelY))
      const inverseRadiusSquared = 1 / (radius * radius)
      for (let ty = bottom; ty <= top; ty += 1) {
        const dy = minY + (ty + 0.5) * texelY - source.y
        const row = ty * size
        for (let tx = left; tx <= right; tx += 1) {
          const dx = minX + (tx + 0.5) * texelX - source.x
          const q = (dx * dx + dy * dy) * inverseRadiusSquared
          if (q >= 1) continue
          const falloff = 1 - q
          const value = falloff * falloff * falloff * source.heat
          const index = row + tx
          const next = data[index] + value * 255
          data[index] = next >= 255 ? 255 : next
        }
      }
    }
    this.texture.needsUpdate = true
  }

  /** Density of the current field at a world position (0…1); for diagnostics. */
  sampleField(x: number, y: number): number {
    const size = this.fieldSize
    const tx = Math.floor(((x - (this.center.x - this.half.x)) / (this.half.x * 2)) * size)
    const ty = Math.floor(((y - (this.center.y - this.half.y)) / (this.half.y * 2)) * size)
    if (tx < 0 || ty < 0 || tx >= size || ty >= size) return 0
    return this.fieldData[ty * size + tx] / 255
  }

  /** The volume currently covered by the density texture. */
  get volume(): { center: THREE.Vector3; half: THREE.Vector2; halfZ: number } {
    return { center: this.center.clone(), half: this.half.clone(), halfZ: this.halfZ }
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.texture.dispose()
    this.group.clear()
    this.heat.clear()
    this.sources = []
    this.scratch = []
  }
}
