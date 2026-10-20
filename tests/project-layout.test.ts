import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation'
import { buildTimeline } from '../src/timeline/builder'
import { buildSchedule } from '../src/timeline/schedule'
import type { RawCommit, RepoInfo } from '../src/git/types'

/**
 * Multi-project layout: every repository is one top-level volume, even when
 * several repositories share an owner. The volumes relax with the normal tree
 * forces, so growing one pushes the others away.
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

function commit(
  sha: string,
  timestamp: number,
  projectKey: string,
  path: string,
): RawCommit {
  return {
    sha,
    parents: [],
    timestamp,
    projectKey,
    projectName: projectKey,
    message: `${projectKey}: ${path}`,
    author: { name: 'Ada', email: 'ada@example.com', login: 'ada' },
    files: [{ path, kind: 'add', additions: 4, deletions: 0 }],
  }
}

function makeSimulation(commits: RawCommit[]) {
  const timeline = buildTimeline(repo, commits)
  const schedule = buildSchedule(timeline.commits)
  const sim = new Simulation(timeline.commits, timeline.authorById)
  sim.scheduleTime = (index) => schedule.times[index] ?? 0
  return sim
}

describe('multi-project volumes', () => {
  it('puts each project directly under the root and repels their volumes', () => {
    const commits: RawCommit[] = []
    for (let index = 0; index < 8; index += 1) {
      commits.push(commit(`w${index}`, 1000 + index * 1000, 'acme/widget', `acme/widget/src/w${index}.ts`))
      commits.push(commit(`s${index}`, 1500 + index * 1000, 'acme/service', `acme/service/lib/s${index}.ts`))
    }

    const sim = makeSimulation(commits)
    sim.applyUpTo(commits.length - 1)
    sim.reflowAll()

    const root = sim.root
    const widget = sim.find('acme/widget')
    const service = sim.find('acme/service')
    expect(widget).toBeDefined()
    expect(service).toBeDefined()
    expect(sim.find('acme')).toBeUndefined()
    expect(widget!.parent).toBe(root.id)
    expect(service!.parent).toBe(root.id)
    expect(widget!.projectKey).toBe('acme/widget')
    expect(service!.projectKey).toBe('acme/service')

    const gap =
      Math.hypot(
        widget!.targetPosition.x - service!.targetPosition.x,
        widget!.targetPosition.y - service!.targetPosition.y,
      ) -
      (widget!.volumeRadius ?? widget!.clusterRadius) -
      (service!.volumeRadius ?? service!.clusterRadius)
    expect(gap).toBeGreaterThan(0)
  })

  it('keeps three same-owner projects apart', () => {
    const commits: RawCommit[] = []
    for (let index = 0; index < 5; index += 1) {
      commits.push(commit(`a${index}`, 1000 + index * 3000, 'acme/alpha', `acme/alpha/src/a${index}.ts`))
      commits.push(commit(`b${index}`, 2000 + index * 3000, 'acme/beta', `acme/beta/lib/b${index}.ts`))
      commits.push(commit(`g${index}`, 3000 + index * 3000, 'acme/gamma', `acme/gamma/app/g${index}.ts`))
    }

    const sim = makeSimulation(commits)
    sim.applyUpTo(commits.length - 1)
    sim.reflowAll()

    const volumes = ['acme/alpha', 'acme/beta', 'acme/gamma'].map((path) => sim.find(path)!)
    expect(volumes.every((volume) => volume.parent === sim.root.id)).toBe(true)
    for (let a = 0; a < volumes.length; a += 1) {
      for (let b = a + 1; b < volumes.length; b += 1) {
        const gap =
          Math.hypot(
            volumes[a].targetPosition.x - volumes[b].targetPosition.x,
            volumes[a].targetPosition.y - volumes[b].targetPosition.y,
          ) -
          (volumes[a].volumeRadius ?? volumes[a].clusterRadius) -
          (volumes[b].volumeRadius ?? volumes[b].clusterRadius)
        expect(gap).toBeGreaterThan(0)
      }
    }
  })

  it('keeps every project element inside its own volume', () => {
    const commits: RawCommit[] = []
    for (let index = 0; index < 24; index += 1) {
      const area = index % 3
      commits.push(
        commit(
          `w${index}`,
          1000 + index * 1000,
          'acme/widget',
          `acme/widget/module-${area}/src/w${index}.ts`,
        ),
      )
    }
    for (let index = 0; index < 10; index += 1) {
      commits.push(commit(`s${index}`, 1500 + index * 1000, 'acme/service', `acme/service/lib/s${index}.ts`))
    }

    const sim = makeSimulation(commits)
    sim.applyUpTo(commits.length - 1)
    sim.reflowAll()

    for (const project of ['acme/widget', 'acme/service']) {
      const volume = sim.find(project)!
      const nodes = sim.nodes.filter(
        (node) => node.id !== volume.id && (node.path === project || node.path.startsWith(`${project}/`)),
      )
      expect(nodes.length).toBeGreaterThan(0)
      for (const node of nodes) {
        expect(node.parent).toBeGreaterThanOrEqual(0)
        const distance = Math.hypot(
          node.targetPosition.x - volume.targetPosition.x,
          node.targetPosition.y - volume.targetPosition.y,
        )
        expect(distance + node.radius).toBeLessThanOrEqual((volume.volumeRadius ?? volume.clusterRadius) + 0.05)
      }
    }
  })

  it('pushes the other project away when one volume grows', () => {
    const commits: RawCommit[] = []
    for (let index = 0; index < 6; index += 1) {
      commits.push(commit(`w${index}`, 1000 + index * 1000, 'acme/widget', `acme/widget/src/w${index}.ts`))
      commits.push(commit(`s${index}`, 1500 + index * 1000, 'acme/service', `acme/service/lib/s${index}.ts`))
    }

    const sim = makeSimulation(commits)
    sim.applyUpTo(commits.length - 1)
    sim.reflowAll()
    const beforeWidget = sim.find('acme/widget')!
    const beforeService = sim.find('acme/service')!
    const beforeGap =
      Math.hypot(
        beforeWidget.targetPosition.x - beforeService.targetPosition.x,
        beforeWidget.targetPosition.y - beforeService.targetPosition.y,
      ) -
      (beforeWidget.volumeRadius ?? beforeWidget.clusterRadius) -
      (beforeService.volumeRadius ?? beforeService.clusterRadius)
    const beforeWidgetRadius = beforeWidget.volumeRadius ?? beforeWidget.clusterRadius

    const extra: RawCommit[] = []
    for (let index = 0; index < 18; index += 1) {
      extra.push(
        commit(
          `extra-${index}`,
          commits.length * 2000 + index * 1000,
          'acme/widget',
          `acme/widget/extra/e${index}.ts`,
        ),
      )
    }
    const extended = buildTimeline(repo, [...commits, ...extra])
    sim.setCommits(extended.commits, extended.authorById)
    sim.applyUpTo(commits.length + extra.length - 1)
    sim.reflowAll()

    const afterWidget = sim.find('acme/widget')!
    const afterService = sim.find('acme/service')!
    expect(afterWidget.volumeRadius ?? afterWidget.clusterRadius).toBeGreaterThan(beforeWidgetRadius)
    const afterGap =
      Math.hypot(
        afterWidget.targetPosition.x - afterService.targetPosition.x,
        afterWidget.targetPosition.y - afterService.targetPosition.y,
      ) -
      (afterWidget.volumeRadius ?? afterWidget.clusterRadius) -
      (afterService.volumeRadius ?? afterService.clusterRadius)
    expect(afterGap).toBeGreaterThan(0)
    expect(Math.abs(afterGap - beforeGap)).toBeGreaterThan(0.05)
  })
})
