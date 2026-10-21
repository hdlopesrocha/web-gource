import { describe, expect, it } from 'vitest'
import { DEMO_REPOSITORIES, DemoProvider } from '../src/git/providers/demo'
import { resolveRepoInput } from '../src/git/providers'

function parsed(input: string) {
  return resolveRepoInput(input, { providerId: 'demo' }).parsed
}

describe('DemoProvider', () => {
  it('defines three differently named synthetic projects', async () => {
    const provider = new DemoProvider()
    const infos = await Promise.all(DEMO_REPOSITORIES.map((input) => provider.fetchRepoInfo(parsed(input))))

    expect(new Set(DEMO_REPOSITORIES).size).toBe(3)
    expect(infos.map((info) => info.fullName)).toEqual([...DEMO_REPOSITORIES])
    expect(new Set(infos.map((info) => info.description)).size).toBe(3)
    expect(new Set(infos.map((info) => info.language)).size).toBe(3)
    expect(new Set(infos.map((info) => info.commitCountEstimate)).size).toBe(3)
  })

  it('gives every project a distinct tree and file-size distribution', async () => {
    const provider = new DemoProvider()
    const projects = await Promise.all(
      DEMO_REPOSITORIES.map(async (input) => {
        const sizes = await provider.fetchFileSizes(parsed(input))
        expect(sizes).not.toBeNull()
        const bytes = [...sizes!.sizes.values()].sort((a, b) => a - b)
        return {
          roots: new Set([...sizes!.sizes.keys()].map((path) => path.split('/')[0] ?? '')),
          median: bytes[Math.floor(bytes.length / 2)]!,
          count: bytes.length,
        }
      }),
    )

    expect(projects.every((project) => project.count > 100)).toBe(true)
    const treeSignatures = projects.map((project) => [...project.roots].sort().join('|'))
    expect(new Set(treeSignatures).size).toBe(3)
    expect(new Set(projects.map((project) => project.median)).size).toBe(3)
    // UI components are small, API files are medium, engine assets are large.
    expect(projects[0]!.median).toBeLessThan(projects[1]!.median)
    expect(projects[1]!.median).toBeLessThan(projects[2]!.median)
  })
})
