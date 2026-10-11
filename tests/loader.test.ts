import { afterEach, describe, expect, it } from 'vitest'
import { loadHistory } from '../src/git/loader'
import { resolveRepoInput } from '../src/git/providers'
import { createMockGithub, generateCommits, type MockCommit } from './helpers/mockGithub'
import { GitError } from '../src/git/errors'
import { buildTimeline } from '../src/timeline/builder'
import type { RawCommit } from '../src/git/types'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Unique repo names per test keep the in-memory cache from leaking state. */
let repoCounter = 0
function uniqueRepo(): string {
  repoCounter += 1
  return `repo-${repoCounter}`
}

function setup(commits: MockCommit[], options: Parameters<typeof createMockGithub>[0] extends infer T ? Omit<T, 'commits' | 'owner' | 'repo'> : never = {}) {
  const repo = uniqueRepo()
  const mock = createMockGithub({ owner: 'itest', repo, commits, ...options })
  globalThis.fetch = mock.fetch
  return { mock, resolved: resolveRepoInput(`https://github.com/itest/${repo}`) }
}

describe('loadHistory', () => {
  it('loads a small repository end to end, oldest first', async () => {
    const commits = generateCommits(12)
    const { resolved, mock } = setup(commits)
    const batches: RawCommit[][] = []
    const result = await loadHistory(resolved, {
      maxCommits: 100,
      range: 'latest',
      onCommits: (batch) => batches.push(batch),
    })

    expect(result.repo.fullName).toBe(`itest/${resolved.parsed.repo}`)
    expect(result.commits).toHaveLength(12)
    expect(result.complete).toBe(true)
    expect(result.truncated).toBe(false)
    expect(result.missingFiles).toBe(0)
    // Chronological order.
    for (let index = 1; index < result.commits.length; index += 1) {
      expect(result.commits[index].timestamp).toBeGreaterThanOrEqual(result.commits[index - 1].timestamp)
    }
    // Every commit got file data.
    expect(result.commits.every((commit) => commit.files !== null)).toBe(true)
    // Batches were emitted incrementally.
    expect(batches.length).toBeGreaterThanOrEqual(1)
    expect(batches.flat()).toHaveLength(12)
    // 1 metadata + 1 list page + 12 details.
    expect(mock.listRequests()).toBe(1)
    expect(mock.detailRequests()).toBe(12)
  })

  it('reports a truncated window when only part of the history is requested', async () => {
    const commits = generateCommits(120)
    const { resolved } = setup(commits)
    const result = await loadHistory(resolved, { maxCommits: 30, range: 'latest' })
    expect(result.commits).toHaveLength(30)
    expect(result.truncated).toBe(true)
    expect(result.complete).toBe(false)
    expect(result.warnings.join(' ')).toMatch(/Showing the newest 30/)
  })

  it('can start from the first commit of the repository', async () => {
    const commits = generateCommits(120)
    const { resolved } = setup(commits)
    const result = await loadHistory(resolved, { maxCommits: 25, range: 'earliest' })
    expect(result.commits).toHaveLength(25)
    // The generator's oldest commit is #0, so the window starts there.
    expect(result.commits[0].message.split('\n')[0]).toBe('commit 0')
    expect(result.commits[1].message.split('\n')[0]).toBe('commit 1')
    expect(result.commits[24].message.split('\n')[0]).toBe('commit 24')
    for (let index = 1; index < result.commits.length; index += 1) {
      expect(result.commits[index].timestamp).toBeGreaterThanOrEqual(result.commits[index - 1].timestamp)
    }
  })

  it('keeps commits and explains the gap when the quota runs out', async () => {
    const commits = generateCommits(40)
    const { resolved } = setup(commits, { rateRemaining: 8 })
    const result = await loadHistory(resolved, { maxCommits: 40, range: 'latest' })
    expect(result.commits).toHaveLength(40)
    expect(result.missingFiles).toBeGreaterThan(0)
    expect(result.warnings.join(' ')).toMatch(/quota/i)
    const flagged = result.commits.filter((commit) => commit.filesMissing === 'rate-limit')
    expect(flagged.length).toBeGreaterThan(0)
  })

  it('fails clearly for an empty repository', async () => {
    const { resolved } = setup([], { empty: true })
    await expect(loadHistory(resolved, { maxCommits: 10, range: 'latest' })).rejects.toThrowError(/empty repository/i)
  })

  it('fails clearly when the repository does not exist', async () => {
    const { resolved } = setup(generateCommits(3), {
      failures: [{ path: /\/repos\/itest\/.*$/, status: 404 }],
    })
    try {
      await loadHistory(resolved, { maxCommits: 10, range: 'latest' })
      throw new Error('expected a failure')
    } catch (error) {
      expect(error).toBeInstanceOf(GitError)
      expect((error as GitError).kind).toBe('not-found')
    }
  })

  it('reports rate limiting from the metadata request', async () => {
    const { resolved } = setup(generateCommits(3), {
      failures: [{ path: /\/repos\/itest\/.*$/, status: 403, body: 'API rate limit exceeded' }],
    })
    await expect(loadHistory(resolved, { maxCommits: 10, range: 'latest' })).rejects.toMatchObject({
      kind: 'rate-limit',
    })
  })

  it('supports cancellation', async () => {
    const commits = generateCommits(60)
    const { resolved } = setup(commits, { latencyMs: 12 })
    const abort = new AbortController()
    const promise = loadHistory(resolved, { maxCommits: 60, range: 'latest', signal: abort.signal })
    setTimeout(() => abort.abort(), 5)
    await expect(promise).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('survives commits whose detail requests fail', async () => {
    const commits = generateCommits(10).map((commit, index) => (index % 3 === 0 ? { ...commit, detailStatus: 500 } : commit))
    const { resolved } = setup(commits)
    const result = await loadHistory(resolved, { maxCommits: 10, range: 'latest' })
    expect(result.commits).toHaveLength(10)
    expect(result.missingFiles).toBeGreaterThan(0)
    expect(result.commits.some((commit) => commit.files === null && commit.filesMissing === 'error')).toBe(true)
  })

  it('feeds the timeline builder with a complete normalized history', async () => {
    const commits = generateCommits(20)
    const { resolved } = setup(commits)
    const result = await loadHistory(resolved, { maxCommits: 20, range: 'latest' })
    const timeline = buildTimeline(result.repo, result.commits, {
      truncated: result.truncated,
      warnings: result.warnings,
    })
    expect(timeline.commits).toHaveLength(20)
    expect(timeline.stats.authors).toBe(4)
    expect(timeline.stats.additions).toBeGreaterThan(0)
    expect(timeline.stats.activity.length).toBeGreaterThan(0)
    expect(timeline.commits[0].changes.length).toBeGreaterThan(0)
  })
})
