import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation'
import { buildTimeline } from '../src/timeline/builder'
import { buildSchedule } from '../src/timeline/schedule'
import type { RawCommit, RepoInfo } from '../src/git/types'

/**
 * The layout contract: whatever the history does, the *targets* it settles on
 * must never put two circles on top of each other.
 *
 *  - a folder's cluster (the room it reserves for its whole subtree) never
 *    overlaps another folder's cluster, except for its own ancestors,
 *  - a file circle never overlaps another file circle,
 *  - a file never crosses a folder ring that is not its own parent,
 *  - every file stays inside the ring extent of its own folder.
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

function syntheticHistory(commits: number, filesPerCommit = 6, areas = 12): RawCommit[] {
  const list: RawCommit[] = []
  const dayMs = 86_400_000
  const modules = ['core', 'ui', 'net', 'storage', 'docs']
  for (let index = 0; index < commits; index += 1) {
    const files = []
    for (let fileIndex = 0; fileIndex < filesPerCommit; fileIndex += 1) {
      const area = (index + fileIndex) % areas
      const module = modules[(index + fileIndex) % modules.length]
      const nested = (index + fileIndex) % 3 === 0 ? `src/${module}/` : 'src/'
      const path = `${nested}area-${area}/module-${(index * filesPerCommit + fileIndex) % 220}.ts`
      const roll = (index + fileIndex) % 13
      files.push({
        path,
        kind: roll === 0 ? ('add' as const) : roll === 1 ? ('delete' as const) : ('modify' as const),
        additions: roll === 1 ? 0 : 3 + (index % 20),
        deletions: roll === 0 ? 0 : index % 7,
      })
    }
    list.push({
      sha: `sha-${index.toString(16).padStart(8, '0')}`,
      parents: index === 0 ? [] : [`sha-${(index - 1).toString(16).padStart(8, '0')}`],
      timestamp: Date.UTC(2016, 0, 1) + index * dayMs * 0.5,
      message: `commit ${index}`,
      author: { name: `Author ${index % 9}`, email: `author${index % 9}@example.com`, login: `author${index % 9}` },
      files,
    })
  }
  return list
}

function makeSimulation(commits: RawCommit[], sizes?: Map<string, number>) {
  const timeline = buildTimeline(repo, commits, { fileSizes: sizes })
  const schedule = buildSchedule(timeline.commits)
  const sim = new Simulation(timeline.commits, timeline.authorById)
  sim.scheduleTime = (index) => schedule.times[index] ?? 0
  if (sizes) sim.setFileSizes(timeline.fileSizes)
  return sim
}

interface Violations {
  clusterOverlaps: { pair: [string, string]; gap: number }[]
  fileOverlaps: { pair: [string, string]; gap: number }[]
  fileFolderOverlaps: { pair: [string, string]; gap: number }[]
  outsideOwnFolder: { path: string; folder: string; overhang: number }[]
}

function inspect(sim: Simulation): Violations {
  const nodes = sim.nodes
  const visible = nodes.filter((node) => node.visible && node.kind !== 'root')
  const dirs = visible.filter((node) => node.kind === 'dir')
  const files = visible.filter((node) => node.kind === 'file')
  const isAncestor = (a: (typeof dirs)[number], b: (typeof dirs)[number]): boolean => {
    let current = a.parent
    let guard = 0
    while (current >= 0 && guard < 512) {
      if (current === b.id) return true
      const parent = nodes[current]
      if (!parent) return false
      current = parent.parent
      guard += 1
    }
    return false
  }

  const result: Violations = { clusterOverlaps: [], fileOverlaps: [], fileFolderOverlaps: [], outsideOwnFolder: [] }
  for (let a = 0; a < dirs.length; a += 1) {
    for (let b = a + 1; b < dirs.length; b += 1) {
      if (isAncestor(dirs[a], dirs[b]) || isAncestor(dirs[b], dirs[a])) continue
      const gap =
        Math.hypot(dirs[a].targetPosition.x - dirs[b].targetPosition.x, dirs[a].targetPosition.y - dirs[b].targetPosition.y) -
        Math.max(dirs[a].radius, dirs[a].clusterRadius) -
        Math.max(dirs[b].radius, dirs[b].clusterRadius)
      if (gap < -0.02) result.clusterOverlaps.push({ pair: [dirs[a].path, dirs[b].path], gap })
    }
  }
  for (let a = 0; a < files.length; a += 1) {
    for (let b = a + 1; b < files.length; b += 1) {
      const gap =
        Math.hypot(
          files[a].targetPosition.x - files[b].targetPosition.x,
          files[a].targetPosition.y - files[b].targetPosition.y,
        ) -
        files[a].radius -
        files[b].radius
      if (gap < -0.02) result.fileOverlaps.push({ pair: [files[a].path, files[b].path], gap })
    }
    for (const dir of dirs) {
      if (dir.id === files[a].parent) continue
      const gap =
        Math.hypot(files[a].targetPosition.x - dir.targetPosition.x, files[a].targetPosition.y - dir.targetPosition.y) -
        files[a].radius -
        dir.radius
      if (gap < -0.02) result.fileFolderOverlaps.push({ pair: [files[a].path, dir.path], gap })
    }
    const folder = nodes[files[a].parent]
    if (folder && folder.kind === 'dir') {
      const distance = Math.hypot(
        files[a].targetPosition.x - folder.targetPosition.x,
        files[a].targetPosition.y - folder.targetPosition.y,
      )
      const overhang = distance + files[a].radius - folder.contentRadius
      if (overhang > 0.02) result.outsideOwnFolder.push({ path: files[a].path, folder: folder.path, overhang })
    }
  }
  return result
}

describe('layout invariants', () => {
  it('keeps every circle clear of every other while the history plays', () => {
    const sim = makeSimulation(syntheticHistory(300))
    sim.applyUpTo(299)
    const violations = inspect(sim)
    expect(violations.clusterOverlaps.slice(0, 5)).toEqual([])
    expect(violations.fileOverlaps.slice(0, 5)).toEqual([])
    expect(violations.fileFolderOverlaps.slice(0, 5)).toEqual([])
    expect(violations.outsideOwnFolder.slice(0, 5)).toEqual([])
  })

  it('keeps a freshly created deep folder and its file together', () => {
    // One commit creates a whole chain of folders; each level is positioned
    // after its children were already laid out, and they must travel with it.
    const commits: RawCommit[] = [
      {
        sha: 'deep',
        parents: [],
        timestamp: Date.UTC(2020, 0, 1),
        message: 'deep',
        author: { name: 'Dev', email: 'dev@example.com', login: 'dev' },
        files: [{ path: 'a/b/c/d/e/deep.ts', kind: 'add', additions: 40, deletions: 0 }],
      },
    ]
    const sim = makeSimulation(commits)
    sim.applyUpTo(0)
    const file = sim.find('a/b/c/d/e/deep.ts')
    const folder = sim.find('a/b/c/d/e')
    expect(file).toBeDefined()
    expect(folder).toBeDefined()
    const distance = Math.hypot(
      file!.targetPosition.x - folder!.targetPosition.x,
      file!.targetPosition.y - folder!.targetPosition.y,
    )
    expect(distance + file!.radius).toBeLessThanOrEqual(folder!.contentRadius + 0.05)
    // And every folder in the chain holds its own files.
    for (const path of ['a', 'a/b', 'a/b/c', 'a/b/c/d']) {
      const dir = sim.find(path)!
      for (const node of sim.nodes) {
        if (node.kind !== 'file' || node.parent !== dir.id) continue
        const own = Math.hypot(node.targetPosition.x - dir.targetPosition.x, node.targetPosition.y - dir.targetPosition.y)
        expect(own + node.radius).toBeLessThanOrEqual(dir.contentRadius + 0.05)
      }
    }
  })

  it('holds after host sizes arrive and after a seek', () => {
    const commits = syntheticHistory(200)
    const sim = makeSimulation(commits)
    sim.applyUpTo(199)
    const sizes = new Map<string, number>()
    for (const node of sim.nodes) {
      if (node.kind === 'file') sizes.set(node.path, 500 + (node.id % 97) * 40_000)
    }
    sim.setFileSizes(sizes)
    sim.seek(199)
    const violations = inspect(sim)
    expect(violations.clusterOverlaps.slice(0, 5)).toEqual([])
    expect(violations.fileOverlaps.slice(0, 5)).toEqual([])
    expect(violations.fileFolderOverlaps.slice(0, 5)).toEqual([])
    expect(violations.outsideOwnFolder.slice(0, 5)).toEqual([])
  })
})
