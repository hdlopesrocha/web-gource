import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation'
import { buildTimeline } from '../src/timeline/builder'
import { buildSchedule } from '../src/timeline/schedule'
import type { RawCommit, RepoInfo } from '../src/git/types'

const repo: RepoInfo = {
  provider: 'github', owner: 'big', name: 'repo', fullName: 'big/repo',
  htmlUrl: 'https://github.com/big/repo', defaultBranch: 'main', isPrivate: false,
}

// Exact copy of the scale test's generator.
function syntheticHistory(commitCount: number, filesPerCommit = 6): RawCommit[] {
  const commits: RawCommit[] = []
  const dayMs = 86_400_000
  for (let index = 0; index < commitCount; index += 1) {
    const files = []
    for (let fileIndex = 0; fileIndex < filesPerCommit; fileIndex += 1) {
      const area = (index + fileIndex) % 40
      const path = `src/area-${area}/module-${(index * filesPerCommit + fileIndex) % 900}.ts`
      const roll = (index + fileIndex) % 13
      files.push({
        path,
        kind: roll === 0 ? ('add' as const) : roll === 1 ? ('delete' as const) : ('modify' as const),
        additions: roll === 1 ? 0 : 3 + (index % 20),
        deletions: roll === 0 ? 0 : index % 7,
      })
    }
    commits.push({
      sha: `sha-${index.toString(16).padStart(8, '0')}`,
      parents: index === 0 ? [] : [`sha-${(index - 1).toString(16).padStart(8, '0')}`],
      timestamp: Date.UTC(2015, 0, 1) + index * dayMs * 0.5,
      message: `commit ${index}`,
      author: { name: `Author ${index % 25}`, email: `author${index % 25}@example.com`, login: `author${index % 25}` },
      files,
    })
  }
  return commits
}

describe('profile3', () => {
  it('times the scale history', () => {
    const timeline = buildTimeline(repo, syntheticHistory(5000))
    const schedule = buildSchedule(timeline.commits)
    const sim = new Simulation(timeline.commits, timeline.authorById)
    sim.scheduleTime = (index) => schedule.times[index] ?? 0

    const totals: Record<string, number> = {}
    const counts: Record<string, number> = {}
    const proto = Simulation.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const name of ['relayout', 'applyChange', 'ensureFile', 'update']) {
      const original = proto[name]
      if (typeof original !== 'function') continue
      proto[name] = function patched(this: unknown, ...args: unknown[]) {
        const start = performance.now()
        try { return original.apply(this, args) } finally {
          const elapsed = performance.now() - start
          totals[name] = (totals[name] ?? 0) + elapsed
          counts[name] = (counts[name] ?? 0) + 1
        }
      }
    }
    const start = performance.now()
    sim.applyUpTo(4999)
    console.log('total play ms:', (performance.now() - start).toFixed(0))
    for (const [name, value] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name}: ${value.toFixed(0)}ms over ${counts[name] ?? 0} calls (avg ${(value / Math.max(1, counts[name] ?? 1)).toFixed(3)}ms)`)
    }
    const stats = sim.stats()
    console.log('visible files:', stats.visibleFiles, 'total files:', stats.files, 'dirs:', stats.dirs)
    expect(true).toBe(true)
  }, 120000)
})
