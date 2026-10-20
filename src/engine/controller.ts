import { describeGitError } from '../git/errors'
import { loadHistory, type LoadResult, type LoadStage } from '../git/loader'
import { resolveRepoInput, type ResolvedRepo } from '../git/providers'
import type { RawCommit, RepoInfo } from '../git/types'
import { buildTimeline, bucketActivity, type TimelineProjectInput } from '../timeline/builder'
import { compileIgnoredFolders, normaliseIgnoredFolders } from '../timeline/ignore'
import type { SizeMode } from '../sim/simulation'
import {
  authorKey,
  legacyAuthorKey,
  projectPath,
  scopedAuthorId,
  type ActivityBucket,
  type Timeline,
} from '../timeline/types'
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
import { BackgroundMusic, decodeMusicFile, fadeGain, type MusicSource } from './audio/music'
import { analyzeMusic, silentLevels, type AudioAnalysis, type AudioLevels } from './audio/analysis'
import { MicrophoneSource } from './audio/microphone'
import {
  persistLoadOptions,
  persistFilters,
  persistMusic,
  persistSettings,
  resetRunState,
  resolvePacing,
  setLastUrls,
  store,
  tokenFor,
} from '../state/store'
import type { MusicSettings } from '../state/store'
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
  /** Every repository queued for this run, in load order. */
  private sources: SourceLoad[] = []
  /** True when the run asked for more than one repository. */
  private multi = false
  /** Host-reported file sizes for the current snapshot (project-scoped). */
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
  /** Live background music and the decoded PCM used by exports. */
  private readonly musicPlayer = new BackgroundMusic()
  private musicSource: MusicSource | null = null
  private musicUrl: string | null = null
  /** Precomputed bands that drive the reactive visuals. */
  private musicAnalysis: AudioAnalysis | null = null
  /** Live microphone audio, used instead of the file while it is selected. */
  private readonly microphone = new MicrophoneSource()
  /** Reused whenever a frame samples the analysis. */
  private readonly audioLevels = silentLevels()
  /** True once the track has actually produced levels; a pause freezes them. */
  private audioWasPlaying = false
  /** Length of the current export in video seconds (for the fade envelope). */
  private exportVideoDuration = 0

  constructor() {
    this.musicPlayer.setClock(() => {
      const engine = this.engine
      if (!engine) return null
      return {
        time: engine.position,
        duration: engine.duration,
        speed: engine.currentSpeed,
        playing: engine.isPlaying,
      }
    })
  }

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
        projects: this.timeline?.projects.length ?? 0,
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
    // The stage is gone: release the microphone with it instead of leaving the
    // browser's recording indicator on.
    this.stopMicrophone()
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

  /** Load one repository (single-project mode). */
  async load(input: string, options: { providerId?: string } = {}): Promise<void> {
    await this.loadMany([input], options)
  }

  /**
   * Load several repositories into one scene.
   *
   * Each project keeps its own file tree and its own author instances: the same
   * person committing in two repositories appears as two avatars, one per
   * project. Sources load sequentially so a rate-limited host cannot starve the
   * next one, and only the first source streams live while the others are
   * merged when they finish (a later project may contain older commits, which
   * would otherwise reorder an already-rendered timeline).
   */
  async loadMany(inputs: string[], options: { providerId?: string } = {}): Promise<void> {
    this.cancelLoad()
    this.resetEngine()
    this.rawCommits = []
    this.sources = []
    this.multi = false
    this.fileSizes = new Map()
    this.sizesTruncated = false
    this.sizeSource = 'unavailable'
    this.repoInfo = null
    this.timeline = null
    resetRunState()
    const urls = dedupe(inputs.map((input) => input.trim()).filter(Boolean))
    store.forcedProvider = options.providerId ?? null
    store.view = 'landing'
    setLastUrls(urls)

    if (urls.length === 0) {
      store.loading.error = 'Add at least one repository URL.'
      return
    }

    // Resolve everything before contacting a host, so a typo in the second row
    // does not waste quota on the first one.
    const sources: SourceLoad[] = []
    for (const input of urls) {
      try {
        const resolved = resolveRepoInput(input, {
          providerId: options.providerId ?? store.forcedProvider ?? undefined,
        })
        sources.push({
          input,
          resolved,
          label: `${resolved.parsed.owner}/${resolved.parsed.repo}`,
          repo: null,
          merged: false,
          sizesMerged: false,
          live: false,
          commits: [],
          fileSizes: new Map(),
          sizesTruncated: false,
          sizeSource: 'unavailable',
          truncated: false,
          warnings: [],
          error: null,
        })
      } catch (error) {
        const message = describeGitError(error)
        sources.push({
          input,
          resolved: null,
          label: input,
          repo: null,
          merged: false,
          sizesMerged: false,
          live: false,
          commits: [],
          fileSizes: new Map(),
          sizesTruncated: false,
          sizeSource: 'unavailable',
          truncated: false,
          warnings: [],
          error: message,
        })
      }
    }
    this.sources = sources
    this.multi = sources.length > 1
    for (const source of sources) {
      if (source.error) this.addWarning(`${source.label}: ${source.error}`)
    }

    if (sources.every((source) => !source.resolved)) {
      store.loading.error = sources.map((source) => `${source.input}: ${source.error}`).join('\n')
      store.loading.status = 'Failed'
      return
    }

    const abort = new AbortController()
    this.abort = abort
    store.loading.active = true
    store.loading.status = this.multi ? `Loading ${sources.length} repositories…` : 'Contacting the host…'
    store.loading.target = store.loadOptions.maxCommits
    store.loading.requests = 0
    store.loading.error = null
    store.loading.streaming = false
    store.loading.total = sources.length

    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]
      store.loading.index = index + 1
      store.loading.total = sources.length
      store.loading.project = source.label
      store.loading.loaded = 0
      store.loading.target = Math.max(1, store.loadOptions.maxCommits)
      store.loading.requests = 0
      if (!source.resolved) continue
      if (abort.signal.aborted) break

      // The first source with no data yet streams straight into the engine;
      // later sources are merged when complete (see the class comment).
      source.live = this.rawCommits.length === 0
      store.loading.active = true
      store.loading.streaming = this.rawCommits.length > 0
      store.loading.status = this.stageStatus(source, `Contacting ${source.resolved.provider.name}…`)

      const token = tokenFor(source.resolved.provider.id)
      try {
        const result = await loadHistory(source.resolved, {
          maxCommits: store.loadOptions.maxCommits,
          range: store.loadOptions.range,
          branch: store.loadOptions.branch || undefined,
          token,
          signal: abort.signal,
          onStage: (stage) => this.handleStage(stage, source),
          onRepo: (repo) => this.attachRepo(source, repo),
          onFileSizes: ({ fileSizes, truncated, source: sizeSource }) => {
            source.fileSizes = this.scopeSizes(source, fileSizes)
            source.sizesTruncated = truncated
            source.sizeSource = sizeSource
            if (source.live) {
              source.sizesMerged = true
              this.recomputeSizes()
              this.engine?.extendSizes(this.fileSizes)
            }
          },
          onCommits: (batch) => this.appendBatch(source, batch),
        })
        if (abort.signal.aborted) break
        this.finishSource(source, result)
      } catch (error) {
        if (abort.signal.aborted) break
        source.error = describeGitError(error)
        this.addWarning(`${source.label}: ${source.error}`)
        this.mergeSource(source)
        this.refreshRepos()
        if (this.rawCommits.length > 0) this.rebuildTimeline({ keepPosition: true })
        store.loading.active = false
      }
      this.refreshRepos()
      store.loading.rateRemaining = source.rateRemaining ?? store.loading.rateRemaining
    }

    this.abort = null
    if (abort.signal.aborted) {
      store.loading.active = false
      store.loading.streaming = false
      store.loading.status = 'Cancelled'
      return
    }

    const loaded = this.sources.filter((source) => source.merged && source.commits.length > 0)
    store.loading.streaming = false
    store.loading.active = false
    store.loading.index = 0
    store.loading.total = 0
    store.loading.project = null
    if (loaded.length === 0 || !this.timeline) {
      const reasons = this.sources.map((source) => `${source.label}: ${source.error ?? 'no visualizable commits'}`)
      store.loading.error = reasons.length === 1 ? reasons[0] : `No repository could be loaded.\n${reasons.join('\n')}`
      store.loading.status = 'Failed'
      store.view = 'landing'
      persistLoadOptions()
      return
    }

    // Final rebuild so stats, warnings and project counts reflect the complete
    // window (and any filter applied while the later repositories loaded).
    this.rebuildTimeline({ keepPosition: true })
    const failed = this.sources.filter((source) => source.error && source.commits.length === 0).length
    store.loading.status = failed > 0 ? `Ready · ${failed} of ${this.sources.length} repositories failed` : 'Ready'
    persistLoadOptions()
  }

  cancelLoad(): void {
    this.abort?.abort()
    this.abort = null
    store.loading.active = false
    store.loading.streaming = false
    store.loading.status = 'Cancelled'
  }

  /** Prefix a per-source stage message with the project position in the queue. */
  private stageStatus(source: SourceLoad, status: string): string {
    if (this.sources.length <= 1) return status
    const index = this.sources.indexOf(source) + 1
    return `${index}/${this.sources.length} · ${source.label} · ${status}`
  }

  private handleStage(stage: LoadStage, source: SourceLoad): void {
    store.loading.active = stage.kind !== 'done'
    store.loading.status = this.stageStatus(source, stage.status)
    store.loading.project = source.repo?.fullName ?? source.label
    if (stage.kind === 'fetching') {
      store.loading.loaded = Math.max(store.loading.loaded, stage.loaded)
      store.loading.target = Math.max(1, stage.target)
      store.loading.requests = stage.requests
      if (stage.rateRemaining !== undefined) store.loading.rateRemaining = stage.rateRemaining
    }
    if (stage.kind === 'done') {
      store.loading.loaded = stage.loaded
      store.loading.target = Math.max(stage.loaded, store.loading.target)
    }
  }

  /** Record the repository metadata as soon as the host reports it. */
  private attachRepo(source: SourceLoad, repo: RepoInfo): void {
    source.repo = repo
    source.label = repo.fullName
    this.assignProjectKey(source)
    if (!this.repoInfo) this.repoInfo = repo
    this.refreshRepos()
    store.loading.project = repo.fullName
  }

  /**
   * Give a project its unique namespace for paths and author ids.
   *
   * The `owner/name` is used verbatim so the tree reads naturally; only exact
   * duplicates between providers get a `~2` suffix. Single-project loads stay
   * unscoped, which keeps their tree and author ids exactly as before.
   */
  private assignProjectKey(source: SourceLoad): void {
    if (!this.multi) {
      source.key = undefined
      return
    }
    const base = source.repo?.fullName || source.label
    let key = base
    let suffix = 2
    while (this.sources.some((other) => other !== source && other.key === key)) {
      key = `${base}~${suffix}`
      suffix += 1
    }
    source.key = key
  }

  /** Receive a hydrated batch and update the visualization incrementally. */
  private appendBatch(source: SourceLoad, batch: RawCommit[]): void {
    if (batch.length === 0) return
    const projectName = source.repo?.fullName ?? source.label
    const tagged = batch.map((commit) => ({ ...commit, projectKey: source.key, projectName }))
    source.commits.push(...tagged)
    if (!source.live) return
    source.merged = true
    this.rawCommits.push(...tagged)
    this.rebuildTimeline({ keepPosition: true, streaming: true })
    if (!store.loading.streaming) {
      store.loading.streaming = true
      store.loading.status = this.stageStatus(source, 'Streaming commits into the visualization…')
    }
  }

  /** Copy a completed source's commits and sizes into the shared timeline. */
  private mergeSource(source: SourceLoad): void {
    if (!source.merged) {
      source.merged = true
      this.rawCommits.push(...source.commits)
    }
    if (!source.sizesMerged) {
      source.sizesMerged = true
      this.recomputeSizes()
    }
  }

  /** Store a per-source result, then rebuild (or reset) the scene. */
  private finishSource(source: SourceLoad, result: LoadResult): void {
    source.repo = result.repo
    source.label = result.repo.fullName
    source.truncated = result.truncated
    source.warnings = result.warnings
    source.rateRemaining = result.rateRemaining
    source.error = null
    if (!source.sizesMerged) {
      // sizeSource/sizesTruncated are already from onFileSizes; keep the
      // authoritative result in case the host reported nothing.
      source.sizesTruncated = source.sizesTruncated || result.sizesTruncated
      if (source.sizeSource === 'unavailable') source.sizeSource = result.sizeSource
    }
    if (!this.repoInfo) this.repoInfo = result.repo
    this.assignProjectKey(source)
    this.refreshRepos()
    this.addWarnings(result.warnings, source)
    this.mergeSource(source)
    this.refreshRepos()

    // A final non-streaming rebuild updates stats and warnings. Live sources
    // already streamed their commits, so this only resets once per source.
    this.rebuildTimeline({ keepPosition: true })
  }

  /** Add source-specific warnings, naming the project when several are loaded. */
  private addWarnings(warnings: string[], source?: SourceLoad): void {
    const prefix = source && this.multi ? `${source.label}: ` : ''
    store.warnings = dedupe([...store.warnings, ...warnings.map((warning) => `${prefix}${warning}`)])
  }

  private addWarning(warning: string): void {
    store.warnings = dedupe([...store.warnings, warning])
  }

  /** Prefix every reported file path with the project's namespace. */
  private scopeSizes(source: SourceLoad, sizes: Map<string, number>): Map<string, number> {
    if (!source.key) return new Map(sizes)
    const scoped = new Map<string, number>()
    for (const [path, bytes] of sizes) scoped.set(projectPath(source.key, path), bytes)
    return scoped
  }

  /** Recombine the per-project size maps into the map handed to the builder. */
  private recomputeSizes(): void {
    const merged = new Map<string, number>()
    const sources = new Set<string>()
    let truncated = false
    for (const source of this.sources) {
      if (!source.sizesMerged) continue
      for (const [path, bytes] of source.fileSizes) merged.set(path, bytes)
      if (source.sizesTruncated) truncated = true
      if (source.sizeSource && source.sizeSource !== 'unavailable') sources.add(source.sizeSource)
    }
    this.fileSizes = merged
    this.sizesTruncated = truncated
    const distinct = [...sources]
    this.sizeSource = distinct.length === 0 ? 'unavailable' : distinct.length === 1 ? distinct[0] : 'mixed'
  }

  /** Keep `store.repos` in sync with the projects that actually have content. */
  private refreshRepos(): void {
    const repos = this.sources
      // A source joins the list only after its commits are merged: while it is
      // still loading (or if the run is cancelled) the scene keeps showing the
      // projects that are really there.
      .filter((source) => source.repo && source.merged && source.commits.length > 0)
      .map((source) => source.repo as RepoInfo)
    store.repos = repos
    store.repo = repos[0] ?? this.timeline?.repo ?? null
  }

  /** Rebuild the timeline (filters included) and hand it to the engine. */
  private rebuildTimeline(options: { keepPosition?: boolean; streaming?: boolean } = {}): void {
    const repo = this.repoInfo ?? store.repos[0] ?? store.repo
    if (!repo || this.rawCommits.length === 0) return
    const filter = this.buildFilter()
    const fileFilter = this.buildFileFilter()
    const projects: TimelineProjectInput[] = this.sources
      // Match `store.repos`: a project appears once it has real commits, not
      // while it is still being fetched or after a failure with no data.
      .filter((source) => source.repo && source.merged && source.commits.length > 0)
      .map((source) => ({
        key: source.key ?? '',
        repo: source.repo as RepoInfo,
        truncated: source.truncated,
        warnings: source.warnings,
        sizeSource: source.sizeSource,
      }))
    const timeline = buildTimeline(repo, this.rawCommits, {
      filter,
      fileFilter,
      truncated: store.timelineTruncated,
      warnings: store.warnings,
      fileSizes: this.fileSizes,
      sizesTruncated: this.sizesTruncated,
      sizeSource: this.sizeSource,
      projects: projects.length > 0 ? projects : undefined,
    })
    if (timeline.commits.length === 0) {
      store.warnings = dedupe([...store.warnings, 'The current filters exclude every commit. Widen the filters to see activity.'])
      return
    }
    this.timeline = timeline
    store.timelineStats = timeline.stats
    store.repo = timeline.repo
    store.timelineTruncated = timeline.projects.some((project) => project.truncated)

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
    engine.setAudioLevelsProvider(this.audioLevelsFor)
    this.engine = engine
    store.view = 'stage'
    engine.start()
    engine.play()
  }

  private onHud(hud: HudState): void {
    store.hud = hud
    this.syncMusic()
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
        const base = authorKey(commit.author)
        // Hiding a project-scoped author hides that person in that project only;
        // a base id (saved by an older profile) still hides them everywhere.
        const scoped = scopedAuthorId(commit.projectKey, base)
        if (hidden.has(scoped) || hidden.has(base)) return false
        // Profiles saved before repeated usernames were separated stored
        // login-first ids. Keep those filters working, including scoped ones.
        const legacy = legacyAuthorKey(commit.author)
        if (legacy !== base) {
          const legacyScoped = scopedAuthorId(commit.projectKey, legacy)
          if (hidden.has(legacyScoped) || hidden.has(legacy)) return false
        }
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
    this.syncMusic(true)
  }

  pause(): void {
    this.engine?.pause()
    this.syncMusic()
  }

  togglePlay(): void {
    this.engine?.togglePlay()
    this.syncMusic(true)
  }

  seek(time: number): void {
    this.engine?.seek(time)
    this.syncMusic()
  }

  seekToIndex(index: number): void {
    this.engine?.seekToIndex(index)
    this.syncMusic()
  }

  seekToDate(ms: number): void {
    this.engine?.seekToDate(ms)
    this.syncMusic()
  }

  step(delta: number): void {
    this.engine?.step(delta)
    this.syncMusic()
  }

  restart(): void {
    this.engine?.restart()
    this.syncMusic(true)
  }

  setSpeed(speed: number): void {
    this.engine?.setSpeed(speed)
    this.syncMusic()
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
   * Immersive WebXR
   * ------------------------------------------------------------------ */

  /**
   * Enter or leave an immersive VR session.
   *
   * Frames are driven by the engine (through three's XR-aware animation loop),
   * so this only has to hand the request to it. Failures are reported in
   * `store.ui.xrError` by the session itself; the session is never entered
   * without a running scene to show.
   */
  toggleVr(): void {
    if (!this.engine) {
      store.ui.xrError = 'Load a repository first: the VR view needs the running scene.'
      return
    }
    void this.engine.toggleVr()
  }

  /* ------------------------------------------------------------------ *
   * Gamepad and head tracking
   * ------------------------------------------------------------------ */

  /** Turn gamepad camera control on or off. */
  setGamepadEnabled(enabled: boolean): void {
    this.updateSettings({ gamepad: enabled })
  }

  /**
   * Turn head tracking (the device gyroscope) on or off.
   *
   * Browsers only show the motion-sensor prompt from a user gesture, which is
   * the settings toggle that calls this; a refusal (or a device without the
   * sensor) is reported in `store.ui.gyroError` instead of failing silently.
   */
  async setGyroEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.updateSettings({ gyro: false })
      this.engine?.disableGyro()
      store.ui.gyroActive = false
      store.ui.gyroError = null
      return
    }
    if (!this.engine) {
      store.ui.gyroError = 'Load a repository first: head tracking moves the running scene.'
      return
    }
    const granted = await this.engine.enableGyro()
    if (!granted) {
      store.ui.gyroError = 'The browser refused access to the motion sensors.'
      return
    }
    store.ui.gyroError = null
    this.updateSettings({ gyro: true })
  }

  /**
   * Bind the current device pose to the current camera pose: the view does not
   * move, and every later head rotation is measured from there. This is what a
   * click on the scene (or the gamepad's A button) does.
   */
  recalibrateOrientation(): void {
    this.engine?.recalibrateOrientation()
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
      showBeams: settings.showBeams,
      beamStyle: settings.beamStyle,
      beamTravelSeconds: settings.beamTravelSeconds,
      beamIntensity: settings.beamIntensity,
      beamWidth: settings.beamWidth,
      showPlasma: settings.showPlasma,
      plasmaIntensity: settings.plasmaIntensity,
      plasmaOpacity: settings.plasmaOpacity,
      plasmaSharpness: settings.plasmaSharpness,
      plasmaWeight: settings.plasmaWeight,
      plasmaRadius: settings.plasmaRadius,
      plasmaDecay: settings.plasmaDecay,
      plasmaHeight: settings.plasmaHeight,
      plasmaSteps: settings.plasmaSteps,
    }
  }

  private cameraOptions(): {
    followActivity: boolean
    autoZoom: boolean
    smoothing: number
    gamepad: boolean
    gamepadSensitivity: number
    gyro: boolean
  } {
    return {
      followActivity: store.settings.followActivity,
      autoZoom: store.settings.autoZoom,
      smoothing: 1.4,
      gamepad: store.settings.gamepad,
      gamepadSensitivity: store.settings.gamepadSensitivity,
      gyro: store.settings.gyro,
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
   * Background music
   * ------------------------------------------------------------------ */

  /** True when a decoded track is ready for playback and export. */
  get hasMusic(): boolean {
    return this.musicSource !== null
  }

  /**
   * Decode an uploaded MP3, start looping it with the current envelope and make
   * it available to the next export. Decoding now (rather than at export time)
   * also validates the file while the user is still in the music panel.
   */
  async loadMusic(file: File): Promise<void> {
    const looksLikeMp3 =
      file.type === 'audio/mpeg' || file.type === 'audio/mp3' || /\.mp3$/i.test(file.name)
    if (!looksLikeMp3) {
      store.music.error = 'Choose an MP3 file (audio/mpeg).'
      return
    }

    this.releaseMusic()
    store.music.loading = true
    store.music.error = null
    store.music.fileName = null
    store.music.duration = 0
    const url = URL.createObjectURL(file)

    try {
      const source = await decodeMusicFile(file)
      if (!source.channels.length || source.length === 0) throw new Error('the file contains no audio samples')
      // Analyse once, up front: the same envelopes then drive live playback and
      // the deterministic export. A failure here must not cost the track, so it
      // only disables the reactive visuals.
      let analysis: AudioAnalysis | null = null
      try {
        analysis = analyzeMusic(source)
      } catch {
        analysis = null
      }
      this.musicSource = source
      this.musicAnalysis = analysis
      this.audioWasPlaying = false
      this.musicUrl = url
      this.musicPlayer.load(url, source.duration)
      this.musicPlayer.setSettings(this.musicSettings())
      store.music.fileName = file.name
      store.music.duration = source.duration
      store.music.loading = false
      this.syncMusic(true)
    } catch (error) {
      URL.revokeObjectURL(url)
      this.musicSource = null
      store.music.loading = false
      store.music.fileName = null
      store.music.error = `Could not read ${file.name}: ${(error as Error).message}`
    }
  }

  /** Remove the current track and release its decoded data. */
  clearMusic(): void {
    this.releaseMusic()
    store.music.fileName = null
    store.music.duration = 0
    store.music.loading = false
    store.music.error = null
  }

  /**
   * Choose what feeds the reactive visuals and the live recording: the uploaded
   * file, or the microphone.
   *
   * Switching to the microphone pauses — but keeps — the decoded track, so
   * switching back resumes it without decoding the file again. Permission and
   * device failures leave the previous source untouched and are reported in
   * `store.music.error`.
   */
  async setAudioSource(source: 'file' | 'microphone'): Promise<void> {
    if (source === 'file') {
      // Stopping the capture ends the tracks, so the browser's recording
      // indicator goes away before the file resumes.
      this.microphone.stop()
      store.music.source = 'file'
      store.music.error = null
      this.audioWasPlaying = false
      this.syncMusic(true)
      return
    }

    if (this.microphone.running) {
      store.music.source = 'microphone'
      store.music.error = null
      return
    }

    // Keep the decoded track loaded but silent while the microphone is live.
    this.musicPlayer.pause()
    this.audioWasPlaying = false
    try {
      await this.microphone.start()
    } catch (error) {
      this.microphone.stop()
      // Still on the file: bring its playback back, then report the failure.
      this.syncMusic(true)
      store.music.error = describeMicrophoneError(error)
      return
    }
    store.music.source = 'microphone'
    store.music.error = null
    // Fade in from silence; the next animation frame writes the real envelope.
    this.microphone.setFade(0)
  }

  /** Update volume and fade lengths, then persist and apply them immediately. */
  updateMusic(patch: Partial<Pick<MusicSettings, 'volume' | 'fadeInSeconds' | 'fadeOutSeconds'>>): void {
    if (patch.volume !== undefined) store.music.volume = Math.max(0, Math.min(1, patch.volume))
    if (patch.fadeInSeconds !== undefined) store.music.fadeInSeconds = Math.max(0, patch.fadeInSeconds)
    if (patch.fadeOutSeconds !== undefined) store.music.fadeOutSeconds = Math.max(0, patch.fadeOutSeconds)
    persistMusic()
    this.musicPlayer.setSettings(this.musicSettings())
    this.syncMusic()
  }

  private musicSettings(): { volume: number; fadeInSeconds: number; fadeOutSeconds: number } {
    return {
      volume: store.music.volume,
      fadeInSeconds: store.music.fadeInSeconds,
      fadeOutSeconds: store.music.fadeOutSeconds,
    }
  }

  /**
   * Bands for the frame being drawn.
   *
   * Live playback samples the position of the looping audio element (what the
   * viewer actually hears). The export samples the same analysis at the video
   * timestamp and applies the same fade envelope as the encoded audio, so the
   * rendered file is deterministic and matches its soundtrack.
   *
   * With the microphone selected the live branch reads the bands from the
   * microphone instead, and there are no export bands at all: a live signal
   * cannot be rendered deterministically, so the export stays video-only.
   */
  private audioLevelsFor = (mode: 'live' | 'export', videoTime: number): AudioLevels | null => {
    const microphoneLive = this.microphone.running && store.music.source === 'microphone'
    if (microphoneLive) {
      // The engine calls this every frame, so this is where the microphone
      // gain follows the file player's fade envelope — even while a live
      // recording runs or the reactive visuals are switched off. Without it a
      // capture would start and end at full volume.
      this.microphone.setFade(this.hudFade() * store.music.volume)
    }

    if (!store.settings.audioReactive) return null

    if (microphoneLive) {
      if (mode === 'export') return null
      const gain = this.hudFade()
      this.microphone.readLevels(this.audioLevels)
      if (!(gain > 0.001)) return null
      this.audioLevels.bass *= gain
      this.audioLevels.low *= gain
      this.audioLevels.mid *= gain
      this.audioLevels.voice *= gain
      this.audioLevels.clap *= gain
      return this.audioLevels
    }

    const analysis = this.musicAnalysis
    if (!analysis) return null

    let gain = 1
    if (mode === 'export') {
      analysis.sample(analysis.duration > 0 ? videoTime % analysis.duration : 0, this.audioLevels)
      if (this.exportVideoDuration > 0) {
        gain = fadeGain(
          videoTime,
          this.exportVideoDuration,
          store.music.fadeInSeconds,
          store.music.fadeOutSeconds,
        )
      }
    } else {
      if (!this.musicPlayer.playing) {
        // Pausing freezes the whole scene; keep the colours it was paused with
        // instead of snapping the palette back to its base.
        return this.audioWasPlaying ? this.audioLevels : null
      }
      this.audioWasPlaying = true
      analysis.sample(this.musicPlayer.position, this.audioLevels)
      const hud = store.hud
      if (hud) {
        const speed = hud.speed > 0.05 ? hud.speed : 1
        gain = fadeGain(
          hud.time / speed,
          hud.duration / speed,
          store.music.fadeInSeconds,
          store.music.fadeOutSeconds,
        )
      }
    }

    if (!(gain > 0.001)) return null
    this.audioLevels.bass *= gain
    this.audioLevels.low *= gain
    this.audioLevels.mid *= gain
    this.audioLevels.voice *= gain
    this.audioLevels.clap *= gain
    return this.audioLevels
  }

  /**
   * Fade factor at the current HUD position, with the same time/speed mapping
   * the file branch uses. Returns 1 before the first HUD update.
   */
  private hudFade(): number {
    const hud = store.hud
    if (!hud) return 1
    const speed = hud.speed > 0.05 ? hud.speed : 1
    return fadeGain(
      hud.time / speed,
      hud.duration / speed,
      store.music.fadeInSeconds,
      store.music.fadeOutSeconds,
    )
  }

  private releaseMusic(): void {
    this.musicPlayer.unload()
    this.musicSource = null
    this.musicAnalysis = null
    this.audioWasPlaying = false
    if (this.musicUrl) URL.revokeObjectURL(this.musicUrl)
    this.musicUrl = null
  }

  /** Start/stop the music with the animation and surface autoplay blocks. */
  private syncMusic(retry = false): void {
    if (store.music.source === 'microphone' && this.microphone.running) {
      // The microphone is the audible source: keep the looping file silent
      // while the same animation clock keeps running.
      this.musicPlayer.pause()
      return
    }
    this.musicPlayer.sync(retry)
    const error = this.musicPlayer.error
    if (error) {
      if (store.music.error !== error) store.music.error = error
    } else if (store.music.error?.startsWith('The browser blocked background music')) {
      store.music.error = null
    }
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
      // Video seconds, used by the reactive visuals' fade envelope.
      this.exportVideoDuration = engine.duration / speed
      const result = await exporter.run({
        duration: engine.duration,
        choice,
        width: settings.width,
        height: settings.height,
        // The export follows the playback speed selected in the app.
        speed,
        bitrate: store.export.bitrate > 0 ? store.export.bitrate : undefined,
        // In microphone mode there is nothing to encode deterministically: the
        // export stays video-only.
        audio:
          this.musicSource && store.music.source === 'file'
            ? {
                source: this.musicSource,
                volume: store.music.volume,
                fadeInSeconds: store.music.fadeInSeconds,
                fadeOutSeconds: store.music.fadeOutSeconds,
              }
            : undefined,
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
      store.export.lastLabel = `${result.choice.label}${result.choice.hardwareAccelerated ? ' · hardware' : ''}${result.audio ? ' · music' : ''}`
      store.export.lastBytes = result.bytes
      store.export.lastFrames = result.frames
      store.export.lastSeconds = result.seconds
      store.export.lastElapsed = result.elapsed
      store.export.lastSpeed = result.speed
      store.export.lastHardware = result.choice.hardwareAccelerated
      store.export.lastMusic = result.audio
    } catch (error) {
      store.export.error =
        error instanceof ExportCancelledError
          ? null
          : `Export failed: ${(error as Error).message}`
    } finally {
      this.exporter = null
      this.exportVideoDuration = 0
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
    const name = `${this.downloadLabel()}-gource-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
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
      // Mix the selected source into the live capture. The microphone stream
      // already carries the fade envelope written by the render loop; the file
      // player taps its own gain node, so the recording follows the same
      // fade-in and fade-out as the playback. The two are never mixed together.
      const audioStream =
        store.music.source === 'microphone'
          ? this.microphone.captureStream()
          : await this.musicPlayer.captureStream()
      this.recorder.start(
        {
          width: settings.width,
          height: settings.height,
          fps: EXPORT_FPS,
          mimeType: format,
        },
        audioStream,
      )
      store.recording.active = true
      this.recordingStartedAt = performance.now()
      this.startProgressTimer()
      this.engine.play()
    } catch (error) {
      store.recording.error = (error as Error).message
      await this.recorder.cancel().catch(() => undefined)
      this.recorder = null
      store.recording.active = false
      this.musicPlayer.releaseCapture()
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
    this.musicPlayer.releaseCapture()
    engine.clearFixedSize()
  }

  async cancelRecording(): Promise<void> {
    if (this.recorder) {
      await this.recorder.cancel().catch(() => undefined)
      this.recorder = null
    }
    this.musicPlayer.releaseCapture()
    this.engine?.endRecording()
    this.engine?.clearFixedSize()
    store.recording.active = false
    store.recording.progress = null
    this.stopProgressTimer()
  }

  downloadRecording(): void {
    const url = store.recording.lastUrl
    if (!url) return
    const name = `${this.downloadLabel()}-gource-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
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
    await this.loadMany(['demo/synthetic-repository'], { providerId: 'demo' })
  }

  /**
   * Re-run the load for the current projects with the current settings and
   * token. Cached payloads are reused, so this mostly spends quota on the file
   * changes that were skipped earlier.
   */
  async reload(): Promise<void> {
    if (store.loading.active) return
    const inputs = this.sources.length > 0 ? this.sources.map((source) => source.input) : store.loadOptions.urls
    const urls = inputs.map((input) => input.trim()).filter(Boolean)
    if (urls.length === 0) return
    await this.loadMany(urls, { providerId: store.forcedProvider ?? undefined })
  }

  backToLanding(): void {
    this.cancelLoad()
    this.resetEngine()
    // Back to the landing view: the microphone must not stay open.
    this.stopMicrophone()
    this.rawCommits = []
    this.sources = []
    this.multi = false
    this.repoInfo = null
    this.timeline = null
    resetRunState()
    store.view = 'landing'
  }

  /** File-name stem for downloads: one repository name, or the project count. */
  private downloadLabel(): string {
    const repos = store.repos.length > 0 ? store.repos : store.repo ? [store.repo] : []
    if (repos.length > 1) return `${repos.length}-repositories`
    return repos[0]?.name ?? 'repository'
  }

  /** Stop the capture and fall back to the file source. */
  private stopMicrophone(): void {
    this.microphone.stop()
    if (store.music.source === 'microphone') {
      store.music.source = 'file'
      store.music.error = null
    }
  }

  private resetEngine(): void {
    if (this.recorder) {
      void this.recorder.cancel()
      this.recorder = null
    }
    this.stopProgressTimer()
    this.musicPlayer.releaseCapture()
    this.musicPlayer.pause()
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

/** One repository queued for a load, with the state accumulated per source. */
interface SourceLoad {
  input: string
  resolved: ResolvedRepo | null
  /** Display label: `owner/name` once known, the raw input before that. */
  label: string
  repo: RepoInfo | null
  /** Project namespace (undefined for a single-repository load). */
  key?: string
  /** Commits already copied into the controller's shared raw list. */
  merged: boolean
  /** File sizes already included in the shared size map. */
  sizesMerged: boolean
  /** The first source with no data yet streams straight into the engine. */
  live: boolean
  /** Tagged commits from this source (all of them, whether merged or not). */
  commits: RawCommit[]
  /** File sizes, already namespaced with {@link key}. */
  fileSizes: Map<string, number>
  sizesTruncated: boolean
  sizeSource: string
  truncated: boolean
  warnings: string[]
  rateRemaining?: number
  error: string | null
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

/** Turn a `getUserMedia` failure into a message the music panel can show. */
function describeMicrophoneError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Allow it in the browser, then choose the microphone again.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found on this device.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is already in use by another application.'
  }
  const message = error instanceof Error && error.message ? error.message : ''
  return message ? `Could not start the microphone: ${message}` : 'Could not start the microphone.'
}

export const controller = new VisualizerController()
