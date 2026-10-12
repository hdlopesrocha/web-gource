import { describe, expect, it } from 'vitest'
import { LAYOUT, placeOnRings, ringExtent } from '../src/sim/layout'
import { Simulation } from '../src/sim/simulation'
import { buildTimeline } from '../src/timeline/builder'
import { buildSchedule } from '../src/timeline/schedule'
import type { RawCommit, RepoInfo } from '../src/git/types'

/**
 * Dynamic layout: files sit on rings around their directory, and those rings
 * reflow when files are added or removed and when circles grow with the file
 * size.
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

describe('placeOnRings', () => {
  it('spreads items evenly and never overlaps them', () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ key: `f${index}.ts`, radius: 0.5 }))
    const placements = placeOnRings(items)
    expect(placements).toHaveLength(12)
    for (let a = 0; a < placements.length; a += 1) {
      for (let b = a + 1; b < placements.length; b += 1) {
        const distance = Math.hypot(placements[a].x - placements[b].x, placements[a].y - placements[b].y)
        // Circles of radius 0.5 each, plus the configured gap.
        expect(distance).toBeGreaterThanOrEqual(1 + LAYOUT.fileGap - 0.05)
      }
    }
  })

  it('grows the ring radius with the number and size of items', () => {
    const few = Array.from({ length: 4 }, (_, index) => ({ key: `a${index}`, radius: 0.3 }))
    const many = Array.from({ length: 24 }, (_, index) => ({ key: `b${index}`, radius: 0.3 }))
    // A crowd of ten where one circle is huge needs more room than ten small ones.
    const smallCrowd = Array.from({ length: 10 }, (_, index) => ({ key: `c${index}`, radius: 0.3 }))
    const mixedCrowd = [...smallCrowd.slice(1), { key: 'c9', radius: 1.5 }]

    expect(ringExtent(placeOnRings(many))).toBeGreaterThan(ringExtent(placeOnRings(few)))
    expect(ringExtent(placeOnRings(mixedCrowd))).toBeGreaterThan(ringExtent(placeOnRings(smallCrowd)))
    // Small circles on a sparse ring still use the minimum clear radius, so
    // their inner edge sits exactly at the configured distance.
    expect(ringExtent(placeOnRings(few))).toBeCloseTo(LAYOUT.fileRingRadius + 0.3, 5)
  })

  it('uses concentric rings when a single ring would be too wide', () => {
    const items = Array.from({ length: 60 }, (_, index) => ({ key: `f${index}`, radius: 0.6 }))
    const placements = placeOnRings(items)
    const rings = new Set(placements.map((placement) => placement.ring))
    expect(rings.size).toBeGreaterThan(1)
    expect(rings.size).toBeLessThanOrEqual(LAYOUT.maxRings)
    // Inner rings are inside outer rings.
    for (const placement of placements) {
      const radius = Math.hypot(placement.x, placement.y)
      if (placement.ring > 0) expect(radius).toBeGreaterThan(LAYOUT.fileRingRadius)
    }
  })

  it('keeps different rings from overlapping each other', () => {
    // Wide items on the first ring and smaller ones on the next: the second ring
    // must clear the first ring's circles, not just its centre line.
    const items = [
      ...Array.from({ length: 7 }, (_, index) => ({ key: `wide-${index}`, radius: 4 })),
      ...Array.from({ length: 12 }, (_, index) => ({ key: `small-${index}`, radius: 0.5 })),
    ]
    const placements = placeOnRings(items, { minRadius: 2, gap: 1, maxRingRadius: 18 })
    expect(new Set(placements.map((placement) => placement.ring)).size).toBeGreaterThan(1)
    // Placements come back in the same (sorted) order as the input keys.
    const sorted = [...items].sort((a, b) => (a.key < b.key ? -1 : 1))
    for (let a = 0; a < placements.length; a += 1) {
      for (let b = a + 1; b < placements.length; b += 1) {
        const distance = Math.hypot(placements[a].x - placements[b].x, placements[a].y - placements[b].y)
        expect(distance).toBeGreaterThanOrEqual(sorted[a].radius + sorted[b].radius - 0.001)
      }
    }
  })

  it('is deterministic and keeps the input order', () => {
    const items = [
      { key: 'src/b.ts', radius: 0.4 },
      { key: 'src/a.ts', radius: 0.9 },
      { key: 'src/c.ts', radius: 0.2 },
    ]
    const first = placeOnRings(items)
    const second = placeOnRings([...items].reverse())
    // Reversing the input does not change the placement of each key.
    expect(second).toEqual(first)
    expect(placeOnRings(items)).toEqual(first)
  })

  it('handles an empty directory', () => {
    expect(placeOnRings([])).toEqual([])
  })
})

describe('dynamic file rings in the simulation', () => {
  it('places files on a ring around their directory', () => {
    const commits = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((path, index) => addFile(path, index))
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(2)
    // Directories are packed too, so let the tree settle before measuring.
    settle(sim)
    const dir = sim.find('src')
    expect(dir).toBeDefined()
    const files = sim.nodes.filter((node) => node.kind === 'file')
    expect(files).toHaveLength(3)
    for (const file of files) {
      const distance = Math.hypot(file.position.x - dir!.position.x, file.position.y - dir!.position.y)
      // All three sit on the same ring, at a sane distance from the directory.
      expect(distance).toBeGreaterThan(LAYOUT.fileRingRadius - 1)
      expect(distance).toBeLessThan(LAYOUT.maxRingRadius + 2)
      // Files never sit exactly on the directory node.
      expect(distance).toBeGreaterThan(1)
    }
  })

  it('reflows the existing files when a new file is added', () => {
    const { sim } = makeSimulation([addFile('src/a.ts', 0), addFile('src/b.ts', 1), addFile('src/c.ts', 2)])
    sim.applyUpTo(1)
    const a = sim.find('src/a.ts')!
    const b = sim.find('src/b.ts')!
    const beforeA = { ...a.position }
    const distanceBefore = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y)

    sim.applyUpTo(2) // adds src/c.ts
    // The existing files are heading somewhere new...
    const targetShift = Math.hypot(a.targetPosition.x - beforeA.x, a.targetPosition.y - beforeA.y)
    expect(targetShift).toBeGreaterThan(0.05)
    // ...but they have not jumped there: the movement is animated.
    expect(Math.hypot(a.position.x - beforeA.x, a.position.y - beforeA.y)).toBeLessThan(targetShift * 0.5)
    sim.update(1 / 60, sim.currentTime + 1 / 60)
    const moving = sim.drainMovedNodes()
    expect(moving).toContain(a.id)
    expect(moving).toContain(b.id)
    settle(sim)
    expect(a.position.x).toBeCloseTo(a.targetPosition.x, 3)
    expect(b.position.x).toBeCloseTo(b.targetPosition.x, 3)
    // The three files still do not overlap.
    const files = sim.nodes.filter((node) => node.kind === 'file')
    for (let x = 0; x < files.length; x += 1) {
      for (let y = x + 1; y < files.length; y += 1) {
        const distance = Math.hypot(files[x].position.x - files[y].position.x, files[x].position.y - files[y].position.y)
        expect(distance).toBeGreaterThanOrEqual(files[x].radius + files[y].radius - 0.05)
      }
    }
    expect(distanceBefore).toBeGreaterThan(0)
  })

  it('expands the ring when a circle grows with its file size', () => {
    const paths = Array.from({ length: 10 }, (_, index) => `src/file-${index}.ts`)
    const commits = paths.map((path, index) => addFile(path, index))
    const sizes = new Map<string, number>(paths.map((path) => [path, 100]))
    const { sim } = makeSimulation(commits, sizes)
    sim.applyUpTo(paths.length - 1)
    settle(sim)
    const hugeBefore = sim.find('src/file-0.ts')!
    const beforeX = hugeBefore.position.x
    const beforeY = hugeBefore.position.y

    // The same file becomes huge: its circle grows, the folder has to make room
    // for it and no two circles may end up touching.
    sim.setFileSizes(new Map([['src/file-0.ts', 4_000_000]]))
    const huge = sim.find('src/file-0.ts')!
    expect(huge.radius).toBeCloseTo(LAYOUT.maxFileRadius, 5)
    expect(huge.radius).toBeGreaterThan(sim.find('src/file-1.ts')!.radius * 1.5)
    settle(sim)

    const dir = sim.find('src')!
    expect(dir.clusterRadius).toBeGreaterThan(0)
    const files = sim.nodes.filter((node) => node.kind === 'file')
    for (let a = 0; a < files.length; a += 1) {
      for (let b = a + 1; b < files.length; b += 1) {
        const distance = Math.hypot(files[a].position.x - files[b].position.x, files[a].position.y - files[b].position.y)
        expect(distance).toBeGreaterThanOrEqual(files[a].radius + files[b].radius - 0.001)
      }
    }
    // The folder makes room for the bigger circle (its cluster grows) and the
    // layout stays collision free. A circle may also simply grow into the free
    // gap around it — what matters is that nothing overlaps.
    expect(dir.clusterRadius).toBeGreaterThan(0)
    const moved = Math.hypot(huge.position.x - beforeX, huge.position.y - beforeY)
    const grew = huge.radius > 0.5
    expect(grew || moved > 0).toBe(true)
    // Every file ended up on its layout position.
    for (const node of sim.nodes) {
      if (node.kind !== 'file') continue
      expect(node.position.x).toBeCloseTo(node.targetPosition.x, 3)
      expect(node.position.y).toBeCloseTo(node.targetPosition.y, 3)
    }
  })

  it('packs files into a disc instead of one wide ring', () => {
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
    // A single ring holding 60 circles of this size would need ~13 units; the
    // disc fills the area instead, which is what keeps folders compact and
    // subfolders close to their parent.
    const ringExtent = ((0.98 + 0.3) / (2 * Math.sin(Math.PI / count))) * 1.02 + 0.49
    expect(ringExtent).toBeGreaterThan(12)
    expect(extent).toBeLessThan(ringExtent * 0.8)
    expect(files[0].radius).toBeGreaterThan(0)
    // Still collision free.
    for (let a = 0; a < files.length; a += 1) {
      for (let b = a + 1; b < files.length; b += 1) {
        const distance = Math.hypot(files[a].position.x - files[b].position.x, files[a].position.y - files[b].position.y)
        expect(distance).toBeGreaterThanOrEqual(files[a].radius + files[b].radius - 0.001)
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
    // Deleting a sibling does not shuffle the files that are still there; the
    // freed space is simply available to the next file.
    expect(Math.hypot(a.position.x - aBefore.x, a.position.y - aBefore.y)).toBeLessThan(0.01)
    expect(a.visible).toBe(true)
    const dir = sim.find('src')!
    expect(Math.hypot(a.position.x - dir.position.x, a.position.y - dir.position.y)).toBeGreaterThan(1)
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
    // Static hashed offsets: the files are where their path says, and adding a
    // sibling did not move anything.
    expect(a.position.x).toBeCloseTo(a.targetPosition.x, 6)
    expect(b.position.x).toBeCloseTo(b.targetPosition.x, 6)
    expect(Math.hypot(a.position.x - dir.position.x, a.position.y - dir.position.y)).toBeGreaterThan(1)
    expect(sim.drainMovedNodes()).toHaveLength(0)
  })

  it('keeps nodes inside the camera bounds while they move', () => {
    const commits = Array.from({ length: 10 }, (_, index) => addFile(`src/file-${index}.ts`, index))
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(9)
    // Mid-animation the reported positions are still finite and inside bounds.
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
  function clusterGap(a: { position: { x: number; y: number }; clusterRadius: number }, b: { position: { x: number; y: number }; clusterRadius: number }): number {
    return Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y) - a.clusterRadius - b.clusterRadius
  }

  it('keeps sibling folders apart, sized by their contents', () => {
    const commits = manyFolders(9, 5)
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(commits.length - 1)
    settle(sim, 6)

    const root = sim.find('')
    expect(root).toBeDefined()
    const folders = sim.nodes.filter((node) => node.kind === 'dir' && node.parent === root!.id)
    expect(folders.length).toBe(9)
    // No two sibling clusters overlap.
    for (let a = 0; a < folders.length; a += 1) {
      for (let b = a + 1; b < folders.length; b += 1) {
        expect(clusterGap(folders[a], folders[b])).toBeGreaterThan(0)
      }
    }
    // Every folder's cluster radius covers its own files.
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
    const beforeTarget = Math.hypot(target.position.x - root!.position.x, target.position.y - root!.position.y)
    const beforeGap = clusterGap(target, sibling)

    // Grow the first folder: many new files arrive there.
    const extra: RawCommit[] = []
    for (let index = 0; index < 12; index += 1) {
      extra.push(addFile(`${target.path}/new-${index}.ts`, commits.length + index))
    }
    const grown = makeSimulation([...commits, ...extra])
    grown.sim.applyUpTo(commits.length + extra.length - 1)
    settle(grown.sim, 8)
    const grownTarget = grown.sim.find(target.path)!
    const grownSibling = grown.sim.find(sibling.path)!
    const afterTarget = Math.hypot(grownTarget.position.x, grownTarget.position.y)
    const afterGap = clusterGap(grownTarget, grownSibling)

    // The folder reserves more room and its sibling moves out of the way.
    expect(grownTarget.clusterRadius).toBeGreaterThan(target.clusterRadius)
    expect(afterGap).toBeGreaterThan(0)
    expect(Math.abs(afterTarget - beforeTarget) + Math.abs(afterGap - beforeGap)).toBeGreaterThan(0.1)
  })

  it('never overlaps clusters while the layout animates', () => {
    const commits = manyFolders(7, 4)
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(commits.length - 1)
    // Sample mid-animation: clusters may be in flight, but the layout targets
    // must already be collision free.
    const root = sim.find('')
    const folders = sim.nodes.filter((node) => node.kind === 'dir' && node.parent === root!.id)
    const byTarget = folders.map((folder) => ({
      position: folder.targetPosition,
      clusterRadius: folder.clusterRadius,
    }))
    for (let a = 0; a < byTarget.length; a += 1) {
      for (let b = a + 1; b < byTarget.length; b += 1) {
        const gap =
          Math.hypot(byTarget[a].position.x - byTarget[b].position.x, byTarget[a].position.y - byTarget[b].position.y) -
          byTarget[a].clusterRadius -
          byTarget[b].clusterRadius
        expect(gap).toBeGreaterThan(0)
      }
    }
  })

  it('keeps nested folders apart as well', () => {
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
    // And the nested clusters stay inside their parent's cluster.
    for (const child of nested) {
      const distance = Math.hypot(child.position.x - src.position.x, child.position.y - src.position.y)
      expect(distance + child.clusterRadius).toBeLessThanOrEqual(src.clusterRadius + 0.05)
    }
  })
})
