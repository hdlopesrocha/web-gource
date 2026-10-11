import { describe, expect, it } from 'vitest'
import { Simulation, fileRadiusForActivity, fileRadiusForBytes, sizeReferenceFrom } from '../src/sim/simulation'
import { LAYOUT } from '../src/sim/layout'
import { buildTimeline } from '../src/timeline/builder'
import { buildSchedule } from '../src/timeline/schedule'
import type { RawCommit, RepoInfo } from '../src/git/types'

/**
 * File size handling: circles must grow with the file size reported by the
 * host, fall back to line activity when sizes are unavailable, and stay inside
 * a documented range.
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

function makeSimulation(commits: RawCommit[], fileSizes?: Map<string, number>) {
  const timeline = buildTimeline(repo, commits, { fileSizes })
  const schedule = buildSchedule(timeline.commits)
  const sim = new Simulation(timeline.commits, timeline.authorById)
  sim.scheduleTime = (index) => schedule.times[index] ?? 0
  sim.setFileSizes(timeline.fileSizes)
  return { sim, timeline }
}

describe('fileRadiusForBytes', () => {
  it('grows monotonically and stays within the documented range', () => {
    const reference = 1_000_000
    const tiny = fileRadiusForBytes(200, reference)
    const small = fileRadiusForBytes(5_000, reference)
    const medium = fileRadiusForBytes(120_000, reference)
    const large = fileRadiusForBytes(reference, reference)
    expect(tiny).toBeLessThan(small)
    expect(small).toBeLessThan(medium)
    expect(medium).toBeLessThan(large)
    expect(tiny).toBeGreaterThanOrEqual(LAYOUT.minFileRadius - 1e-9)
    expect(large).toBeLessThanOrEqual(LAYOUT.maxFileRadius + 1e-9)
    // The largest file always maps to the largest circle.
    expect(large).toBeCloseTo(LAYOUT.maxFileRadius, 6)
  })

  it('is logarithmic: a 1000× bigger file is not 1000× the radius', () => {
    const a = fileRadiusForBytes(1_000, 1_000_000)
    const b = fileRadiusForBytes(1_000_000, 1_000_000)
    expect(b / a).toBeLessThan(4)
    // Ordinary files across two orders of magnitude are still distinguishable.
    expect(fileRadiusForBytes(10_000, 1_000_000)).toBeGreaterThan(a * 1.1)
    expect(fileRadiusForBytes(100_000, 1_000_000)).toBeGreaterThan(fileRadiusForBytes(10_000, 1_000_000) * 1.1)
  })

  it('uses the 95th percentile as reference so outliers cannot squash the scale', () => {
    const values = [...Array.from({ length: 99 }, () => 20_000), 50_000_000]
    const reference = sizeReferenceFrom(values)
    expect(reference).toBe(20_000)
    // A normal file still gets a visible circle next to the outlier.
    const normal = fileRadiusForBytes(20_000, reference)
    expect(normal).toBeGreaterThan(LAYOUT.minFileRadius * 3)
  })

  it('handles unknown or empty references without breaking', () => {
    expect(fileRadiusForBytes(0, 0)).toBeGreaterThan(0)
    expect(Number.isFinite(fileRadiusForBytes(500, 0))).toBe(true)
  })
})

describe('sizing file circles', () => {
  const commits: RawCommit[] = [
    raw({
      sha: 'a',
      timestamp: 1000,
      files: [
        { path: 'src/tiny.ts', kind: 'add', additions: 2, deletions: 0 },
        { path: 'src/huge.ts', kind: 'add', additions: 3, deletions: 0 },
        { path: 'src/unknown.ts', kind: 'add', additions: 40, deletions: 0 },
      ],
    }),
  ]

  it('uses host-reported sizes by default and orders the circles', () => {
    const sizes = new Map<string, number>([
      ['src/tiny.ts', 800],
      ['src/huge.ts', 900_000],
    ])
    const { sim } = makeSimulation(commits, sizes)
    sim.applyUpTo(0)
    const tiny = sim.find('src/tiny.ts')
    const huge = sim.find('src/huge.ts')
    const unknown = sim.find('src/unknown.ts')
    expect(tiny?.sizeKnown).toBe(true)
    expect(tiny?.sizeBytes).toBe(800)
    expect(huge?.sizeKnown).toBe(true)
    // The huge file has a clearly bigger circle than the tiny one, while both
    // stay inside the documented range.
    expect(huge!.radius).toBeGreaterThan(tiny!.radius * 1.4)
    expect(huge!.radius).toBeCloseTo(LAYOUT.maxFileRadius, 6)
    expect(tiny!.radius).toBeGreaterThan(LAYOUT.minFileRadius)
    // Files without a reported size fall back to line activity and stay valid.
    expect(unknown?.sizeKnown).toBe(false)
    expect(unknown!.radius).toBeGreaterThanOrEqual(LAYOUT.minFileRadius)
    expect(unknown!.radius).toBeLessThanOrEqual(LAYOUT.maxFileRadius)
  })

  it('recomputes circles when sizes arrive after the nodes exist', () => {
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(0)
    const before = sim.find('src/huge.ts')!.radius
    sim.setFileSizes(new Map([['src/huge.ts', 2_000_000]]))
    const after = sim.find('src/huge.ts')!.radius
    expect(after).toBeGreaterThan(before)
    expect(sim.sizeCoverage()).toMatchObject({ known: 1, total: 3 })
    expect(sim.sizeCoverage().bytes).toBe(2_000_000)
  })

  it('switches between size modes', () => {
    const sizes = new Map<string, number>([['src/huge.ts', 900_000]])
    const { sim } = makeSimulation(commits, sizes)
    sim.applyUpTo(0)
    const bytesRadius = sim.find('src/huge.ts')!.radius

    sim.setSizeMode('uniform')
    for (const node of sim.nodes) {
      if (node.kind === 'file') expect(node.radius).toBeCloseTo(LAYOUT.fileRadius, 6)
    }

    sim.setSizeMode('activity')
    const activityRadius = sim.find('src/huge.ts')!.radius
    expect(activityRadius).toBeGreaterThanOrEqual(LAYOUT.minFileRadius)
    // The unknown file with 40 changed lines is the most active one here.
    expect(sim.find('src/unknown.ts')!.radius).toBeGreaterThanOrEqual(activityRadius * 0.5)

    sim.setSizeMode('bytes')
    expect(sim.find('src/huge.ts')!.radius).toBeCloseTo(bytesRadius, 6)
    expect(sim.currentSizeMode).toBe('bytes')
  })

  it('exposes reference values for the UI legend', () => {
    const sizes = new Map<string, number>([['src/huge.ts', 500_000]])
    const { sim } = makeSimulation(commits, sizes)
    sim.applyUpTo(0)
    const reference = sim.sizeReference
    expect(reference.mode).toBe('bytes')
    expect(reference.bytes).toBe(500_000)
    expect(reference.activity).toBeGreaterThanOrEqual(8)
    // The legend uses the same functions as the simulation.
    expect(fileRadiusForBytes(reference.bytes, reference.bytes)).toBeCloseTo(LAYOUT.maxFileRadius, 6)
    expect(fileRadiusForActivity(reference.activity, reference.activity)).toBeGreaterThan(0)
  })

  it('keeps directory radii independent of file sizes', () => {
    const sizes = new Map<string, number>([['src/tiny.ts', 5_000_000]])
    const { sim } = makeSimulation(commits, sizes)
    sim.applyUpTo(0)
    const dir = sim.find('src')
    expect(dir?.kind).toBe('dir')
    expect(dir?.sizeKnown).toBe(false)
    expect(dir!.radius).toBeGreaterThan(LAYOUT.minFileRadius)
  })

  it('produces a deterministic layout on the XY plane', () => {
    const { sim } = makeSimulation(commits)
    sim.applyUpTo(0)
    for (const node of sim.nodes) {
      expect(node.position.z).toBe(0)
    }
    const first = sim.nodes.map((node) => `${node.path}:${node.position.x.toFixed(4)},${node.position.y.toFixed(4)}`)
    const second = makeSimulation(commits).sim
    second.applyUpTo(0)
    const repeat = second.nodes.map((node) => `${node.path}:${node.position.x.toFixed(4)},${node.position.y.toFixed(4)}`)
    expect(repeat).toEqual(first)
  })
})
