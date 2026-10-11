import { describe, expect, it } from 'vitest'
import { resolveRepoInput } from '../../src/git/providers'
import { GitHubProvider } from '../../src/git/providers/github'

const REPO = process.env['WEB_GOURCE_TEST_REPO'] ?? 'https://github.com/hdlopesrocha/opencode-talk'

describe('live file sizes', () => {
  it('reads real blob sizes from the tree endpoint', async () => {
    const resolved = resolveRepoInput(REPO)
    const provider = new GitHubProvider()
    const page = await provider.loadCommitPage(resolved.parsed, { limit: 5 })
    const newest = page.commits[0]?.sha
    expect(newest).toBeTruthy()
    const sizes = await provider.fetchFileSizes(resolved.parsed, { ref: newest })
    console.log('sizes:', sizes ? sizes.sizes.size : null, 'source:', sizes?.source, 'truncated:', sizes?.truncated)
    const sample = sizes ? [...sizes.sizes.entries()].slice(0, 3) : []
    console.log('sample:', sample)
    expect(sizes).not.toBeNull()
    expect(sizes!.sizes.size).toBeGreaterThan(0)
  }, 60000)
})
