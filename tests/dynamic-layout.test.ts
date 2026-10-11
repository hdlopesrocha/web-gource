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
    // Small circles on a sparse ring still use the minimum radius.
    expect(ringExtent(placeOnRings(few))).toBeCloseTo(LAYOUT.fileRingRadius, 5)
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
    const before = Math.hypot(
      sim.find('src/file-0.ts')!.position.x - sim.find('src')!.position.x,
      sim.find('src/file-0.ts')!.position.y - sim.find('src')!.position.y,
    )

    // The same file becomes huge: its circle grows and pushes the ring out.
    sim.setFileSizes(new Map([['src/file-0.ts', 4_000_000]]))
    expect(sim.find('src/file-0.ts')!.radius).toBeGreaterThan(1)
    // The siblings are now heading outwards, and they get there smoothly.
    sim.update(1 / 60, sim.currentTime + 1 / 60)
    expect(sim.drainMovedNodes().length).toBeGreaterThan(0)
    settle(sim)
    const after = Math.hypot(
      sim.find('src/file-0.ts')!.position.x - sim.find('src')!.position.x,
      sim.find('src/file-0.ts')!.position.y - sim.find('src')!.position.y,
    )
    expect(after).toBeGreaterThan(before)
    // Every file ended up on its layout position.
    for (const node of sim.nodes) {
      if (node.kind !== 'file') continue
      expect(node.position.x).toBeCloseTo(node.targetPosition.x, 3)
      expect(node.position.y).toBeCloseTo(node.targetPosition.y, 3)
    }
  })

  it('reflows when a file is deleted', () => {
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
    const aAfter = sim.find('src/a.ts')!.position
    // With the sibling gone the ring is recentred on a single file.
    expect(Math.hypot(aAfter.x - aBefore.x, aAfter.y - aBefore.y)).toBeGreaterThan(0.05)
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
