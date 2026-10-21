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

const secondRepo: RepoInfo = {
  ...repo,
  name: 'service',
  fullName: 'acme/service',
  htmlUrl: 'https://github.com/acme/service',
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

/** A small two-project timeline shared by the Stage, Authors and Settings tests. */
function multiProjectTimeline() {
  const bob = { name: 'Bob', email: 'bob@example.com', login: 'bob' }
  const commits: RawCommit[] = [
    { ...rawCommit(0), projectKey: 'acme/widget', projectName: 'acme/widget' },
    { ...rawCommit(1), projectKey: 'acme/widget', projectName: 'acme/widget', author: bob },
    { ...rawCommit(2), projectKey: 'acme/service', projectName: 'acme/service' },
    { ...rawCommit(3), projectKey: 'acme/service', projectName: 'acme/service', author: bob },
  ]
  return buildTimeline(repo, commits, {
    projects: [
      { key: 'acme/widget', repo },
      { key: 'acme/service', repo: secondRepo },
    ],
  })
}

beforeEach(() => {
  localStorage.clear()
  resetRunState()
  // Module state that localStorage.clear() does not touch.
  store.loadOptions.tokens = {}
  store.loadOptions.draftToken = ''
  store.loadOptions.urls = []
  store.loadOptions.lastUrl = ''
  store.forcedProvider = null
  store.view = 'landing'
  store.repo = null
  store.repos = []
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

  it('presents the synthetic demo as a second primary action and still starts it', async () => {
    const loadDemo = vi.spyOn(controller, 'loadDemo').mockResolvedValue()
    const wrapper = mount(LandingView)
    const buttonNamed = (label: string) => wrapper.findAll('button').find((button) => button.text().trim() === label)
    const loadButton = buttonNamed('Load Repository')
    const demoButton = buttonNamed('Try the synthetic demo')
    expect(loadButton).toBeDefined()
    expect(demoButton).toBeDefined()
    // Both entry points carry the same primary treatment.
    for (const button of [loadButton!, demoButton!]) {
      expect(button.classes()).toContain('btn')
      expect(button.classes()).toContain('primary')
    }
    await demoButton!.trigger('click')
    expect(loadDemo).toHaveBeenCalledTimes(1)
    // The demo fills the field with its synthetic repository, as before.
    expect((wrapper.find('input[aria-label="Repository URL"]').element as HTMLInputElement).value).toBe(
      'demo/synthetic-repository',
    )
    loadDemo.mockRestore()
  })

  it('detects the provider while typing and shows a badge', async () => {
    const wrapper = mount(LandingView)
    const input = wrapper.find('input[aria-label="Repository URL"]')
    await input.setValue('https://github.com/acme/widget')
    expect(wrapper.find('.provider-badge').text()).toContain('GitHub')
    await input.setValue('https://gitlab.com/group/project')
    expect(wrapper.find('.provider-badge').text()).toContain('GitLab')
  })

  it('adds several repositories and loads them into one scene', async () => {
    const loadMany = vi.spyOn(controller, 'loadMany').mockResolvedValue()
    const wrapper = mount(LandingView)
    const add = wrapper.findAll('button').find((button) => button.text().includes('Add repository'))
    expect(add).toBeDefined()
    await add!.trigger('click')

    let inputs = wrapper.findAll('input[aria-label="Repository URL"]')
    expect(inputs).toHaveLength(2)
    await inputs[0].setValue('https://github.com/acme/one')
    await inputs[1].setValue('https://github.com/acme/two')
    inputs = wrapper.findAll('input[aria-label="Repository URL"]')
    expect((inputs[1].element as HTMLInputElement).value).toBe('https://github.com/acme/two')

    // The primary action names the project count and submits every row.
    expect(wrapper.text()).toContain('Load 2 repositories')
    await wrapper.find('form').trigger('submit')
    expect(loadMany).toHaveBeenCalledTimes(1)
    expect(loadMany).toHaveBeenCalledWith(['https://github.com/acme/one', 'https://github.com/acme/two'])
    loadMany.mockRestore()
  })

  it('removes a repository row and keeps the remaining projects', async () => {
    const wrapper = mount(LandingView)
    await wrapper.findAll('button').find((button) => button.text().includes('Add repository'))!.trigger('click')
    let inputs = wrapper.findAll('input[aria-label="Repository URL"]')
    await inputs[0].setValue('https://github.com/acme/one')
    await inputs[1].setValue('https://github.com/acme/two')

    await wrapper.find('button[title="Remove repository 1"]').trigger('click')
    inputs = wrapper.findAll('input[aria-label="Repository URL"]')
    expect(inputs).toHaveLength(1)
    expect((inputs[0].element as HTMLInputElement).value).toBe('https://github.com/acme/two')
    expect(store.url).toBe('https://github.com/acme/two')
    // Removing the last row leaves an empty input instead of an unusable form.
    await wrapper.find('button[title="Remove repository 1"]').trigger('click')
    inputs = wrapper.findAll('input[aria-label="Repository URL"]')
    expect(inputs).toHaveLength(1)
    expect((inputs[0].element as HTMLInputElement).value).toBe('')
  })

  it('pre-fills every project saved from the previous run', () => {
    store.loadOptions.urls = ['https://github.com/acme/one', 'https://gitlab.com/group/two']
    store.url = 'https://github.com/acme/one'
    const wrapper = mount(LandingView)
    const values = wrapper
      .findAll('input[aria-label="Repository URL"]')
      .map((input) => (input.element as HTMLInputElement).value)
    expect(values).toEqual(['https://github.com/acme/one', 'https://gitlab.com/group/two'])
    expect(wrapper.text()).toContain('Load 2 repositories')
  })

  it('fills the form with the five multi-repository samples', async () => {
    store.loading.error = 'old error'
    const wrapper = mount(LandingView)
    const fill = wrapper.findAll('button').find((button) => button.text().includes('Fill 5 repositories'))
    expect(fill).toBeTruthy()
    await fill!.trigger('click')

    const values = wrapper
      .findAll('input[aria-label="Repository URL"]')
      .map((input) => (input.element as HTMLInputElement).value)
    expect(values).toEqual([
      'hdlopesrocha/lithos-engine',
      'hdlopesrocha/vulkan-engine',
      'hdlopesrocha/opencode-talk',
      'hdlopesrocha/web-gource',
      'hdlopesrocha/infinity-edge-web',
    ])
    expect(wrapper.text()).toContain('Load 5 repositories')
    expect(store.url).toBe(values[0])
    expect(store.loading.error).toBeNull()
  })

  it('shows a token host selector when the projects span several providers', async () => {
    const wrapper = mount(LandingView)
    await wrapper.findAll('button').find((button) => button.text().includes('Add repository'))!.trigger('click')
    const inputs = wrapper.findAll('input[aria-label="Repository URL"]')
    await inputs[0].setValue('https://github.com/acme/one')
    await inputs[1].setValue('https://gitlab.com/group/two')
    await wrapper.find('button.btn.ghost').trigger('click') // Advanced

    const selector = wrapper.find('#token-provider')
    expect(selector.exists()).toBe(true)
    const options = selector.findAll('option').map((option) => option.text())
    expect(options).toEqual(['GitHub', 'GitLab (beta)'])

    // A token typed while GitLab is selected belongs to GitLab only.
    await selector.setValue('gitlab')
    const tokenInput = wrapper.find('input[aria-label="Personal access token"]')
    await tokenInput.setValue('glpat-multihost')
    await tokenInput.trigger('blur')
    expect(tokenFor('gitlab')).toBe('glpat-multihost')
    expect(tokenFor('github')).toBe('')
  })

  it('explains an unsupported host instead of failing silently', async () => {
    const wrapper = mount(LandingView)
    await wrapper.find('input[aria-label="Repository URL"]').setValue('https://bitbucket.org/a/b')
    expect(wrapper.text()).toContain('No provider matches')
  })

  it('clears the demo provider when a real URL is typed afterwards', async () => {
    // Returning from the demo leaves the demo provider forced. Editing a row
    // must release it, or the new GitHub URL would be resolved as a demo repo.
    store.forcedProvider = 'demo'
    const wrapper = mount(LandingView)
    await wrapper.find('input[aria-label="Repository URL"]').setValue('https://github.com/acme/widget')
    expect(store.forcedProvider).toBeNull()
    expect(wrapper.find('.provider-badge').text()).toContain('GitHub')
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

  it('offers the example repositories oldest first', () => {
    const wrapper = mount(LandingView)
    expect(wrapper.findAll('.examples button').map((button) => button.text())).toEqual([
      'gitlab-foss (GitLab, beta)',
      'vuejs/core',
      'hdlopesrocha/vulkan-engine',
      'hdlopesrocha/opencode-talk',
      'Fill 5 repositories',
    ])
  })

  it('fills the input when an example is clicked', async () => {
    const wrapper = mount(LandingView)
    const buttons = wrapper.findAll('.examples button')
    const target = buttons.find((button) => button.text().includes('opencode-talk'))
    expect(target).toBeDefined()
    await target?.trigger('click')
    expect(store.url).toBe('https://github.com/hdlopesrocha/opencode-talk')
  })

  it('uses examples to add a second project instead of replacing the first', async () => {
    const wrapper = mount(LandingView)
    const examples = wrapper.findAll('.examples button')
    await examples.find((button) => button.text().includes('vulkan-engine'))!.trigger('click')
    await examples.find((button) => button.text().includes('opencode-talk'))!.trigger('click')

    const values = wrapper
      .findAll('input[aria-label="Repository URL"]')
      .map((input) => (input.element as HTMLInputElement).value)
    expect(values).toEqual([
      'https://github.com/hdlopesrocha/vulkan-engine',
      'https://github.com/hdlopesrocha/opencode-talk',
    ])
    expect(store.url).toBe('https://github.com/hdlopesrocha/vulkan-engine')
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

  it('summarizes several projects and names them all in the header title', () => {
    const timeline = multiProjectTimeline()
    store.repo = timeline.repo
    store.repos = [repo, secondRepo]
    store.timelineStats = timeline.stats
    const wrapper = mount(StageView)

    expect(wrapper.find('.repo-name strong').text()).toBe('2 repositories')
    expect(wrapper.find('.repo-name').attributes('title')).toBe('acme/widget\nacme/service')
    expect(wrapper.text()).toContain('2 projects')
    expect(wrapper.text()).toContain('4 commits')
    expect(wrapper.text()).toContain('4 author instances')
    expect(wrapper.text()).toContain('← Repositories')
  })

  it('always offers the 3D view without a flat 2D toggle', () => {
    const wrapper = mount(StageView)
    const buttonNamed = (label: string) => wrapper.findAll('button').find((entry) => entry.text().trim() === label)
    expect(buttonNamed('2D')).toBeUndefined()
    expect(buttonNamed('Reset')).toBeTruthy()
  })
})

describe('panels', () => {
  /** A complete HUD: other tests leave components mounted that read every field. */
  function hudAt(date: number): NonNullable<typeof store.hud> {
    return {
      time: 0,
      duration: 1,
      date,
      index: 0,
      total: 1,
      playing: false,
      speed: 1,
      commit: null,
      activeAuthors: [],
      visibleFiles: 0,
      visibleDirs: 0,
      totalFiles: 0,
      sizeMode: 'bytes',
      filesWithSize: 0,
      totalBytes: 0,
      additions: 0,
      deletions: 0,
      fps: 0,
      recording: false,
    }
  }

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
    expect(wrapper.text()).toContain('ada@example.com')
    expect(wrapper.findAll('.author-row').length).toBe(1)
  })

  it('authors panel lists every person sharing a username when emails differ', () => {
    const first = rawCommit(0)
    const timeline = buildTimeline(repo, [
      { ...first, author: { name: 'Ada', email: 'ada@one.example', login: 'ada' } },
      { ...first, sha: 'sha-second', author: { name: 'Ada', email: 'ada@two.example', login: 'ada' } },
    ])
    vi.spyOn(controller, 'timelineAuthors').mockReturnValue(timeline.authors)
    const wrapper = mount(AuthorsPanel)

    expect(wrapper.findAll('.author-row')).toHaveLength(2)
    expect(wrapper.text()).toContain('ada@one.example')
    expect(wrapper.text()).toContain('ada@two.example')
  })

  it('authors panel shows one instance per project with project badges', () => {
    const timeline = multiProjectTimeline()
    vi.spyOn(controller, 'timelineAuthors').mockReturnValue(timeline.authors)
    store.repos = [repo, secondRepo]
    store.timelineStats = timeline.stats
    const wrapper = mount(AuthorsPanel)

    expect(wrapper.text()).toContain('4 author instances across 2 projects')
    expect(wrapper.findAll('.author-row')).toHaveLength(4)
    const badges = wrapper.findAll('.badge.project').map((badge) => badge.text())
    expect(badges).toHaveLength(4)
    expect(badges.filter((name) => name === 'acme/widget')).toHaveLength(2)
    expect(badges.filter((name) => name === 'acme/service')).toHaveLength(2)

    // Both people appear twice: once for each project they committed to.
    const names = wrapper.findAll('.author-row .name').map((name) => name.text())
    expect(names.filter((name) => name === 'Ada')).toHaveLength(2)
    expect(names.filter((name) => name === 'Bob')).toHaveLength(2)
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

  it('activity panel follows the playback position', async () => {
    const at = (index: number, timestamp: number): RawCommit => ({ ...rawCommit(index), timestamp })
    const timeline = buildTimeline(repo, [
      at(0, Date.UTC(2024, 2, 6, 14, 30)), // Wednesday
      at(1, Date.UTC(2024, 2, 6, 14, 50)), // Wednesday, same hour
      at(2, Date.UTC(2024, 2, 8, 9, 0)), // Friday
    ])
    vi.spyOn(controller, 'currentTimeline', 'get').mockReturnValue(timeline)

    // At the first commit only that one is counted.
    store.hud = hudAt(Date.UTC(2024, 2, 6, 14, 30))
    const wrapper = mount(ActivityPanel)
    expect(wrapper.text()).toContain('1 commits · busiest Wed 14:00 (1)')
    expect(wrapper.text()).toContain('→ 2024-03-09')

    // Scrubbing forward adds the later commits, and the future appears only
    // once it has happened.
    store.hud = hudAt(Date.UTC(2024, 2, 8, 9, 0))
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('3 commits · busiest Wed 14:00 (2)')

    // And back again: the future is removed, not just left shaded.
    store.hud = hudAt(Date.UTC(2024, 2, 6, 14, 30))
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('1 commits · busiest Wed 14:00 (1)')
    vi.restoreAllMocks()
  })

  it('activity panel sizes its canvases to the chart, not to a probe height', async () => {
    const timeline = buildTimeline(repo, [rawCommit(0), rawCommit(1)])
    vi.spyOn(controller, 'currentTimeline', 'get').mockReturnValue(timeline)
    store.hud = hudAt(Date.UTC(2024, 2, 8, 12, 0))
    const wrapper = mount(ActivityPanel)
    await wrapper.vm.$nextTick()

    const canvases = wrapper.findAll('canvas')
    expect(canvases).toHaveLength(2)
    for (const canvas of canvases) {
      const element = canvas.element as HTMLCanvasElement
      // The bug: a probe height made the cells (and the canvas) ~1000px tall.
      expect(element.height).toBeGreaterThan(40)
      expect(element.height).toBeLessThan(220)
    }
    vi.restoreAllMocks()
  })

  it('activity panel draws both heatmaps from the timeline', () => {
    const at = (index: number, timestamp: number): RawCommit => ({ ...rawCommit(index), timestamp })
    const timeline = buildTimeline(repo, [
      at(0, Date.UTC(2024, 2, 6, 14, 30)), // Wednesday
      at(1, Date.UTC(2024, 2, 6, 14, 50)), // Wednesday, same hour
      at(2, Date.UTC(2024, 2, 8, 9, 0)), // Friday
    ])
    vi.spyOn(controller, 'currentTimeline', 'get').mockReturnValue(timeline)
    store.hud = hudAt(Date.UTC(2024, 2, 8, 12, 0))
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

  it('settings panel offers the beam styles', async () => {
    const wrapper = mount(SettingsPanel)
    // Travelling is the default; the classic solid ray stays selectable.
    expect(store.settings.beamStyle).toBe('travelling')
    const select = wrapper.find('#beam-style').element as HTMLSelectElement
    expect(select.value).toBe('travelling')
    const options = [...select.options].map((option) => option.value)
    expect(options).toEqual(['travelling', 'solid'])
    expect(wrapper.text()).toContain('Travel time')
    expect(wrapper.text()).toContain('solid ray is the original full-length line')
  })

  it('settings panel exposes the plasma opacity', async () => {
    const wrapper = mount(SettingsPanel)
    await openTab(wrapper, 'Visual')
    const field = wrapper
      .findAll('div.field')
      .find((entry) => entry.find('label').text().startsWith('Opacity'))
    expect(field).toBeTruthy()
    const slider = field!.find('input[type="range"]')
    expect((slider.element as HTMLInputElement).value).toBe('1')
    await slider.setValue('0.2')
    expect(store.settings.plasmaOpacity).toBeCloseTo(0.2, 5)

    // Files and folders are always spheres; the old billboard toggle is gone.
    expect(wrapper.text()).not.toContain('3D file spheres')

    // Leave the singleton store as the other tests expect it.
    store.settings.plasmaOpacity = 1
  })

  it('settings panel exposes visualization, camera, filter and data tabs', async () => {
    const wrapper = mount(SettingsPanel)
    expect(wrapper.text()).toContain('Visual')
    await openTab(wrapper, 'Camera')
    expect(wrapper.text()).toContain('Automatic view')
    expect(wrapper.text()).toContain('Reset to the default view')
    expect(wrapper.text()).not.toContain('Flat top-down 2D view')
    await openTab(wrapper, 'Filters')
    expect(wrapper.text()).toContain('Hidden folders')
    expect(wrapper.text()).toContain('Ignored folders')
    await openTab(wrapper, 'Recording')
    expect(wrapper.text()).toContain('Video export')
    await openTab(wrapper, 'Data')
    expect(wrapper.text()).toContain('Loaded data')
  })

  it('settings panel lists every project with its own counts', async () => {
    const timeline = multiProjectTimeline()
    vi.spyOn(controller, 'currentTimeline', 'get').mockReturnValue(timeline)
    store.repo = timeline.repo
    store.repos = [repo, secondRepo]
    store.timelineStats = timeline.stats
    const wrapper = mount(SettingsPanel)
    await openTab(wrapper, 'Data')

    expect(wrapper.text()).toContain('Projects')
    expect(wrapper.text()).toContain('acme/widget')
    expect(wrapper.text()).toContain('acme/service')
    expect(wrapper.text()).toContain('2 commits · 2 authors')
  })

  it('authors panel keeps to authors and dates', () => {
    const wrapper = mount(AuthorsPanel)
    // No folder-filter UI and no pointer to it: those live in Settings → Filters.
    expect(wrapper.find('input[list="ignored-folder-suggestions"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Open folder filters')
    expect(wrapper.text()).not.toContain('Folder filters')
    expect(wrapper.text()).toContain('Show commits between')
    expect(wrapper.text()).toContain('Clear every filter')
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

  it('settings panel loads and configures background music', async () => {
    store.music.volume = 0.7
    store.music.fadeInSeconds = 2
    store.music.fadeOutSeconds = 2
    store.music.fileName = null
    store.music.duration = 0
    store.music.loading = false
    store.music.error = null

    const loadMusic = vi.spyOn(controller, 'loadMusic').mockResolvedValue()
    const wrapper = mount(SettingsPanel)
    await openTab(wrapper, 'Music')
    const section = wrapper.findAll('section.group').find((entry) => entry.find('h3').text() === 'Background music')
    expect(section).toBeDefined()
    expect(section!.text()).toContain('No track loaded')
    expect(section!.text()).toContain('included in deterministic renders and live captures')
    expect(section!.text()).toContain('Audio-reactive visuals')

    const input = wrapper.find('#music-file')
    expect(input.attributes('accept')).toContain('.mp3')
    const file = new File([new Uint8Array([1, 2, 3])], 'song.mp3', { type: 'audio/mpeg' })
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')
    expect(loadMusic).toHaveBeenCalledWith(file)
    await flushPromises()
    loadMusic.mockRestore()

    // The loaded track is shown with its loop length.
    store.music.fileName = 'song.mp3'
    store.music.duration = 83
    await wrapper.vm.$nextTick()
    expect(section!.text()).toContain('song.mp3')
    expect(section!.text()).toContain('1:23 loop')

    const sliders = section!.findAll('input[type="range"]')
    expect(sliders).toHaveLength(3)
    await sliders[0].setValue('0.35')
    await sliders[1].setValue('1.5')
    await sliders[2].setValue('0.5')
    expect(store.music.volume).toBeCloseTo(0.35, 5)
    expect(store.music.fadeInSeconds).toBeCloseTo(1.5, 5)
    expect(store.music.fadeOutSeconds).toBeCloseTo(0.5, 5)

    const saved = JSON.parse(localStorage.getItem('web-gource:music:v1') ?? '{}') as {
      volume?: number
      fadeInSeconds?: number
      fadeOutSeconds?: number
    }
    expect(saved.volume).toBeCloseTo(0.35, 5)
    expect(saved.fadeInSeconds).toBeCloseTo(1.5, 5)
    expect(saved.fadeOutSeconds).toBeCloseTo(0.5, 5)

    const remove = section!.findAll('button').find((button) => button.attributes('title')?.includes('Remove'))
    expect(remove).toBeDefined()
    await remove!.trigger('click')
    expect(store.music.fileName).toBeNull()
    expect(store.music.duration).toBe(0)
    expect(section!.text()).toContain('No track loaded')

    // The reactive visuals toggle is a persisted setting and lives with the music.
    store.settings.audioReactive = true
    const toggle = section!.find('input[type="checkbox"]')
    expect((toggle.element as HTMLInputElement).checked).toBe(true)
    await toggle.setValue(false)
    expect(store.settings.audioReactive).toBe(false)
    const savedSettings = JSON.parse(localStorage.getItem('web-gource:settings:v1') ?? '{}') as {
      audioReactive?: boolean
    }
    expect(savedSettings.audioReactive).toBe(false)
    store.settings.audioReactive = true
  })

  it('keeps music settings out of the recording tab', async () => {
    const wrapper = mount(SettingsPanel)
    await openTab(wrapper, 'Recording')
    expect(wrapper.find('#music-file').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Audio-reactive visuals')
  })

  it('help overlay documents shortcuts and limitations', () => {
    const wrapper = mount(HelpOverlay)
    expect(wrapper.text()).toContain('Space')
    expect(wrapper.text()).toContain('60 requests/hour')
    expect(wrapper.text()).toContain('WebCodecs')
    expect(wrapper.text()).toContain('activity plasma')
    expect(wrapper.text()).toContain('microphone')
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
    const list = [
      {
        author: { id: 'x', name: 'Ada', commits: 1, first: 0, last: 0, additions: 0, deletions: 0, colorIndex: 0, unattributed: false },
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        target: { x: 0, y: 0, z: 0 },
        targetNodeId: 0,
        lastActiveAt: 0,
        appearedAt: 0,
        appliedCommits: 1,
        lastKind: 'modify' as const,
        visible: true,
        tethers: [],
      },
    ]
    authors.sync(list)
    // Both the halo and the avatar itself render above the beams (12) and the
    // labels stay on top of everything.
    expect(authors.group.children.length).toBeGreaterThan(0)
    for (const child of authors.group.children) {
      expect(child.renderOrder).toBeGreaterThan(12)
      expect(child.renderOrder).toBeLessThan(30)
    }

    // The vocal range makes the avatars breathe without rebuilding textures.
    const slot = (authors as unknown as { slots: { sprite: { scale: { y: number } } }[] }).slots[0]
    const restHeight = slot.sprite.scale.y
    authors.sync(list, 0, 1)
    expect(slot.sprite.scale.y).toBeGreaterThan(restHeight)
    authors.sync(list, 0, 0)
    expect(slot.sprite.scale.y).toBeCloseTo(restHeight, 4)
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
