import { describe, expect, it } from 'vitest'
import { parseRepoInput } from '../src/git/url'
import { resolveRepoInput, detectProvider } from '../src/git/providers'
import { GitError } from '../src/git/errors'

describe('parseRepoInput', () => {
  it('parses a plain https GitHub URL', () => {
    const result = parseRepoInput('https://github.com/vuejs/core')
    expect(result).not.toBeNull()
    expect(result?.host).toBe('github.com')
    expect(result?.segments).toEqual(['vuejs', 'core'])
  })

  it('handles trailing slashes, .git suffixes and scp-like syntax', () => {
    expect(parseRepoInput('https://github.com/vuejs/core.git/')?.segments).toEqual(['vuejs', 'core'])
    expect(parseRepoInput('git@github.com:vuejs/core.git')?.host).toBe('github.com')
    expect(parseRepoInput('git@github.com:vuejs/core.git')?.segments).toEqual(['vuejs', 'core'])
    expect(parseRepoInput('github.com/vuejs/core')?.segments).toEqual(['vuejs', 'core'])
  })

  it('accepts bare owner/repo input', () => {
    const result = parseRepoInput('vuejs/core')
    expect(result?.host).toBe('')
    expect(result?.segments).toEqual(['vuejs', 'core'])
  })

  it('strips UI routes such as /tree/main', () => {
    expect(parseRepoInput('https://github.com/vuejs/core/tree/main/packages')?.segments).toEqual(['vuejs', 'core'])
    expect(parseRepoInput('https://github.com/owner/repo/commits/main')?.segments).toEqual(['owner', 'repo'])
  })

  it('keeps nested group paths for GitLab', () => {
    expect(parseRepoInput('https://gitlab.com/group/sub/project')?.segments).toEqual(['group', 'sub', 'project'])
  })

  it('rejects nonsense input', () => {
    expect(parseRepoInput('')).toBeNull()
    expect(parseRepoInput('   ')).toBeNull()
    expect(parseRepoInput('https://github.com/onlyowner')).toBeNull()
  })
})

describe('resolveRepoInput', () => {
  it('resolves github.com to the GitHub provider', () => {
    const resolved = resolveRepoInput('https://github.com/vuejs/core')
    expect(resolved.provider.id).toBe('github')
    expect(resolved.parsed.owner).toBe('vuejs')
    expect(resolved.parsed.repo).toBe('core')
  })

  it('guesses github.com for bare owner/repo input', () => {
    const resolved = resolveRepoInput('vuejs/core')
    expect(resolved.provider.id).toBe('github')
    expect(resolved.hostGuessed).toBe(true)
  })

  it('routes GitLab nested groups', () => {
    const resolved = resolveRepoInput('https://gitlab.com/group/sub/project')
    expect(resolved.provider.id).toBe('gitlab')
    expect(resolved.parsed.params?.projectPath).toBe('group/sub/project')
  })

  it('supports GitHub Enterprise hosts', () => {
    const resolved = resolveRepoInput('https://github.example.com/team/service')
    expect(resolved.provider.id).toBe('github')
    expect(resolved.parsed.params?.apiBase).toBe('https://github.example.com/api/v3')
  })

  it('reports unsupported hosts clearly', () => {
    expect(() => resolveRepoInput('https://bitbucket.org/team/repo')).toThrowError(GitError)
    try {
      resolveRepoInput('https://bitbucket.org/team/repo')
    } catch (error) {
      expect((error as GitError).kind).toBe('unsupported')
      expect((error as GitError).message).toContain('bitbucket.org')
    }
  })

  it('resolves the synthetic demo provider only when asked for', () => {
    const resolved = resolveRepoInput('demo/synthetic-repository', { providerId: 'demo' })
    expect(resolved.provider.id).toBe('demo')
    expect(resolved.parsed.host).toBe('demo')
    expect(detectProvider('demo/synthetic-repository')?.provider.id).toBe('github')
  })
})
