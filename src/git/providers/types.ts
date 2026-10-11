import type { CommitPage, FileSizeResult, ProviderProgress, RawCommit, RepoInfo } from '../types'

/** Credentials for a provider. Tokens are never persisted in source. */
export interface ProviderAuth {
  token?: string
}

/**
 * Result of parsing a user supplied repository location.
 * `params` holds provider specific routing information (owner/repo, project id,
 * self-hosted base URL, ...) and is opaque to the UI.
 */
export interface ParsedRepoUrl {
  providerId: string
  owner: string
  repo: string
  /** Canonical display URL. */
  htmlUrl: string
  /** Hostname of the Git host (used for self-hosted instances). */
  host: string
  /** Provider specific extra routing data (e.g. GitLab nested groups). */
  params?: Record<string, string>
}

/** Options for {@link GitProvider.loadCommitPage}. */
export interface LoadPageOptions {
  /** Opaque cursor from a previous page; omit for the newest page. */
  cursor?: string
  branch?: string
  signal?: AbortSignal
  auth?: ProviderAuth
  /** Requested page size. Providers may cap it (GitHub caps at 100). */
  limit?: number
  /** Called after each HTTP request so the loader can track quota usage. */
  onProgress?: (progress: ProviderProgress) => void
}

export interface HydrateOptions {
  signal?: AbortSignal
  auth?: ProviderAuth
  onProgress?: (progress: ProviderProgress) => void
}

/**
 * A Git hosting provider.
 *
 * Providers are small and mostly stateless. They translate their own API
 * payloads into the normalized types in `../types`, and they are explicit about
 * what they could not deliver (`filesMissing`) instead of inventing data.
 *
 * Fetching is split in two phases because APIs differ wildly in cost:
 *  - {@link GitProvider.loadCommitPage} returns cheap commit metadata;
 *  - {@link GitProvider.hydrateFiles} attaches file level changes, which for
 *    GitHub/GitLab costs one request per commit and must be budgeted carefully.
 */
export interface GitProvider {
  readonly id: string
  readonly name: string
  /** Short note about capabilities/limitations shown in the UI. */
  readonly notes?: string
  /** True when the provider can be used without credentials for public repos. */
  readonly supportsAnonymous: boolean

  /** Try to parse a URL. Returns `null` when the host is not handled here. */
  parse(url: URL): ParsedRepoUrl | null

  fetchRepoInfo(repo: ParsedRepoUrl, options: { signal?: AbortSignal; auth?: ProviderAuth }): Promise<RepoInfo>

  /** Newest-first page of commits, without file changes. */
  loadCommitPage(repo: ParsedRepoUrl, options: LoadPageOptions): Promise<CommitPage>

  /**
   * Oldest page of history in as few requests as possible.
   * Used by the "start from the first commit" range option.
   */
  loadEarliestPage?(repo: ParsedRepoUrl, options: LoadPageOptions): Promise<CommitPage>

  /**
   * File sizes for a snapshot of the repository, when the host exposes them
   * cheaply. Returning `null` means "not available here"; the visualization
   * then falls back to sizing circles by line activity.
   */
  fetchFileSizes?(
    repo: ParsedRepoUrl,
    options: { ref?: string; signal?: AbortSignal; auth?: ProviderAuth },
  ): Promise<FileSizeResult | null>

  /**
   * Attach file changes to commits (mutates them in place).
   *
   * Implementations must check their cache first, respect `onProgress` quota
   * reporting, and set `filesMissing` rather than throwing when a single commit
   * fails. Only abort errors may propagate.
   */
  hydrateFiles(repo: ParsedRepoUrl, commits: RawCommit[], options: HydrateOptions): Promise<void>

  /** Canonical browser URL for a commit. */
  commitUrl(repo: ParsedRepoUrl, sha: string): string
}

/** Cursor payload for page based APIs. */
export function encodePageCursor(page: number): string {
  return `p${page}`
}

export function decodePageCursor(cursor: string | undefined): number {
  if (!cursor) return 1
  const match = /^p(\d+)$/.exec(cursor)
  return match ? Number(match[1]) : 1
}
