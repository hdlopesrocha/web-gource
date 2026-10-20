// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { controller } from '../src/engine/controller'
import { analyzeMusic, type AudioLevels } from '../src/engine/audio/analysis'
import type { MusicSource } from '../src/engine/audio/music'
import { resetRunState, store } from '../src/state/store'
import { createMockGithub, generateCommits, type MockCommit, type MockGithubOptions } from './helpers/mockGithub'
import StageView from '../src/ui/StageView.vue'

/**
 * End-to-end controller tests: the app logic that turns a repository URL into a
 * loaded timeline, filters, scrubbing and recording state.
 *
 * jsdom has no WebGL, which is also a useful case to cover: the app must
 * degrade with a clear message instead of crashing.
 */

const realFetch = globalThis.fetch
let counter = 0

interface MockApiOptions extends Omit<MockGithubOptions, 'owner' | 'repo' | 'commits' | 'failures'> {
  /** Failure rules, built from the generated repository name. */
  failures?: (repo: string) => MockGithubOptions['failures']
}

function mockApi(commits: MockCommit[], options: MockApiOptions = {}) {
  counter += 1
  const repo = `widget-${counter}`
  const mock = createMockGithub({ owner: 'acme', repo, commits, ...options, failures: options.failures?.(repo) })
  globalThis.fetch = mock.fetch
  return { mock, url: `https://github.com/acme/${repo}` }
}

interface MultiRepoSpec {
  label: string
  commits: MockCommit[]
  /** Failure rules, built from the generated repository name. */
  failures?: (repo: string) => MockGithubOptions['failures']
}

/**
 * Serve several GitHub repositories through one fetch, routing by the
 * repository pathname. Each call uses fresh repo names so URLs never collide.
 */
function mockMultiApi(specs: MultiRepoSpec[]) {
  const routes = specs.map((spec) => {
    counter += 1
    const repo = `${spec.label}-${counter}`
    const mock = createMockGithub({
      owner: 'acme',
      repo,
      commits: spec.commits,
      failures: spec.failures?.(repo),
    })
    return { repo, fullName: `acme/${repo}`, url: `https://github.com/acme/${repo}`, mock }
  })
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const pathname = new URL(url).pathname
    const route = routes.find((candidate) => pathname.includes(`/repos/acme/${candidate.repo}`))
    if (!route) return Promise.reject(new Error(`Unexpected request in multi-repository test: ${url}`))
    return route.mock.fetch(input, init)
  }
  return routes
}

beforeEach(() => {
  localStorage.clear()
  resetRunState()
  store.repo = null
  store.url = ''
  store.loadOptions.maxCommits = 150
  store.loadOptions.range = 'latest'
  store.dateRange = { from: null, to: null }
  store.hiddenAuthors = []
})

afterEach(() => {
  controller.backToLanding()
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('VisualizerController', () => {
  it('loads a repository and reports the timeline', async () => {
    const { url } = mockApi(generateCommits(30))
    await controller.load(url)

    expect(store.loading.active).toBe(false)
    expect(store.loading.error).toBeNull()
    expect(store.view).toBe('stage')
    expect(store.repo?.fullName).toMatch(/^acme\/widget-\d+$/)
    expect(store.timelineStats?.commits).toBe(30)
    expect(store.timelineStats?.authors).toBe(4)
    expect(controller.currentTimeline?.commits).toHaveLength(30)
    // The controller keeps the timeline playable even without a renderer.
    expect(controller.duration()).toBeGreaterThan(0)
    expect(controller.activityBuckets(10)).toHaveLength(10)
  })

  it('reports unsupported hosts and empty repositories as errors', async () => {
    await controller.load('https://bitbucket.org/team/repo')
    expect(store.loading.error).toContain('No provider is configured')
    expect(store.view).toBe('landing')

    const { url } = mockApi([], { empty: true })
    await controller.load(url)
    expect(store.loading.error).toMatch(/empty repository/i)
    expect(store.view).toBe('landing')
  })

  it('reports a missing repository', async () => {
    mockApi(generateCommits(5), { failures: (repo) => [{ path: new RegExp(`/repos/acme/${repo}`), status: 404 }] })
    await controller.load('https://github.com/acme/does-not-exist')
    expect(store.loading.error).toMatch(/not found/i)
    expect(store.view).toBe('landing')
  })

  it('loads two repositories into one scene', async () => {
    const routes = mockMultiApi([
      { label: 'alpha', commits: generateCommits(8) },
      { label: 'beta', commits: generateCommits(8) },
    ])
    const [alpha, beta] = routes
    await controller.loadMany(routes.map((route) => route.url))

    expect(store.view).toBe('stage')
    expect(store.loading.error).toBeNull()
    expect(store.loading.index).toBe(0)
    expect(store.loading.total).toBe(0)
    expect(store.loading.status).toBe('Ready')
    expect(store.timelineStats?.commits).toBe(16)
    expect(store.repos.map((repo) => repo.fullName)).toEqual([alpha!.fullName, beta!.fullName])

    const timeline = controller.currentTimeline!
    expect(timeline.projects).toHaveLength(2)
    for (const route of routes) {
      const project = timeline.projects.find((entry) => entry.repo.fullName === route.fullName)
      expect(project?.commits).toBe(8)
      expect(project?.authors).toBe(4)
    }

    const commitsFor = (fullName: string) => timeline.commits.filter((commit) => commit.projectKey === fullName)
    const alphaCommits = commitsFor(alpha!.fullName)
    const betaCommits = commitsFor(beta!.fullName)
    expect(alphaCommits).toHaveLength(8)
    expect(betaCommits).toHaveLength(8)

    const alphaPaths = alphaCommits.flatMap((commit) => commit.changes.map((change) => change.path))
    const betaPaths = betaCommits.flatMap((commit) => commit.changes.map((change) => change.path))
    expect(alphaPaths.length).toBeGreaterThan(0)
    expect(betaPaths.length).toBeGreaterThan(0)
    expect(alphaPaths.every((path) => path.startsWith(`${alpha!.fullName}/`))).toBe(true)
    expect(betaPaths.every((path) => path.startsWith(`${beta!.fullName}/`))).toBe(true)

    const alphaAuthors = timeline.authors.filter((author) => author.projectKey === alpha!.fullName)
    const betaAuthors = timeline.authors.filter((author) => author.projectKey === beta!.fullName)
    expect(alphaAuthors).toHaveLength(4)
    expect(betaAuthors).toHaveLength(4)
    expect(alphaAuthors.every((author) => author.id.startsWith(`${alpha!.fullName}::`))).toBe(true)
    expect(betaAuthors.every((author) => author.id.startsWith(`${beta!.fullName}::`))).toBe(true)

    // The same login is one person per project: distinct rows, shared identity
    // and colour, so avatars still read as the same person across the scene.
    const alphaAuthor = alphaAuthors.find((author) => author.login === 'author0')!
    const betaAuthor = betaAuthors.find((author) => author.login === 'author0')!
    expect(timeline.authors.filter((author) => author.login === 'author0')).toHaveLength(2)
    expect(alphaAuthor.id).not.toBe(betaAuthor.id)
    expect(alphaAuthor.baseId).toBe('login:author0|email:author0@example.com')
    expect(betaAuthor.baseId).toBe('login:author0|email:author0@example.com')
    expect(alphaAuthor.colorIndex).toBe(betaAuthor.colorIndex)
  })

  it('downloads repositories in parallel and merges them chronologically', async () => {
    const routes = mockMultiApi([
      { label: 'newer', commits: generateCommits(6, { startYear: 2022 }) },
      { label: 'older', commits: generateCommits(6, { startYear: 2019 }) },
    ])
    const [newer, older] = routes
    const active = new Set<string>()
    let overlapped = false
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      const pathname = new URL(url).pathname
      const route = routes.find((candidate) => pathname.includes(`/repos/acme/${candidate.repo}`))
      if (!route) return Promise.reject(new Error(`Unexpected request: ${url}`))
      active.add(route.repo)
      if (active.size > 1) overlapped = true
      try {
        // Hold the first response long enough for the other repository to start.
        await new Promise((resolve) => setTimeout(resolve, 5))
        return await route.mock.fetch(input, init)
      } finally {
        active.delete(route.repo)
      }
    }

    await controller.loadMany(routes.map((route) => route.url))

    expect(overlapped).toBe(true)
    const timeline = controller.currentTimeline!
    expect(timeline.projects).toHaveLength(2)
    expect(timeline.commits).toHaveLength(12)
    const timestamps = timeline.commits.map((commit) => commit.timestamp)
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b))
    expect(timeline.commits[0]?.projectKey).toBe(older!.fullName)
    expect(timeline.commits.at(-1)?.projectKey).toBe(newer!.fullName)
  })

  it('keeps successful repositories when another fails', async () => {
    const routes = mockMultiApi([
      { label: 'alpha', commits: generateCommits(6) },
      {
        label: 'beta',
        commits: generateCommits(6),
        failures: (repo) => [{ path: new RegExp(`/repos/acme/${repo}`), status: 404 }],
      },
    ])
    const [alpha, beta] = routes
    await controller.loadMany(routes.map((route) => route.url))

    expect(store.view).toBe('stage')
    expect(store.loading.error).toBeNull()
    expect(store.timelineStats?.commits).toBe(6)
    expect(store.repos.map((repo) => repo.fullName)).toEqual([alpha!.fullName])
    expect(controller.currentTimeline?.projects.map((project) => project.repo.fullName)).toEqual([alpha!.fullName])
    expect(store.warnings.join(' ')).toContain(beta!.fullName)
    expect(store.warnings.join(' ')).toMatch(/not found/i)
    expect(store.loading.status).toMatch(/1 of 2 repositories failed/)
    expect(store.loading.index).toBe(0)
    expect(store.loading.total).toBe(0)
  })

  it('dedupes repeated repository inputs', async () => {
    const { url } = mockApi(generateCommits(10))
    await controller.loadMany([url, ` ${url} `])

    expect(store.timelineStats?.commits).toBe(10)
    expect(store.repos).toHaveLength(1)
    expect(controller.currentTimeline?.projects).toHaveLength(1)
    expect(controller.currentTimeline?.projects[0]?.commits).toBe(10)
    // A single project stays unscoped, exactly like `load()`.
    const paths = controller.currentTimeline!.commits.flatMap((commit) => commit.changes.map((change) => change.path))
    expect(paths.every((path) => path.startsWith('src/'))).toBe(true)
    expect(controller.currentTimeline!.commits.every((commit) => !commit.projectKey)).toBe(true)
  })

  it('keeps commits and warns when the API quota runs out', async () => {
    const { url } = mockApi(generateCommits(40), { rateRemaining: 8 })
    await controller.load(url)
    expect(store.timelineStats?.commits).toBe(40)
    expect(store.timelineStats?.withoutFileData).toBeGreaterThan(0)
    expect(store.warnings.join(' ')).toMatch(/quota/i)
    expect(store.view).toBe('stage')
  })

  it('filters by author and by date, then clears the filters', async () => {
    const { url } = mockApi(generateCommits(24))
    await controller.load(url)
    const total = store.timelineStats?.commits ?? 0
    expect(total).toBe(24)

    controller.applyFilters({ hiddenAuthors: ['login:author1', 'login:author2'] })
    expect(store.timelineStats?.commits).toBeLessThan(total)
    expect(store.timelineStats?.authors).toBe(2)

    const timeline = controller.currentTimeline
    const middle = timeline?.commits[Math.floor((timeline.commits.length - 1) / 2)].timestamp ?? 0
    controller.applyFilters({ hiddenAuthors: [], from: middle })
    expect(store.timelineStats?.commits).toBeLessThan(total)
    expect(store.timelineStats?.commits).toBeGreaterThan(0)

    controller.clearFilters()
    expect(store.timelineStats?.commits).toBe(total)
  })

  it('ignores folders by name without dropping their commits', async () => {
    const { url } = mockApi(generateCommits(40))
    await controller.load(url)
    const timeline = controller.currentTimeline
    expect(timeline).not.toBeNull()
    const before = timeline!.commits.flatMap((commit) => commit.changes.map((change) => change.path))
    expect(before.some((path) => path.startsWith('src/module-3/'))).toBe(true)

    controller.applyFilters({ ignoredFolders: ['module-3'] })

    const after = controller.currentTimeline!.commits
    // No path inside the ignored folder survives...
    const paths = after.flatMap((commit) => commit.changes.map((change) => change.path))
    expect(paths.filter((path) => path.startsWith('src/module-3/'))).toEqual([])
    // ...but the commits themselves stay: the history did not shrink.
    expect(store.timelineStats?.commits).toBe(40)
    expect(store.timelineStats?.ignoredFiles).toBeGreaterThan(0)
    // Other modules are untouched.
    expect(paths.some((path) => path.startsWith('src/module-4/'))).toBe(true)

    // The list is a preference and round-trips through the normalisation.
    expect(store.ignoredFolders).toEqual(['module-3'])

    controller.clearFilters()
    expect(store.ignoredFolders).toEqual([])
    expect(controller.currentTimeline!.commits.flatMap((commit) => commit.changes.map((change) => change.path)))
      .toHaveLength(before.length)
  })

  it('reports deterministic export support honestly', async () => {
    // jsdom has no WebCodecs, so the export must say so instead of pretending.
    expect(controller.exportSupport().supported).toBe(false)
    expect(store.export.codecs).toEqual([])
    expect(store.export.probed).toBe(false)
    await controller.refreshExportSupport()
    expect(store.export.probed).toBe(true)
    expect(store.export.codecs).toEqual([])
    // Without an engine there is nothing to render; the call must be a no-op
    // rather than throwing.
    await controller.startExport()
    expect(store.export.active).toBe(false)
    controller.cancelExport()
    expect(store.export.active).toBe(false)
  })

  it('hides hidden folders by default and brings them back on request', async () => {
    const commits = generateCommits(24)
    // Give the history a hidden folder plus a hidden file at the root.
    const first = commits[0]!
    const second = commits[1]!
    first.files = [...(first.files ?? []), { filename: '.github/workflows/ci.yml', status: 'added', additions: 12, deletions: 0 }]
    second.files = [...(second.files ?? []), { filename: '.gitignore', status: 'modified', additions: 2, deletions: 1 }]
    const { url } = mockApi(commits)
    // The filter is a persisted preference, so state it explicitly here.
    store.hideHiddenFolders = true
    await controller.load(url)

    const paths = () => controller.currentTimeline!.commits.flatMap((commit) => commit.changes.map((change) => change.path))
    // Hidden folders are filtered; hidden files are not.
    expect(store.hideHiddenFolders).toBe(true)
    expect(paths()).not.toContain('.github/workflows/ci.yml')
    expect(paths()).toContain('.gitignore')
    expect(store.timelineStats?.ignoredFiles).toBe(1)
    // Commits are still there.
    expect(store.timelineStats?.commits).toBe(24)

    controller.applyFilters({ hideHiddenFolders: false })
    expect(paths()).toContain('.github/workflows/ci.yml')
    expect(store.hideHiddenFolders).toBe(false)

    controller.applyFilters({ hideHiddenFolders: true })
    expect(paths()).not.toContain('.github/workflows/ci.yml')

    // "Clear every filter" turns the folder filters off.
    controller.clearFilters()
    expect(store.hideHiddenFolders).toBe(false)
    expect(paths()).toContain('.github/workflows/ci.yml')
  })

  it('toggles a single author', async () => {
    const { url } = mockApi(generateCommits(16))
    await controller.load(url)
    const author = controller.timelineAuthors()[0]
    controller.toggleAuthor(author.id)
    expect(store.hiddenAuthors).toContain(author.id)
    expect(store.timelineStats?.commits).toBe(16 - author.commits)
    controller.toggleAuthor(author.id)
    expect(store.hiddenAuthors).toHaveLength(0)
    expect(store.timelineStats?.commits).toBe(16)
  })

  it('scopes an author toggle to one project but a base id to all projects', async () => {
    const routes = mockMultiApi([
      { label: 'alpha', commits: generateCommits(8) },
      { label: 'beta', commits: generateCommits(8) },
    ])
    const [alpha, beta] = routes
    await controller.loadMany(routes.map((route) => route.url))

    const total = store.timelineStats?.commits ?? 0
    expect(total).toBe(16)
    const alphaAuthor = controller
      .timelineAuthors()
      .find((author) => author.projectKey === alpha!.fullName && author.login === 'author0')!
    const betaAuthor = controller
      .timelineAuthors()
      .find((author) => author.projectKey === beta!.fullName && author.login === 'author0')!
    expect(alphaAuthor.commits).toBeGreaterThan(0)
    expect(betaAuthor.commits).toBeGreaterThan(0)

    // A project-scoped id hides that person in alpha only; beta keeps theirs.
    controller.toggleAuthor(alphaAuthor.id)
    expect(store.hiddenAuthors).toContain(alphaAuthor.id)
    expect(store.timelineStats?.commits).toBe(total - alphaAuthor.commits)
    const afterToggle = controller.currentTimeline!
    expect(afterToggle.commits.some((commit) => commit.authorId === alphaAuthor.id)).toBe(false)
    expect(afterToggle.commits.filter((commit) => commit.authorId === betaAuthor.id)).toHaveLength(betaAuthor.commits)

    // The unscoped identity hides the person in both projects.
    const expected = total - alphaAuthor.commits - betaAuthor.commits
    controller.applyFilters({ hiddenAuthors: [alphaAuthor.baseId!] })
    expect(store.timelineStats?.commits).toBe(expected)
    expect(
      controller
        .currentTimeline!.commits.some(
          (commit) => commit.authorId === alphaAuthor.id || commit.authorId === betaAuthor.id,
        ),
    ).toBe(false)

    controller.clearFilters()
    expect(store.timelineStats?.commits).toBe(total)
  })

  it('jumps to a commit by SHA prefix', async () => {
    const { url, mock } = mockApi(generateCommits(12))
    await controller.load(url)
    const commits = controller.currentTimeline?.commits ?? []
    const target = commits[5]
    const index = controller.jumpToSha(target.sha.slice(0, 8))
    expect(index).toBe(5)
    expect(controller.jumpToSha('zzzzzzzz')).toBeNull()
    void mock
  })

  it('reports the real date range and mapping helpers', async () => {
    const { url } = mockApi(generateCommits(10))
    await controller.load(url)
    const range = controller.realRange()
    expect(range.end).toBeGreaterThan(range.start)
    expect(controller.realTimeAt(0)).toBe(range.start)
    expect(controller.simTimeAtRealTime(range.start)).toBeCloseTo(0, 6)
  })

  it('explains when WebGL is unavailable instead of crashing', async () => {
    const wrapper = mount(StageView)
    const { url } = mockApi(generateCommits(6))
    await controller.load(url)
    // jsdom has no WebGL context, so the engine cannot start.
    expect(store.loading.error).toMatch(/webgl/i)
    expect(store.view).toBe('landing')
    expect(controller.hasEngine).toBe(false)
    // The loaded history is still available for a retry in a capable browser.
    expect(controller.currentTimeline?.commits.length).toBe(6)
    wrapper.unmount()
  })

  it('records nothing and reports support honestly when MediaRecorder is missing', () => {
    const support = controller.recordingSupport()
    // jsdom has no MediaRecorder at all.
    expect(support.supported).toBe(false)
    expect(support.formats.every((format) => format.supported === false)).toBe(true)
  })

  it('cancels an in-flight load', async () => {
    const { url } = mockApi(generateCommits(80), { latencyMs: 15 })
    const loading = controller.load(url)
    setTimeout(() => controller.cancelLoad(), 10)
    await loading
    expect(store.loading.active).toBe(false)
  })

  it('returns to the landing view and clears run state', async () => {
    const { url } = mockApi(generateCommits(8))
    await controller.load(url)
    expect(store.view).toBe('stage')
    controller.backToLanding()
    expect(store.view).toBe('landing')
    expect(store.repo).toBeNull()
    expect(store.timelineStats).toBeNull()
    expect(controller.currentTimeline).toBeNull()
  })

  it('resolves providers for detection without loading', () => {
    expect(controller.resolve('https://github.com/a/b')?.providerId).toBe('github')
    expect(controller.resolve('https://gitlab.com/a/b')?.providerId).toBe('gitlab')
    expect(controller.resolve('not a url')).toBeNull()
  })

  it('provides music bands to the renderer, freezing them while playback is paused', () => {
    const rate = 44_100
    const samples = new Float32Array(rate / 2)
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin((2 * Math.PI * 100 * index) / rate)
    }
    const source: MusicSource = {
      sampleRate: rate,
      numberOfChannels: 1,
      length: samples.length,
      channels: [samples],
      duration: samples.length / rate,
    }
    const internals = controller as unknown as {
      musicAnalysis: ReturnType<typeof analyzeMusic> | null
      musicPlayer: unknown
      audioWasPlaying: boolean
      audioLevelsFor: (mode: 'live' | 'export', videoTime: number) => AudioLevels | null
    }
    const original = {
      analysis: internals.musicAnalysis,
      player: internals.musicPlayer,
      wasPlaying: internals.audioWasPlaying,
    }
    try {
      internals.musicAnalysis = analyzeMusic(source)
      internals.audioWasPlaying = false
      // Nothing has played yet, so a paused player must not react.
      internals.musicPlayer = { playing: false, position: 0.25 }
      expect(internals.audioLevelsFor('live', 0)).toBeNull()

      internals.musicPlayer = { playing: true, position: 0.25 }
      const live = internals.audioLevelsFor('live', 0)
      expect(live?.bass).toBeGreaterThan(0.5)

      // Pausing keeps the palette the frame was paused with, instead of
      // snapping every reactive layer back to its base colour.
      internals.musicPlayer = { playing: false, position: 0.25 }
      const frozen = internals.audioLevelsFor('live', 0)
      expect(frozen).toBe(live)
      expect(frozen?.bass).toBe(live?.bass)

      // The export samples the same analysis at the video timestamp.
      internals.musicPlayer = { playing: true, position: 0.25 }
      const exported = internals.audioLevelsFor('export', 0.25)
      expect(exported?.bass).toBeGreaterThan(0.5)

      store.settings.audioReactive = false
      expect(internals.audioLevelsFor('live', 0)).toBeNull()
      store.settings.audioReactive = true
    } finally {
      internals.musicAnalysis = original.analysis
      internals.musicPlayer = original.player
      internals.audioWasPlaying = original.wasPlaying
    }
  })
})
