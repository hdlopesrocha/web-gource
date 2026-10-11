import * as THREE from 'three'
import type { ChangeKind } from '../timeline/types'
import type { SimEvent, SimNode, Simulation } from '../sim/simulation'
import { NodeField, type FileColorMode } from './nodes'
import { EdgeField } from './edges'
import { ParticleField, projectionScaleFor } from './particles'
import { AuthorField } from './authors'
import { LabelField } from './labels'
import { backgroundColor, DIR_COLOR, fogColor } from './palette'

export interface RendererSettings {
  fileColorMode: FileColorMode
  showEdges: boolean
  edgeOpacity: number
  showDirs: boolean
  /** Multiplier for file node size. */
  fileSize: number
  /** 0 disables particles entirely. */
  particleIntensity: number
  showLabels: boolean
  showDirectoryLabels: boolean
  showFileLabels: boolean
  showAuthorNames: boolean
  showAuthorGlow: boolean
  authorScale: number
  showStars: boolean
  fogDensity: number
}

export const DEFAULT_RENDERER_SETTINGS: RendererSettings = {
  fileColorMode: 'extension',
  showEdges: true,
  edgeOpacity: 0.45,
  showDirs: true,
  fileSize: 1,
  particleIntensity: 1,
  showLabels: true,
  showDirectoryLabels: true,
  showFileLabels: true,
  showAuthorNames: true,
  showAuthorGlow: true,
  authorScale: 1,
  showStars: true,
  fogDensity: 0.0011,
}

const MAX_PARTICLES = 9000
const MAX_LABELS = 110
const MAX_AUTHORS = 72
/** Node capacities are grown on demand, these are the initial allocations. */
const INITIAL_FILE_CAPACITY = 6000
const INITIAL_DIR_CAPACITY = 900

export interface SceneRendererOptions {
  maxFiles?: number
  maxDirs?: number
  /** Labelled scene for easier debugging of multiple canvases. */
  label?: string
}

/**
 * The WebGL scene: instanced tree nodes, branch edges, activity particles,
 * author avatars, labels and the background.
 *
 * The renderer owns no state that the simulation can produce itself — it reacts
 * to {@link SimEvent}s and to full-sync requests after a seek, which keeps
 * playback and scrubbing identical.
 */
export class SceneRenderer {
  readonly scene = new THREE.Scene()
  readonly gl: THREE.WebGLRenderer
  private canvas: HTMLCanvasElement
  private nodes: NodeField
  private edges: EdgeField
  private particles: ParticleField
  private authors: AuthorField
  private labels: LabelField
  private background: THREE.Mesh
  private stars: THREE.Points
  private settings: RendererSettings = { ...DEFAULT_RENDERER_SETTINGS }
  private dirtyNodes = new Set<number>()
  private trailCooldown = new Map<string, number>()
  private disposed = false
  private size = { width: 1, height: 1, pixelRatio: 1 }
  private fullSyncPending = true
  private fileCapacity: number
  private dirCapacity: number

  constructor(canvas: HTMLCanvasElement, options: SceneRendererOptions = {}) {
    this.canvas = canvas
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    })
    if (options.label) this.gl.domElement.dataset['renderer'] = options.label
    this.gl.setClearColor(backgroundColor())
    this.gl.autoClear = true

    this.scene.fog = new THREE.FogExp2(fogColor().getHex(), this.settings.fogDensity)

    this.background = this.createBackground()
    this.scene.add(this.background)
    this.stars = this.createStars()
    this.scene.add(this.stars)

    this.fileCapacity = Math.max(INITIAL_FILE_CAPACITY, options.maxFiles ?? INITIAL_FILE_CAPACITY)
    this.dirCapacity = Math.max(INITIAL_DIR_CAPACITY, options.maxDirs ?? INITIAL_DIR_CAPACITY)
    this.nodes = new NodeField({
      maxFiles: this.fileCapacity,
      maxDirs: this.dirCapacity,
      colorMode: this.settings.fileColorMode,
    })
    this.edges = new EdgeField(this.fileCapacity + this.dirCapacity)
    this.particles = new ParticleField(MAX_PARTICLES)
    this.authors = new AuthorField(MAX_AUTHORS, {
      showNames: this.settings.showAuthorNames,
      showGlow: this.settings.showAuthorGlow,
      scale: this.settings.authorScale,
    })
    this.labels = new LabelField(MAX_LABELS)

    this.scene.add(this.edges.lines)
    this.scene.add(this.nodes.group)
    this.scene.add(this.particles.points)
    this.scene.add(this.authors.group)
    this.scene.add(this.labels.group)

    this.applySettings(this.settings)
  }

  get domElement(): HTMLCanvasElement {
    return this.canvas
  }

  get info(): { liveParticles: number; nodeStats: { files: number; dirs: number } } {
    return { liveParticles: this.particles.liveCount, nodeStats: this.nodes.stats }
  }

  private createBackground(): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(4000, 32, 16)
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x03040a) },
        uBottom: { value: new THREE.Color(0x0a1024) },
        uGlow: { value: new THREE.Color(0x14213d) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vPosition;
        void main() {
          vPosition = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uBottom;
        uniform vec3 uGlow;
        varying vec3 vPosition;
        void main() {
          vec3 direction = normalize(vPosition);
          float height = clamp(direction.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 color = mix(uBottom, uTop, pow(height, 0.85));
          float horizon = exp(-abs(direction.y) * 6.0);
          color += uGlow * horizon * 0.55;
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = -10
    return mesh
  }

  private createStars(): THREE.Points {
    const count = 1400
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    // Deterministic star field so screenshots and recordings are reproducible.
    let seed = 0x2f6e2b1
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    for (let index = 0; index < count; index += 1) {
      const theta = random() * Math.PI * 2
      const phi = Math.acos(2 * random() - 1)
      const radius = 1500 + random() * 1600
      positions[index * 3] = Math.sin(phi) * Math.cos(theta) * radius
      positions[index * 3 + 1] = Math.cos(phi) * radius * 0.75
      positions[index * 3 + 2] = Math.sin(phi) * Math.sin(theta) * radius
      const brightness = 0.25 + random() * 0.6
      colors[index * 3] = brightness * 0.85
      colors[index * 3 + 1] = brightness * 0.9
      colors[index * 3 + 2] = brightness
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const material = new THREE.PointsMaterial({
      size: 2.2,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      fog: false,
    })
    const points = new THREE.Points(geometry, material)
    points.frustumCulled = false
    points.renderOrder = -9
    return points
  }

  applySettings(settings: Partial<RendererSettings>): void {
    const previous = this.settings
    this.settings = { ...previous, ...settings }
    this.nodes.setColorMode(this.settings.fileColorMode, this.pendingNodes ?? [])
    this.nodes.setFileSizeScale(this.settings.fileSize)
    this.edges.setOpacity(this.settings.edgeOpacity)
    this.edges.lines.visible = this.settings.showEdges
    this.nodes.setDirsVisible(this.settings.showDirs, this.pendingNodes ?? [])
    this.particles.setEnabled(this.settings.particleIntensity > 0)
    this.particles.setIntensity(this.settings.particleIntensity)
    this.authors.setOptions({
      showNames: this.settings.showAuthorNames,
      showGlow: this.settings.showAuthorGlow,
      scale: this.settings.authorScale,
    })
    this.stars.visible = this.settings.showStars
    const fog = this.scene.fog as THREE.FogExp2 | null
    if (fog) fog.density = this.settings.fogDensity

    // Only instance colours/sizes/visibility need a full instance rewrite;
    // dragging a slider then stays cheap.
    if (
      previous.fileColorMode !== this.settings.fileColorMode ||
      previous.showDirs !== this.settings.showDirs ||
      previous.fileSize !== this.settings.fileSize
    ) {
      this.fullSyncPending = true
    }
  }

  /** Keep a reference to the node list so settings changes can resync it. */
  setNodes(nodes: readonly SimNode[]): void {
    this.pendingNodes = nodes
  }

  private pendingNodes: readonly SimNode[] | null = null

  get currentSettings(): RendererSettings {
    return this.settings
  }

  resize(width: number, height: number, pixelRatio: number): void {
    const safeWidth = Math.max(1, Math.floor(width))
    const safeHeight = Math.max(1, Math.floor(height))
    this.size = { width: safeWidth, height: safeHeight, pixelRatio }
    this.gl.setPixelRatio(pixelRatio)
    this.gl.setSize(safeWidth, safeHeight, false)
  }

  /**
   * Keep particle sizes physically consistent with the projection: a particle
   * with a given world-space size covers the same fraction of the screen at any
   * resolution or field of view.
   */
  updateEffectScale(camera: THREE.PerspectiveCamera): void {
    const heightPixels = this.size.height * this.size.pixelRatio
    this.particles.setProjectionScale(projectionScaleFor(heightPixels, camera.fov))
  }

  get viewport(): { width: number; height: number; pixelRatio: number } {
    return this.size
  }

  /** Force the next frame to rewrite every instance (after a seek or reload). */
  requestFullSync(): void {
    this.fullSyncPending = true
  }

  /** React to simulation events: update instances and spawn effects. */
  consumeEvents(sim: Simulation, now: number): void {
    const nodes = sim.nodes
    this.pendingNodes = nodes
    const events = sim.drainEvents()
    const full = sim.needsFullSync || this.fullSyncPending
    if (events.length === 0 && !full) return

    for (const event of events) {
      switch (event.type) {
        case 'node-added':
        case 'node-changed':
        case 'node-removed':
          this.dirtyNodes.add(event.node.id)
          break
        case 'activity': {
          this.dirtyNodes.add(event.node.id)
          this.nodes.touch(event.node.id, event.kind, now)
          this.edges.touch(event.node.id, event.kind, now)
          const radius = event.node.kind === 'file' ? 0.35 : 0.9
          this.particles.burst(event.node.position, event.kind, event.strength, radius)
          break
        }
        case 'author':
        case 'commit':
          break
      }
    }

    if (full) {
      this.nodes.sync(nodes, true)
      this.edges.sync(nodes, true)
      this.dirtyNodes.clear()
      sim.needsFullSync = false
      this.fullSyncPending = false
      return
    }

    this.nodes.sync(nodes, false, [...this.dirtyNodes])
    this.edges.sync(nodes, false, [...this.dirtyNodes])
    this.dirtyNodes.clear()
  }

  /** Advance animations. */
  update(dt: number, now: number, sim: Simulation, camera: THREE.PerspectiveCamera): void {
    const nodes = sim.nodes
    this.pendingNodes = nodes
    this.nodes.update(now, nodes)
    this.edges.update(now, nodes)
    this.particles.update(dt)

    const authors = [...sim.authors]
    this.authors.sync(authors)

    // Trail particles for avatars that are travelling.
    for (const { author, color } of this.authors.movingAvatars(authors)) {
      const last = this.trailCooldown.get(author.author.id) ?? 0
      if (now - last < 0.05) continue
      this.trailCooldown.set(author.author.id, now)
      this.particles.trail({ x: author.position.x, y: author.position.y + 1.4, z: author.position.z }, color)
    }
    if (this.trailCooldown.size > 256) {
      for (const [id, time] of this.trailCooldown) if (now - time > 5) this.trailCooldown.delete(id)
    }

    this.labels.update(
      dt,
      camera,
      camera.position,
      nodes,
      sim.currentIndex,
      {
        enabled: this.settings.showLabels,
        directories: this.settings.showDirectoryLabels,
        files: this.settings.showFileLabels,
        maxLabels: MAX_LABELS,
        pixelHeight: 13,
      },
      { width: this.size.width, height: this.size.height },
    )
  }

  render(camera: THREE.Camera): void {
    if (this.disposed) return
    this.gl.render(this.scene, camera)
  }

  /** Clear transient effects (seeking). */
  clearEffects(): void {
    this.particles.clear()
  }

  dispose(): void {
    this.disposed = true
    this.nodes.dispose()
    this.edges.dispose()
    this.particles.dispose()
    this.authors.dispose()
    this.labels.dispose()
    this.background.geometry.dispose()
    ;(this.background.material as THREE.Material).dispose()
    this.stars.geometry.dispose()
    ;(this.stars.material as THREE.Material).dispose()
    this.scene.clear()
    this.gl.dispose()
  }
}

/** Colour a directory node should use (exposed for the minimap). */
export function directoryColor(): THREE.Color {
  return DIR_COLOR
}

export type { ChangeKind }
