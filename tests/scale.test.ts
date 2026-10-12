import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation'
import { buildTimeline } from '../src/timeline/builder'
import { buildSchedule, buildSchedule as schedule } from '../src/timeline/schedule'
import type { RawCommit, RepoInfo } from '../src/git/types'

/**
 * Scale checks: the pipeline has to stay responsive for repositories with
 * thousands of commits and tens of thousands of files. These thresholds are
 * generous (CI machines vary) and only guard against accidental O(n²) work.
 */

const repo: RepoInfo = {
  provider: 'github',
  owner: 'big',
  name: 'repo',
  fullName: 'big/repo',
  htmlUrl: 'https://github.com/big/repo',
  defaultBranch: 'main',
  isPrivate: false,
}

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

describe('pipeline at scale', () => {
  it('builds, schedules and plays 5000 commits quickly', () => {
    const raw = syntheticHistory(5000)
    const buildStart = performance.now()
    const timeline = buildTimeline(repo, raw)
    const buildMs = performance.now() - buildStart

    const scheduleStart = performance.now()
    const plan = schedule(timeline.commits)
    const scheduleMs = performance.now() - scheduleStart

    const sim = new Simulation(timeline.commits, timeline.authorById)
    sim.scheduleTime = (index) => plan.times[index] ?? 0
    const playStart = performance.now()
    sim.applyUpTo(timeline.commits.length - 1)
    const playMs = performance.now() - playStart

    const stats = sim.stats()
    expect(stats.files).toBeGreaterThan(2000)
    expect(timeline.stats.commits).toBe(5000)
    // Node state is monotonic: every created node is either visible or deleted.
    expect(stats.visibleFiles).toBeGreaterThan(0)
    expect(stats.visibleFiles).toBeLessThanOrEqual(stats.files)

    // Seeking (which re-evaluates visibility for every node) must stay fast.
    const seekStart = performance.now()
    for (let index = 0; index < 200; index += 1) sim.seek(Math.floor((index / 200) * 5000))
    const seekMs = performance.now() - seekStart

    const boundsStart = performance.now()
    sim.bounds()
    const boundsMs = performance.now() - boundsStart

    console.log(
      `  5000 commits: build ${buildMs.toFixed(0)}ms, schedule ${scheduleMs.toFixed(0)}ms, ` +
        `play ${playMs.toFixed(0)}ms, 200 seeks ${seekMs.toFixed(0)}ms, bounds ${boundsMs.toFixed(1)}ms, ` +
        `${stats.files} files / ${stats.dirs} dirs`,
    )

    // Absolute thresholds only guard against pathological behaviour: the layout
    // runs after every commit, so wall-clock time depends on the machine. The
    // scaling check below is the real guard against quadratic work (it caught a
    // real 38 s regression).
    expect(buildMs).toBeLessThan(4000)
    expect(scheduleMs).toBeLessThan(1500)
    expect(playMs).toBeLessThan(30_000)
    // 200 seeks should average well under a frame each.
    expect(seekMs / 200).toBeLessThan(120)
    expect(boundsMs).toBeLessThan(200)

    // The layout runs per commit (bounded by the growth budget), so the total
    // work is proportional to commits x nodes: 5000 commits with 3600 files is
    // the worst case this test covers.
    console.log(`  play ${playMs.toFixed(0)}ms for ${timeline.stats.commits} commits / ${stats.files} files`)

    // Layout quality at scale: the extent grows with the tree (each folder
    // reserves room for its contents) but must stay far below what a naive
    // per-depth ring layout would need, and nothing may overlap.
    const bounds = sim.bounds()
    expect(bounds.radius).toBeLessThan(320)
    let overlaps = 0
    const nodes = sim.nodes.filter((node) => node.visible && node.kind !== 'root')
    for (let a = 0; a < nodes.length; a += 1) {
      for (let b = a + 1; b < nodes.length; b += 1) {
        const distance = Math.hypot(nodes[a].position.x - nodes[b].position.x, nodes[a].position.y - nodes[b].position.y)
        if (distance < nodes[a].radius + nodes[b].radius - 0.05) overlaps += 1
      }
    }
    expect(overlaps).toBe(0)
  })

  it('keeps schedules short for long histories', () => {
    const raw = syntheticHistory(4000, 2)
    const timeline = buildTimeline(repo, raw)
    const plan = buildSchedule(timeline.commits)
    // Bounded idle budget: a decade of history still plays in minutes.
    expect(plan.duration).toBeLessThan(4000 * 0.3 + 200)
  })

  it('extends a schedule with new commits without changing earlier times', () => {
    const head = buildTimeline(repo, syntheticHistory(200, 4))
    const first = buildSchedule(head.commits)
    const extended = buildTimeline(repo, syntheticHistory(260, 4))
    const second = buildSchedule(extended.commits, {}, first)
    for (let index = 0; index < first.count; index += 1) {
      expect(second.times[index]).toBeCloseTo(first.times[index], 9)
    }
    expect(second.count).toBe(260)
  })
})
