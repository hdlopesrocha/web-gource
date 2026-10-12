import { describe, expect, it } from 'vitest'
import {
  GOURCE,
  dirRadiusFor,
  fileArea,
  placeFilesInRings,
  relaxDirectories,
  type ForceNode,
} from '../src/sim/layout'
import { Simulation } from '../src/sim/simulation'
import { buildTimeline } from '../src/timeline/builder'
import { buildSchedule } from '../src/timeline/schedule'
import type { RawCommit, RepoInfo } from '../src/git/types'

/**
 * Dynamic layout, replicating Gource's model (src/dirnode.cpp):
 *
 *  - a directory's radius is `sqrt(area) * padding`,
 *  - files are grouped on concentric rings around their directory,
 *  - directories are placed by a force relaxation (gravity to the ideal
 *    clearance from the parent, an outward push along the parent's normal,
 *    sibling repulsion, and overlap resolution).
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

function raw(partial: Partial<RawCommit> & { sha: string; timestamp: number }): RawCommit {
  return {
    parents: [],
    message: 'message',
    author: { name: 'Dev', email: 'dev@example.com' },
    files: [],
    ...partial,
  }
}

function addFile(path: string, index: number): RawCommit {
  return raw({
    sha: `sha-${index}`,
    timestamp: 1000 + index * 1000,
    files: [{ path, kind: 'add', additions: 5, deletions: 0 }],
  })
}

function makeSimulation(commits: RawCommit[], sizes?: Map<string, number>) {
  const timeline = buildTimeline(repo, commits, { fileSizes: sizes })
  const schedule = buildSchedule(timeline.commits)
  const sim = new Simulation(timeline.commits, timeline.authorById)
  sim.scheduleTime = (index) => schedule.times[index] ?? 0
  sim.setFileSizes(timeline.fileSizes)
  return { sim, timeline }
}

/** Settle every moving node by advancing the simulation clock. */
function settle(sim: Simulation, seconds = 3): void {
  for (let step = 0; step < Math.ceil(seconds * 60); step += 1) {
    sim.update(1 / 60, sim.currentTime + step / 60)
  }
}

function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

describe('placeFilesInRings (Gource file grouping)', () => {
  it('never overlaps two files and keeps them outside the folder node', () => {
    const innerRadius = 0.5
    const items = Array.from({ length: 12 }, (_, index) => ({ key: `f${index}.ts`, radius: 0.5 }))
    const placements = placeFilesInRings(items, { innerRadius })
    expect(placements).toHaveLength(12)
    for (let a = 0; a < placements.length; a += 1) {
      const radius = Math.hypot(placements[a].x, placements[a].y)
      // Innermost ring clears the folder node and the widest circle.
      expect(radius).toBeGreaterThanOrEqual(innerRadius + 0.5 + GOURCE.fileGap - 1e-6)
      for (let b = a + 1; b < placements.length; b += 1) {
        const distance = distanceBetween(placements[a], placements[b])
        expect(distance).toBeGreaterThanOrEqual(1 - 1e-6)
      }
    }
  })

  it('gives a wide file the room it needs', () => {
    const items = [
      { key: 'wide.ts', radius: 1.5 },
      { key: 'a.ts', radius: 0.2 },
      { key: 'b.ts', radius: 0.2 },
      { key: 'c.ts', radius: 0.2 },
    ]
    const placements = placeFilesInRings(items, { innerRadius: 0.5 })
    for (let index = 1; index < placements.length; index += 1) {
      expect(distanceBetween(placements[0], placements[index])).toBeGreaterThanOrEqual(1.7)
    }
  })

  it('grows outwards as files are added', () => {
    const extentOf = (count: number): number => {
      const items = Array.from({ length: count }, (_, index) => ({ key: `f${index}`, radius: 0.3 }))
      return Math.max(...placeFilesInRings(items, { innerRadius: 0.5 }).map((p) => Math.hypot(p.x, p.y) + 0.3))
    }
    expect(extentOf(24)).toBeGreaterThan(extentOf(4))
  })

  it('fills a disc instead of one very wide ring', () => {
    const items = Array.from({ length: 60 }, (_, index) => ({ key: `f${index}`, radius: 0.5 }))
    const placements = placeFilesInRings(items, { innerRadius: 0.5 })
    const rings = new Set(placements.map((placement) => placement.ring))
    expect(rings.size).toBeGreaterThan(1)
    const extent = Math.max(...placements.map((p) => Math.hypot(p.x, p.y) + 0.5))
    // One ring holding 60 of these circles would reach ~13 units.
    expect(extent).toBeLessThan(8)
  })

  it('is deterministic and keeps the input order', () => {
    const items = [
      { key: 'src/b.ts', radius: 0.4 },
      { key: 'src/a.ts', radius: 0.9 },
      { key: 'src/c.ts', radius: 0.2 },
    ]
    const first = placeFilesInRings(items, { innerRadius: 0.5 })
    expect(placeFilesInRings(items, { innerRadius: 0.5 })).toEqual(first)
    expect(first.map((placement) => placement.ring)).toHaveLength(3)
  })

  it('handles an empty directory', () => {
    expect(placeFilesInRings([], { innerRadius: 0.5 })).toEqual([])
  })
})

describe('Gource radii', () => {
  it('counts a circle as pi r squared and grows the radius with its square root', () => {
    expect(fileArea(2)).toBeCloseTo(Math.PI * 4, 6)
    const single = dirRadiusFor(fileArea(1))
    const quad = dirRadiusFor(fileArea(1) * 4)
    expect(quad).toBeCloseTo(single * 2, 6)
    expect(single).toBeCloseTo(1.5 * Math.PI ** 0.5, 6)
  })

  it('floors a tiny folder at the minimum radius', () => {
    expect(dirRadiusFor(0)).toBeCloseTo(GOURCE.minDirRadius, 6)
  })
})

describe('relaxDirectories (Gource forces)', () => {
  function node(id: number, parent: number, x: number, y: number, ownRadius = 1, dirRadius = 1.5): ForceNode {
    return { id, parent, children: [], ownRadius, dirRadius, x, y, visible: true }
  }

  it('keeps the root at the origin and settles children at their ideal clearance', () => {
    const root = node(0, -1, 3, -2, 1, 2)
    const children = [node(1, 0, 3.1, -2.1), node(2, 0, 3.05, -1.95), node(3, 0, 2.9, -2.2)]
    root.children = [1, 2, 3]
    const nodes = [root, ...children]
    relaxDirectories(nodes, { steps: 200 })
    expect(root.x).toBeCloseTo(0, 6)
    expect(root.y).toBeCloseTo(0, 6)
    for (const child of children) {
      // Clearance: |parent - child| - (child radius + parent own radius) ~ 0.
      const clearance = distanceBetween(child, root) - (child.dirRadius + root.ownRadius)
      expect(Math.abs(clearance)).toBeLessThan(0.35)
    }
    // Siblings spread around the parent instead of stacking.
    for (let a = 0; a < children.length; a += 1) {
      for (let b = a + 1; b < children.length; b += 1) {
        expect(distanceBetween(children[a], children[b])).toBeGreaterThan(children[a].dirRadius + children[b].dirRadius)
      }
    }
  })

  it('pushes overlapping directories apart', () => {
    const root = node(0, -1, 0, 0, 0.5, 0.5)
    const a = node(1, 0, 0, -3, 0.5, 2)
    const b = node(2, 0, 0.4, -3, 0.5, 2)
    root.children = [1, 2]
    relaxDirectories([root, a, b], { steps: 300 })
    expect(distanceBetween(a, b)).toBeGreaterThanOrEqual(a.dirRadius + b.dirRadius - 0.05)
  })

  it('is deterministic', () => {
    const make = () => {
      const root = node(0, -1, 0, 0, 1, 1)
      const children = [node(1, 0, 1, 0), node(2, 0, -1, 0.2), node(3, 0, 0.3, -1)]
      root.children = [1, 2, 3]
      return [root, ...children]
    }
    const first = make()
    const second = make()
    relaxDirectories(first, { steps: 50 })
    relaxDirectories(second, { steps: 50 })
    for (let index = 0; index < first.length; index += 1) {
      expect(first[index].x).toBeCloseTo(second[index].x, 10)
      expect(first[index].y).toBeCloseTo(second[index].y, 10)
    }
  })
})

describe('dynamic layout in the simulation', () => {
  it('groups a folder\'s files on a ring around it', () => {
    const commits = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((path, index) => addFile(path, index))
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(2)
    settle(sim)
    const dir = sim.find('src')!
    const files = sim.nodes.filter((node) => node.kind === 'file')
    expect(files).toHaveLength(3)
    for (const file of files) {
      const distance = Math.hypot(file.position.x - dir.position.x, file.position.y - dir.position.y)
      // Every file sits on the same ring, just outside the folder node.
      expect(distance).toBeGreaterThan(dir.radius)
      expect(distance).toBeLessThan(2)
    }
    // And no two circles touch.
    for (let a = 0; a < files.length; a += 1) {
      for (let b = a + 1; b < files.length; b += 1) {
        expect(distanceBetween(files[a].position, files[b].position)).toBeGreaterThanOrEqual(
          files[a].radius + files[b].radius - 0.02,
        )
      }
    }
  })

  it('reflows the existing files when a new file is added', () => {
    const { sim } = makeSimulation([addFile('src/a.ts', 0), addFile('src/b.ts', 1), addFile('src/c.ts', 2)])
    sim.applyUpTo(1)
    const a = sim.find('src/a.ts')!
    const b = sim.find('src/b.ts')!
    const beforeA = { ...a.position }

    sim.applyUpTo(2) // adds src/c.ts
    // The existing files are heading somewhere new...
    const targetShift = distanceBetween(a.targetPosition, beforeA)
    expect(targetShift).toBeGreaterThan(0.05)
    // ...but they have not jumped there: the movement is animated.
    expect(distanceBetween(a.position, beforeA)).toBeLessThan(targetShift * 0.5)
    sim.update(1 / 60, sim.currentTime + 1 / 60)
    const moving = sim.drainMovedNodes()
    expect(moving).toContain(a.id)
    expect(moving).toContain(b.id)
    settle(sim)
    expect(a.position.x).toBeCloseTo(a.targetPosition.x, 3)
    expect(b.position.x).toBeCloseTo(b.targetPosition.x, 3)
  })

  it('expands the rings when a circle grows with its file size', () => {
    const paths = Array.from({ length: 10 }, (_, index) => `src/file-${index}.ts`)
    const commits = paths.map((path, index) => addFile(path, index))
    const sizes = new Map<string, number>(paths.map((path) => [path, 100]))
    const { sim } = makeSimulation(commits, sizes)
    sim.applyUpTo(paths.length - 1)
    settle(sim)
    const before = { ...sim.find('src/file-0.ts')!.position }

    sim.setFileSizes(new Map([['src/file-0.ts', 4_000_000]]))
    const huge = sim.find('src/file-0.ts')!
    expect(huge.radius).toBeCloseTo(0.75, 5)
    expect(huge.radius).toBeGreaterThan(sim.find('src/file-1.ts')!.radius * 1.2)
    settle(sim)

    const files = sim.nodes.filter((node) => node.kind === 'file')
    for (let a = 0; a < files.length; a += 1) {
      for (let b = a + 1; b < files.length; b += 1) {
        expect(distanceBetween(files[a].position, files[b].position)).toBeGreaterThanOrEqual(
          files[a].radius + files[b].radius - 0.02,
        )
      }
    }
    // The big circle either moved or grew into the free space around it.
    expect(huge.radius > 0.5 || distanceBetween(huge.position, before) > 0).toBe(true)
    for (const node of files) {
      expect(node.position.x).toBeCloseTo(node.targetPosition.x, 3)
      expect(node.position.y).toBeCloseTo(node.targetPosition.y, 3)
    }
  })

  it('fills a disc instead of one wide ring', () => {
    const count = 60
    const commits = Array.from({ length: count }, (_, index) => addFile(`src/f${index}.ts`, index))
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(count - 1)
    settle(sim, 8)
    const dir = sim.find('src')!
    const files = sim.nodes.filter((node) => node.kind === 'file')
    expect(files.length).toBe(count)
    let extent = 0
    for (const file of files) {
      extent = Math.max(extent, Math.hypot(file.position.x - dir.position.x, file.position.y - dir.position.y) + file.radius)
    }
    // One ring holding 60 circles of this size would need ~13 units.
    expect(extent).toBeLessThan(10)
    for (let a = 0; a < files.length; a += 1) {
      for (let b = a + 1; b < files.length; b += 1) {
        expect(distanceBetween(files[a].position, files[b].position)).toBeGreaterThanOrEqual(
          files[a].radius + files[b].radius - 0.02,
        )
      }
    }
  })

  it('keeps the survivors in place when a file is deleted', () => {
    const commits = [
      addFile('src/a.ts', 0),
      addFile('src/b.ts', 1),
      raw({
        sha: 'delete-b',
        timestamp: 5000,
        files: [{ path: 'src/b.ts', kind: 'delete', additions: 0, deletions: 10 }],
      }),
    ]
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(1)
    settle(sim)
    const aBefore = { ...sim.find('src/a.ts')!.position }
    sim.applyUpTo(2)
    expect(sim.find('src/b.ts')!.visible).toBe(false)
    settle(sim)
    const a = sim.find('src/a.ts')!
    // The first file keeps the first slot, so deleting its sibling does not
    // shuffle it; the freed space is simply available to the next file.
    expect(distanceBetween(a.position, aBefore)).toBeLessThan(0.01)
    expect(a.visible).toBe(true)
    const dir = sim.find('src')!
    expect(Math.hypot(a.position.x - dir.position.x, a.position.y - dir.position.y)).toBeGreaterThan(dir.radius)
  })

  it('produces the same layout whether played or seeked', () => {
    const commits = Array.from({ length: 8 }, (_, index) => addFile(`src/mod/file-${index}.ts`, index))
    const played = makeSimulation(commits)
    played.sim.applyUpTo(7)
    settle(played.sim)
    const playedPositions = played.sim.nodes
      .filter((node) => node.kind === 'file')
      .map((node) => `${node.path}:${node.position.x.toFixed(4)},${node.position.y.toFixed(4)}`)

    const sought = makeSimulation(commits)
    sought.sim.seek(7)
    const soughtPositions = sought.sim.nodes
      .filter((node) => node.kind === 'file')
      .map((node) => `${node.path}:${node.position.x.toFixed(4)},${node.position.y.toFixed(4)}`)
    expect(soughtPositions).toEqual(playedPositions)
  })

  it('can be switched off for a static map', () => {
    const commits = [addFile('src/a.ts', 0), addFile('src/b.ts', 1)]
    const { sim } = makeSimulation(commits)
    sim.dynamicLayout = false
    sim.applyUpTo(1)
    const a = sim.find('src/a.ts')!
    const b = sim.find('src/b.ts')!
    const dir = sim.find('src')!
    expect(a.position.x).toBeCloseTo(a.targetPosition.x, 6)
    expect(b.position.x).toBeCloseTo(b.targetPosition.x, 6)
    expect(Math.hypot(a.position.x - dir.position.x, a.position.y - dir.position.y)).toBeGreaterThan(1)
    expect(sim.drainMovedNodes()).toHaveLength(0)
  })

  it('keeps nodes inside the camera bounds while they move', () => {
    const commits = Array.from({ length: 10 }, (_, index) => addFile(`src/file-${index}.ts`, index))
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(9)
    sim.update(1 / 60, sim.currentTime + 0.1)
    const bounds = sim.bounds()
    for (const node of sim.nodes) {
      if (!node.visible) continue
      const distance = Math.hypot(node.position.x - bounds.center.x, node.position.y - bounds.center.y)
      expect(distance).toBeLessThanOrEqual(bounds.radius + 1)
    }
  })
})

describe('folder clusters', () => {
  /** Build a tree with several folders, each holding a few files. */
  function manyFolders(folders: number, filesPerFolder: number): RawCommit[] {
    const commits: RawCommit[] = []
    let index = 0
    for (let folder = 0; folder < folders; folder += 1) {
      for (let file = 0; file < filesPerFolder; file += 1) {
        commits.push(addFile(`area-${folder}/file-${file}.ts`, index))
        index += 1
      }
    }
    return commits
  }

  /** Distance between two clusters' centres minus both cluster radii. */
  function clusterGap(
    a: { position: { x: number; y: number }; clusterRadius: number },
    b: { position: { x: number; y: number }; clusterRadius: number },
  ): number {
    return distanceBetween(a.position, b.position) - a.clusterRadius - b.clusterRadius
  }

  it('spreads sibling folders around the root without overlapping', () => {
    const commits = manyFolders(9, 5)
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(commits.length - 1)
    settle(sim, 6)

    const root = sim.find('')
    expect(root).toBeDefined()
    const folders = sim.nodes.filter((node) => node.kind === 'dir' && node.parent === root!.id)
    expect(folders.length).toBe(9)
    for (let a = 0; a < folders.length; a += 1) {
      for (let b = a + 1; b < folders.length; b += 1) {
        expect(clusterGap(folders[a], folders[b])).toBeGreaterThan(0)
      }
    }
    // Every folder's cluster radius covers the files it holds.
    for (const folder of folders) {
      const files = sim.nodes.filter((node) => node.kind === 'file' && node.parent === folder.id)
      expect(files.length).toBe(5)
      for (const file of files) {
        const distance = Math.hypot(file.position.x - folder.position.x, file.position.y - folder.position.y)
        expect(distance + file.radius).toBeLessThanOrEqual(folder.clusterRadius + 0.05)
      }
    }
  })

  it('pushes siblings outwards when one folder grows', () => {
    const commits = manyFolders(6, 3)
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(commits.length - 1)
    settle(sim, 6)
    const root = sim.find('')
    const folders = sim.nodes.filter((node) => node.kind === 'dir' && node.parent === root!.id)
    const target = folders[0]
    const sibling = folders[1]
    const beforeGap = clusterGap(target, sibling)

    const extra: RawCommit[] = []
    for (let index = 0; index < 12; index += 1) {
      extra.push(addFile(`${target.path}/new-${index}.ts`, commits.length + index))
    }
    const grown = makeSimulation([...commits, ...extra])
    grown.sim.applyUpTo(commits.length + extra.length - 1)
    settle(grown.sim, 8)
    const grownTarget = grown.sim.find(target.path)!
    const grownSibling = grown.sim.find(sibling.path)!

    // The folder reserves more room and its sibling stays clear of it.
    expect(grownTarget.clusterRadius).toBeGreaterThan(target.clusterRadius)
    expect(clusterGap(grownTarget, grownSibling)).toBeGreaterThan(0)
    expect(Math.abs(clusterGap(grownTarget, grownSibling) - beforeGap)).toBeGreaterThan(0.05)
  })

  it('keeps nested folders apart and near their parent', () => {
    const commits: RawCommit[] = []
    let index = 0
    for (const path of [
      'src/core/one.ts',
      'src/core/two.ts',
      'src/ui/three.ts',
      'src/ui/four.ts',
      'src/net/five.ts',
    ]) {
      commits.push(addFile(path, index))
      index += 1
    }
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(commits.length - 1)
    settle(sim, 6)
    const src = sim.find('src')!
    const nested = sim.nodes.filter((node) => node.kind === 'dir' && node.parent === src.id)
    expect(nested.length).toBe(3)
    for (let a = 0; a < nested.length; a += 1) {
      for (let b = a + 1; b < nested.length; b += 1) {
        expect(clusterGap(nested[a], nested[b])).toBeGreaterThan(0)
      }
    }
    for (const child of nested) {
      // A nested folder stays close to its parent: the relaxation pulls it to
      // the parent's clearance distance and the projection only pushes it out
      // as far as the two clusters need, so it hovers just outside the parent's
      // cluster instead of drifting away.
      expect(distanceBetween(child.position, src.position)).toBeLessThan(
        src.clusterRadius + child.clusterRadius + 1.5,
      )
    }
  })

  it('keeps the extent of the tree growing with the square root of its content', () => {
    const small = makeSimulation(manyFolders(4, 5))
    small.sim.applyUpTo(19)
    settle(small.sim, 4)
    const large = makeSimulation(manyFolders(64, 5))
    large.sim.applyUpTo(319)
    settle(large.sim, 4)

    const extent = (sim: Simulation): number => {
      let max = 0
      for (const node of sim.nodes) {
        if (!node.visible) continue
        max = Math.max(max, Math.hypot(node.position.x, node.position.y) + node.clusterRadius)
      }
      return max
    }
    const smallExtent = extent(small.sim)
    const largeExtent = extent(large.sim)
    // 16x the content should cost about 4x the radius, not 16x.
    expect(largeExtent).toBeLessThan(smallExtent * 8)
    expect(largeExtent).toBeGreaterThan(smallExtent)
  })
})
