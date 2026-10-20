import * as THREE from 'three'
import type { ChangeKind } from '../timeline/types'
import type { AudioLevels } from '../engine/audio/analysis'
import type { SimEvent, SimNode, Simulation } from '../sim/simulation'
import { EFFECT_Z, NodeField, type FileColorMode } from './nodes'
import { EdgeField } from './edges'
import { ParticleField } from './particles'
import { AuthorField } from './authors'
import { BeamField, type BeamStyle } from './beams'
import { PlasmaField, DEFAULT_PLASMA_STEPS } from './plasma'
import { LabelField } from './labels'
import { OrbitCamera } from './camera'
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
  /** How a beam is drawn: a head travelling to the element, or a solid ray. */
  beamStyle: BeamStyle
  /** Seconds the travelling head takes to cross a beam. */
  beamTravelSeconds: number
  beamIntensity: number
  /** Beam width in CSS pixels. */
  beamWidth: number
  /** Ray-marched plasma that forms around the files with the most activity. */
  showPlasma: boolean
  /** Overall plasma brightness (0 hides it). */
  plasmaIntensity: number
  /** Plasma opacity: how much the volume adds over the scene (0 hides it). */
  plasmaOpacity: number
  /** Crispness of the plasma surface. */
  plasmaSharpness: number
  /** Metaball weight: how much each file's contribution counts. */
  plasmaWeight: number
  /** Blob radius multiplier. */
  plasmaRadius: number
  /** Seconds for activity heat to fall to 1/e. */
  plasmaDecay: number
  /** Plasma volume height multiplier. */
  plasmaHeight: number
  /** Ray-march steps per pixel. */
  plasmaSteps: number
  /**
   * Draw files as real 3D spheres (instanced geometry with lighting) instead of
   * the camera-facing ball billboards. Implied while an immersive WebXR session
   * is running, where the flat billboards read as flat discs.
   */
  renderSpheres: boolean
}

export const DEFAULT_RENDERER_SETTINGS: RendererSettings = {
  fileColorMode: 'extension',
  showEdges: true,
  edgeOpacity: 0.6,
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
  beamStyle: 'travelling',
  beamTravelSeconds: 0.55,
  beamIntensity: 1.15,
  beamWidth: 3.2,
  showPlasma: true,
  plasmaIntensity: 0.5,
  plasmaOpacity: 1,
  plasmaSharpness: 2,
  plasmaWeight: 1,
  plasmaRadius: 1,
  plasmaDecay: 5,
  plasmaHeight: 1.5,
  plasmaSteps: DEFAULT_PLASMA_STEPS,
  renderSpheres: false,
}

/**
 * Depth stack of the scene along -Z:
 *
 *   grid -0.6 · branches 0 · nodes +0.25 · effects +0.5
 *
 * The background is now a full-screen gradient drawn independently of the
 * camera, so it does not need a world depth. The grid is a transparent overlay,
 * so it is drawn after the opaque circles; depth testing (not the render order)
 * is what keeps it behind the tree.
 */
export const GRID_Z = -0.6
/** Kept for callers that used to size a world-space backdrop. */
export const BACKGROUND_Z = -6

const MAX_PARTICLES = 9000
const MAX_LABELS = 160
// The same person appears once per project, so several projects multiply the
// number of author instances that must stay visible at once.
const MAX_AUTHORS = 120
const INITIAL_FILE_CAPACITY = 6000
const INITIAL_DIR_CAPACITY = 900
/** Minimum on-screen height of an avatar, in CSS pixels. */
const MIN_AVATAR_PIXELS = 26

export interface SceneRendererOptions {
  maxFiles?: number
  maxDirs?: number
  label?: string
  /**
   * Inject the WebGL renderer. Production leaves this unset and a three
   * `WebGLRenderer` is created; tests pass a stub, which is the only way to
   * exercise {@link SceneRenderer.applySettings} without a GL context.
   */
  gl?: THREE.WebGLRenderer
}

/**
 * Whether files should be drawn as real spheres.
 *
 * The user setting wins, and an immersive XR session forces them on: flat
 * billboards read as flat discs in a headset, where the depth cue is the whole
 * point.
 *
 * The flat top-down 2D view needs no special case: every node is at one view
 * depth there, so a sphere's world radius and a billboard's compensated radius
 * are the same number and the two modes differ only in shading.
 */
export function effectiveSphereMode(renderSpheres: boolean, xrPresenting: boolean): boolean {
  return renderSpheres || xrPresenting
}

/**
 * The 3D WebGL scene: file and directory billboards, branch edges, activity
 * particles, author avatars, labels and the background grid.
 *
 * The tree layout stays on the XY plane (as in Gource), but it is viewed
 * through a perspective orbit camera. Nodes are billboards facing the camera
 * with perspective-compensated scale, so their on-screen size stays fixed. The
 * renderer reacts to {@link SimEvent}s and to full-sync
 * requests after a seek, which keeps playback and scrubbing identical.
 */
export class SceneRenderer {
  readonly scene = new THREE.Scene()
  /**
   * The tabletop: every layer except the clip-space backdrop.
   *
   * Keeping it in one group is what lets an XR session move and scale the whole
   * tree into the room in front of the user, and put it back exactly afterwards.
   * With the identity transform (every normal frame) it is a transparent wrapper.
   */
  readonly world = new THREE.Group()
  readonly gl: THREE.WebGLRenderer
  private canvas: HTMLCanvasElement
  private nodes: NodeField
  private edges: EdgeField
  private particles: ParticleField
  private authors: AuthorField
  private beams: BeamField
  private labels: LabelField
  private plasma: PlasmaField
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
  /** Scratch camera for the headset pose, expressed in tabletop coordinates. */
  private readonly xrView = new THREE.PerspectiveCamera()
  private readonly worldInverse = new THREE.Matrix4()

  constructor(canvas: HTMLCanvasElement, options: SceneRendererOptions = {}) {
    this.canvas = canvas
    this.gl =
      options.gl ??
      new THREE.WebGLRenderer({
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
    this.scene.add(this.world)
    this.grid = this.createGrid()
    this.world.add(this.grid)

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
    this.plasma = new PlasmaField()

    this.world.add(this.edges.lines)
    this.world.add(this.beams.mesh)
    this.world.add(this.plasma.group)
    this.world.add(this.nodes.group)
    this.world.add(this.particles.points)
    this.world.add(this.authors.group)
    this.world.add(this.labels.group)

    this.applySettings(this.settings)
  }

  get domElement(): HTMLCanvasElement {
    return this.canvas
  }

  /** three's renderer: the frame loop and the WebXR manager live here. */
  get webgl(): THREE.WebGLRenderer {
    return this.gl
  }

  /**
   * The camera three poses from the headset while an XR session runs.
   *
   * Outside a session this is an unposed array camera, so callers must guard on
   * `renderer.xr.isPresenting` (see {@link update}).
   */
  get xrCamera(): THREE.Camera {
    return this.gl.xr.getCamera()
  }

  get info(): {
    liveParticles: number
    nodeStats: { files: number; dirs: number }
    beams: number
    plasma: { sources: number; heat: number; visible: boolean }
  } {
    return {
      liveParticles: this.particles.liveCount,
      nodeStats: this.nodes.stats,
      beams: this.beams.segmentCount,
      plasma: {
        sources: this.plasma.stats.sources,
        heat: this.plasma.stats.heat,
        visible: this.plasma.stats.visible,
      },
    }
  }

  /** Full-screen vertical gradient, independent of the camera orientation. */
  private createBackground(): THREE.Mesh {
    // A clip-space quad: the vertex shader bypasses the camera matrices, so the
    // backdrop fills the frame from every orbit angle.
    const geometry = new THREE.PlaneGeometry(2, 2)
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
          gl_Position = vec4(position.xy, 1.0, 1.0);
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

  /**
   * Grid that follows the camera so panning and zooming stay readable.
   *
   * It is a transparent overlay (the lines fade out), which means it is drawn in
   * the transparent pass *after* the opaque node circles. Depth testing is what
   * keeps it behind them: the circles are nearer to the camera and already wrote
   * depth, so the grid is rejected wherever a circle covers it. Without the
   * depth test the grid would be painted over the tree.
   */
  private createGrid(): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(1, 1)
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        uColor: { value: GRID_COLOR },
        uSpacing: { value: this.settings.gridSpacing },
        uOpacity: { value: 0.5 },
        // Grid lines far from the view centre are near the horizon in 3D and
        // would be stretched into broad wedges by perspective. Fade them out.
        uCenter: { value: new THREE.Vector2(0, 0) },
        uFade: { value: new THREE.Vector2(1, 2) },
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
        uniform vec2 uCenter;
        uniform vec2 uFade;
        varying vec2 vWorld;
        void main() {
          vec2 cell = abs(fract(vWorld / uSpacing - 0.5) - 0.5) * uSpacing;
          float line = 1.0 - smoothstep(0.0, 0.8, min(cell.x, cell.y));
          float fade = 1.0 - smoothstep(uFade.x, uFade.y, length(vWorld - uCenter));
          float alpha = line * uOpacity * fade;
          if (alpha <= 0.001) discard;
          gl_FragColor = vec4(uColor, alpha);
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
    this.nodes.setSphereMode(
      effectiveSphereMode(this.settings.renderSpheres, this.gl.xr.isPresenting),
      this.pendingNodes ?? [],
    )
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
    this.beams.setStyle(this.settings.beamStyle)
    this.beams.setTravelSeconds(this.settings.beamTravelSeconds)
    this.beams.setIntensity(this.settings.beamIntensity)
    this.beams.setWidthPixels(this.settings.beamWidth)
    this.plasma.setEnabled(this.settings.showPlasma)
    this.plasma.applySettings({
      intensity: this.settings.plasmaIntensity,
      opacity: this.settings.plasmaOpacity,
      sharpness: this.settings.plasmaSharpness,
      weight: this.settings.plasmaWeight,
      radius: this.settings.plasmaRadius,
      decay: this.settings.plasmaDecay,
      height: this.settings.plasmaHeight,
      steps: this.settings.plasmaSteps,
    })
    const gridMaterial = this.grid.material as THREE.ShaderMaterial
    gridMaterial.uniforms.uSpacing.value = this.settings.gridSpacing

    if (
      previous.fileColorMode !== this.settings.fileColorMode ||
      previous.showDirs !== this.settings.showDirs ||
      previous.radiusScale !== this.settings.radiusScale ||
      // The edge dimming is baked into the vertex colours.
      previous.edgeOpacity !== this.settings.edgeOpacity
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

  /**
   * Forget every instance of the current simulation.
   *
   * Called when the history is rebuilt: node ids are per simulation, so the
   * layers must start from nothing or the previous tree would stay drawn.
   */
  resetLayers(): void {
    this.nodes.reset()
    this.edges.reset()
    this.plasma.reset()
    this.particles.clear()
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
          this.plasma.touch(event.node.id, event.strength)
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
      // A seek or a rebuilt history replaces the state the heat was built from,
      // so the plasma restarts from the live events that follow (as Gource's
      // effects do). Same path as `reset()` above for filter changes.
      this.plasma.reset()
      this.plasma.sync(nodes, true)
      this.dirtyNodes.clear()
      sim.needsFullSync = false
      this.fullSyncPending = false
      return
    }

    this.nodes.sync(nodes, false, [...this.dirtyNodes])
    this.edges.sync(nodes, false, [...this.dirtyNodes])
    this.plasma.sync(nodes, false, [...this.dirtyNodes])
    this.dirtyNodes.clear()
  }

  /**
   * Advance animations. The camera drives the projection-dependent sizes; the
   * optional audio levels drive the music-reactive colours and avatar pulse
   * (null keeps the static palette).
   */
  update(
    dt: number,
    now: number,
    sim: Simulation,
    camera: OrbitCamera,
    audio: AudioLevels | null = null,
  ): void {
    const nodes = sim.nodes
    const simTime = sim.currentTime
    this.pendingNodes = nodes

    // Files switch to real spheres either by setting or while an immersive
    // session runs (flat billboards read as discs in a headset). The check is
    // cheap and keeps the two sources of truth — the setting and the session —
    // from drifting apart when a session starts or ends mid-playback.
    const spheres = effectiveSphereMode(this.settings.renderSpheres, this.gl.xr.isPresenting)
    if (this.nodes.sphereMode !== spheres) this.nodes.setSphereMode(spheres, nodes)

    // Every billboard faces the viewer: the orbit camera normally, the headset
    // pose while presenting. The pose arrives in world coordinates, so it is
    // mapped into the tabletop's own frame, which is the frame the fields (and
    // the node positions) are expressed in.
    const view = this.viewCamera(camera)

    // Nodes easing towards a new layout position (dynamic file rings).
    const moved = sim.drainMovedNodes()
    if (moved.length > 0 && !this.fullSyncPending) {
      this.nodes.sync(nodes, false, moved)
      this.edges.sync(nodes, false, moved)
    }
    this.nodes.update(simTime, nodes)
    this.edges.update(simTime, nodes)
    this.particles.update(dt)

    // Keep the ground grid centered under the orbit target. It is oversized so
    // the visible plane stays covered while the camera rotates; the backdrop is
    // a full-screen shader and needs no per-frame sizing.
    const viewHeight = camera.viewHeight
    const viewWidth = viewHeight * (this.size.width / this.size.height)
    const gridExtent = Math.max(viewWidth, viewHeight) * 6
    this.grid.scale.set(gridExtent, gridExtent, 1)
    const focus = camera.focusPoint
    this.grid.position.set(focus.x, focus.y, GRID_Z)
    const gridMaterial = this.grid.material as THREE.ShaderMaterial
    gridMaterial.uniforms.uCenter.value.set(focus.x, focus.y)
    const fadeStart = Math.max(viewWidth, viewHeight) * 1.2
    gridMaterial.uniforms.uFade.value.set(fadeStart, fadeStart * 2.4)

    const authors = [...sim.authors]
    const worldPerPixel = camera.worldPerPixel(this.size.height)
    this.authors.sync(authors, worldPerPixel * MIN_AVATAR_PIXELS, audio?.voice ?? 0)

    // The nodes are camera-facing billboards. The fixed scale is compensated
    // inside those layers from the same orbit target.
    this.nodes.update(simTime, nodes, view, focus, audio)
    this.edges.applyAudio(audio)

    // The plasma volume is ray-marched in the fragment shader. It is drawn
    // behind every other layer (see PlasmaField), so it never hides the tree.
    this.plasma.update(dt, nodes, view, viewHeight)
    this.plasma.applyAudio(audio)

    // Beams from each author to the files of the current commit (drawn on top:
    // they are the activity highlight, not scenery). Their quads face the
    // camera from any orbit angle.
    this.beams.update(simTime, authors, nodes, worldPerPixel, view)

    // Trail particles for avatars that are travelling.
    for (const { author, color } of this.authors.movingAvatars(authors)) {
      const last = this.trailCooldown.get(author.author.id) ?? 0
      if (now - last < 0.05) continue
      this.trailCooldown.set(author.author.id, now)
      this.particles.trail({ x: author.position.x, y: author.position.y + 1.4, z: EFFECT_Z }, color)
    }
    if (this.trailCooldown.size > 256) {
      for (const [id, time] of this.trailCooldown) if (now - time > 5) this.trailCooldown.delete(id)
    }

    this.labels.update(
      dt,
      view,
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

  /**
   * Camera the billboards should face.
   *
   * Normally the orbit camera. While presenting, the headset pose comes from
   * `renderer.xr.getCamera()`; it is expressed in world coordinates, so it is
   * mapped into the tabletop's frame (the `world` group is tipped and scaled
   * into the room) before being handed to the fields, which all work in that
   * local frame. The projection matrices are copied for completeness, but the
   * plasma rays come from the eye camera that is drawing the quad (see
   * `PlasmaField.syncCamera`), not from this stereo union frustum.
   */
  private viewCamera(camera: OrbitCamera): THREE.Camera {
    if (!this.gl.xr.isPresenting) return camera.camera
    const xrCamera = this.gl.xr.getCamera()
    this.world.updateMatrixWorld()
    this.worldInverse.copy(this.world.matrixWorld).invert()
    this.xrView.matrixWorld.multiplyMatrices(this.worldInverse, xrCamera.matrixWorld)
    this.xrView.matrixWorld.decompose(this.xrView.position, this.xrView.quaternion, this.xrView.scale)
    this.xrView.projectionMatrix.copy(xrCamera.projectionMatrix)
    this.xrView.projectionMatrixInverse.copy(xrCamera.projectionMatrixInverse)
    this.xrView.updateMatrixWorld(true)
    return this.xrView
  }

  render(camera: THREE.Camera): void {
    if (this.disposed) return
    this.gl.render(this.scene, camera)
  }

  /**
   * Diagnostics for the branch lines: how far every drawn endpoint sits outside
   * the circle it belongs to. A negative clearance would mean a line running
   * into a node.
   */
  lineClearance(): { edges: number; minChildClearance: number; minParentClearance: number } | null {
    const nodes = this.pendingNodes
    if (!nodes) return null
    const positions = this.edges.lines.geometry.getAttribute('position') as THREE.BufferAttribute
    const array = positions.array as Float32Array
    let edges = 0
    let minChild = Number.POSITIVE_INFINITY
    let minParent = Number.POSITIVE_INFINITY
    for (const node of nodes) {
      if (node.parent < 0 || !node.visible) continue
      const parent = nodes[node.parent]
      if (!parent || parent.kind === 'file') continue
      const index = node.id * 6
      const ax = array[index]
      const ay = array[index + 1]
      const bx = array[index + 3]
      const by = array[index + 4]
      if (ax === 0 && ay === 0 && bx === 0 && by === 0) continue
      edges += 1
      minChild = Math.min(minChild, Math.hypot(bx - node.position.x, by - node.position.y) - node.radius)
      minParent = Math.min(minParent, Math.hypot(ax - parent.position.x, ay - parent.position.y) - parent.radius)
    }
    if (edges === 0) return { edges: 0, minChildClearance: 0, minParentClearance: 0 }
    return {
      edges,
      minChildClearance: Math.round(minChild * 1000) / 1000,
      minParentClearance: Math.round(minParent * 1000) / 1000,
    }
  }

  /**
   * Instances that are actually drawn, per layer.
   *
   * Diagnostics for the "a seek must not leave the previous state on screen"
   * contract: after any seek (or a restart) these must match the visible nodes.
   */
  drawnInstances(): { files: number; dirs: number; edges: number } {
    const nodes = this.pendingNodes
    const drawn = this.nodes.drawn
    let edges = 0
    if (nodes) {
      const positions = this.edges.lines.geometry.getAttribute('position') as THREE.BufferAttribute
      const array = positions.array as Float32Array
      for (const node of nodes) {
        if (node.parent < 0) continue
        const index = node.id * 6
        if (array[index] === 0 && array[index + 1] === 0 && array[index + 3] === 0 && array[index + 4] === 0) continue
        edges += 1
      }
    }
    return { files: drawn.files, dirs: drawn.dirs, edges }
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
    this.plasma.dispose()
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
