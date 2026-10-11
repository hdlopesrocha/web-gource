import { afterEach, describe, expect, it } from 'vitest'
import { GitHubProvider, parseLastPage } from '../src/git/providers/github'
import { createMockGithub, generateCommits, type MockCommit, type MockGithubOptions } from './helpers/mockGithub'
import { resolveRepoInput } from '../src/git/providers'
import { GitError } from '../src/git/errors'

const realFetch = globalThis.fetch

/**
 * Each test gets a unique repository name so the module level payload cache
 * never leaks state between tests (which is exactly what it does in the app).
 */
let repoCounter = 0
interface SetupOptions extends Omit<MockGithubOptions, 'commits' | 'owner' | 'repo' | 'failures'> {
  /** Failure rules, built with the generated repository name. */
  failures?: (repo: string) => MockGithubOptions['failures']
}

function setup(commits: MockCommit[], options: SetupOptions = {}) {
  repoCounter += 1
  const repo = `widget-${repoCounter}`
  const mock = createMockGithub({
    owner: 'acme',
    repo,
    commits,
    ...options,
    failures: options.failures?.(repo),
  })
  globalThis.fetch = mock.fetch
  return {
    mock,
    repo,
    resolved: resolveRepoInput(`https://github.com/acme/${repo}`),
  }
}

const simpleCommits: MockCommit[] = [
  {
    sha: 'b'.repeat(40),
    message: 'feat: add renderer\n\nMore detail here.',
    author: { name: 'Ada Lovelace', email: 'ada@example.com', login: 'ada', avatar_url: 'https://example.com/ada.png' },
    date: '2024-03-02T10:00:00Z',
    parents: ['a'.repeat(40)],
    files: [
      { filename: 'src/renderer.ts', status: 'added', additions: 120, deletions: 0 },
      { filename: 'README.md', status: 'modified', additions: 4, deletions: 1 },
    ],
  },
  {
    sha: 'a'.repeat(40),
    message: 'chore: initial commit',
    author: { name: 'Grace Hopper', email: 'grace@example.com' },
    date: '2024-01-01T09:00:00Z',
    parents: [],
    files: [{ filename: 'README.md', status: 'added', additions: 10, deletions: 0 }],
  },
]

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('GitHubProvider', () => {
  it('parses a repository URL and builds commit URLs', () => {
    const provider = new GitHubProvider()
    const parsed = provider.parse(new URL('https://github.com/acme/widget'))
    expect(parsed?.owner).toBe('acme')
    expect(parsed?.repo).toBe('widget')
    expect(parsed && provider.commitUrl(parsed, 'abc')).toBe('https://github.com/acme/widget/commit/abc')
    expect(provider.parse(new URL('https://gitlab.com/a/b'))).toBeNull()
  })

  it('normalizes repository metadata', async () => {
    const { resolved, mock } = setup(simpleCommits)
    const provider = new GitHubProvider()
    const info = await provider.fetchRepoInfo(resolved.parsed)
    expect(info.fullName).toBe(`acme/${resolved.parsed.repo}`)
    expect(info.defaultBranch).toBe('main')
    expect(info.isPrivate).toBe(false)
    expect(info.language).toBe('TypeScript')
    expect(mock.requests).toHaveLength(1)
  })

  it('fetches a commit page and hydrates normalized file changes', async () => {
    const { resolved, mock } = setup(simpleCommits)
    const provider = new GitHubProvider()
    const page = await provider.loadCommitPage(resolved.parsed, { limit: 100 })
    expect(page.commits).toHaveLength(2)
    // Newest first, no file data before hydration.
    expect(page.commits[0].sha).toBe('b'.repeat(40))
    expect(page.commits[0].files).toBeNull()

    await provider.hydrateFiles(resolved.parsed, page.commits, {})
    const newest = page.commits[0]
    expect(newest.files).toHaveLength(2)
    expect(newest.files?.[0]).toMatchObject({ path: 'src/renderer.ts', kind: 'add', additions: 120 })
    expect(newest.author.login).toBe('ada')
    expect(newest.stats).toEqual({ additions: 124, deletions: 1 })
    expect(mock.detailRequests()).toBe(2)
  })

  it('marks merge commits without files instead of inventing changes', async () => {
    const merge: MockCommit = {
      sha: 'c'.repeat(40),
      message: 'Merge branch feature',
      author: { name: 'Merge Bot', email: 'bot@example.com' },
      date: '2024-04-01T00:00:00Z',
      parents: ['b'.repeat(40), 'd'.repeat(40)],
      omitFiles: true,
    }
    const { resolved } = setup([merge])
    const provider = new GitHubProvider()
    const page = await provider.loadCommitPage(resolved.parsed, { limit: 100 })
    await provider.hydrateFiles(resolved.parsed, page.commits, {})
    const commit = page.commits[0]
    expect(commit.isMerge).toBe(true)
    expect(commit.files).toEqual([])
    expect(commit.filesMissing).toBe('merge-parents')
  })

  it('flags truncated file lists at the 300 file cap', async () => {
    const files = Array.from({ length: 300 }, (_, index) => ({
      filename: `src/file-${index}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
    }))
    const { resolved } = setup([
      {
        sha: 'd'.repeat(40),
        message: 'big change',
        author: { name: 'Busy Dev', email: 'busy@example.com' },
        date: '2024-05-01T00:00:00Z',
        files,
      },
    ])
    const provider = new GitHubProvider()
    const page = await provider.loadCommitPage(resolved.parsed, { limit: 100 })
    await provider.hydrateFiles(resolved.parsed, page.commits, {})
    expect(page.commits[0].filesTruncated).toBe(true)
    expect(page.commits[0].files).toHaveLength(300)
  })

  it('maps removed and renamed files', async () => {
    const { resolved } = setup([
      {
        sha: 'e'.repeat(40),
        message: 'restructure',
        author: { name: 'Dev', email: 'dev@example.com' },
        date: '2024-06-01T00:00:00Z',
        files: [
          { filename: 'src/new-name.ts', previous_filename: 'src/old-name.ts', status: 'renamed', additions: 2, deletions: 2 },
          { filename: 'docs/legacy.md', status: 'removed', additions: 0, deletions: 30 },
          { filename: 'src/copy.ts', previous_filename: 'src/new-name.ts', status: 'copied', additions: 5, deletions: 0 },
        ],
      },
    ])
    const provider = new GitHubProvider()
    const page = await provider.loadCommitPage(resolved.parsed, { limit: 100 })
    await provider.hydrateFiles(resolved.parsed, page.commits, {})
    const files = page.commits[0].files ?? []
    expect(files[0]).toMatchObject({ path: 'src/new-name.ts', previousPath: 'src/old-name.ts', kind: 'rename' })
    expect(files[1]).toMatchObject({ path: 'docs/legacy.md', kind: 'delete' })
    expect(files[2]).toMatchObject({ path: 'src/copy.ts', kind: 'rename' })
  })

  it('keeps commits when a detail request fails', async () => {
    const commits = generateCommits(3).map((commit, index) => (index === 1 ? { ...commit, detailStatus: 500 } : commit))
    const { resolved } = setup(commits)
    const provider = new GitHubProvider()
    const page = await provider.loadCommitPage(resolved.parsed, { limit: 100 })
    await provider.hydrateFiles(resolved.parsed, page.commits, {})
    const failed = page.commits.find((commit) => commit.filesMissing === 'error')
    expect(failed).toBeDefined()
    expect(failed?.files).toBeNull()
    expect(page.commits.filter((commit) => commit.files !== null).length).toBeGreaterThan(0)
  })

  it('stops hydrating when the quota runs out and flags the rest', async () => {
    const commits = generateCommits(10)
    const { resolved } = setup(commits, { rateRemaining: 4 })
    const provider = new GitHubProvider()
    const page = await provider.loadCommitPage(resolved.parsed, { limit: 100 })
    const remaining: number[] = []
    await provider.hydrateFiles(resolved.parsed, page.commits, {
      onProgress: (value) => {
        if (value.rateRemaining !== undefined) remaining.push(value.rateRemaining)
      },
    })
    const missing = page.commits.filter((commit) => commit.files === null)
    expect(missing.length).toBeGreaterThan(0)
    expect(missing.every((commit) => commit.filesMissing === 'rate-limit')).toBe(true)
    expect(remaining.length).toBeGreaterThan(0)
  })

  it('surfaces a clear error for empty repositories', async () => {
    const { resolved } = setup([], { empty: true })
    const provider = new GitHubProvider()
    await expect(provider.loadCommitPage(resolved.parsed, {})).rejects.toThrowError(/empty repository/i)
    try {
      await provider.loadCommitPage(resolved.parsed, {})
    } catch (error) {
      expect((error as GitError).kind).toBe('unsupported')
    }
  })

  it('classifies rate limit responses', async () => {
    const { resolved } = setup(simpleCommits, {
      failures: (repo) => [{ path: new RegExp(`/repos/acme/${repo}/commits(\\?|$)`), status: 403, body: 'API rate limit exceeded' }],
    })
    const provider = new GitHubProvider()
    await expect(provider.loadCommitPage(resolved.parsed, {})).rejects.toMatchObject({ kind: 'rate-limit' })
  })

  it('classifies 404 as not-found and sends the token header when provided', async () => {
    const { resolved, mock } = setup(simpleCommits, {
      failures: (repo) => [{ path: new RegExp(`/repos/acme/${repo}$`), status: 404 }],
    })
    const provider = new GitHubProvider()
    await expect(provider.fetchRepoInfo(resolved.parsed, { auth: { token: 'secret-token' } })).rejects.toMatchObject({
      kind: 'not-found',
    })
    const request = mock.requests.at(-1)
    expect(request?.headers['authorization']).toBe('Bearer secret-token')
  })

  it('uses the cache for repeated hydration without extra requests', async () => {
    const { resolved, mock } = setup(simpleCommits)
    const provider = new GitHubProvider()
    const first = await provider.loadCommitPage(resolved.parsed, { limit: 100 })
    await provider.hydrateFiles(resolved.parsed, first.commits, {})
    const firstCount = mock.detailRequests()

    const second = await provider.loadCommitPage(resolved.parsed, { limit: 100 })
    await provider.hydrateFiles(resolved.parsed, second.commits, {})
    expect(mock.detailRequests()).toBe(firstCount)
    expect(second.commits[0].files).not.toBeNull()
  })

  it('paginates through a large history with one request per page', async () => {
    const commits = generateCommits(250)
    const { resolved, mock } = setup(commits)
    const provider = new GitHubProvider()
    const first = await provider.loadCommitPage(resolved.parsed, { limit: 100 })
    expect(first.commits).toHaveLength(100)
    expect(first.next).toBe('p2')
    const second = await provider.loadCommitPage(resolved.parsed, { limit: 100, cursor: 'p2' })
    expect(second.commits).toHaveLength(100)
    expect(second.next).toBe('p3')
    const third = await provider.loadCommitPage(resolved.parsed, { limit: 100, cursor: 'p3' })
    expect(third.commits).toHaveLength(50)
    expect(third.next).toBeNull()
    expect(mock.listRequests()).toBe(3)
  })

  it('finds the oldest page in two requests', async () => {
    const commits = generateCommits(250)
    const { resolved, mock } = setup(commits)
    const provider = new GitHubProvider()
    const page = await provider.loadEarliestPage(resolved.parsed, { limit: 100 })
    expect(page.commits).toHaveLength(50)
    expect(page.next).toBe('p2')
    expect(mock.listRequests()).toBe(2)
    // The oldest commit of the generated history is the last one chronologically.
    expect(page.commits.at(-1)?.message.split('\n')[0]).toBe('commit 0')
  })
})

describe('parseLastPage', () => {
  it('extracts the last page number from a Link header', () => {
    const header =
      '<https://api.github.com/repositories/1/commits?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/commits?per_page=100&page=72>; rel="last"'
    expect(parseLastPage(header)).toBe(72)
    expect(parseLastPage(null)).toBeUndefined()
    expect(parseLastPage('<https://api.github.com/x>; rel="next"')).toBeUndefined()
  })
})

describe('GitHubProvider file sizes', () => {
  it('reads blob sizes from the recursive tree in a single request', async () => {
    const { resolved, mock } = setup(simpleCommits, {
      treeSizes: {
        'src/renderer.ts': 4096,
        'README.md': 512,
        'src/index.ts': 20_000,
      },
    })
    const provider = new GitHubProvider()
    const result = await provider.fetchFileSizes(resolved.parsed, { ref: 'b'.repeat(40) })
    expect(result).not.toBeNull()
    expect(result?.source).toBe('git-tree')
    expect(result?.truncated).toBe(false)
    expect(result?.sizes.get('src/renderer.ts')).toBe(4096)
    expect(result?.sizes.size).toBe(3)
    // One request for the whole tree.
    expect(mock.requests.filter((request) => request.url.includes('/git/trees/'))).toHaveLength(1)
  })

  it('flags a truncated tree and returns null when the host has no sizes', async () => {
    const truncated = setup(simpleCommits, { treeSizes: { 'a.ts': 10 }, treeTruncated: true })
    const provider = new GitHubProvider()
    const result = await provider.fetchFileSizes(truncated.resolved.parsed, { ref: 'b'.repeat(40) })
    expect(result?.truncated).toBe(true)

    const unavailable = setup(simpleCommits)
    const missing = await provider.fetchFileSizes(unavailable.resolved.parsed, { ref: 'b'.repeat(40) })
    expect(missing).toBeNull()
  })

  it('caches sizes per ref and needs a ref to work', async () => {
    const { resolved, mock } = setup(simpleCommits, { treeSizes: { 'a.ts': 10 } })
    const provider = new GitHubProvider()
    expect(await provider.fetchFileSizes(resolved.parsed, {})).toBeNull()
    await provider.fetchFileSizes(resolved.parsed, { ref: 'sha-1' })
    await provider.fetchFileSizes(resolved.parsed, { ref: 'sha-1' })
    expect(mock.requests.filter((request) => request.url.includes('/git/trees/'))).toHaveLength(1)
  })
})
