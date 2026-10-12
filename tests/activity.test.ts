import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation'
import { buildTimeline } from '../src/timeline/builder'
import { buildSchedule } from '../src/timeline/schedule'
import { BeamField } from '../src/render/beams'
import type { RawCommit, RepoInfo } from '../src/git/types'

/**
 * Author motion and activity beams.
 *
 * Avatars must travel visibly between the files they change (no teleports), and
 * every commit must tether the author to each file it touched for a short while.
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

function makeSimulation(commits: RawCommit[]) {
  const timeline = buildTimeline(repo, commits)
  const schedule = buildSchedule(timeline.commits)
  const sim = new Simulation(timeline.commits, timeline.authorById)
  sim.scheduleTime = (index) => schedule.times[index] ?? 0
  return { sim, timeline }
}

/** Commits that alternate between two far apart areas of the tree. */
const alternating: RawCommit[] = [
  raw({
    sha: 'a',
    timestamp: 1000,
    author: { name: 'Ada', email: 'ada@example.com' },
    files: [{ path: 'src/one/file.ts', kind: 'add', additions: 5, deletions: 0 }],
  }),
  raw({
    sha: 'b',
    timestamp: 2000,
    author: { name: 'Ada', email: 'ada@example.com' },
    files: [{ path: 'other/two/other.ts', kind: 'add', additions: 5, deletions: 0 }],
  }),
  raw({
    sha: 'c',
    timestamp: 3000,
    author: { name: 'Ada', email: 'ada@example.com' },
    files: [{ path: 'src/one/file.ts', kind: 'modify', additions: 1, deletions: 1 }],
  }),
]

describe('author motion', () => {
  it('moves towards the target instead of teleporting', () => {
    const { sim } = makeSimulation(alternating)
    sim.applyUpTo(0)
    const author = [...sim.authors][0]
    const first = { ...author.position }

    // Next commit targets a different part of the tree.
    sim.applyUpTo(1)
    const target = { ...author.target }
    const distanceBefore = Math.hypot(target.x - author.position.x, target.y - author.position.y)
    expect(distanceBefore).toBeGreaterThan(3)

    // One frame moves a little, not all the way.
    sim.update(1 / 60, sim.currentTime + 1 / 60)
    const distanceAfterOneFrame = Math.hypot(target.x - author.position.x, target.y - author.position.y)
    expect(distanceAfterOneFrame).toBeLessThan(distanceBefore)
    expect(distanceAfterOneFrame).toBeGreaterThan(distanceBefore * 0.5)

    // After ~1.2 s the avatar has essentially arrived (a visible glide, not a
    // teleport).
    for (let step = 0; step < 72; step += 1) {
      sim.update(1 / 60, sim.currentTime + step / 60)
    }
    const remaining = Math.hypot(target.x - author.position.x, target.y - author.position.y)
    expect(remaining).toBeLessThan(1)
    // The path taken was continuous: no jump larger than the speed limit.
    expect(Math.hypot(author.position.x - first.x, author.position.y - first.y)).toBeGreaterThan(1)
  })

  it('keeps movement monotonic and bounded by the speed limit', () => {
    const { sim } = makeSimulation(alternating)
    sim.applyUpTo(0)
    const author = [...sim.authors][0]
    const start = { ...author.position }
    sim.applyUpTo(1)
    const target = { ...author.target }
    const totalDistance = Math.hypot(target.x - start.x, target.y - start.y)

    let previous = Math.hypot(target.x - author.position.x, target.y - author.position.y)
    let maxStep = 0
    for (let step = 0; step < 90; step += 1) {
      const before = { ...author.position }
      sim.update(1 / 60, sim.currentTime + step / 60)
      const stepDistance = Math.hypot(author.position.x - before.x, author.position.y - before.y)
      maxStep = Math.max(maxStep, stepDistance)
      const remaining = Math.hypot(target.x - author.position.x, target.y - author.position.y)
      expect(remaining).toBeLessThanOrEqual(previous + 0.001)
      previous = remaining
    }
    // A single frame never covers the whole distance (that would be a teleport).
    expect(maxStep).toBeLessThan(totalDistance)
    // ...but the avatar does get there.
    expect(previous).toBeLessThan(0.5)
  })

  it('never moves faster than the configured speed limit', () => {
    const timeline = buildTimeline(repo, alternating)
    const schedule = buildSchedule(timeline.commits)
    const sim = new Simulation(timeline.commits, timeline.authorById, { maxSpeed: 40 })
    sim.scheduleTime = (index) => schedule.times[index] ?? 0
    sim.applyUpTo(1)
    const author = [...sim.authors][0]
    for (let step = 0; step < 60; step += 1) {
      const before = { ...author.position }
      sim.update(0.05, sim.currentTime + step * 0.05)
      const moved = Math.hypot(author.position.x - before.x, author.position.y - before.y)
      expect(moved).toBeLessThanOrEqual(40 * 0.05 + 0.001)
    }
  })

  it('reports the author speed for trails', () => {
    const { sim } = makeSimulation(alternating)
    sim.applyUpTo(1)
    const author = [...sim.authors][0]
    sim.update(1 / 60, sim.currentTime + 1 / 60)
    expect(sim.authorSpeed(author)).toBeGreaterThan(0)
  })
})

describe('activity tethers', () => {
  it('creates a tether for every file a commit touched', () => {
    const { sim } = makeSimulation([
      raw({
        sha: 'a',
        timestamp: 1000,
        files: [
          { path: 'src/a.ts', kind: 'add', additions: 1, deletions: 0 },
          { path: 'src/b.ts', kind: 'add', additions: 2, deletions: 0 },
          { path: 'src/c.ts', kind: 'add', additions: 1, deletions: 0 },
        ],
      }),
      raw({
        sha: 'b',
        timestamp: 2000,
        files: [
          { path: 'src/a.ts', kind: 'modify', additions: 1, deletions: 1 },
          { path: 'src/b.ts', kind: 'rename', previousPath: 'src/c.ts', additions: 0, deletions: 0 },
          { path: 'src/d.ts', kind: 'delete', additions: 0, deletions: 4 },
        ],
      }),
    ])
    sim.applyUpTo(1)
    const author = [...sim.authors][0]
    // One tether per touched file, and the second commit replaced the kinds.
    expect(author.tethers.length).toBeGreaterThanOrEqual(3)
    const kinds = new Set(author.tethers.map((tether) => tether.kind))
    expect(kinds.has('modify')).toBe(true)
    expect(kinds.has('rename')).toBe(true)
    for (const tether of author.tethers) {
      expect(tether.until).toBeGreaterThan(tether.start)
      expect(sim.get(tether.nodeId)?.path.startsWith('src/')).toBe(true)
    }
  })

  it('expires tethers after the configured duration', () => {
    const { sim } = makeSimulation(alternating)
    sim.applyUpTo(0)
    const author = [...sim.authors][0]
    expect(author.tethers.length).toBeGreaterThan(0)
    const until = author.tethers[0].until
    sim.update(1 / 60, until - 0.1)
    expect(author.tethers.length).toBeGreaterThan(0)
    sim.update(1 / 60, until + 0.05)
    expect(author.tethers).toHaveLength(0)
  })

  it('refreshes the tether when the same file is changed again', () => {
    const { sim } = makeSimulation(alternating)
    sim.applyUpTo(0)
    const author = [...sim.authors][0]
    const fileNode = sim.find('src/one/file.ts')
    const first = author.tethers.find((tether) => tether.nodeId === fileNode?.id)
    expect(first).toBeDefined()
    const firstUntil = first!.until

    sim.applyUpTo(2) // touches src/one/file.ts again
    const refreshed = author.tethers.find((tether) => tether.nodeId === fileNode?.id)
    expect(refreshed).toBeDefined()
    expect(refreshed!.until).toBeGreaterThan(firstUntil)
    // No duplicate tether for the same file.
    expect(author.tethers.filter((tether) => tether.nodeId === fileNode?.id)).toHaveLength(1)
  })

  it('keeps the number of tethers bounded', () => {
    const files = Array.from({ length: 40 }, (_, index) => ({
      path: `src/many/file-${index}.ts`,
      kind: 'add' as const,
      additions: 1,
      deletions: 0,
    }))
    const { sim } = makeSimulation([raw({ sha: 'a', timestamp: 1000, files })])
    sim.applyUpTo(0)
    const author = [...sim.authors][0]
    expect(author.tethers.length).toBeLessThanOrEqual(12)
    expect(author.tethers.length).toBeGreaterThan(0)
  })
})

describe('BeamField', () => {
  function node(id: number, x: number, y: number) {
    return {
      id,
      path: `src/f${id}.ts`,
      name: `f${id}.ts`,
      kind: 'file' as const,
      parent: 0,
      children: [],
      position: { x, y, z: 0 },
      targetPosition: { x, y, z: 0 },
      radius: 0.4,
      clusterRadius: 0.4,
      sizeBytes: 0,
      sizeKnown: false,
      activity: 1,
      bornIndex: 0,
      lastChangeIndex: 0,
      lastKind: 'modify' as const,
      changes: 1,
      additions: 1,
      deletions: 0,
      visible: true,
    }
  }

  function author(
    tethers: { nodeId: number; kind: 'add' | 'modify' | 'delete' | 'rename'; start: number; until: number; strength?: number; reference?: number }[],
  ) {
    return {
      author: { id: 'login:ada', name: 'Ada', commits: 1, first: 0, last: 0, additions: 0, deletions: 0, colorIndex: 0, unattributed: false },
      position: { x: 10, y: 10, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      target: { x: 0, y: 0, z: 0 },
      targetNodeId: 0,
      lastActiveAt: 0,
      appearedAt: 0,
      appliedCommits: 1,
      lastKind: 'modify' as const,
      visible: true,
      tethers: tethers.map((tether) => ({ strength: 5, reference: 20, ...tether })),
    }
  }

  it('draws a quad per active tether and follows both endpoints', () => {
    const field = new BeamField(16)
    const nodes = [node(0, 0, 0)]
    const sim = author([{ nodeId: 0, kind: 'add', start: 0, until: 2 }])
    field.update(0.5, [sim], nodes, 0.25)
    expect(field.segmentCount).toBe(1)
    // Twelve vertices per beam: glow quad plus core quad.
    expect(field.mesh.geometry.drawRange.count).toBe(12)
    const positions = field.mesh.geometry.getAttribute('position') as import('three').BufferAttribute
    // The beam starts at the avatar (10, 10 + lift) and ends at the node (0, 0).
    const xs = [0, 1, 2, 3, 4, 5].map((index) => positions.getX(index))
    const ys = [0, 1, 2, 3, 4, 5].map((index) => positions.getY(index))
    expect(Math.max(...xs)).toBeGreaterThan(9)
    expect(Math.min(...xs)).toBeLessThan(1)
    expect(Math.max(...ys)).toBeGreaterThan(10)
    expect(Math.min(...ys)).toBeLessThan(1)
    // The quad is perpendicular to the beam: the width offsets are equal and
    // opposite around the axis.
    const widths = [0, 1].map((index) => Math.hypot(positions.getX(index) - 10, positions.getY(index) - 12.5))
    expect(widths[0]).toBeCloseTo(widths[1], 5)
    expect(widths[0]).toBeGreaterThan(0)

    // Moving the author moves the beam start point.
    sim.position = { x: 20, y: 5, z: 0 }
    field.update(0.6, [sim], nodes, 0.25)
    const moved = field.mesh.geometry.getAttribute('position') as import('three').BufferAttribute
    expect(Math.max(...[0, 1, 2, 3, 4, 5].map((index) => moved.getX(index)))).toBeGreaterThan(19)
    field.dispose()
  })

  it('scales the beam width with the zoom level', () => {
    const field = new BeamField(4)
    const nodes = [node(0, 0, 0)]
    const sim = author([{ nodeId: 0, kind: 'add', start: 0, until: 2 }])
    const width = (): number => {
      const positions = field.mesh.geometry.getAttribute('position') as import('three').BufferAttribute
      return Math.hypot(positions.getX(0) - 10, positions.getY(0) - 12.5)
    }
    field.update(0.5, [sim], nodes, 0.1)
    const narrow = width()
    field.update(0.5, [sim], nodes, 0.4)
    expect(width()).toBeGreaterThan(narrow * 3)
    field.dispose()
  })

  it('fades out and stops drawing expired or hidden tethers', () => {
    const field = new BeamField(8)
    const nodes = [node(0, 0, 0)]
    const sim = author([{ nodeId: 0, kind: 'delete', start: 0, until: 1 }])

    const colors = () => field.mesh.geometry.getAttribute('color') as import('three').BufferAttribute
    field.update(0.02, [sim], nodes, 0.25)
    const early = colors().getX(0)
    field.update(0.95, [sim], nodes, 0.25)
    const late = colors().getX(0)
    expect(late).toBeLessThan(early)

    field.update(1.5, [sim], nodes, 0.25)
    expect(field.segmentCount).toBe(0)

    // Hidden authors draw nothing, and a hidden node is skipped.
    sim.visible = false
    field.update(0.5, [sim], nodes, 0.25)
    expect(field.segmentCount).toBe(0)
    sim.visible = true
    nodes[0].visible = false
    field.update(0.5, [sim], nodes, 0.25)
    expect(field.segmentCount).toBe(0)
    field.dispose()
  })

  it('draws stronger beams for bigger changes', () => {
    const field = new BeamField(4)
    const nodes = [node(0, 0, 0), node(1, 0, 0)]
    const small = author([{ nodeId: 0, kind: 'modify', start: 0, until: 5, strength: 2, reference: 400 }])
    const big = author([{ nodeId: 0, kind: 'modify', start: 0, until: 5, strength: 400, reference: 400 }])
    const read = (target: ReturnType<typeof author>) => {
      field.update(0.5, [target], nodes, 0.2)
      const colors = field.mesh.geometry.getAttribute('color') as import('three').BufferAttribute
      const positions = field.mesh.geometry.getAttribute('position') as import('three').BufferAttribute
      // Brightness of the beam core.
      const brightness = colors.getX(6) + colors.getY(6) + colors.getZ(6)
      // Width: distance from the beam axis to the first vertex.
      const width = Math.hypot(positions.getX(6) - 10, positions.getY(6) - 12.5)
      return { brightness, width }
    }
    const weak = read(small)
    const strong = read(big)
    expect(strong.brightness).toBeGreaterThan(weak.brightness * 1.4)
    expect(strong.width).toBeGreaterThan(weak.width * 1.4)
    field.dispose()
  })

  it('records the change size on each tether', () => {
    const commits = [
      raw({
        sha: 'a',
        timestamp: 1000,
        files: [
          { path: 'src/big.ts', kind: 'add', additions: 400, deletions: 0 },
          { path: 'src/tiny.ts', kind: 'add', additions: 1, deletions: 0 },
        ],
      }),
    ]
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(0)
    const author = [...sim.authors][0]
    const big = author.tethers.find((tether) => sim.get(tether.nodeId)?.path === 'src/big.ts')
    const tiny = author.tethers.find((tether) => sim.get(tether.nodeId)?.path === 'src/tiny.ts')
    expect(big).toBeDefined()
    expect(tiny).toBeDefined()
    // The tether of the bigger change is stronger, and both know the reference
    // they are normalised against.
    expect(big!.strength).toBeGreaterThan(tiny!.strength)
    expect(big!.reference).toBeGreaterThanOrEqual(big!.strength)
  })

  it('respects its capacity', () => {
    const field = new BeamField(3)
    const nodes = Array.from({ length: 10 }, (_, index) => node(index, index, 0))
    const sim = author(
      Array.from({ length: 10 }, (_, index) => ({ nodeId: index, kind: 'modify' as const, start: 0, until: 5 })),
    )
    field.update(0.1, [sim], nodes, 0.25)
    expect(field.segmentCount).toBe(3)
    field.dispose()
  })

  it('can be switched off', () => {
    const field = new BeamField(4)
    const nodes = [node(0, 0, 0)]
    const sim = author([{ nodeId: 0, kind: 'add', start: 0, until: 5 }])
    field.setEnabled(false)
    field.update(0.1, [sim], nodes, 0.25)
    expect(field.segmentCount).toBe(0)
    expect(field.mesh.visible).toBe(false)
    field.dispose()
  })
})
