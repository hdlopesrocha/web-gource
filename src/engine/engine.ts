import * as THREE from 'three'
import type { ActivityBucket, Timeline, TimelineCommit, TimelineAuthor } from '../timeline/types'
import { buildSchedule, type Schedule, type ScheduleOptions } from '../timeline/schedule'
import { Simulation, type SizeMode } from '../sim/simulation'
import { OrbitCamera, type CameraOptions } from '../render/camera'
import { CameraControls } from './controls'
import { SceneRenderer, type RendererSettings } from '../render/renderer'
import { XrSession } from '../render/xr'
import {
  XR_PANEL_CANVAS_HEIGHT,
  XR_PANEL_CANVAS_WIDTH,
  XR_PANEL_HEIGHT_METRES,
  XR_PANEL_WIDTH_METRES,
  XrReticle,
  XrTimelinePanel,
  createDwellState,
  dwell,
  dwellProgress,
  hitTargetId,
  hitTest,
  panelLayout,
  panelPose,
  xrCommand,
  type XrHit,
  type XrPanelLayout,
  type XrPanelState,
} from '../render/xr-ui'
import { formatDateTime } from '../timeline/schedule'
import { authorCssColor } from '../render/palette'
import type { ChangeKind } from '../timeline/types'
import type { AudioLevels } from './audio/analysis'
import { EXPORT_FPS } from './export/frames'
import type { ExportFrame, ExportFrameRequest } from './export/exporter'
import { ExportOverlay, type OverlayOptions } from './export/overlay'

export interface HudCommitInfo {
  sha: string
  shortSha: string
  subject: string
  /** `owner/name` of the project, when several are loaded. */
  project?: string
  author: string
  authorColor: string
  isMerge: boolean
  filesKnown: boolean
  filesMissingReason?: string
  filesTruncated: boolean
  changes: { path: string; kind: ChangeKind; size?: number }[]
  additions: number
  deletions: number
  filesTotal?: number
  timestamp: number
}

export interface HudAuthor {
  id: string
  name: string
  /** `owner/name` of the project this instance belongs to, when multi-project. */
  project?: string
  color: string
  commits: number
  lastActiveAt: number
}

export interface HudState {
  /** Simulated playback position in seconds. */
  time: number
  duration: number
  /** Interpolated real-world date at the current position (epoch ms). */
  date: number
  /** Commit index and total. */
  index: number
  total: number
  playing: boolean
  speed: number
  commit: HudCommitInfo | null
  activeAuthors: HudAuthor[]
  visibleFiles: number
  visibleDirs: number
  totalFiles: number
  /** Size mode and how many circles use a host-reported size. */
  sizeMode: SizeMode
  filesWithSize: number
  totalBytes: number
  additions: number
  deletions: number
  fps: number
  /** True while recording. */
  recording: boolean
}

export interface EngineOptions {
  schedule?: Partial<ScheduleOptions>
  camera?: Partial<CameraOptions>
  renderer?: Partial<RendererSettings>
  /** Node capacities, derived from the timeline before construction. */
  capacities?: { files: number; dirs: number }
}

export const DEFAULT_CAMERA_OPTIONS: CameraOptions = {
  followActivity: true,
  autoZoom: true,
  smoothing: 1.4,
}

/** Live playback or the deterministic export: the time bases differ. */
export type AudioLevelsMode = 'live' | 'export'
/**
 * Supplies the music bands for the frame being drawn. Live levels come from
 * the audible track; export levels are sampled at the video timestamp so the
 * rendered file is deterministic.
 */
export type AudioLevelsProvider = (mode: AudioLevelsMode, videoTime: number) => AudioLevels | null

/** HUD updates per second (kept low so Vue does not re-render every frame). */
const HUD_RATE = 8

/**
 * Playback engine: owns the clock, the simulation, the camera and the renderer.
 *
 * The engine never talks to Vue directly; it pushes throttled {@link HudState}
 * snapshots to a callback. Rendering is driven by three's animation loop
 * (`renderer.setAnimationLoop`), which uses the window's `requestAnimationFrame`
 * normally and switches to the XR session's own loop while an immersive session
 * runs. During recording the clock advances by an exact `1/fps` step so the
 * captured video is a deterministic sampling of the timeline.
 */
export class Engine {
  readonly renderer: SceneRenderer
  readonly rig: OrbitCamera
  /** Gamepad and gyroscope camera control (live playback only, never exports). */
  readonly controls = new CameraControls()
  private sim: Simulation
  private timeline: Timeline
  private schedule: Schedule
  private canvas: HTMLCanvasElement
  private container: HTMLElement
  private running = false
  private lastFrameMs = 0
  private fpsAccumulator = 0
  private fpsFrames = 0
  private fps = 60
  private hudTimer = 0
  private onHud: (hud: HudState) => void
  private cameraOptions: CameraOptions
  private simTime = 0
  private playing = false
  private speed = 1
  private disposed = false
  private resizeObserver: ResizeObserver | null = null
  private recording: { fps: number; frames: number; width: number; height: number } | null = null
  private authorColorLookup: (id: string) => string
  /** Size of the current export, used when compositing frames. */
  private exportSize = { width: 1920, height: 1080 }
  /** Music bands for the frame being drawn, provided by the controller. */
  private audioLevels: AudioLevelsProvider | null = null
  /** Immersive WebXR session, created on first use. */
  private xr: XrSession | null = null
  /** Rig group the camera is parented to while an XR session runs. */
  private readonly xrRig = new THREE.Group()
  /** In-scene timeline panel, alive only while presenting. */
  private xrPanel: XrTimelinePanel | null = null
  /** Circular gaze crosshair, alive only while presenting. */
  private xrReticle: XrReticle | null = null
  /** Gaze dwell accumulator, reset whenever the panel is (re)created. */
  private readonly xrDwell = createDwellState()
  /** Panel hit rectangles, matching the panel's canvas. */
  private xrLayout: XrPanelLayout = panelLayout()
  /** The element the gaze is resting on, for the panel highlight. */
  private xrHovered: string | null = null
  /** Cached activity histogram for the panel (invalidated by timeline changes). */
  private xrBuckets: ActivityBucket[] | null = null
  private xrBucketsVersion = -1
  /** Bumped whenever the commits or schedule change, so the panel cache drops. */
  private timelineVersion = 0
  private readonly xrRayMatrix = new THREE.Matrix4()
  private readonly xrRayOrigin = new THREE.Vector3()
  private readonly xrRayDir = new THREE.Vector3()
  /** Headset pose centred between the eyes, in scene coordinates. */
  private readonly xrHeadMatrix = new THREE.Matrix4()
  private readonly xrEyePosition = new THREE.Vector3()
  private readonly xrOtherEyePosition = new THREE.Vector3()
  /** Panel pose in scene coordinates, before mapping into the tabletop group. */
  private readonly xrPanelPosition = new THREE.Vector3()
  private readonly xrPanelQuaternion = new THREE.Quaternion()
  private readonly xrParentPosition = new THREE.Vector3()
  private readonly xrParentQuaternion = new THREE.Quaternion()
  private readonly xrParentScale = new THREE.Vector3()

  constructor(
    canvas: HTMLCanvasElement,
    container: HTMLElement,
    timeline: Timeline,
    onHud: (hud: HudState) => void,
    options: EngineOptions = {},
  ) {
    this.canvas = canvas
    this.container = container
    this.onHud = onHud
    this.timeline = timeline
    this.schedule = buildSchedule(timeline.commits, options.schedule)
    this.cameraOptions = { ...DEFAULT_CAMERA_OPTIONS, ...options.camera }
    this.sim = new Simulation(timeline.commits, timeline.authorById)
    this.sim.scheduleTime = (index) => this.scheduleTime(index)
    this.sim.setFileSizes(timeline.fileSizes)
    this.sim.seek(-1)

    this.renderer = new SceneRenderer(canvas, {
      maxFiles: options.capacities?.files ?? timeline.stats.uniquePaths.files + 64,
      maxDirs: options.capacities?.dirs ?? timeline.stats.uniquePaths.dirs + 64,
    })
    if (options.renderer) this.renderer.applySettings(options.renderer)
    this.renderer.setNodes(this.sim.nodes)
    this.rig = new OrbitCamera()
    this.rig.attach(canvas)
    this.renderer.requestFullSync()

    this.authorColorLookup = (id) => {
      const author = this.timeline.authorById.get(id)
      return author ? authorCssColor(author.colorIndex) : '#ffffff'
    }

    this.resize()
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(container)
    }
    window.addEventListener('resize', this.handleWindowResize)

    // Frame the repository so the initial view is sensible even before playback.
    const bounds = this.sim.bounds()
    this.rig.frame(bounds, true)
  }

  private handleWindowResize = () => this.resize()

  /* ------------------------------------------------------------------ *
   * Timeline management
   * ------------------------------------------------------------------ */

  get currentTimeline(): Timeline {
    return this.timeline
  }

  get currentSchedule(): Schedule {
    return this.schedule
  }

  get simulation(): Simulation {
    return this.sim
  }

  /**
   * Extend the timeline with newly loaded commits.
   *
   * Because the schedule is append stable, commits already played keep their
   * times and the current position stays valid.
   */
  extend(timeline: Timeline): void {
    this.timeline = timeline
    this.schedule = buildSchedule(timeline.commits, this.schedule.options, this.schedule)
    this.sim.setCommits(timeline.commits, timeline.authorById)
    this.sim.scheduleTime = (index) => this.scheduleTime(index)
    // Host-reported sizes usually arrive with the first batch and cover files
    // that appear later, so they are applied on every extension.
    this.sim.setFileSizes(timeline.fileSizes)
    this.renderer.setNodes(this.sim.nodes)
    this.timelineVersion += 1
    this.emitHud(true)
  }

  /** Attach file sizes that arrived after the timeline was built. */
  extendSizes(sizes: Map<string, number>): void {
    if (sizes.size === 0) return
    this.timeline.fileSizes = sizes
    this.sim.setFileSizes(sizes)
    this.renderer.requestFullSync()
    this.emitHud(true)
  }

  /** Replace the whole history (filter changes, new repository). */
  reset(timeline: Timeline, options: { keepPosition?: boolean; frameCamera?: boolean } = {}): void {
    const ratio = this.schedule.duration > 0 ? this.simTime / this.schedule.duration : 0
    this.timeline = timeline
    this.schedule = buildSchedule(timeline.commits, this.schedule.options)
    this.sim = new Simulation(timeline.commits, timeline.authorById)
    this.sim.scheduleTime = (index) => this.scheduleTime(index)
    this.sim.setSizeMode(this.sizeMode)
    this.sim.setFileSizes(timeline.fileSizes)
    // The new simulation allocates its own node ids, so every layer drops the
    // instances of the previous one (otherwise hidden folders keep rendering).
    this.renderer.resetLayers()
    this.renderer.setNodes(this.sim.nodes)
    const target = options.keepPosition ? ratio * this.schedule.duration : 0
    if (options.frameCamera) this.rig.frame(this.sim.bounds(), true)
    this.seek(target)
    this.renderer.clearEffects()
    this.renderer.requestFullSync()
    this.timelineVersion += 1
    this.emitHud(true)
  }

  private scheduleTime(index: number): number {
    const times = this.schedule.times
    if (index < 0 || index >= times.length) return this.schedule.duration
    return times[index]
  }

  /* ------------------------------------------------------------------ *
   * Playback control
   * ------------------------------------------------------------------ */

  get isPlaying(): boolean {
    return this.playing
  }

  get position(): number {
    return this.simTime
  }

  get duration(): number {
    return this.schedule.duration
  }

  play(): void {
    if (this.playing || this.timeline.commits.length === 0) return
    if (this.simTime >= this.schedule.duration - 0.001) {
      // Replaying from the end restarts the scene from an empty repository.
      this.simTime = 0
      this.sim.seek(-1)
      this.renderer.clearEffects()
      this.renderer.requestFullSync()
    }
    this.playing = true
    this.emitHud(true)
  }

  pause(): void {
    if (!this.playing) return
    this.playing = false
    this.emitHud(true)
  }

  togglePlay(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.05, Math.min(64, speed))
    this.emitHud(true)
  }

  get currentSpeed(): number {
    return this.speed
  }

  /** Simulated time of a commit index (0 when out of range). */
  timeAtIndex(index: number): number {
    return this.scheduleTime(index)
  }

  /** Real-world timestamp at a simulated time (interpolated). */
  realTimeAt(time: number): number {
    return this.schedule.realTimeAt(time)
  }

  /** Simulated time for a real-world timestamp. */
  simTimeAtRealTime(ms: number): number {
    return this.schedule.simTimeAtRealTime(ms)
  }

  /** Commit index at a simulated time. */
  indexAt(time: number): number {
    return this.schedule.indexAt(time)
  }

  /** Activity histogram in simulated time, for the scrubber. */
  activityBuckets(count: number): ActivityBucket[] {
    return this.schedule.activity(count, this.timeline.commits)
  }

  /** Seek to a simulated time in seconds. */
  seek(time: number): void {
    const clamped = Math.max(0, Math.min(this.schedule.duration, time))
    this.simTime = clamped
    const index = this.schedule.indexAt(clamped)
    this.sim.seek(index)
    this.renderer.clearEffects()
    this.renderer.requestFullSync()
    this.emitHud(true)
  }

  /** Seek so that the state reflects every commit up to `index`. */
  seekToIndex(index: number): void {
    if (this.timeline.commits.length === 0) return
    const clamped = Math.max(0, Math.min(this.timeline.commits.length - 1, index))
    this.seek(this.scheduleTime(clamped))
  }

  /** Seek to a real-world date (epoch ms). */
  seekToDate(ms: number): void {
    if (this.timeline.commits.length === 0) return
    this.seek(this.schedule.simTimeAtRealTime(ms))
  }

  /** Step forward/backwards by a number of commits. */
  step(delta: number): void {
    const target = this.sim.currentIndex + delta
    if (target < 0) {
      // Before the first commit: an empty repository.
      this.seek(0)
      this.sim.seek(-1)
      this.renderer.requestFullSync()
      this.emitHud(true)
      return
    }
    this.seekToIndex(target)
  }

  restart(): void {
    this.seek(0)
    this.sim.seek(-1)
    this.renderer.requestFullSync()
    this.play()
  }

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  applyRendererSettings(settings: Partial<RendererSettings>): void {
    this.renderer.applySettings(settings)
    this.renderer.setNodes(this.sim.nodes)
  }

  applyCameraOptions(options: Partial<CameraOptions>): void {
    this.cameraOptions = { ...this.cameraOptions, ...options }
  }

  /**
   * Turn the dynamic file rings on or off. Turning them off eases files back to
   * their path-derived positions.
   */
  setDynamicLayout(enabled: boolean): void {
    this.sim.dynamicLayout = enabled
    if (enabled) {
      this.sim.reflowAll()
    } else {
      this.sim.resetToStaticLayout()
    }
    this.renderer.requestFullSync()
    this.emitHud(true)
  }

  /** How file circles are sized (bytes / activity / uniform). */
  private sizeMode: SizeMode = 'bytes'

  setSizeMode(mode: SizeMode): void {
    this.sizeMode = mode
    this.sim.setSizeMode(mode)
    this.renderer.requestFullSync()
    this.emitHud(true)
  }

  get currentSizeMode(): SizeMode {
    return this.sizeMode
  }

  /** Reference values for the size legend in the UI. */
  sizeReference(): { bytes: number; activity: number; mode: SizeMode } {
    return this.sim.sizeReference
  }

  /** How many file circles use a host-reported size. */
  sizeCoverage(): { known: number; total: number; bytes: number } {
    return this.sim.sizeCoverage()
  }

  setScheduleOptions(options: Partial<ScheduleOptions>): void {
    const ratio = this.schedule.duration > 0 ? this.simTime / this.schedule.duration : 0
    this.schedule = buildSchedule(this.timeline.commits, options)
    this.sim.scheduleTime = (index) => this.scheduleTime(index)
    const index = this.schedule.indexAt(ratio * this.schedule.duration)
    this.sim.seek(index)
    this.renderer.requestFullSync()
    this.timelineVersion += 1
    this.emitHud(true)
  }

  resetCamera(): void {
    this.rig.reset3D(this.sim.bounds(), true)
  }

  /* ------------------------------------------------------------------ *
   * Camera control devices
   * ------------------------------------------------------------------ */

  /** Bind the current device pose to the current camera pose (gyro reset). */
  recalibrateOrientation(): void {
    this.controls.recalibrate(this.rig)
  }

  /** Ask for motion-sensor permission; must run inside a user gesture. */
  async enableGyro(): Promise<boolean> {
    return this.controls.enableGyro()
  }

  disableGyro(): void {
    this.controls.disableGyro()
  }

  /** True while a gamepad or the gyroscope is flying the camera. */
  get cameraIsFree(): boolean {
    return this.rig.isFree
  }

  /* ------------------------------------------------------------------ *
   * Immersive WebXR
   * ------------------------------------------------------------------ */

  /** True while an immersive VR session is running. */
  get vrActive(): boolean {
    return this.xr?.active ?? false
  }

  /**
   * Enter or leave an immersive VR session.
   *
   * The session owns the framing: the tree is scaled and centred on the scene
   * origin and the user stands there on the local floor, while their real
   * headset height places the eyes. The files and folders are already real
   * spheres, so they keep their parallax in stereo.
   */
  async toggleVr(): Promise<void> {
    const xr = this.ensureXr()
    if (xr.active) {
      await xr.exit()
      this.destroyXrUi()
    } else {
      await xr.enter()
    }
  }

  private ensureXr(): XrSession {
    if (!this.xr) {
      this.xrRig.name = 'xr-rig'
      this.renderer.scene.add(this.xrRig)
      this.xr = new XrSession({
        renderer: this.renderer.webgl,
        framing: {
          rig: this.xrRig,
          scene: this.renderer.scene,
          camera: this.rig.camera,
          root: this.renderer.world,
          bounds: () => this.sim.bounds(),
        },
      })
    }
    return this.xr
  }

  /* ------------------------------------------------------------------ *
   * In-scene timeline panel and gaze
   * ------------------------------------------------------------------ */

  /**
   * Create the in-scene timeline panel and crosshair.
   *
   * Only ever called while an immersive session is presenting: outside VR the
   * panel does not exist and nothing here runs.
   */
  private createXrUi(): void {
    if (this.xrPanel) return
    const panel = new XrTimelinePanel()
    const reticle = new XrReticle()
    this.renderer.world.add(panel.mesh)
    // The reticle is posed from the headset camera each frame, so it lives in
    // scene space (not the scaled tabletop group).
    this.renderer.scene.add(reticle.mesh)
    this.xrPanel = panel
    this.xrReticle = reticle
    this.xrLayout = panelLayout()
    this.xrHovered = null
    this.xrDwell.target = null
    this.xrDwell.elapsed = 0
    this.xrDwell.fired = false
    this.placeXrPanel()
  }

  /** Remove the panel and crosshair (a no-op when there is none). */
  private destroyXrUi(): void {
    if (this.xrPanel) {
      this.renderer.world.remove(this.xrPanel.mesh)
      this.xrPanel.dispose()
      this.xrPanel = null
    }
    if (this.xrReticle) {
      this.renderer.scene.remove(this.xrReticle.mesh)
      this.xrReticle.dispose()
      this.xrReticle = null
    }
    this.xrHovered = null
    this.xrDwell.target = null
    this.xrDwell.elapsed = 0
    this.xrDwell.fired = false
  }

  /**
   * The headset pose in scene coordinates, centred between the eyes.
   *
   * three's XR camera is posed at the left eye, so a gaze ray cast from it would
   * put the crosshair off-centre for the other eye. The position is therefore
   * the midpoint of the eye cameras while the orientation stays theirs.
   */
  private xrHead(): THREE.Matrix4 {
    const camera = this.renderer.webgl.xr.getCamera()
    this.xrHeadMatrix.copy(camera.matrixWorld)
    const eyes = camera.cameras
    if (eyes && eyes.length > 1) {
      this.xrEyePosition.setFromMatrixPosition(eyes[0].matrixWorld)
      this.xrOtherEyePosition.setFromMatrixPosition(eyes[eyes.length - 1].matrixWorld)
      this.xrEyePosition.add(this.xrOtherEyePosition).multiplyScalar(0.5)
      this.xrHeadMatrix.setPosition(this.xrEyePosition)
    }
    return this.xrHeadMatrix
  }

  /**
   * Float the panel in the upper part of the view, in front of the user.
   *
   * It is parented to the tabletop group (so it shares the room scale and the
   * gaze ray can be mapped into its local space). The pose comes from the
   * headset itself — ahead of wherever the user is facing, raised into the top
   * of the view, facing them — so the panel is visible as soon as the session
   * starts, whatever forward direction the runtime picked. Once placed it stays
   * fixed in the room, which is what makes gaze selection stable.
   */
  private placeXrPanel(): void {
    const panel = this.xrPanel
    if (!panel) return
    const world = this.renderer.world
    world.updateMatrixWorld(true)
    const scale = Math.max(1e-6, world.matrixWorld.getMaxScaleOnAxis())
    panelPose(this.xrHead(), this.xrPanelPosition, this.xrPanelQuaternion)
    // Scene pose -> the tabletop group's local frame. The group is only scaled
    // and translated today, but decomposing keeps this right if it ever rotates.
    this.xrRayMatrix.copy(world.matrixWorld).invert()
    world.matrixWorld.decompose(this.xrParentPosition, this.xrParentQuaternion, this.xrParentScale)
    panel.mesh.position.copy(this.xrPanelPosition).applyMatrix4(this.xrRayMatrix)
    panel.mesh.quaternion.copy(this.xrParentQuaternion).invert().multiply(this.xrPanelQuaternion)
    panel.mesh.scale.set(XR_PANEL_WIDTH_METRES / scale, XR_PANEL_HEIGHT_METRES / scale, 1)
    panel.mesh.updateMatrixWorld(true)
  }

  /** The commit histogram for the panel, recomputed only when the timeline changes. */
  private xrActivityBuckets(): ActivityBucket[] {
    if (this.xrBucketsVersion !== this.timelineVersion || !this.xrBuckets) {
      this.xrBucketsVersion = this.timelineVersion
      this.xrBuckets = this.schedule.activity(240, this.timeline.commits)
    }
    return this.xrBuckets
  }

  /** Point the gaze ray from the head at the panel and hit-test it. */
  private gazeHit(): XrHit | null {
    const panel = this.xrPanel
    if (!panel) return null
    const head = this.xrHead()
    panel.mesh.updateMatrixWorld(true)
    // The ray is built in scene space and mapped into the panel's own frame, so
    // the tabletop group's scale (and any rotation) are handled for free.
    this.xrRayMatrix.copy(panel.mesh.matrixWorld).invert()
    this.xrRayOrigin.setFromMatrixPosition(head).applyMatrix4(this.xrRayMatrix)
    this.xrRayDir.set(0, 0, -1).transformDirection(head).transformDirection(this.xrRayMatrix)
    if (Math.abs(this.xrRayDir.z) < 1e-6) return null
    const t = -this.xrRayOrigin.z / this.xrRayDir.z
    if (t < 0) return null
    const x = this.xrRayOrigin.x + this.xrRayDir.x * t
    const y = this.xrRayOrigin.y + this.xrRayDir.y * t
    // The plane spans [-0.5, 0.5] in its own frame; the canvas' Y grows downwards.
    const canvasX = (x + 0.5) * XR_PANEL_CANVAS_WIDTH
    const canvasY = (0.5 - y) * XR_PANEL_CANVAS_HEIGHT
    return hitTest(this.xrLayout, canvasX, canvasY)
  }

  /** Apply the command a gaze hit maps to. */
  private runXrCommand(hit: XrHit): void {
    const command = xrCommand(hit)
    switch (command.kind) {
      case 'restart':
        this.restart()
        break
      case 'step':
        this.step(command.delta)
        break
      case 'togglePlay':
        this.togglePlay()
        break
      case 'seek':
        this.seek(command.ratio * this.schedule.duration)
        break
    }
  }

  /**
   * Update the in-scene panel and run the gaze dwell for one frame.
   *
   * Inert unless a session is presenting: the panel is created on the first
   * presenting frame and torn down as soon as presentation stops.
   */
  private updateXrUi(dt: number): void {
    if (!this.renderer.webgl.xr.isPresenting) return
    if (!this.xrPanel) this.createXrUi()
    const panel = this.xrPanel
    const reticle = this.xrReticle
    if (!panel || !reticle) return

    const hit = this.gazeHit()
    this.xrHovered = hitTargetId(hit)

    const state: XrPanelState = {
      buckets: this.xrActivityBuckets(),
      position: this.simTime,
      duration: this.schedule.duration,
      date: formatDateTime(this.computeDate()),
      progress: this.schedule.duration > 0 ? this.simTime / this.schedule.duration : 0,
      playing: this.playing,
      hovered: this.xrHovered,
    }
    panel.redraw(state)

    if (dwell(this.xrDwell, this.xrHovered, dt) && hit) this.runXrCommand(hit)

    reticle.update({ progress: dwellProgress(this.xrDwell), hovered: this.xrHovered !== null })
    reticle.place(this.xrHead())
  }

  /** Attach (or detach) the music analysis used by the renderer. */
  setAudioLevelsProvider(provider: AudioLevelsProvider | null): void {
    this.audioLevels = provider
  }

  /* ------------------------------------------------------------------ *
   * Loop
   * ------------------------------------------------------------------ */

  start(): void {
    if (this.running) return
    this.running = true
    this.lastFrameMs = performance.now()
    // Driving frames through three's renderer (rather than our own
    // requestAnimationFrame) is what lets an immersive session receive frames:
    // three swaps to the session's animation loop while presenting and falls
    // back to the window's rAF afterwards.
    this.renderer.webgl.setAnimationLoop(this.frame)
  }

  private frame = (now: number): void => {
    if (!this.running || this.disposed) return
    this.tick(now)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.renderer.webgl.setAnimationLoop(null)
  }

  /** Render a single frame without advancing time (used for still captures). */
  renderOnce(): void {
    const audio = this.audioLevels?.('live', this.simTime) ?? null
    this.renderer.consumeEvents(this.sim, performance.now() * 0.001)
    this.renderer.update(0, performance.now() * 0.001, this.sim, this.rig, audio)
    this.renderer.render(this.rig.camera)
  }

  private tick(now: number): void {
    const wallDt = Math.min(0.25, Math.max(0, (now - this.lastFrameMs) / 1000))
    this.lastFrameMs = now
    const clock = now * 0.001

    let simDt = wallDt
    if (this.recording) {
      // During recording the clock advances by exactly one frame step so the
      // exported video is a deterministic sampling of the timeline.
      simDt = 1 / this.recording.fps
    }

    if (this.playing && this.timeline.commits.length > 0) {
      this.simTime += simDt * this.speed
      if (this.simTime >= this.schedule.duration) {
        this.simTime = this.schedule.duration
        const index = this.schedule.indexAt(this.simTime)
        this.sim.applyUpTo(index)
        this.playing = false
        this.emitHud(true)
      } else {
        const index = this.schedule.indexAt(this.simTime)
        if (index > this.sim.currentIndex) this.sim.applyUpTo(index)
      }
    }

    this.sim.update(simDt, this.simTime)
    if (this.timeline.commits.length > 0) this.sim.pruneAuthors(this.simTime, 120)

    const focus = this.sim.recentActivityCenter(4) ?? this.sim.authorCentroid()
    const bounds = this.boundsCache(clock)
    // A gamepad or the gyroscope takes the camera before the automatic framing
    // runs, so flying the view is never fought by the follow behaviour.
    this.controls.update(simDt, this.rig, this.cameraOptions)
    this.rig.update(simDt, this.cameraOptions, focus, bounds)
    // three refreshes the XR camera inside render(); doing it before the scene
    // update gives this frame's camera-facing layers, gaze and panel the current
    // headset pose instead of the previous frame's.
    if (this.renderer.webgl.xr.isPresenting) this.renderer.webgl.xr.updateCamera(this.rig.camera)
    const audio = this.audioLevels?.('live', this.simTime) ?? null

    this.renderer.consumeEvents(this.sim, clock)
    this.renderer.update(simDt, clock, this.sim, this.rig, audio)

    // The in-scene VR panel and gaze are updated before the scene is drawn.
    // three has already posed the headset camera for this frame, and creating
    // the panel here means it appears on the very first presenting frame rather
    // than one frame later. They are inert outside a presenting session.
    if (this.renderer.webgl.xr.isPresenting) this.updateXrUi(simDt)
    else if (this.xrPanel) this.destroyXrUi()

    this.renderer.render(this.rig.camera)

    // While recording, keep the composite (scene + panels) up to date so the
    // capture stream sees the same overlay the exported video gets.
    if (this.recording) {
      this.composeFrame(this.recording.width, this.recording.height)
    }

    // FPS tracking for the HUD.
    this.fpsAccumulator += wallDt
    this.fpsFrames += 1
    if (this.fpsAccumulator >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccumulator
      this.fpsAccumulator = 0
      this.fpsFrames = 0
    }

    this.hudTimer += wallDt
    if (this.hudTimer >= 1 / HUD_RATE) {
      this.hudTimer = 0
      this.emitHud(false)
    }
    if (this.recording) this.recording.frames += 1
  }

  private boundsCacheTime = 0
  private boundsValue: { center: { x: number; y: number; z: number }; radius: number } = {
    center: { x: 0, y: 0, z: 0 },
    radius: 20,
  }

  /** Recomputing the bounds is O(nodes); a few times per second is plenty. */
  private boundsCache(clock: number): { center: { x: number; y: number; z: number }; radius: number } {
    if (clock - this.boundsCacheTime > 0.5) {
      this.boundsCacheTime = clock
      this.boundsValue = this.sim.bounds()
    }
    return this.boundsValue
  }

  /* ------------------------------------------------------------------ *
   * HUD
   * ------------------------------------------------------------------ */

  private emitHud(force: boolean): void {
    void force
    const stats = this.sim.stats()
    const currentIndex = this.sim.currentIndex
    const commit = currentIndex >= 0 ? (this.timeline.commits[currentIndex] ?? null) : null
    const date = this.computeDate()

    const activeAuthors: HudAuthor[] = []
    for (const author of this.sim.authors) {
      if (!author.visible) continue
      activeAuthors.push({
        id: author.author.id,
        name: author.author.name,
        project: this.timeline.projects.length > 1 ? author.author.projectName : undefined,
        color: this.authorColorLookup(author.author.id),
        commits: author.appliedCommits,
        lastActiveAt: author.lastActiveAt,
      })
    }
    activeAuthors.sort((a, b) => b.lastActiveAt - a.lastActiveAt)

    const hud: HudState = {
      time: this.simTime,
      duration: this.schedule.duration,
      date,
      index: Math.max(0, currentIndex),
      total: this.timeline.commits.length,
      playing: this.playing,
      speed: this.speed,
      commit: commit ? this.toHudCommit(commit) : null,
      activeAuthors: activeAuthors.slice(0, 10),
      visibleFiles: stats.visibleFiles,
      visibleDirs: stats.dirs,
      totalFiles: stats.files,
      sizeMode: this.sizeMode,
      filesWithSize: this.timeline.stats.filesWithSize,
      totalBytes: this.timeline.stats.totalBytes,
      additions: stats.additions,
      deletions: stats.deletions,
      fps: Math.round(this.fps),
      recording: this.recording !== null,
    }
    this.onHud(hud)
  }

  private computeDate(): number {
    if (this.timeline.commits.length === 0) return 0
    if (this.simTime <= 0) return this.schedule.realStart
    if (this.simTime >= this.schedule.duration) return this.schedule.realEnd
    return this.schedule.realTimeAt(this.simTime)
  }

  private toHudCommit(commit: TimelineCommit): HudCommitInfo {
    const author: TimelineAuthor | undefined = this.timeline.authorById.get(commit.authorId)
    return {
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      project: this.timeline.projects.length > 1 ? commit.projectName : undefined,
      author: author?.name ?? 'Unknown author',
      authorColor: this.authorColorLookup(commit.authorId),
      isMerge: commit.isMerge,
      filesKnown: commit.filesKnown,
      filesMissingReason: commit.filesMissingReason,
      filesTruncated: commit.filesTruncated,
      changes: commit.changes.slice(0, 40).map((change) => {
        const size = this.timeline.fileSizes.get(change.path)
        return size === undefined
          ? { path: change.path, kind: change.kind }
          : { path: change.path, kind: change.kind, size }
      }),
      additions: commit.additions,
      deletions: commit.deletions,
      filesTotal: commit.filesTotal,
      timestamp: commit.timestamp,
    }
  }

  /* ------------------------------------------------------------------ *
   * Deterministic export
   * ------------------------------------------------------------------ */

  /**
   * Prepare for an offline export.
   *
   * The simulation is reset to a clean state (an empty repository at t = 0) and
   * the camera is put back to its automatic framing, so the exported animation
   * is a pure function of the timeline and the settings — not of whatever the
   * user happened to do before pressing export.
   */
  /**
   * Off-screen canvas the export and the live recording composite into: the
   * WebGL frame plus the panel overlay (timeline, overview, activity charts).
   */
  private composite: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null
  private overlay: ExportOverlay | null = null

  private ensureComposite(width: number, height: number, options?: OverlayOptions): CanvasRenderingContext2D | null {
    if (!this.composite || this.composite.canvas.width !== width || this.composite.canvas.height !== height) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width))
      canvas.height = Math.max(1, Math.round(height))
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      this.composite = { canvas, ctx }
    }
    if (!this.overlay) {
      this.overlay = new ExportOverlay(this.timeline.commits, this.timeline.authors, {
        repository: this.timeline.projects.length > 1
          ? `${this.timeline.projects.length} projects`
          : this.timeline.repo.name,
        ...options,
      })
    } else {
      this.overlay.setCommits(this.timeline.commits)
      this.overlay.setAuthors(this.timeline.authors)
      this.overlay.setFileSizes(this.timeline.fileSizes)
    }
    return this.composite.ctx
  }

  /** Draw the scene plus the panel overlay into the composite canvas. */
  private composeFrame(
    width: number,
    height: number,
    overlayOptions?: OverlayOptions,
  ): HTMLCanvasElement | null {
    const ctx = this.ensureComposite(width, height, overlayOptions)
    if (!ctx || !this.composite) return null
    const canvas = this.composite.canvas
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // The WebGL canvas is read in the same task as the render, so no
    // preserveDrawingBuffer is needed.
    ctx.drawImage(this.canvas, 0, 0, canvas.width, canvas.height)
    this.overlay?.draw(ctx, {
      width: canvas.width,
      height: canvas.height,
      simTime: this.simTime,
      duration: this.schedule.duration,
      sim: this.sim,
      cameraTarget: this.rig.focusPoint,
      date: this.computeDate(),
      commit: this.timeline.commits[this.sim.currentIndex] ?? null,
      buckets: this.schedule.activity(240, this.timeline.commits),
      timeline: {
        files: this.timeline.stats.files,
        totalBytes: this.timeline.stats.totalBytes,
        authors: this.timeline.stats.authors,
      },
      fps: this.recording?.fps ?? EXPORT_FPS,
    })
    return canvas
  }

  beginOfflineExport(width: number, height: number): void {
    this.pause()
    this.exportSize = { width, height }
    this.overlay = null
    this.sim.reset()
    this.simTime = 0
    this.boundsCacheTime = -Infinity
    this.sim.scheduleTime = (index) => this.scheduleTime(index)
    this.sim.setSizeMode(this.sizeMode)
    this.sim.setFileSizes(this.timeline.fileSizes)
    this.renderer.setNodes(this.sim.nodes)
    this.renderer.clearEffects()
    this.renderer.requestFullSync()
    this.resizeTo(width, height)
    // Reset the orbit angles too, so an export is not affected by however the
    // user happened to be looking at the scene before pressing record.
    this.rig.reset(this.sim.bounds(), true)
    this.emitHud(true)
  }

  /** Restore responsive sizing and the pre-export position. */
  endOfflineExport(restoreTime: number): void {
    this.overlay = null
    this.clearFixedSize()
    this.seek(Math.max(0, Math.min(this.schedule.duration, restoreTime)))
    this.boundsCacheTime = -Infinity
    this.emitHud(true)
  }

  /**
   * Render one export frame and wrap it for the encoder.
   *
   * The clock advances by exactly one frame step ({@link EXPORT_FPS} frames per
   * simulated second) regardless of how long the frame took to render, which is
   * what makes the export independent of hardware speed.
   */
  renderExportFrame(request: ExportFrameRequest, overlayOptions?: OverlayOptions): ExportFrame {
    const dt = 1 / EXPORT_FPS
    this.simTime = Math.max(0, Math.min(this.schedule.duration, request.simTime))

    const index = this.schedule.indexAt(this.simTime)
    if (index > this.sim.currentIndex) this.sim.applyUpTo(index)

    this.sim.update(dt, this.simTime)
    this.sim.pruneAuthors(this.simTime, 120)

    const focus = this.sim.recentActivityCenter(4) ?? this.sim.authorCentroid()
    // Bounds are recomputed on a fixed frame cadence (never on wall-clock time)
    // so the camera follows the same path on every machine.
    if (request.frame % 15 === 0) this.boundsValue = this.sim.bounds()
    this.rig.update(dt, this.cameraOptions, focus, this.boundsValue)

    // `now` is the simulated time: every time-based effect is deterministic.
    // The music bands are sampled at the video timestamp so the rays, colours
    // and claps in the exported file follow the encoded audio.
    const audio = this.audioLevels?.('export', request.frame / EXPORT_FPS) ?? null
    this.renderer.consumeEvents(this.sim, this.simTime)
    this.renderer.update(dt, this.simTime, this.sim, this.rig, audio)
    this.renderer.render(this.rig.camera)

    // Composite the panel overlay (timeline, overview, activity) into the frame.
    const composed = this.composeFrame(this.exportSize.width, this.exportSize.height, overlayOptions)
    return new VideoFrame(composed ?? this.canvas, {
      timestamp: request.timestamp,
      duration: request.duration,
    })
  }

  /* ------------------------------------------------------------------ *
   * Recording hooks
   * ------------------------------------------------------------------ */

  /**
   * Called by the recorder: fixed-step clock advancement at the given frame
   * rate, compositing the panels at that resolution. The simulation follows the
   * playback speed, so the video matches what is on screen.
   */
  beginRecording(fps: number, width: number, height: number): void {
    this.recording = { fps, frames: 0, width, height }
  }

  /** Composite canvas (scene + panels) used as the live capture source. */
  prepareRecordingCanvas(width: number, height: number): HTMLCanvasElement | null {
    this.ensureComposite(width, height)
    return this.composite?.canvas ?? null
  }

  endRecording(): void {
    this.recording = null
  }

  get recordedFrames(): number {
    return this.recording?.frames ?? 0
  }

  /* ------------------------------------------------------------------ *
   * Sizing and teardown
   * ------------------------------------------------------------------ */

  resize(): void {
    // A recording renders at a fixed resolution; responsive resizing is paused
    // until the recording ends.
    if (this.recording) return
    const rect = this.container.getBoundingClientRect()
    const width = Math.max(1, rect.width)
    const height = Math.max(1, rect.height)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.renderer.resize(width, height, dpr)
    this.rig.setViewport(width, height)
  }

  /** Resize to an explicit resolution (used while recording a fixed size). */
  resizeTo(width: number, height: number): void {
    this.renderer.resize(width, height, 1)
    this.rig.setViewport(width, height)
    this.canvas.style.aspectRatio = `${width} / ${height}`
  }

  /** Restore the responsive full-window sizing after a recording. */
  clearFixedSize(): void {
    this.canvas.style.aspectRatio = ''
    this.resize()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.destroyXrUi()
    this.xr?.dispose()
    this.xr = null
    window.removeEventListener('resize', this.handleWindowResize)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.rig.dispose()
    this.controls.dispose()
    this.renderer.dispose()
  }
}

export { THREE }
