import { GitError } from '../errors'
import { parseRepoInput } from '../url'
import { DemoProvider } from './demo'
import { GitHubProvider } from './github'
import { GitLabProvider } from './gitlab'
import type { GitProvider, ParsedRepoUrl } from './types'
import type { ProviderAuth } from './types'

export interface ProviderDescriptor {
  id: string
  name: string
  notes?: string
  /** Human readable hint used in the URL field placeholder. */
  example: string
  /** localStorage key for an optional token. */
  tokenKey: string
  tokenLabel: string
  /** Where the user creates a token. */
  tokenUrl?: string
}

/** Registry of available providers. Adding a host means adding an entry here. */
export const providers: GitProvider[] = [
  new GitHubProvider(),
  new GitLabProvider(),
  new DemoProvider(),
]

export const demoProvider = providers.find((provider) => provider.id === 'demo') as DemoProvider

const TOKEN_META: Record<string, { tokenLabel: string; tokenUrl?: string }> = {
  github: { tokenLabel: 'Fine-grained or classic token with public repo read access', tokenUrl: 'https://github.com/settings/tokens' },
  gitlab: { tokenLabel: 'Personal access token with `read_api` scope', tokenUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens' },
  demo: { tokenLabel: 'Not required' },
}

export function listProviderDescriptors(): ProviderDescriptor[] {
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    notes: provider.notes,
    example: provider.id === 'github' ? 'https://github.com/owner/repository' : provider.id === 'gitlab' ? 'https://gitlab.com/group/project' : 'demo://demo/synthetic',
    tokenKey: `web-gource:token:${provider.id}`,
    tokenLabel: TOKEN_META[provider.id]?.tokenLabel ?? 'Personal access token',
    tokenUrl: TOKEN_META[provider.id]?.tokenUrl,
  }))
}

export function getProvider(id: string): GitProvider | undefined {
  return providers.find((provider) => provider.id === id)
}

export interface ResolvedRepo {
  provider: GitProvider
  parsed: ParsedRepoUrl
  /** True when the host was guessed because the user typed `owner/repo`. */
  hostGuessed: boolean
}

/**
 * Resolve user input to a provider + parsed repository.
 *
 * Throws a {@link GitError} with `kind: 'unsupported'` when nothing matches so
 * the UI can explain which hosts are supported today.
 */
export function resolveRepoInput(input: string, options: { providerId?: string } = {}): ResolvedRepo {
  const trimmed = input.trim()
  if (!trimmed) throw new GitError('unsupported', 'Enter a repository URL.')

  const normalized = parseRepoInput(trimmed)
  if (!normalized) {
    throw new GitError('unsupported', `Could not understand "${trimmed}". Expected something like https://github.com/owner/repository.`)
  }

  // Bare `owner/repo`: assume github.com unless a provider was pinned.
  let host = normalized.host
  let hostGuessed = false
  if (!host) {
    host = 'github.com'
    hostGuessed = true
  }

  // The demo provider has no host; it is only reachable through an explicit choice.
  if (options.providerId === 'demo') {
    const demoUrl = new URL(`demo://demo/${normalized.segments.join('/')}`)
    const parsed = demoProvider.parse(demoUrl)
    if (parsed) return { provider: demoProvider, parsed, hostGuessed: false }
  }

  const url = new URL(`https://${host}/${normalized.segments.map(encodeURIComponent).join('/')}`)

  const ordered = options.providerId
    ? [...providers.filter((provider) => provider.id === options.providerId), ...providers]
    : providers

  for (const provider of ordered) {
    const parsed = provider.parse(url)
    if (parsed) return { provider, parsed, hostGuessed }
  }

  throw new GitError(
    'unsupported',
    `No provider is configured for "${host}". Supported hosts: github.com (and GitHub Enterprise), gitlab.com (and self-managed GitLab).`,
  )
}

/** Cheap detection used by the URL field to show a provider badge. */
export function detectProvider(input: string): { provider: GitProvider; hostGuessed: boolean } | null {
  try {
    const resolved = resolveRepoInput(input)
    return { provider: resolved.provider, hostGuessed: resolved.hostGuessed }
  } catch {
    return null
  }
}

export function authFor(_providerId: string, token: string | undefined): ProviderAuth {
  const trimmed = token?.trim()
  return trimmed ? { token: trimmed } : {}
}

export type { GitProvider, ParsedRepoUrl }
