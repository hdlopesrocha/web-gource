// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import LandingView from '../src/ui/LandingView.vue'
import PlaybackBar from '../src/ui/PlaybackBar.vue'
import AuthorsPanel from '../src/ui/AuthorsPanel.vue'
import ActivityPanel from '../src/ui/ActivityPanel.vue'
import SettingsPanel from '../src/ui/SettingsPanel.vue'
import HelpOverlay from '../src/ui/HelpOverlay.vue'
import StageView from '../src/ui/StageView.vue'
import { store, setToken, tokenFor, resetRunState } from '../src/state/store'
import { AuthorField } from '../src/render/authors'
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
  // Module state that localStorage.clear() does not touch.
  store.loadOptions.tokens = {}
  store.loadOptions.draftToken = ''
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
    const tokenInput = wrapper.find('input[aria-label="Personal access token"]')
    expect(tokenInput.exists()).toBe(true)
    await tokenInput.setValue('ghp_supersecret')
    await tokenInput.trigger('blur')
    expect(tokenFor('github')).toBe('ghp_supersecret')
    expect(localStorage.getItem('web-gource:load-options:v1')).toContain('ghp_supersecret')
  })

  it('accepts a token before any repository URL is known', async () => {
    const wrapper = mount(LandingView)
    await wrapper.find('button.btn.ghost').trigger('click') // Advanced
    const tokenInput = wrapper.find('input[aria-label="Personal access token"]')
    // No URL typed yet: the field must still be editable.
    expect((tokenInput.element as HTMLInputElement).disabled).toBe(false)
    await tokenInput.setValue('glpat-pastedtoken')
    await tokenInput.trigger('blur')
    // The prefix identifies GitLab even though no URL was entered.
    expect(tokenFor('gitlab')).toBe('glpat-pastedtoken')
    expect(tokenFor('github')).toBe('')
  })

  it('attaches a pasted token to the host once the URL is entered', async () => {
    const wrapper = mount(LandingView)
    await wrapper.find('button.btn.ghost').trigger('click') // Advanced
    // An opaque token cannot be attributed yet, so it is kept as a draft.
    const tokenInput = wrapper.find('input[aria-label="Personal access token"]')
    await tokenInput.setValue('opaque-pasted-value')
    await tokenInput.trigger('blur')
    expect(store.loadOptions.draftToken).toBe('opaque-pasted-value')
    expect(tokenFor('github')).toBe('opaque-pasted-value')

    await wrapper.find('input[aria-label="Repository URL"]').setValue('https://github.com/acme/widget')
    await flushPromises()
    expect(store.loadOptions.draftToken).toBe('')
    expect(tokenFor('github')).toBe('opaque-pasted-value')
    expect(wrapper.find('.token-field').text()).toContain('Stored for GitHub')
  })

  it('never hands a host-specific token to another host', async () => {
    const wrapper = mount(LandingView)
    await wrapper.find('button.btn.ghost').trigger('click')
    const tokenInput = wrapper.find('input[aria-label="Personal access token"]')
    await tokenInput.setValue('ghp_githubonly')
    await tokenInput.trigger('blur')
    await wrapper.find('input[aria-label="Repository URL"]').setValue('https://gitlab.com/group/project')
    await flushPromises()
    expect(tokenFor('github')).toBe('ghp_githubonly')
    expect(tokenFor('gitlab')).toBe('')
  })

  it('cleans up pasted whitespace and Bearer prefixes', async () => {
    const wrapper = mount(LandingView)
    await wrapper.find('button.btn.ghost').trigger('click')
    const tokenInput = wrapper.find('input[aria-label="Personal access token"]')
    await tokenInput.setValue('  Bearer ghp_with\nlinebreak  ')
    await tokenInput.trigger('blur')
    expect(tokenFor('github')).toBe('ghp_withlinebreak')
    // The field shows the cleaned value.
    expect((tokenInput.element as HTMLInputElement).value).toBe('ghp_withlinebreak')
  })

  it('reads the clipboard with the Paste button and explains when it is blocked', async () => {
    const wrapper = mount(LandingView)
    await wrapper.find('button.btn.ghost').trigger('click')

    const readText = vi.fn().mockResolvedValue('ghp_fromclipboard\n')
    Object.defineProperty(window.navigator, 'clipboard', { value: { readText }, configurable: true })
    const pasteButton = wrapper.findAll('button').find((button) => button.text() === 'Paste')
    expect(pasteButton).toBeDefined()
    await pasteButton?.trigger('click')
    await flushPromises()
    expect(readText).toHaveBeenCalled()
    expect(tokenFor('github')).toBe('ghp_fromclipboard')
    expect(wrapper.find('.token-field').text()).toContain('Stored for GitHub')
    // The clipboard error must disappear once a paste succeeds.
    expect(wrapper.find('.token-field .hint.warn').exists()).toBe(false)

    // Blocked clipboard → actionable fallback message.
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { readText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    })
    await pasteButton?.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Ctrl/Cmd+V')
  })

  it('can clear a stored token', async () => {
    const wrapper = mount(LandingView)
    await wrapper.find('button.btn.ghost').trigger('click')
    const tokenInput = wrapper.find('input[aria-label="Personal access token"]')
    await tokenInput.setValue('ghp_tobecleared')
    await tokenInput.trigger('blur')
    const clearButton = wrapper.findAll('button').find((button) => button.text() === 'Clear')
    expect(clearButton).toBeDefined()
    await clearButton?.trigger('click')
    expect(tokenFor('github')).toBe('')
    expect(store.loadOptions.draftToken).toBe('')
  })

  it('does not store half-typed tokens while the user is still typing', async () => {
    const wrapper = mount(LandingView)
    await wrapper.find('button.btn.ghost').trigger('click')
    const tokenInput = wrapper.find('input[aria-label="Personal access token"]')
    vi.useFakeTimers()
    try {
      // Simulate the keystrokes of a slowly typed token: no partial prefix may
      // ever be persisted as a token.
      for (const partial of ['g', 'gl', 'glp', 'glpat', 'glpat-', 'glpat-abc']) {
        await tokenInput.setValue(partial)
        expect(store.loadOptions.tokens).toEqual({})
        expect(store.loadOptions.draftToken).toBe('')
      }
      vi.advanceTimersByTime(500)
      await wrapper.vm.$nextTick()
      expect(tokenFor('gitlab')).toBe('glpat-abc')
    } finally {
      vi.useRealTimers()
    }
  })

  it('commits a typed token after a short pause, without blurring', async () => {
    const wrapper = mount(LandingView)
    await wrapper.find('button.btn.ghost').trigger('click')
    const tokenInput = wrapper.find('input[aria-label="Personal access token"]')
    vi.useFakeTimers()
    try {
      await tokenInput.setValue('ghp_typed_slowly')
      expect(tokenFor('github')).toBe('')
      vi.advanceTimersByTime(500)
      await wrapper.vm.$nextTick()
      expect(tokenFor('github')).toBe('ghp_typed_slowly')
    } finally {
      vi.useRealTimers()
    }
  })

  it('pre-fills the URL and token after a reload', async () => {
    // Simulate the state a previous session left behind in local storage.
    localStorage.setItem(
      'web-gource:load-options:v1',
      JSON.stringify({
        maxCommits: 150,
        range: 'latest',
        branch: '',
        tokens: { github: 'ghp_from_previous_session' },
        draftToken: '',
        lastTokenProvider: 'github',
        lastUrl: 'https://github.com/hdlopesrocha/opencode-talk',
      }),
    )
    store.loadOptions.lastUrl = 'https://github.com/hdlopesrocha/opencode-talk'
    store.loadOptions.tokens = { github: 'ghp_from_previous_session' }
    store.loadOptions.lastTokenProvider = 'github'
    store.url = 'https://github.com/hdlopesrocha/opencode-talk'

    const wrapper = mount(LandingView)
    const urlField = wrapper.find('input[aria-label="Repository URL"]').element as HTMLInputElement
    expect(urlField.value).toBe('https://github.com/hdlopesrocha/opencode-talk')
    // The stored token is visible and editable straight away.
    const tokenInput = wrapper.find('input[aria-label="Personal access token"]')
    expect((tokenInput.element as HTMLInputElement).value).toBe('ghp_from_previous_session')
    expect(wrapper.text()).toContain('token & rate limits ✓')
  })

  it('marks the advanced section when a token is stored', async () => {
    setToken('github', 'ghp_saved')
    const wrapper = mount(LandingView)
    expect(wrapper.text()).toContain('token & rate limits ✓')
    expect(wrapper.find('input[aria-label="Personal access token"]').exists()).toBe(true)
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
      sizeMode: 'bytes',
      filesWithSize: 8,
      totalBytes: 4096,
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
  /** Click a settings tab by its label (tab order is a UI detail). */
  async function openTab(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
    const button = wrapper.findAll('.tabs button').find((entry) => entry.text().trim() === label)
    if (!button) throw new Error(`settings tab "${label}" not found`)
    await button.trigger('click')
  }

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

  it('settings panel adds and removes ignored folders', async () => {
    store.ignoredFolders = []
    const wrapper = mount(SettingsPanel)
    await openTab(wrapper, 'Filters')
    const input = wrapper.find('input[list="ignored-folder-suggestions"]')
    expect(input.exists()).toBe(true)

    await input.setValue('third_party')
    await input.trigger('keydown.enter')
    expect(store.ignoredFolders).toEqual(['third_party'])
    // The list renders as a removable chip, and the suggestion disappears.
    expect(wrapper.find('.chips').text()).toContain('third_party')
    const suggestions = wrapper.findAll('#ignored-folder-suggestions option').map((option) => option.attributes('value'))
    expect(suggestions).not.toContain('third_party')

    await wrapper.find('.chips li button').trigger('click')
    expect(store.ignoredFolders).toEqual([])
    expect(wrapper.find('.chips').exists()).toBe(false)
  })

  it('settings panel toggles hidden folders', async () => {
    store.hideHiddenFolders = true
    const wrapper = mount(SettingsPanel)
    await openTab(wrapper, 'Filters')
    const box = wrapper.find('input[type="checkbox"]')
    expect(box.exists()).toBe(true)
    expect(wrapper.text()).toContain('Hide hidden folders')
    expect(wrapper.text()).toContain('.github')

    await box.setValue(false)
    expect(store.hideHiddenFolders).toBe(false)
    await box.setValue(true)
    expect(store.hideHiddenFolders).toBe(true)
  })

  it('activity panel draws both heatmaps from the timeline', () => {
    const at = (index: number, timestamp: number): RawCommit => ({ ...rawCommit(index), timestamp })
    const timeline = buildTimeline(repo, [
      at(0, Date.UTC(2024, 2, 6, 14, 30)), // Wednesday
      at(1, Date.UTC(2024, 2, 6, 14, 50)), // Wednesday, same hour
      at(2, Date.UTC(2024, 2, 8, 9, 0)), // Friday
    ])
    vi.spyOn(controller, 'currentTimeline', 'get').mockReturnValue(timeline)
    store.hud = { ...(store.hud ?? {}), date: Date.UTC(2024, 2, 8, 12, 0) } as typeof store.hud
    const wrapper = mount(ActivityPanel)

    // Both charts are present, with their axes and summaries.
    expect(wrapper.findAll('canvas')).toHaveLength(2)
    expect(wrapper.text()).toContain('Commits per weekday and hour')
    expect(wrapper.text()).toContain('Contributions · last 53 weeks')
    expect(wrapper.text()).toContain('3 commits')
    expect(wrapper.text()).toContain('Wed 14:00')
    expect(wrapper.text()).toContain('busiest Wed 14:00 (2)')
    // The window ends with the Saturday of the current week.
    expect(wrapper.text()).toContain('→ 2024-03-09')
    expect(wrapper.text()).toContain('Right column is the current week')
    vi.restoreAllMocks()
  })

  it('settings panel exposes visualization, camera, filter and data tabs', async () => {
    const wrapper = mount(SettingsPanel)
    expect(wrapper.text()).toContain('Visual')
    await openTab(wrapper, 'Camera')
    expect(wrapper.text()).toContain('Automatic view')
    await openTab(wrapper, 'Filters')
    expect(wrapper.text()).toContain('Hidden folders')
    expect(wrapper.text()).toContain('Ignored folders')
    await openTab(wrapper, 'Recording')
    expect(wrapper.text()).toContain('Video export')
    await openTab(wrapper, 'Data')
    expect(wrapper.text()).toContain('Loaded data')
  })

  it('authors panel points at the folder filters', () => {
    const wrapper = mount(AuthorsPanel)
    expect(wrapper.text()).toContain('Settings → Filters')
    expect(wrapper.find('input[list="ignored-folder-suggestions"]').exists()).toBe(false)
  })

  it('settings panel reports when recording is unsupported', async () => {
    const support = vi.spyOn(controller, 'recordingSupport').mockReturnValue({
      supported: false,
      formats: [{ mimeType: 'video/webm', label: 'WebM', extension: 'webm', supported: false }],
    })
    const exportSupport = vi.spyOn(controller, 'exportSupport').mockReturnValue({ supported: false, codecs: [] })
    const wrapper = mount(SettingsPanel)
    await openTab(wrapper, 'Recording')
    // The deterministic render is the default mode and says what is missing.
    expect(wrapper.text()).toContain('cannot encode video frame by frame')
    // Live capture keeps its own message.
    await wrapper.findAll('.mode-row button')[1].trigger('click')
    expect(wrapper.text()).toContain('cannot record canvas video')
    support.mockRestore()
    exportSupport.mockRestore()
  })

  it('offers a deterministic 60 fps render with WebM by default', async () => {
    const exportSupport = vi.spyOn(controller, 'exportSupport').mockReturnValue({
      supported: true,
      codecs: [
        { container: 'webm', label: 'WebM · VP9', codec: 'vp09.00.10.08', supported: true, hardware: false },
        { container: 'mp4', label: 'MP4 · H.264', codec: 'avc1.420028', supported: true, hardware: true },
      ],
    })
    const wrapper = mount(SettingsPanel)
    await openTab(wrapper, 'Recording')
    const text = wrapper.text()
    // Frame rate is fixed at 60, the speed follows playback, and the panels are
    // part of the video.
    expect(text).toContain('60 fps (fixed)')
    expect(text).toContain('follows the playback speed')
    expect(text).toContain('the timeline, the overview, the weekday/hour heatmap and the contribution calendar')
    expect(text).toContain('WebM · VP9 (default)')
    expect(text).toContain('MP4 · H.264 (optional)')
    expect(text).toContain('Render animation')
    const format = wrapper.find('#export-format').element as HTMLSelectElement
    expect(format.value).toBe('webm')
    exportSupport.mockRestore()
  })

  it('help overlay documents shortcuts and limitations', () => {
    const wrapper = mount(HelpOverlay)
    expect(wrapper.text()).toContain('Space')
    expect(wrapper.text()).toContain('60 requests/hour')
    expect(wrapper.text()).toContain('MediaRecorder')
  })
})

describe('author layer', () => {
  it('draws authors above rays, particles and circles', () => {
    // jsdom has no 2D canvas: stub just enough for the avatar texture cache.
    const stub = {
      font: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      textAlign: '',
      textBaseline: '',
      beginPath() {},
      arc() {},
      fill() {},
      stroke() {},
      fillRect() {},
      clearRect() {},
      fillText() {},
      measureText: () => ({ width: 12, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
      createRadialGradient: () => ({ addColorStop() {} }),
      moveTo() {},
      arcTo() {},
      closePath() {},
      save() {},
      restore() {},
      translate() {},
      scale() {},
      setTransform() {},
      drawImage() {},
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(stub as never)
    const authors = new AuthorField(2)
    authors.sync([
      {
        author: { id: 'x', name: 'Ada', commits: 1, first: 0, last: 0, additions: 0, deletions: 0, colorIndex: 0, unattributed: false },
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        target: { x: 0, y: 0, z: 0 },
        targetNodeId: 0,
        lastActiveAt: 0,
        appearedAt: 0,
        appliedCommits: 1,
        lastKind: 'modify',
        visible: true,
        tethers: [],
      },
    ])
    // Both the halo and the avatar itself render above the beams (12) and the
    // labels stay on top of everything.
    expect(authors.group.children.length).toBeGreaterThan(0)
    for (const child of authors.group.children) {
      expect(child.renderOrder).toBeGreaterThan(12)
      expect(child.renderOrder).toBeLessThan(30)
    }
    authors.dispose()
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
    store.settings.autoZoom = false
    resetRunState()
    expect(store.warnings).toHaveLength(0)
    expect(store.hiddenAuthors).toHaveLength(0)
    expect(store.settings.autoZoom).toBe(false)
    store.settings.autoZoom = true
  })
})
