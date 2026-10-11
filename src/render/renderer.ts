import * as THREE from 'three'
import type { ChangeKind } from '../timeline/types'
import type { SimEvent, SimNode, Simulation } from '../sim/simulation'
import { NodeField, type FileColorMode } from './nodes'
import { EdgeField } from './edges'
import { ParticleField } from './particles'
import { AuthorField } from './authors'
import { BeamField } from './beams'
import { LabelField } from './labels'
import { Camera2D } from './camera'
import { backgroundColor, DIR_COLOR, GRID_COLOR } from './palette'

export interface RendererSettings {
  fileColorMode: FileColorMode
  showEdges: boolean
  edgeOpacity: number
  showDirs: boolean
  /** Multiplier for file circle radii. */
  radiusScale: number
  /** 0 disables particles entirely. */
  particleIntensity: number
  showLabels: boolean
  showDirectoryLabels: boolean
  showFileLabels: boolean
  /** Append host-reported sizes to file labels. */
  showFileSizes: boolean
  showAuthorNames: boolean
  showAuthorGlow: boolean
  authorScale: number
  /** Faint background grid (helps with panning/zooming in 2D). */
  showGrid: boolean
  gridSpacing: number
  /** Beams from an author to the files it just changed (Gource tethers). */
  showBeams: boolean
  beamIntensity: number
  /** Beam width in CSS pixels. */
  beamWidth: number
}

export const DEFAULT_RENDERER_SETTINGS: RendererSettings = {
  fileColorMode: 'extension',
  showEdges: true,
  edgeOpacity: 0.5,
  showDirs: true,
  radiusScale: 1,
  particleIntensity: 1,
  showLabels: true,
  showDirectoryLabels: true,
  showFileLabels: true,
  showFileSizes: true,
  showAuthorNames: true,
  showAuthorGlow: true,
  authorScale: 1,
  showGrid: true,
  gridSpacing: 40,
  showBeams: true,
  beamIntensity: 1.15,
  beamWidth: 3.2,
}

const MAX_PARTICLES = 9000
const MAX_LABELS = 120
const MAX_AUTHORS = 72
const INITIAL_FILE_CAPACITY = 6000
const INITIAL_DIR_CAPACITY = 900
/** Minimum on-screen height of an avatar, in CSS pixels. */
const MIN_AVATAR_PIXELS = 26

export interface SceneRendererOptions {
  maxFiles?: number
  maxDirs?: number
  label?: string
}

/**
 * The 2D WebGL scene: flat file circles, directory rings, branch edges,
 * activity particles, author avatars, labels and the background grid.
 *
 * Everything lives on the XY plane and is viewed through an orthographic
 * camera, so there is no perspective, no fog and no depth sorting. The renderer
 * reacts to {@link SimEvent}s and to full-sync requests after a seek, which
 * keeps playback and scrubbing identical.
 */
export class SceneRenderer {
  readonly scene = new THREE.Scene()
  readonly gl: THREE.WebGLRenderer
  private canvas: HTMLCanvasElement
  private nodes: NodeField
  private edges: EdgeField
  private particles: ParticleField
  private authors: AuthorField
  private beams: BeamField
  private labels: LabelField
  private background: THREE.Mesh
  private grid: THREE.Mesh
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

    this.background = this.createBackground()
    this.scene.add(this.background)
    this.grid = this.createGrid()
    this.scene.add(this.grid)

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
    this.beams = new BeamField()

    this.scene.add(this.edges.lines)
    this.scene.add(this.beams.mesh)
    this.scene.add(this.nodes.group)
    this.scene.add(this.particles.points)
    this.scene.add(this.authors.group)
    this.scene.add(this.labels.group)

    this.applySettings(this.settings)
  }

  get domElement(): HTMLCanvasElement {
    return this.canvas
  }

  get info(): { liveParticles: number; nodeStats: { files: number; dirs: number }; beams: number } {
    return {
      liveParticles: this.particles.liveCount,
      nodeStats: this.nodes.stats,
      beams: this.beams.segmentCount,
    }
  }

  /** Flat vertical gradient, sized to the viewport every frame. */
  private createBackground(): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(1, 1)
    const material = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x0a1024) },
        uBottom: { value: new THREE.Color(0x03040a) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uBottom;
        varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(mix(uBottom, uTop, vUv.y), 1.0);
        }
      `,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = -20
    return mesh
  }

  /** Grid that follows the camera so panning and zooming stay readable. */
  private createGrid(): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(1, 1)
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uColor: { value: GRID_COLOR },
        uSpacing: { value: this.settings.gridSpacing },
        uOpacity: { value: 0.5 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xy;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uSpacing;
        uniform float uOpacity;
        varying vec2 vWorld;
        void main() {
          vec2 cell = abs(fract(vWorld / uSpacing - 0.5) - 0.5) * uSpacing;
          float line = 1.0 - smoothstep(0.0, 0.8, min(cell.x, cell.y));
          if (line <= 0.001) discard;
          gl_FragColor = vec4(uColor, line * uOpacity);
        }
      `,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = -19
    return mesh
  }

  applySettings(settings: Partial<RendererSettings>): void {
    const previous = this.settings
    this.settings = { ...previous, ...settings }
    this.nodes.setColorMode(this.settings.fileColorMode, this.pendingNodes ?? [])
    this.nodes.setRadiusScale(this.settings.radiusScale)
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
    this.grid.visible = this.settings.showGrid
    this.beams.setEnabled(this.settings.showBeams)
    this.beams.setIntensity(this.settings.beamIntensity)
    this.beams.setWidthPixels(this.settings.beamWidth)
    const gridMaterial = this.grid.material as THREE.ShaderMaterial
    gridMaterial.uniforms.uSpacing.value = this.settings.gridSpacing

    if (
      previous.fileColorMode !== this.settings.fileColorMode ||
      previous.showDirs !== this.settings.showDirs ||
      previous.radiusScale !== this.settings.radiusScale
    ) {
      this.fullSyncPending = true
    }
  }

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
    this.particles.setPixelRatio(pixelRatio)
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
    void now
    const nodes = sim.nodes
    const simTime = sim.currentTime
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
          this.nodes.touch(event.node.id, event.kind, simTime)
          this.edges.touch(event.node.id, event.kind, simTime)
          this.particles.burst(event.node.position, event.kind, event.strength, event.node.radius)
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

  /** Advance animations. The camera drives the projection-dependent sizes. */
  update(dt: number, now: number, sim: Simulation, camera: Camera2D): void {
    const nodes = sim.nodes
    const simTime = sim.currentTime
    this.pendingNodes = nodes

    // Nodes easing towards a new layout position (dynamic file rings).
    const moved = sim.drainMovedNodes()
    if (moved.length > 0 && !this.fullSyncPending) {
      this.nodes.sync(nodes, false, moved)
      this.edges.sync(nodes, false, moved)
    }
    this.nodes.update(simTime, nodes)
    this.edges.update(simTime, nodes)
    this.particles.update(dt)

    // Keep the background and grid covering the visible area.
    const viewHeight = camera.viewHeight
    const viewWidth = viewHeight * (this.size.width / this.size.height)
    this.background.scale.set(viewWidth, viewHeight, 1)
    this.background.position.set(camera.center2D.x, camera.center2D.y, -5)
    this.grid.scale.set(viewWidth, viewHeight, 1)
    this.grid.position.set(camera.center2D.x, camera.center2D.y, -4)

    const authors = [...sim.authors]
    const worldPerPixel = camera.worldPerPixel(this.size.height)
    this.authors.sync(authors, worldPerPixel * MIN_AVATAR_PIXELS)

    // Beams from each author to the files of the current commit.
    this.beams.update(simTime, authors, nodes, worldPerPixel)

    // Trail particles for avatars that are travelling.
    for (const { author, color } of this.authors.movingAvatars(authors)) {
      const last = this.trailCooldown.get(author.author.id) ?? 0
      if (now - last < 0.05) continue
      this.trailCooldown.set(author.author.id, now)
      this.particles.trail({ x: author.position.x, y: author.position.y + 1.4, z: 0 }, color)
    }
    if (this.trailCooldown.size > 256) {
      for (const [id, time] of this.trailCooldown) if (now - time > 5) this.trailCooldown.delete(id)
    }

    this.labels.update(
      dt,
      camera.camera,
      camera.focusPoint,
      nodes,
      sim.currentIndex,
      {
        enabled: this.settings.showLabels,
        directories: this.settings.showDirectoryLabels,
        files: this.settings.showFileLabels,
        fileSizes: this.settings.showFileSizes,
        maxLabels: MAX_LABELS,
        pixelHeight: 13,
      },
      { width: this.size.width, height: this.size.height, worldPerPixel },
    )
  }

  render(camera: THREE.Camera): void {
    if (this.disposed) return
    this.gl.render(this.scene, camera)
  }

  /** Diagnostics for the beam layer. */
  beamSample(): Record<string, number> | null {
    return this.beams.sample()
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
    this.beams.dispose()
    this.labels.dispose()
    this.background.geometry.dispose()
    ;(this.background.material as THREE.Material).dispose()
    this.grid.geometry.dispose()
    ;(this.grid.material as THREE.Material).dispose()
    this.scene.clear()
    this.gl.dispose()
  }
}

/** Colour a directory node should use (exposed for the minimap). */
export function directoryColor(): THREE.Color {
  return DIR_COLOR
}

export type { ChangeKind }
