// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import LandingView from '../src/ui/LandingView.vue'
import PlaybackBar from '../src/ui/PlaybackBar.vue'
import AuthorsPanel from '../src/ui/AuthorsPanel.vue'
import SettingsPanel from '../src/ui/SettingsPanel.vue'
import HelpOverlay from '../src/ui/HelpOverlay.vue'
import StageView from '../src/ui/StageView.vue'
import { store, setToken, tokenFor, resetRunState } from '../src/state/store'
import { controller } from '../src/engine/controller'
import { buildTimeline } from '../src/timeline/builder'
import type { RawCommit, RepoInfo } from '../src/git/types'

/**
 * Component smoke tests.
 *
 * The WebGL scene itself cannot run in jsdom, but these tests cover the parts
 * that break most often: template bindings, computed state derived from the
 * store, and the panels mounting/unmounting without errors.
 */

const repo: RepoInfo = {
  provider: 'github',
  owner: 'acme',
  name: 'widget',
  fullName: 'acme/widget',
  htmlUrl: 'https://github.com/acme/widget',
  defaultBranch: 'main',
  isPrivate: false,
}

function rawCommit(index: number): RawCommit {
  return {
    sha: `sha-${index}`,
    parents: index === 0 ? [] : [`sha-${index - 1}`],
    timestamp: Date.UTC(2021, 0, 1) + index * 86_400_000,
    message: `commit ${index}`,
    author: { name: 'Ada', email: 'ada@example.com', login: 'ada' },
    files: [{ path: `src/file-${index}.ts`, kind: 'add', additions: 4, deletions: 0 }],
  }
}

beforeEach(() => {
  localStorage.clear()
  resetRunState()
  store.view = 'landing'
  store.repo = null
  store.url = ''
  store.timelineStats = null
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LandingView', () => {
  it('renders the URL input, options and primary action', () => {
    const wrapper = mount(LandingView)
    expect(wrapper.find('input[aria-label="Repository URL"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Load Repository')
    expect(wrapper.text()).toContain('Snapshot size')
    expect(wrapper.findAll('option').length).toBeGreaterThan(3)
  })

  it('detects the provider while typing and shows a badge', async () => {
    const wrapper = mount(LandingView)
    const input = wrapper.find('input[aria-label="Repository URL"]')
    await input.setValue('https://github.com/acme/widget')
    expect(wrapper.find('.provider-badge').text()).toContain('GitHub')
    await input.setValue('https://gitlab.com/group/project')
    expect(wrapper.find('.provider-badge').text()).toContain('GitLab')
  })

  it('explains an unsupported host instead of failing silently', async () => {
    const wrapper = mount(LandingView)
    await wrapper.find('input[aria-label="Repository URL"]').setValue('https://bitbucket.org/a/b')
    expect(wrapper.text()).toContain('No provider matches')
  })

  it('surfaces errors from the store', async () => {
    store.loading.error = 'Repository not found.'
    const wrapper = mount(LandingView)
    expect(wrapper.text()).toContain('Could not load the repository.')
    expect(wrapper.text()).toContain('Repository not found.')
  })

  it('shows load progress', async () => {
    store.loading.active = true
    store.loading.status = 'Loading file changes 12/40…'
    store.loading.loaded = 12
    store.loading.target = 40
    const wrapper = mount(LandingView)
    expect(wrapper.text()).toContain('Loading file changes 12/40…')
    expect(wrapper.find('.bar-fill').exists()).toBe(true)
  })

  it('keeps tokens in the store and local storage, never in source', async () => {
    const wrapper = mount(LandingView)
    await wrapper.find('input[aria-label="Repository URL"]').setValue('https://github.com/acme/widget')
    await wrapper.find('button.btn.ghost').trigger('click') // Advanced
    const tokenInput = wrapper.find('input[type="password"]')
    await tokenInput.setValue('ghp_supersecret')
    expect(tokenFor('github')).toBe('ghp_supersecret')
    expect(localStorage.getItem('web-gource:load-options:v1')).toContain('ghp_supersecret')
  })

  it('offers the configured example repositories', () => {
    const wrapper = mount(LandingView)
    const text = wrapper.text()
    expect(text).toContain('hdlopesrocha/vulkan-engine')
    expect(text).toContain('hdlopesrocha/opencode-talk')
  })

  it('fills the input when an example is clicked', async () => {
    const wrapper = mount(LandingView)
    const buttons = wrapper.findAll('.examples button')
    const target = buttons.find((button) => button.text().includes('opencode-talk'))
    expect(target).toBeDefined()
    await target?.trigger('click')
    expect(store.url).toBe('https://github.com/hdlopesrocha/opencode-talk')
  })
})

describe('PlaybackBar', () => {
  it('renders controls and a scrubber', () => {
    store.hud = {
      time: 10,
      duration: 100,
      date: Date.UTC(2022, 5, 1),
      index: 3,
      total: 20,
      playing: true,
      speed: 2,
      commit: null,
      activeAuthors: [],
      visibleFiles: 5,
      visibleDirs: 2,
      totalFiles: 12,
      additions: 10,
      deletions: 2,
      fps: 60,
      recording: false,
    }
    const wrapper = mount(PlaybackBar)
    expect(wrapper.find('.scrubber').exists()).toBe(true)
    expect(wrapper.text()).toContain('2022-06-01')
    expect(wrapper.text()).toContain('0:10')
    // Pause button because the store says it is playing.
    expect(wrapper.find('.play').text()).toContain('❚❚')
    expect(wrapper.findAll('.jump-row').length).toBe(2)
  })
})

describe('StageView', () => {
  it('mounts the canvas and panels without an engine', () => {
    const wrapper = mount(StageView)
    expect(wrapper.find('canvas.scene').exists()).toBe(true)
    expect(wrapper.text()).toContain('Repository')
    expect(wrapper.find('.playback').exists()).toBe(true)
  })

  it('shows repository summary and warnings when data is loaded', async () => {
    const timeline = buildTimeline(repo, [rawCommit(0), rawCommit(1)])
    store.repo = timeline.repo
    store.timelineStats = timeline.stats
    store.warnings = ['Loaded the newest 2 of roughly 900 commits.']
    const wrapper = mount(StageView)
    expect(wrapper.text()).toContain('acme/widget')
    expect(wrapper.text()).toContain('note about this load')
    await wrapper.find('.warn-head').trigger('click')
    expect(wrapper.text()).toContain('Loaded the newest 2')
  })
})

describe('panels', () => {
  it('authors panel lists authors from the timeline', () => {
    const timeline = buildTimeline(repo, [rawCommit(0), rawCommit(1)])
    // Point the controller at a timeline without creating an engine.
    const original = Object.getOwnPropertyDescriptor(controller, 'currentTimeline')
    void original
    const authors = timeline.authors
    vi.spyOn(controller, 'timelineAuthors').mockReturnValue(authors)
    const wrapper = mount(AuthorsPanel)
    expect(wrapper.text()).toContain('Ada')
    expect(wrapper.findAll('.author-row').length).toBe(1)
  })

  it('settings panel exposes visualization, camera and recording tabs', async () => {
    const wrapper = mount(SettingsPanel)
    expect(wrapper.text()).toContain('Visual')
    await wrapper.findAll('.tabs button')[1].trigger('click')
    expect(wrapper.text()).toContain('Automatic camera')
    await wrapper.findAll('.tabs button')[2].trigger('click')
    expect(wrapper.text()).toContain('Video export')
    await wrapper.findAll('.tabs button')[3].trigger('click')
    expect(wrapper.text()).toContain('Loaded data')
  })

  it('settings panel reports when recording is unsupported', async () => {
    const support = vi.spyOn(controller, 'recordingSupport').mockReturnValue({
      supported: false,
      formats: [{ mimeType: 'video/webm', label: 'WebM', extension: 'webm', supported: false }],
    })
    const wrapper = mount(SettingsPanel)
    await wrapper.findAll('.tabs button')[2].trigger('click')
    expect(wrapper.text()).toContain('cannot record canvas video')
    support.mockRestore()
  })

  it('help overlay documents shortcuts and limitations', () => {
    const wrapper = mount(HelpOverlay)
    expect(wrapper.text()).toContain('Space')
    expect(wrapper.text()).toContain('60 requests/hour')
    expect(wrapper.text()).toContain('MediaRecorder')
  })
})

describe('store', () => {
  it('persists and clears tokens per provider', () => {
    setToken('github', 'abc')
    setToken('gitlab', 'def')
    expect(tokenFor('github')).toBe('abc')
    setToken('github', '')
    expect(tokenFor('github')).toBe('')
    expect(tokenFor('gitlab')).toBe('def')
  })

  it('resets run state without clearing settings', () => {
    store.warnings = ['something']
    store.hiddenAuthors = ['login:ada']
    store.settings.autoRotate = false
    resetRunState()
    expect(store.warnings).toHaveLength(0)
    expect(store.hiddenAuthors).toHaveLength(0)
    expect(store.settings.autoRotate).toBe(false)
    store.settings.autoRotate = true
  })
})
