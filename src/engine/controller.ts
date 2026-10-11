import { GitError, describeGitError } from '../git/errors'
import { loadHistory, type LoadStage } from '../git/loader'
import { resolveRepoInput, demoProvider } from '../git/providers'
import type { RawCommit, RepoInfo } from '../git/types'
import { buildTimeline, bucketActivity } from '../timeline/builder'
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
import { persistLoadOptions, persistSettings, resetRunState, resolvePacing, store, tokenFor } from '../state/store'
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
      nodes: this.simulation?.nodes.length ?? 0,
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
    this.repoInfo = null
    this.timeline = null
    resetRunState()
    store.url = input
    store.forcedProvider = options.providerId ?? null
    store.view = 'landing'

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
        onCommits: (batch) => this.appendBatch(batch),
      })
      this.repoInfo = result.repo
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
    const timeline = buildTimeline(repo, this.rawCommits, {
      filter,
      truncated: store.timelineTruncated,
      warnings: store.warnings,
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

  applyFilters(filters: { hiddenAuthors?: string[]; from?: number | null; to?: number | null }): void {
    if (filters.hiddenAuthors) store.hiddenAuthors = [...filters.hiddenAuthors]
    if (filters.from !== undefined) store.dateRange.from = filters.from
    if (filters.to !== undefined) store.dateRange.to = filters.to
    this.rebuildTimeline({ keepPosition: true })
  }

  clearFilters(): void {
    store.hiddenAuthors = []
    store.dateRange = { from: null, to: null }
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
      fileSize: settings.fileSize,
      particleIntensity: settings.particleIntensity,
      showLabels: settings.showLabels,
      showDirectoryLabels: settings.showDirectoryLabels,
      showFileLabels: settings.showFileLabels,
      showAuthorNames: settings.showAuthorNames,
      showAuthorGlow: settings.showAuthorGlow,
      authorScale: settings.authorScale,
      showStars: settings.showStars,
      fogDensity: settings.fogDensity,
    }
  }

  private cameraOptions(): { followActivity: boolean; autoRotate: boolean; autoZoom: boolean } {
    return {
      followActivity: store.settings.followActivity,
      autoRotate: store.settings.autoRotate,
      autoZoom: store.settings.autoZoom,
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

  /** Activity histogram in simulated time (falls back to real-time bucketing). */
  activityBuckets(count = 320): ActivityBucket[] {
    if (this.engine && this.timeline) return this.engine.activityBuckets(count)
    if (this.timeline) return bucketActivity(this.timeline.commits, count)
    return []
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
    this.recorder = new VideoRecorder(this.engine.renderer.domElement)
    try {
      this.engine.pause()
      this.engine.resizeTo(settings.width, settings.height)
      this.engine.seek(0)
      this.recorder.start({
        width: settings.width,
        height: settings.height,
        fps: settings.fps,
        speed: settings.speed,
        mimeType: format,
      })
      this.engine.beginRecording(settings.fps, settings.speed)
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
