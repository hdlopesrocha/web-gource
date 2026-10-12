import { GitError, describeGitError } from '../git/errors'
import { loadHistory, type LoadStage } from '../git/loader'
import { resolveRepoInput, demoProvider } from '../git/providers'
import type { RawCommit, RepoInfo } from '../git/types'
import { buildTimeline, bucketActivity } from '../timeline/builder'
import { compileIgnoredFolders, normaliseIgnoredFolders } from '../timeline/ignore'
import type { SizeMode } from '../sim/simulation'
import type { ActivityBucket, Timeline } from '../timeline/types'
import type { Simulation } from '../sim/simulation'
import { buildSchedule, type ScheduleOptions } from '../timeline/schedule'
import { Engine, type EngineOptions, type HudState } from './engine'
import {
  VideoRecorder,
  availableFormats,
  downloadRecording,
  isRecordingSupported,
  preferredFormat,
} from './recorder'
import { EXPORT_FPS } from './export/frames'
import { ExportCancelledError, OfflineExporter, type ExportProgress } from './export/exporter'
import { discoverCodecs, isWebCodecsSupported, type CodecChoice } from './export/encoder'
import {
  persistLoadOptions,
  persistFilters,
  persistSettings,
  resetRunState,
  resolvePacing,
  setLastUrl,
  store,
  tokenFor,
} from '../state/store'
import type { RendererSettings } from '../render/renderer'

/**
 * Application controller.
 *
 * Owns the engine, the recorder and the raw commit buffer, and translates UI
 * intentions into engine calls. Keeping this outside the Vue components means
 * the visualization can be driven (and tested) without the DOM, and the
 * components stay declarative.
 */
export class VisualizerController {
  private engine: Engine | null = null
  private recorder: VideoRecorder | null = null
  private canvas: HTMLCanvasElement | null = null
  private container: HTMLElement | null = null
  private rawCommits: RawCommit[] = []
  /** Host-reported file sizes for the current snapshot. */
  private fileSizes = new Map<string, number>()
  private sizesTruncated = false
  private sizeSource = 'unavailable'
  private repoInfo: RepoInfo | null = null
  private abort: AbortController | null = null
  private progressTimer: number | null = null
  private recordingStartedAt = 0
  private timeline: Timeline | null = null
  /** Timeline duration used before an engine exists (settings preview, scrubber). */
  private fallbackDuration = 0

  get hasEngine(): boolean {
    return this.engine !== null
  }

  get currentTimeline(): Timeline | null {
    return this.timeline
  }

  /** Live simulation state (used by the minimap). */
  get simulation(): Simulation | null {
    return this.engine?.simulation ?? null
  }

  /**
   * Diagnostics for the console and for end-to-end checks: how many instances
   * are allocated, how many particles are alive, how long the schedule is.
   */
  get debugInfo(): Record<string, unknown> | null {
    if (!this.engine) return { engine: false }
    const info = this.engine.renderer.info
    const schedule = this.engine.currentSchedule
    return {
      engine: true,
      viewport: this.engine.renderer.viewport,
      instances: info.nodeStats,
      particles: info.liveParticles,
      beams: info.beams,
      bloom: info.bloom,
      beamSample: this.engine.renderer.beamSample(),
      lineClearance: this.engine.renderer.lineClearance(),
      nodes: this.simulation?.nodes.length ?? 0,
      sizes: {
        mapSize: this.fileSizes.size,
        truncated: this.sizesTruncated,
        source: this.sizeSource,
      },
      timeline: {
        commits: this.timeline?.commits.length ?? 0,
        authors: this.timeline?.authors.length ?? 0,
        duration: Math.round(this.engine.duration * 100) / 100,
        scheduleCount: schedule.count,
        firstTimes: [...schedule.times.slice(0, 5)].map((value) => Math.round(value * 100) / 100),
        lastTime: Math.round((schedule.times[schedule.count - 1] ?? 0) * 100) / 100,
      },
      settings: {
        pacing: store.settings.pacing,
        effective: resolvePacing(store.settings.pacing, {
          secondsPerDay: store.settings.customSecondsPerDay,
          minSpacing: store.settings.customMinSpacing,
        }),
        labels: store.settings.showLabels,
      },
    }
  }

  /** Camera focus point in world space. */
  get cameraTarget(): { x: number; y: number; z: number } {
    const target = this.engine?.rig.focusPoint
    return target ? { x: target.x, y: target.y, z: target.z } : { x: 0, y: 0, z: 0 }
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  attach(canvas: HTMLCanvasElement, container: HTMLElement): void {
    this.canvas = canvas
    this.container = container
    if (!this.engine && this.timeline) this.createEngine(this.timeline)
  }

  detach(): void {
    this.resetEngine()
    this.canvas = null
    this.container = null
  }

  /* ------------------------------------------------------------------ *
   * Loading
   * ------------------------------------------------------------------ */

  /** Resolve user input to a provider (also used for live URL validation). */
  resolve(input: string): { providerId: string; label: string } | null {
    try {
      const resolved = resolveRepoInput(input, { providerId: store.forcedProvider ?? undefined })
      return { providerId: resolved.provider.id, label: resolved.provider.name }
    } catch {
      return null
    }
  }

  async load(input: string, options: { providerId?: string } = {}): Promise<void> {
    this.cancelLoad()
    this.resetEngine()
    this.rawCommits = []
    this.fileSizes = new Map()
    this.sizesTruncated = false
    this.sizeSource = 'unavailable'
    this.repoInfo = null
    this.timeline = null
    resetRunState()
    store.url = input
    store.forcedProvider = options.providerId ?? null
    store.view = 'landing'
    setLastUrl(input)

    let resolved
    try {
      resolved = resolveRepoInput(input, { providerId: options.providerId ?? store.forcedProvider ?? undefined })
    } catch (error) {
      store.loading.error = describeGitError(error)
      return
    }

    this.abort = new AbortController()
    store.loading.active = true
    store.loading.status = `Contacting ${resolved.provider.name}…`
    store.loading.target = store.loadOptions.maxCommits
    store.loading.requests = 0
    store.loading.error = null
    store.loading.streaming = false

    const token = tokenFor(resolved.provider.id)
    try {
      const result = await loadHistory(resolved, {
        maxCommits: store.loadOptions.maxCommits,
        range: store.loadOptions.range,
        branch: store.loadOptions.branch || undefined,
        token,
        signal: this.abort.signal,
        onStage: (stage) => this.handleStage(stage),
        onRepo: (repo) => {
          this.repoInfo = repo
          store.repo = repo
        },
        onFileSizes: ({ fileSizes, truncated, source }) => {
          // Sizes arrive before the file changes: hand them to the running
          // visualization so circles are right from the first batch.
          this.fileSizes = fileSizes
          this.sizesTruncated = truncated
          this.sizeSource = source
          this.engine?.extendSizes(fileSizes)
        },
        onCommits: (batch) => this.appendBatch(batch),
      })
      this.repoInfo = result.repo
      this.fileSizes = result.fileSizes
      this.sizesTruncated = result.sizesTruncated
      this.sizeSource = result.sizeSource
      store.repo = result.repo
      store.timelineTruncated = result.truncated
      store.warnings = dedupe([...store.warnings, ...result.warnings])
      store.loading.status = 'Ready'
      store.loading.active = false
      store.loading.rateRemaining = result.rateRemaining
      persistLoadOptions()

      // Final rebuild so stats and warnings reflect the complete window.
      this.rebuildTimeline({ keepPosition: true })
      const timeline = this.timeline as Timeline | null
      if (!timeline || timeline.commits.length === 0) {
        store.loading.error = 'This repository produced no visualizable commits.'
        store.view = 'landing'
        return
      }
    } catch (error) {
      store.loading.active = false
      const message = describeGitError(error)
      const hadContent = this.timeline !== null
      store.loading.streaming = false
      if (error instanceof GitError && error.kind === 'aborted') {
        store.loading.error = null
        return
      }
      store.loading.error = message
      // Keep a partially loaded visualization on screen; otherwise go back.
      if (!hadContent) store.view = 'landing'
    }
  }

  cancelLoad(): void {
    this.abort?.abort()
    this.abort = null
    store.loading.active = false
    store.loading.streaming = false
    store.loading.status = 'Cancelled'
  }

  private handleStage(stage: LoadStage): void {
    store.loading.active = stage.kind !== 'done'
    store.loading.status = stage.status
    if (stage.kind === 'fetching') {
      store.loading.loaded = Math.max(store.loading.loaded, stage.loaded)
      store.loading.target = Math.max(1, stage.target)
      store.loading.requests = stage.requests
      if (stage.rateRemaining !== undefined) store.loading.rateRemaining = stage.rateRemaining
    }
    if (stage.kind === 'done') {
      store.loading.loaded = stage.loaded
      store.loading.target = Math.max(stage.loaded, store.loading.target)
      // The visualization keeps running, so the progress banner can go away.
      store.loading.streaming = false
    }
  }

  /** Receive a hydrated batch and update the visualization incrementally. */
  private appendBatch(batch: RawCommit[]): void {
    if (batch.length === 0) return
    this.rawCommits.push(...batch)
    this.rebuildTimeline({ keepPosition: true, streaming: true })
    if (!store.loading.streaming) {
      store.loading.streaming = true
      store.loading.status = 'Streaming commits into the visualization…'
    }
  }

  /** Rebuild the timeline (filters included) and hand it to the engine. */
  private rebuildTimeline(options: { keepPosition?: boolean; streaming?: boolean } = {}): void {
    const repo = this.repoInfo ?? store.repo
    if (!repo || this.rawCommits.length === 0) return
    const filter = this.buildFilter()
    const fileFilter = this.buildFileFilter()
    const timeline = buildTimeline(repo, this.rawCommits, {
      filter,
      fileFilter,
      truncated: store.timelineTruncated,
      warnings: store.warnings,
      fileSizes: this.fileSizes,
      sizesTruncated: this.sizesTruncated,
      sizeSource: this.sizeSource,
    })
    if (timeline.commits.length === 0) {
      store.warnings = dedupe([...store.warnings, 'The current filters exclude every commit. Widen the filters to see activity.'])
      return
    }
    this.timeline = timeline
    store.timelineStats = timeline.stats
    store.repo = timeline.repo

    if (!this.engine) {
      // With a mounted canvas we can create the engine right away; otherwise
      // switch views and let `attach()` do it when the canvas mounts.
      this.fallbackDuration = buildSchedule(timeline.commits, this.scheduleOptions()).duration
      if (this.canvas && this.container) this.createEngine(timeline)
      else store.view = 'stage'
      return
    }
    if (options.streaming) this.engine.extend(timeline)
    else this.engine.reset(timeline, { keepPosition: options.keepPosition })
  }

  private createEngine(timeline: Timeline): void {
    if (!this.canvas || !this.container) return
    const engineOptions: EngineOptions = {
      capacities: {
        files: timeline.stats.uniquePaths.files + 64,
        dirs: timeline.stats.uniquePaths.dirs + 64,
      },
      renderer: this.rendererSettings(),
      camera: this.cameraOptions(),
      schedule: this.scheduleOptions(),
    }
    let engine: Engine
    try {
      engine = new Engine(this.canvas, this.container, timeline, (hud) => this.onHud(hud), engineOptions)
    } catch (error) {
      // No WebGL (old browser, blocked GPU, headless environment).
      store.loading.error =
        'WebGL could not be initialised, so the visualization cannot start. ' +
        `Make sure hardware acceleration is enabled. (${(error as Error).message})`
      store.view = 'landing'
      return
    }
    engine.setSpeed(store.hud?.speed ?? 1)
    engine.setDynamicLayout(store.settings.dynamicLayout)
    this.engine = engine
    store.view = 'stage'
    engine.start()
    engine.play()
  }

  private onHud(hud: HudState): void {
    store.hud = hud
    if (store.recording.active && this.recorder) {
      const maxWall = store.recording.maxWallSeconds
      const elapsed = (performance.now() - this.recordingStartedAt) / 1000
      const finished = hud.time >= hud.duration - 0.001 && !hud.playing
      if ((store.recording.stopAtEnd && finished) || elapsed >= maxWall) {
        void this.stopRecording()
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Filters
   * ------------------------------------------------------------------ */

  /**
   * Ignored folders plus hidden (dot-prefixed) folders, as a path predicate.
   * Returns undefined when neither filter is active.
   */
  private buildFileFilter(): ((path: string) => boolean) | undefined {
    const matcher = compileIgnoredFolders(store.ignoredFolders, { hiddenFolders: store.hideHiddenFolders })
    if (!matcher.active) return undefined
    return (path: string) => matcher.matches(path)
  }

  private buildFilter(): ((commit: RawCommit) => boolean) | undefined {
    const hidden = new Set(store.hiddenAuthors)
    const { from, to } = store.dateRange
    if (hidden.size === 0 && from === null && to === null) return undefined
    return (commit: RawCommit) => {
      if (from !== null && commit.timestamp < from) return false
      if (to !== null && commit.timestamp > to) return false
      if (hidden.size > 0) {
        const key = commit.author.login
          ? `login:${commit.author.login.toLowerCase()}`
          : commit.author.email
            ? `email:${commit.author.email.toLowerCase()}`
            : `name:${commit.author.name.trim().toLowerCase()}`
        if (hidden.has(key)) return false
      }
      return true
    }
  }

  applyFilters(filters: {
    hiddenAuthors?: string[]
    ignoredFolders?: string[]
    hideHiddenFolders?: boolean
    from?: number | null
    to?: number | null
  }): void {
    if (filters.hiddenAuthors) store.hiddenAuthors = [...filters.hiddenAuthors]
    if (filters.ignoredFolders) store.ignoredFolders = normaliseIgnoredFolders(filters.ignoredFolders)
    if (filters.hideHiddenFolders !== undefined) store.hideHiddenFolders = filters.hideHiddenFolders
    if (filters.ignoredFolders || filters.hideHiddenFolders !== undefined) persistFilters()
    if (filters.from !== undefined) store.dateRange.from = filters.from
    if (filters.to !== undefined) store.dateRange.to = filters.to
    this.rebuildTimeline({ keepPosition: true })
  }

  clearFilters(): void {
    store.hiddenAuthors = []
    store.ignoredFolders = []
    store.hideHiddenFolders = false
    store.dateRange = { from: null, to: null }
    persistFilters()
    this.rebuildTimeline({ keepPosition: true })
  }

  toggleAuthor(authorId: string): void {
    const hidden = new Set(store.hiddenAuthors)
    if (hidden.has(authorId)) hidden.delete(authorId)
    else hidden.add(authorId)
    this.applyFilters({ hiddenAuthors: [...hidden] })
  }

  /* ------------------------------------------------------------------ *
   * Playback
   * ------------------------------------------------------------------ */

  play(): void {
    this.engine?.play()
  }

  pause(): void {
    this.engine?.pause()
  }

  togglePlay(): void {
    this.engine?.togglePlay()
  }

  seek(time: number): void {
    this.engine?.seek(time)
  }

  seekToIndex(index: number): void {
    this.engine?.seekToIndex(index)
  }

  seekToDate(ms: number): void {
    this.engine?.seekToDate(ms)
  }

  step(delta: number): void {
    this.engine?.step(delta)
  }

  restart(): void {
    this.engine?.restart()
  }

  setSpeed(speed: number): void {
    this.engine?.setSpeed(speed)
  }

  /** Jump to the commit matching a SHA prefix. Returns the index or null. */
  jumpToSha(prefix: string): number | null {
    const needle = prefix.trim().toLowerCase()
    if (!needle || !this.timeline) return null
    const index = this.timeline.commits.findIndex((commit) => commit.sha.toLowerCase().startsWith(needle))
    if (index < 0) return null
    this.seekToIndex(index)
    return index
  }

  resetCamera(): void {
    this.engine?.resetCamera()
  }

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  private rendererSettings(): Partial<RendererSettings> {
    const settings = store.settings
    return {
      fileColorMode: settings.fileColorMode,
      showEdges: settings.showEdges,
      edgeOpacity: settings.edgeOpacity,
      showDirs: settings.showDirs,
      radiusScale: settings.radiusScale,
      particleIntensity: settings.particleIntensity,
      showLabels: settings.showLabels,
      showDirectoryLabels: settings.showDirectoryLabels,
      showFileLabels: settings.showFileLabels,
      showFileSizes: settings.showFileSizes,
      showAuthorNames: settings.showAuthorNames,
      showAuthorGlow: settings.showAuthorGlow,
      authorScale: settings.authorScale,
      showGrid: settings.showGrid,
      gridSpacing: settings.gridSpacing,
      showBloom: settings.showBloom,
      bloomIntensity: settings.bloomIntensity,
      showBeams: settings.showBeams,
      beamStyle: settings.beamStyle,
      beamTravelSeconds: settings.beamTravelSeconds,
      beamIntensity: settings.beamIntensity,
      beamWidth: settings.beamWidth,
    }
  }

  private cameraOptions(): { followActivity: boolean; autoZoom: boolean; smoothing: number } {
    return {
      followActivity: store.settings.followActivity,
      autoZoom: store.settings.autoZoom,
      smoothing: 1.4,
    }
  }

  private scheduleOptions(): ScheduleOptions {
    const pacing = resolvePacing(store.settings.pacing, {
      secondsPerDay: store.settings.customSecondsPerDay,
      minSpacing: store.settings.customMinSpacing,
    })
    return {
      minSpacing: pacing.minSpacing,
      secondsPerDay: pacing.secondsPerDay,
      maxGapSeconds: pacing.maxGapSeconds,
      idleBudget: pacing.idleBudget,
      tail: pacing.tail,
    }
  }

  /** Apply a visualization settings patch and push it to the engine. */
  updateSettings(patch: Partial<typeof store.settings>): void {
    Object.assign(store.settings, patch)
    persistSettings()
    if (!this.engine) return
    this.engine.applyRendererSettings(this.rendererSettings())
    this.engine.applyCameraOptions(this.cameraOptions())
    if (patch.sizeMode) this.engine.setSizeMode(patch.sizeMode)
    if (patch.dynamicLayout !== undefined) this.engine.setDynamicLayout(patch.dynamicLayout)
    if (patch.pacing) this.engine.setScheduleOptions(this.scheduleOptions())
  }

  /* ------------------------------------------------------------------ *
   * Timeline queries (used by the scrubber and filters)
   * ------------------------------------------------------------------ */

  /** Total simulated duration in seconds. */
  duration(): number {
    return this.engine?.duration ?? this.fallbackDuration
  }

  /** Simulated seconds for a real timestamp (identity when no engine exists). */
  simTimeAtRealTime(ms: number): number {
    return this.engine ? this.engine.simTimeAtRealTime(ms) : 0
  }

  /** Real timestamp for a simulated time. */
  realTimeAt(time: number): number {
    if (this.engine) return this.engine.realTimeAt(time)
    const stats = this.timeline?.stats
    return stats ? stats.start : 0
  }

  /** Commit index at a simulated time. */
  indexAt(time: number): number {
    return this.engine ? this.engine.indexAt(time) : 0
  }

  /** Real timestamp of the first and last loaded commit. */
  realRange(): { start: number; end: number } {
    const schedule = this.engine?.currentSchedule
    if (schedule && schedule.count > 0) return { start: schedule.realStart, end: schedule.realEnd }
    const stats = this.timeline?.stats
    return { start: stats?.start ?? 0, end: stats?.end ?? 0 }
  }

  /** Circle-size reference values (95th percentile bytes, max activity). */
  sizeReference(): { bytes: number; activity: number; mode: SizeMode } {
    if (this.engine) return this.engine.sizeReference()
    const stats = this.timeline?.stats
    return {
      bytes: Math.max(1024, stats?.largestFileBytes ?? 0),
      activity: 8,
      mode: store.settings.sizeMode,
    }
  }

  /** How many file circles use a host-reported size. */
  sizeCoverage(): { known: number; total: number; bytes: number } {
    if (this.engine) return this.engine.sizeCoverage()
    const stats = this.timeline?.stats
    return {
      known: stats?.filesWithSize ?? 0,
      total: stats?.files ?? 0,
      bytes: stats?.totalBytes ?? 0,
    }
  }

  /** Activity histogram in simulated time (falls back to real-time bucketing). */
  activityBuckets(count = 320): ActivityBucket[] {
    if (this.engine && this.timeline) return this.engine.activityBuckets(count)
    if (this.timeline) return bucketActivity(this.timeline.commits, count)
    return []
  }

  /* ------------------------------------------------------------------ *
   * Deterministic export
   * ------------------------------------------------------------------ */

  private exporter: OfflineExporter | null = null

  /** Whether deterministic export is possible, and which codecs were found. */
  exportSupport(): { supported: boolean; codecs: typeof store.export.codecs } {
    return { supported: isWebCodecsSupported(), codecs: store.export.codecs }
  }

  /**
   * Probe the browser's encoders at the export resolution.
   *
   * WebCodecs support differs by platform (WebM everywhere Chromium runs, MP4
   * only where an AVC encoder exists), so the list is discovered rather than
   * assumed, and hardware implementations are preferred.
   */
  async refreshExportSupport(): Promise<void> {
    const settings = store.recording
    if (!isWebCodecsSupported()) {
      store.export.codecs = []
      store.export.probed = true
      return
    }
    const found = await discoverCodecs(settings.width, settings.height, EXPORT_FPS, 6_000_000)
    store.export.codecs = found.map((codec: CodecChoice) => ({
      container: codec.container,
      label: codec.label,
      codec: codec.codecString,
      supported: true,
      hardware: codec.hardwareAccelerated,
    }))
    store.export.probed = true
  }

  private exportChoice(): CodecChoice | null {
    const preferred = store.export.container
    const available = store.export.codecs.filter((codec) => codec.supported)
    const pick = available.find((codec) => codec.container === preferred) ?? available[0]
    if (!pick) return null
    return {
      container: pick.container,
      codec: pick.codec.startsWith('avc1') ? 'h264' : pick.codec.startsWith('vp09') ? 'vp9' : pick.codec === 'vp8' ? 'vp8' : 'av1',
      codecString: pick.codec,
      label: pick.label,
      extension: pick.container === 'webm' ? 'webm' : 'mp4',
      mimeType: pick.container === 'webm' ? 'video/webm' : 'video/mp4',
      hardwareAccelerated: pick.hardware,
    }
  }

  /**
   * Render the whole animation from `t = 0` and encode it.
   *
   * The clock is driven by the frame index (30 frames per simulated second), so
   * the result does not depend on how fast this machine renders; progress is
   * reported as frames and simulated time.
   */
  async startExport(): Promise<void> {
    if (!this.engine || store.export.active) return
    // Mark the export as active before the first await, so the UI (and any
    // caller) sees it immediately rather than during codec probing.
    store.export.active = true
    store.export.progress = null
    store.export.error = null
    const engine = this.engine
    let restoreTime = engine.position
    try {
      if (!isWebCodecsSupported()) {
        store.export.error = 'This browser cannot encode video (WebCodecs is unavailable). Try desktop Chrome or Edge.'
        return
      }
      if (store.export.codecs.length === 0) await this.refreshExportSupport()
      const choice = this.exportChoice()
      if (!choice) {
        store.export.error = 'No usable video encoder was found for this resolution in this browser.'
        return
      }
      if (store.export.lastUrl) {
        URL.revokeObjectURL(store.export.lastUrl)
        store.export.lastUrl = null
      }

      const settings = store.recording
      restoreTime = engine.position
      const exporter = new OfflineExporter()
      this.exporter = exporter
      engine.beginOfflineExport(settings.width, settings.height)

      const speed = Math.max(0.05, store.hud?.speed ?? engine.currentSpeed ?? 1)
      const result = await exporter.run({
        duration: engine.duration,
        choice,
        width: settings.width,
        height: settings.height,
        // The export follows the playback speed selected in the app.
        speed,
        bitrate: store.export.bitrate > 0 ? store.export.bitrate : undefined,
        onProgress: (progress: ExportProgress) => {
          store.export.progress = {
            frames: progress.frames,
            totalFrames: progress.totalFrames,
            simTime: progress.simTime,
            duration: progress.duration,
            percent: progress.percent,
            bytes: progress.bytes,
            queue: progress.queue,
          }
        },
        frameFactory: (request) => engine.renderExportFrame(request),
      })
      store.export.lastUrl = URL.createObjectURL(result.blob)
      store.export.lastExtension = result.extension
      store.export.lastLabel = `${result.choice.label}${result.choice.hardwareAccelerated ? ' · hardware' : ''}`
      store.export.lastBytes = result.bytes
      store.export.lastFrames = result.frames
      store.export.lastSeconds = result.seconds
      store.export.lastElapsed = result.elapsed
      store.export.lastSpeed = result.speed
      store.export.lastHardware = result.choice.hardwareAccelerated
    } catch (error) {
      store.export.error =
        error instanceof ExportCancelledError
          ? null
          : `Export failed: ${(error as Error).message}`
    } finally {
      this.exporter = null
      store.export.active = false
      store.export.progress = null
      engine.endOfflineExport(restoreTime)
    }
  }

  cancelExport(): void {
    this.exporter?.cancel()
  }

  downloadExport(): void {
    const url = store.export.lastUrl
    if (!url) return
    const name = `${store.repo?.name ?? 'repository'}-gource-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
    downloadRecording(
      {
        blob: new Blob(),
        url,
        mimeType: store.export.lastExtension === 'mp4' ? 'video/mp4' : 'video/webm',
        extension: store.export.lastExtension,
        frames: store.export.lastFrames,
        elapsed: store.export.lastElapsed,
        simulatedSeconds: store.export.lastSeconds,
        bytes: store.export.lastBytes,
      },
      name,
    )
  }

  /* ------------------------------------------------------------------ *
   * Recording
   * ------------------------------------------------------------------ */

  recordingSupport(): { supported: boolean; formats: ReturnType<typeof availableFormats> } {
    return { supported: isRecordingSupported(), formats: availableFormats() }
  }

  async startRecording(): Promise<void> {
    if (!this.engine || store.recording.active) return
    if (!isRecordingSupported()) {
      store.recording.error = 'This browser cannot record canvas video. Try Chrome, Edge or Firefox on desktop.'
      return
    }
    const settings = store.recording
    const format = store.recording.mimeType || preferredFormat()?.mimeType || ''
    if (!format) {
      store.recording.error = 'No supported video format was found in this browser.'
      return
    }
    if (store.recording.lastUrl) {
      URL.revokeObjectURL(store.recording.lastUrl)
      store.recording.lastUrl = null
    }
    store.recording.error = null
    // Live capture runs at 60 fps and follows the playback speed, capturing the
    // composited canvas so the panels (timeline, overview, activity) are in the
    // video exactly as they are in the deterministic render.
    this.engine.beginRecording(EXPORT_FPS, settings.width, settings.height)
    const source = this.engine.prepareRecordingCanvas(settings.width, settings.height) ?? this.engine.renderer.domElement
    this.recorder = new VideoRecorder(source)
    try {
      this.engine.pause()
      this.engine.resizeTo(settings.width, settings.height)
      this.engine.seek(0)
      this.recorder.start({
        width: settings.width,
        height: settings.height,
        fps: EXPORT_FPS,
        mimeType: format,
      })
      store.recording.active = true
      this.recordingStartedAt = performance.now()
      this.startProgressTimer()
      this.engine.play()
    } catch (error) {
      store.recording.error = (error as Error).message
      await this.recorder.cancel().catch(() => undefined)
      this.recorder = null
      store.recording.active = false
      this.engine.endRecording()
      this.engine.clearFixedSize()
    }
  }

  async stopRecording(): Promise<void> {
    if (!this.recorder || !this.engine) return
    const engine = this.engine
    const frames = engine.recordedFrames
    const simulated = engine.position
    engine.endRecording()
    const result = await this.recorder.stop()
    if (result) {
      this.recorder.complete(result, frames, simulated)
      store.recording.lastUrl = result.url
      store.recording.lastExtension = result.extension
      store.recording.lastBytes = result.bytes
      store.recording.lastFrames = result.frames
      store.recording.lastSeconds = result.simulatedSeconds
    }
    if (this.recorder.lastError) store.recording.error = this.recorder.lastError
    this.recorder = null
    store.recording.active = false
    store.recording.progress = null
    this.stopProgressTimer()
    engine.clearFixedSize()
  }

  async cancelRecording(): Promise<void> {
    if (this.recorder) {
      await this.recorder.cancel().catch(() => undefined)
      this.recorder = null
    }
    this.engine?.endRecording()
    this.engine?.clearFixedSize()
    store.recording.active = false
    store.recording.progress = null
    this.stopProgressTimer()
  }

  downloadRecording(): void {
    const url = store.recording.lastUrl
    if (!url) return
    const name = `${store.repo?.name ?? 'repository'}-gource-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
    downloadRecording(
      {
        blob: new Blob(),
        url,
        mimeType: store.recording.mimeType,
        extension: store.recording.lastExtension,
        frames: store.recording.lastFrames,
        elapsed: 0,
        simulatedSeconds: store.recording.lastSeconds,
        bytes: store.recording.lastBytes,
      },
      name,
    )
  }

  private startProgressTimer(): void {
    this.stopProgressTimer()
    this.progressTimer = window.setInterval(() => {
      if (!this.recorder || !this.engine) return
      const frames = this.engine.recordedFrames
      const captured = this.engine.position
      const total = this.engine.duration
      store.recording.progress = this.recorder.progress(frames, captured, total)
    }, 250)
  }

  private stopProgressTimer(): void {
    if (this.progressTimer !== null) {
      window.clearInterval(this.progressTimer)
      this.progressTimer = null
    }
  }

  /* ------------------------------------------------------------------ *
   * Utilities
   * ------------------------------------------------------------------ */

  /** Load the built-in synthetic repository (clearly labelled as fake). */
  async loadDemo(): Promise<void> {
    store.url = 'demo/synthetic-repository'
    const url = new URL('demo://demo/synthetic-repository')
    const parsed = demoProvider.parse(url)
    if (!parsed) return
    await this.load('demo/synthetic-repository', { providerId: 'demo' })
  }

  /**
   * Re-run the load for the current repository with the current settings and
   * token. Cached payloads are reused, so this mostly spends quota on the file
   * changes that were skipped earlier.
   */
  async reload(): Promise<void> {
    const url = store.url
    if (!url || store.loading.active) return
    await this.load(url, { providerId: store.forcedProvider ?? undefined })
  }

  backToLanding(): void {
    this.cancelLoad()
    this.resetEngine()
    this.rawCommits = []
    this.repoInfo = null
    this.timeline = null
    resetRunState()
    store.repo = null
    store.view = 'landing'
  }

  private resetEngine(): void {
    if (this.recorder) {
      void this.recorder.cancel()
      this.recorder = null
    }
    this.stopProgressTimer()
    store.recording.active = false
    store.recording.progress = null
    this.engine?.dispose()
    this.engine = null
  }

  /** Update the URL field and provider detection while typing. */
  setUrl(value: string): void {
    store.url = value
    store.forcedProvider = null
  }

  /** Timeline accessor used by the filter UI. */
  timelineAuthors(): Timeline['authors'] {
    return this.timeline?.authors ?? []
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

export const controller = new VisualizerController()
