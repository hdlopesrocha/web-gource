import { describe, expect, it } from 'vitest'
import { loadHistory } from '../../src/git/loader'
import { resolveRepoInput } from '../../src/git/providers'
import { GitError, describeGitError } from '../../src/git/errors'
import { buildTimeline } from '../../src/timeline/builder'
import { buildSchedule } from '../../src/timeline/schedule'
import { Simulation } from '../../src/sim/simulation'

/**
 * Live API checks. These validate that the parsers match the *real* payloads of
 * the hosting providers (field names, pagination headers, file change shapes)
 * which mocked fixtures cannot guarantee.
 *
 * A repository URL can be overridden with `WEB_GOURCE_TEST_REPO`, and a token
 * can be supplied through `GITHUB_TOKEN` to avoid the anonymous quota.
 */

const REPO = process.env['WEB_GOURCE_TEST_REPO'] ?? 'https://github.com/hdlopesrocha/opencode-talk'
const TOKEN = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'] ?? undefined

function rateLimited(error: unknown): boolean {
  return error instanceof GitError && (error.kind === 'rate-limit' || error.kind === 'auth')
}

describe('live GitHub integration', () => {
  it('loads a real repository and builds a playable timeline', async () => {
    const resolved = resolveRepoInput(REPO)
    let result
    try {
      result = await loadHistory(resolved, { maxCommits: 15, range: 'latest', token: TOKEN })
    } catch (error) {
      if (rateLimited(error)) {
        console.warn(`skipped: ${describeGitError(error)}`)
        return
      }
      throw error
    }

    expect(result.repo.fullName.length).toBeGreaterThan(0)
    expect(result.repo.defaultBranch.length).toBeGreaterThan(0)
    expect(result.commits.length).toBeGreaterThan(0)

    // Chronological order.
    for (let index = 1; index < result.commits.length; index += 1) {
      expect(result.commits[index].timestamp).toBeGreaterThanOrEqual(result.commits[index - 1].timestamp)
    }
    // Real payloads always carry these fields.
    for (const commit of result.commits) {
      expect(commit.sha.length).toBeGreaterThanOrEqual(7)
      expect(commit.timestamp).toBeGreaterThan(0)
      expect(commit.author.name.length).toBeGreaterThan(0)
    }
    // At least some commits must have file level data unless the quota ran out.
    const withFiles = result.commits.filter((commit) => commit.files !== null)
    if (result.missingFiles === 0) expect(withFiles.length).toBe(result.commits.length)

    for (const commit of withFiles) {
      for (const change of commit.files ?? []) {
        expect(change.path.length).toBeGreaterThan(0)
        expect(['add', 'modify', 'delete', 'rename']).toContain(change.kind)
        if (change.kind === 'rename') expect(change.previousPath?.length ?? 0).toBeGreaterThan(0)
      }
    }

    const timeline = buildTimeline(result.repo, result.commits, { truncated: result.truncated })
    const schedule = buildSchedule(timeline.commits)
    expect(schedule.duration).toBeGreaterThan(0)

    const sim = new Simulation(timeline.commits, timeline.authorById)
    sim.scheduleTime = (index) => schedule.times[index] ?? 0
    sim.applyUpTo(timeline.commits.length - 1)
    const stats = sim.stats()
    expect(stats.files).toBeGreaterThan(0)
    expect(stats.visibleFiles).toBeGreaterThan(0)
    console.log(
      `  loaded ${timeline.stats.commits} commits from ${result.repo.fullName}: ` +
        `${timeline.stats.authors} authors, ${stats.dirs} dirs, ${stats.files} files, ` +
        `${result.requestCount} API requests`,
    )
  })

  it('can start from the very first commits of a real repository', async () => {
    const resolved = resolveRepoInput(REPO)
    let result
    try {
      result = await loadHistory(resolved, { maxCommits: 10, range: 'earliest', token: TOKEN })
    } catch (error) {
      if (rateLimited(error)) {
        console.warn(`skipped: ${describeGitError(error)}`)
        return
      }
      throw error
    }
    expect(result.commits.length).toBeGreaterThan(0)
    // The first commit of a repository has no parents.
    expect(result.commits[0].parents.length).toBe(0)
    for (let index = 1; index < result.commits.length; index += 1) {
      expect(result.commits[index].timestamp).toBeGreaterThanOrEqual(result.commits[index - 1].timestamp)
    }
    console.log(`  first ${result.commits.length} commits of ${result.repo.fullName} loaded`)
  })

  it('reports an actionable error for a missing repository', async () => {
    const resolved = resolveRepoInput('https://github.com/hdlopesrocha/definitely-not-a-real-repo-xyz')
    try {
      await loadHistory(resolved, { maxCommits: 5, range: 'latest', token: TOKEN })
      throw new Error('expected a failure')
    } catch (error) {
      expect(error).toBeInstanceOf(GitError)
      const kind = (error as GitError).kind
      // 404 → not-found; with an exhausted IP quota GitHub may answer 403.
      expect(['not-found', 'rate-limit', 'private']).toContain(kind)
      console.log(`  error message: ${describeGitError(error)}`)
    }
  })
})
