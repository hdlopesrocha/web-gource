import { describe, expect, it } from 'vitest'
import { Simulation, type SimEvent } from '../src/sim/simulation'
import { directoryOffset, fileOffset, hashString, splitPath } from '../src/sim/layout'
import { buildTimeline } from '../src/timeline/builder'
import { buildSchedule } from '../src/timeline/schedule'
import type { RawCommit, RepoInfo } from '../src/git/types'

const repo: RepoInfo = {
  provider: 'github',
  owner: 'acme',
  name: 'widget',
  fullName: 'acme/widget',
  htmlUrl: 'https://github.com/acme/widget',
  defaultBranch: 'main',
  isPrivate: false,
}

function raw(partial: Partial<RawCommit> & { sha: string; timestamp: number }): RawCommit {
  return {
    parents: [],
    message: 'message',
    author: { name: 'Dev', email: 'dev@example.com' },
    files: [],
    ...partial,
  }
}

function makeSimulation(commits: RawCommit[]) {
  const timeline = buildTimeline(repo, commits)
  const schedule = buildSchedule(timeline.commits)
  const sim = new Simulation(timeline.commits, timeline.authorById)
  sim.scheduleTime = (index) => schedule.times[index] ?? 0
  return { sim, timeline, schedule }
}

/** Play the whole timeline, collecting the drained event log. */
function playAll(sim: Simulation, timeline: { commits: unknown[] }, schedule: { indexAt: (time: number) => number }): SimEvent[] {
  const log: SimEvent[] = []
  const total = timeline.commits.length
  for (let index = 0; index < total; index += 1) {
    sim.seek(index - 1)
    sim.applyUpTo(index)
    log.push(...sim.drainEvents())
  }
  void schedule
  return log
}

describe('layout', () => {
  it('is deterministic for the same path', () => {
    expect(directoryOffset('src/components', 2)).toEqual(directoryOffset('src/components', 2))
    expect(fileOffset('src/file.ts')).toEqual(fileOffset('src/file.ts'))
  })

  it('spreads children of the same depth apart', () => {
    const a = directoryOffset('src/a', 1)
    const b = directoryOffset('src/b', 1)
    const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    expect(distance).toBeGreaterThan(1)
  })

  it('keeps files close to their directory', () => {
    const offset = fileOffset('src/deep/file.ts')
    expect(Math.hypot(offset.x, offset.y, offset.z)).toBeLessThan(4)
  })

  it('hashes consistently and splits paths', () => {
    expect(hashString('src')).toBe(hashString('src'))
    expect(hashString('src')).not.toBe(hashString('tests'))
    expect(splitPath('a/b/c.ts')).toEqual({ parent: 'a/b', name: 'c.ts' })
    expect(splitPath('c.ts')).toEqual({ parent: '', name: 'c.ts' })
  })
})

describe('Simulation', () => {
  it('builds the tree from file paths, creating directories on demand', () => {
    const { sim } = makeSimulation([
      raw({
        sha: 'a',
        timestamp: 1000,
        files: [
          { path: 'src/ui/button.vue', kind: 'add', additions: 10, deletions: 0 },
          { path: 'README.md', kind: 'add', additions: 5, deletions: 0 },
        ],
      }),
    ])
    sim.applyUpTo(0)
    expect(sim.find('src')?.kind).toBe('dir')
    expect(sim.find('src/ui')?.kind).toBe('dir')
    expect(sim.find('src/ui/button.vue')?.kind).toBe('file')
    expect(sim.find('README.md')?.parent).toBe(sim.root.id)
    const stats = sim.stats()
    expect(stats.files).toBe(2)
    expect(stats.dirs).toBe(2)
    expect(stats.visibleFiles).toBe(2)
  })

  it('hides deleted files and re-shows them when re-added', () => {
    const { sim } = makeSimulation([
      raw({ sha: 'a', timestamp: 1000, files: [{ path: 'gone.ts', kind: 'add', additions: 1, deletions: 0 }] }),
      raw({ sha: 'b', timestamp: 2000, files: [{ path: 'gone.ts', kind: 'delete', additions: 0, deletions: 5 }] }),
      raw({ sha: 'c', timestamp: 3000, files: [{ path: 'gone.ts', kind: 'add', additions: 9, deletions: 0 }] }),
    ])
    sim.applyUpTo(0)
    expect(sim.find('gone.ts')?.visible).toBe(true)
    expect(sim.stats().visibleFiles).toBe(1)
    sim.applyUpTo(1)
    expect(sim.find('gone.ts')?.visible).toBe(false)
    expect(sim.stats().visibleFiles).toBe(0)
    sim.applyUpTo(2)
    expect(sim.find('gone.ts')?.visible).toBe(true)
    expect(sim.stats().visibleFiles).toBe(1)

    // Seeking between the delete and the re-add must not show the file.
    sim.seek(1)
    expect(sim.find('gone.ts')?.visible).toBe(false)
    sim.seek(2)
    expect(sim.find('gone.ts')?.visible).toBe(true)
    sim.seek(0)
    expect(sim.find('gone.ts')?.visible).toBe(true)
  })

  it('treats a modification of an unknown file as an addition', () => {
    const { sim } = makeSimulation([
      raw({ sha: 'a', timestamp: 1000, files: [{ path: 'legacy.ts', kind: 'modify', additions: 3, deletions: 1 }] }),
    ])
    sim.applyUpTo(0)
    const node = sim.find('legacy.ts')
    expect(node).toBeDefined()
    expect(node?.lastKind).toBe('add')
  })

  it('moves files on rename and keeps a single node', () => {
    const { sim } = makeSimulation([
      raw({ sha: 'a', timestamp: 1000, files: [{ path: 'src/old.ts', kind: 'add', additions: 4, deletions: 0 }] }),
      raw({
        sha: 'b',
        timestamp: 2000,
        files: [{ path: 'lib/new.ts', previousPath: 'src/old.ts', kind: 'rename', additions: 1, deletions: 1 }],
      }),
    ])
    sim.applyUpTo(0)
    const before = sim.find('src/old.ts')
    sim.applyUpTo(1)
    expect(sim.find('src/old.ts')).toBeUndefined()
    const after = sim.find('lib/new.ts')
    expect(after).toBe(before)
    expect(after?.movedFrom).toBeDefined()
    expect(sim.find('lib')?.kind).toBe('dir')
    expect(sim.stats().files).toBe(1)
  })

  it('applies only file changes for commits that have none (merge commits)', () => {
    const { sim } = makeSimulation([
      raw({ sha: 'a', timestamp: 1000, files: null, filesMissing: 'merge-parents', isMerge: true, parents: ['x', 'y'] }),
      raw({ sha: 'b', timestamp: 2000, files: [{ path: 'a.ts', kind: 'add', additions: 1, deletions: 0 }] }),
    ])
    sim.seek(-1)
    expect(sim.applyUpTo(1)).toBe(2)
    expect(sim.stats().files).toBe(1)
  })

  it('produces the same event sequence when replayed', () => {
    const commits = Array.from({ length: 25 }, (_, index) =>
      raw({
        sha: `sha${index}`,
        timestamp: 1000 + index * 86400000,
        author: { name: `Dev ${index % 3}`, email: `dev${index % 3}@example.com` },
        files: [
          { path: `src/module-${index % 5}/file-${index}.ts`, kind: 'add', additions: 5, deletions: 0 },
          ...(index % 4 === 0 ? [{ path: `src/module-${(index + 2) % 5}/file-${index - 2}.ts`, kind: 'delete' as const, additions: 0, deletions: 3 }] : []),
        ],
      }),
    )
    const first = makeSimulation(commits)
    const second = makeSimulation(commits)
    const logA = playAll(first.sim, first.timeline, first.schedule)
    const logB = playAll(second.sim, second.timeline, second.schedule)
    expect(logA.length).toBeGreaterThan(0)
    expect(logA.map((event) => JSON.stringify(event))).toEqual(logB.map((event) => JSON.stringify(event)))
  })

  it('reaches the same state by seeking as by playing forward', () => {
    const commits = Array.from({ length: 30 }, (_, index) =>
      raw({
        sha: `sha${index}`,
        timestamp: 1000 + index * 3600000,
        files: [
          { path: `src/mod-${index % 4}/f${index}.ts`, kind: 'add', additions: 2, deletions: 0 },
          ...(index % 5 === 0 && index > 0
            ? [{ path: `src/mod-${index % 4}/f${index - 3}.ts`, kind: 'delete' as const, additions: 0, deletions: 1 }]
            : []),
        ],
      }),
    )
    const played = makeSimulation(commits)
    played.sim.applyUpTo(29)
    const playedVisible = played.sim.nodes.filter((node) => node.visible).map((node) => node.path)
    const playedStats = played.sim.stats()

    const sought = makeSimulation(commits)
    sought.sim.seek(29)
    const soughtVisible = sought.sim.nodes.filter((node) => node.visible).map((node) => node.path)
    const soughtStats = sought.sim.stats()

    expect(soughtVisible).toEqual(playedVisible)
    expect(soughtStats.visibleFiles).toBe(playedStats.visibleFiles)
    expect(soughtStats.files).toBe(playedStats.files)
  })

  it('does not double count when replaying after a seek', () => {
    const { sim } = makeSimulation([
      raw({ sha: 'a', timestamp: 1000, files: [{ path: 'a.ts', kind: 'add', additions: 7, deletions: 2 }] }),
      raw({ sha: 'b', timestamp: 2000, files: [{ path: 'a.ts', kind: 'modify', additions: 3, deletions: 1 }] }),
    ])
    sim.applyUpTo(1)
    const first = sim.stats()
    sim.seek(0)
    sim.applyUpTo(1)
    const second = sim.stats()
    expect(second.additions).toBe(first.additions)
    expect(second.deletions).toBe(first.deletions)
    expect(sim.find('a.ts')?.changes).toBe(2)
  })

  it('spawns authors and moves them towards their work', () => {
    const { sim } = makeSimulation([
      raw({ sha: 'a', timestamp: 1000, files: [{ path: 'src/a.ts', kind: 'add', additions: 1, deletions: 0 }] }),
      raw({
        sha: 'b',
        timestamp: 2000,
        author: { name: 'Ada', email: 'ada@example.com', login: 'ada' },
        files: [{ path: 'other/b.ts', kind: 'add', additions: 1, deletions: 0 }],
      }),
    ])
    sim.applyUpTo(1)
    const authors = [...sim.authors]
    expect(authors).toHaveLength(2)
    const ada = authors.find((entry) => entry.author.login === 'ada')
    const file = sim.find('other/b.ts')
    expect(ada?.targetNodeId).toBe(file?.id)
    expect(ada?.target.x).toBeCloseTo(file?.position.x ?? 0, 6)
    expect(ada?.target.y).toBeCloseTo(file?.position.y ?? 0, 6)

    // The author stays visible while recently active, then fades out.
    sim.update(0.1, 1.5)
    expect(ada?.visible).toBe(true)
    sim.update(0.1, 6)
    expect(ada?.visible).toBe(false)
  })

  it('reports bounds that contain the visible tree', () => {
    const { sim } = makeSimulation([
      raw({
        sha: 'a',
        timestamp: 1000,
        files: [
          { path: 'src/a.ts', kind: 'add', additions: 1, deletions: 0 },
          { path: 'docs/b.md', kind: 'add', additions: 1, deletions: 0 },
        ],
      }),
    ])
    sim.applyUpTo(0)
    const bounds = sim.bounds()
    expect(bounds.radius).toBeGreaterThan(0)
    for (const node of sim.nodes) {
      if (!node.visible) continue
      const distance = Math.hypot(node.position.x - bounds.center.x, node.position.y - bounds.center.y, node.position.z - bounds.center.z)
      expect(distance).toBeLessThanOrEqual(bounds.radius + 1)
    }
  })

  it('can be extended with more commits without losing state', () => {
    const head = [raw({ sha: 'a', timestamp: 1000, files: [{ path: 'a.ts', kind: 'add', additions: 1, deletions: 0 }] })]
    const { sim, timeline } = makeSimulation(head)
    sim.applyUpTo(0)
    const more = [...head, raw({ sha: 'b', timestamp: 2000, files: [{ path: 'b.ts', kind: 'add', additions: 1, deletions: 0 }] })]
    const extended = buildTimeline(repo, more)
    sim.setCommits(extended.commits, extended.authorById)
    sim.applyUpTo(1)
    expect(sim.stats().files).toBe(2)
    expect(sim.find('a.ts')?.visible).toBe(true)
    void timeline
  })

  it('handles an empty timeline', () => {
    const { sim } = makeSimulation([])
    expect(sim.applyUpTo(0)).toBe(0)
    expect(sim.stats().files).toBe(0)
    expect(sim.bounds().radius).toBeGreaterThan(0)
  })
})

describe('restart', () => {
  const commits: RawCommit[] = [
    raw({ sha: 'a', timestamp: 1000, files: [{ path: 'src/core/one.ts', kind: 'add', additions: 5, deletions: 0 }] }),
    raw({ sha: 'b', timestamp: 2000, files: [{ path: 'src/ui/two.ts', kind: 'add', additions: 3, deletions: 0 }] }),
    raw({ sha: 'c', timestamp: 3000, files: [{ path: 'src/core/three.ts', kind: 'add', additions: 4, deletions: 0 }] }),
  ]

  it('brings the folders back when a restart replays the history', () => {
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(2)
    const dirs = () => sim.nodes.filter((node) => node.kind !== 'file')
    expect(dirs().every((dir) => dir.visible)).toBe(true)

    // A restart rewinds to before the first commit: everything hides.
    sim.seek(-1)
    expect(dirs().some((dir) => dir.visible)).toBe(false)

    // Replaying (fresh = false, so no new toggles) must restore the folders
    // along with the files that live in them.
    sim.applyUpTo(1)
    const visibleDirs = dirs().filter((dir) => dir.visible)
    expect(visibleDirs.length).toBeGreaterThan(0)
    expect(sim.find('src')!.visible).toBe(true)
    expect(sim.find('src/core')!.visible).toBe(true)
    // The root is the origin and comes back too.
    expect(sim.root.visible).toBe(true)
    // Every visible file has a fully visible folder chain above it.
    for (const file of sim.nodes.filter((node) => node.kind === 'file' && node.visible)) {
      let parentId = file.parent
      while (parentId >= 0) {
        const parent = sim.nodes[parentId]
        expect(parent.visible).toBe(true)
        parentId = parent.parent
      }
    }
  })

  it('does not resurrect folders whose files are all gone', () => {
    const withDelete: RawCommit[] = [
      ...commits,
      raw({ sha: 'd', timestamp: 4000, files: [{ path: 'src/ui/two.ts', kind: 'delete', additions: 0, deletions: 3 }] }),
    ]
    const { sim } = makeSimulation(withDelete)
    sim.applyUpTo(3)
    expect(sim.find('src/ui')!.visible).toBe(true)
    sim.seek(-1)
    sim.applyUpTo(0) // only the first commit has happened again
    expect(sim.find('src/ui')!.visible).toBe(false)
    expect(sim.find('src/core')!.visible).toBe(true)
  })
})
