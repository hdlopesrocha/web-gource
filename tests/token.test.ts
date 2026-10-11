// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  acceptToken,
  applyDraftToken,
  clearToken,
  detectTokenProvider,
  hasToken,
  persistLoadOptions,
  sanitizeToken,
  setDraftToken,
  setToken,
  store,
  tokenFor,
} from '../src/state/store'

/**
 * Token handling: tokens must be usable at any time (even before a repository
 * URL is known), must survive whitespace/newline paste artefacts, and must never
 * be sent to a host they do not belong to.
 */

beforeEach(() => {
  localStorage.clear()
  store.loadOptions.tokens = {}
  store.loadOptions.draftToken = ''
})

describe('sanitizeToken', () => {
  it('removes whitespace, line breaks and zero-width characters', () => {
    expect(sanitizeToken('  ghp_abc123  ')).toBe('ghp_abc123')
    expect(sanitizeToken('ghp_abc\n123\r\n')).toBe('ghp_abc123')
    expect(sanitizeToken('ghp_abc\u200b123')).toBe('ghp_abc123')
    expect(sanitizeToken('ghp_abc 123')).toBe('ghp_abc123')
  })

  it('strips an accidental Bearer or token prefix', () => {
    expect(sanitizeToken('Bearer ghp_abc123')).toBe('ghp_abc123')
    expect(sanitizeToken('bearer: ghp_abc123')).toBe('ghp_abc123')
    expect(sanitizeToken('token ghp_abc123')).toBe('ghp_abc123')
  })

  it('handles empty input', () => {
    expect(sanitizeToken('')).toBe('')
    expect(sanitizeToken('   \n ')).toBe('')
  })
})

describe('detectTokenProvider', () => {
  it('recognises GitHub and GitLab token prefixes', () => {
    expect(detectTokenProvider('ghp_abc')).toBe('github')
    expect(detectTokenProvider('github_pat_abc')).toBe('github')
    expect(detectTokenProvider('ghs_abc')).toBe('github')
    expect(detectTokenProvider('glpat-abc')).toBe('gitlab')
    expect(detectTokenProvider('glrt-abc')).toBe('gitlab')
  })

  it('returns null for unknown or empty input', () => {
    expect(detectTokenProvider('some-opaque-token')).toBeNull()
    expect(detectTokenProvider('')).toBeNull()
  })

  it('ignores the prefix casing and paste noise', () => {
    expect(detectTokenProvider('  GHP_ABC\n')).toBe('github')
  })
})

describe('draft tokens', () => {
  it('keeps a token that was entered before a host was known', () => {
    const result = acceptToken('ghp_pasted123', null)
    expect(result).toEqual({ providerId: 'github', draft: false })
    // The prefix already identified the host, so it is stored directly.
    expect(tokenFor('github')).toBe('ghp_pasted123')
    expect(store.loadOptions.draftToken).toBe('')

    const opaque = acceptToken('opaque-token-value', null)
    expect(opaque.draft).toBe(true)
    expect(store.loadOptions.draftToken).toBe('opaque-token-value')
    // A saved token for a known host wins until the draft is claimed.
    expect(tokenFor('github')).toBe('ghp_pasted123')
    expect(tokenFor('gitlab')).toBe('opaque-token-value')
  })

  it('lets a freshly pasted draft replace the previously saved token', () => {
    setToken('github', 'ghp_older')
    setDraftToken('ghp_newer')
    // Typing the URL (or opening the field for that host) claims the draft.
    expect(applyDraftToken('github')).toBe(true)
    expect(tokenFor('github')).toBe('ghp_newer')
    expect(store.loadOptions.draftToken).toBe('')
  })

  it('attaches a draft to the provider once known', () => {
    setDraftToken('glpat-draftvalue')
    expect(tokenFor('gitlab')).toBe('glpat-draftvalue')
    // A GitLab token must never be offered to GitHub.
    expect(tokenFor('github')).toBe('')
    expect(hasToken('github')).toBe(false)

    expect(applyDraftToken('github')).toBe(false)
    expect(applyDraftToken('gitlab')).toBe(true)
    expect(store.loadOptions.draftToken).toBe('')
    expect(store.loadOptions.tokens['gitlab']).toBe('glpat-draftvalue')
  })

  it('does not hand an unlabeled draft to a mismatching host once a real token exists', () => {
    setDraftToken('opaque-token-value')
    setToken('github', 'ghp_saved')
    expect(tokenFor('github')).toBe('ghp_saved')
    expect(tokenFor('gitlab')).toBe('opaque-token-value')
  })

  it('stores a token for a known provider directly', () => {
    const result = acceptToken(' my-token ', 'github')
    expect(result.providerId).toBe('github')
    expect(tokenFor('github')).toBe('my-token')
    expect(store.loadOptions.draftToken).toBe('')
  })

  it('clears tokens and drafts', () => {
    setToken('github', 'ghp_saved')
    setDraftToken('glpat-draft')
    clearToken('github')
    expect(tokenFor('github')).toBe('') // the GitLab draft must not leak here
    expect(acceptToken('', null)).toEqual({ providerId: null, draft: false })
    expect(store.loadOptions.draftToken).toBe('')
  })

  it('persists tokens and the draft so a reload keeps them', () => {
    setToken('github', 'ghp_saved')
    setDraftToken('opaque-draft')
    const raw = localStorage.getItem('web-gource:load-options:v1')
    expect(raw).toContain('ghp_saved')
    expect(raw).toContain('opaque-draft')
    persistLoadOptions()
    const parsed = JSON.parse(localStorage.getItem('web-gource:load-options:v1') ?? '{}') as {
      tokens?: Record<string, string>
      draftToken?: string
    }
    expect(parsed.tokens?.['github']).toBe('ghp_saved')
    expect(parsed.draftToken).toBe('opaque-draft')
  })

  it('trims a token that contains a copy/paste artefact', () => {
    setToken('github', 'Bearer ghp_tokenwithspaces\n')
    expect(tokenFor('github')).toBe('ghp_tokenwithspaces')
  })
})
