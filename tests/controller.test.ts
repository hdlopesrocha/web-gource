// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { controller } from '../src/engine/controller'
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
})
