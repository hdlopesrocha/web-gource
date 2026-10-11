/**
 * Normalized Git data model.
 *
 * Every provider (GitHub, GitLab, ...) is responsible for translating its own
 * API payloads into these structures. The rest of the application (timeline
 * building, simulation, rendering) only ever sees these types, which keeps the
 * hosting-specific code isolated in `src/git/providers`.
 *
 * Rule: never invent data. When an API cannot tell us something (for example
 * the list of files touched by a commit because of rate limiting) the field is
 * left `undefined`/`null` and the caller has to explain the gap to the user.
 */

/** A single file touched by a commit. */
export interface RawFileChange {
  /** Path after the commit (new path for renames). */
  path: string
  /** Previous path, only present for renames/copies. */
  previousPath?: string
  kind: 'add' | 'modify' | 'delete' | 'rename'
  additions: number
  deletions: number
}

/** Why file level data is missing for a commit. */
export type FilesMissingReason =
  | 'rate-limit'
  | 'error'
  | 'merge-parents'
  | 'too-large'
  | 'not-requested'

export interface RawCommit {
  sha: string
  /** Parent SHAs, in order. Empty for the root commit. */
  parents: string[]
  /** True when the commit has more than one parent. */
  isMerge?: boolean
  /** Commit time in milliseconds since the epoch (author date, UTC). */
  timestamp: number
  message: string
  author: RawAuthor
  committer?: RawAuthor
  /** `null` when the provider could not deliver file level data. */
  files: RawFileChange[] | null
  filesMissing?: FilesMissingReason
  /** True when the provider truncated the file list (e.g. GitHub caps at 300). */
  filesTruncated?: boolean
  /** Total changed files reported by the API, even when the list is truncated. */
  filesTotal?: number
  stats?: { additions: number; deletions: number }
}

export interface RawAuthor {
  name: string
  email?: string
  /** Hosting-platform login when it could be resolved. */
  login?: string
  avatarUrl?: string
}

/** Repository metadata used for the UI header and for planning the fetch. */
export interface RepoInfo {
  provider: string
  owner: string
  name: string
  /** `owner/name`, or a provider-specific project path. */
  fullName: string
  htmlUrl: string
  description?: string
  defaultBranch: string
  /** Repository size as reported by the host, in kilobytes when available. */
  sizeKb?: number
  stars?: number
  language?: string
  isPrivate: boolean
  isFork?: boolean
  /** ISO timestamp of the most recent push/activity. */
  pushedAt?: string
  createdAt?: string
  /** Approximate commit count when the host exposes it cheaply. */
  commitCountEstimate?: number
}

/**
 * File sizes (path → bytes) for a snapshot of the repository.
 *
 * Hosts expose this cheaply (GitHub: one recursive tree request), which is what
 * lets the visualization size file circles by real file size instead of by
 * change activity.
 */
export interface FileSizeResult {
  sizes: Map<string, number>
  /** True when the host truncated the listing (very large repositories). */
  truncated: boolean
  /** Where the sizes came from, shown in the UI (`git-tree`, `synthetic`). */
  source: string
}

/** Page of commits returned by a provider, newest first. */
export interface CommitPage {
  commits: RawCommit[]
  /** Cursor/page handle to request the next (older) page, `null` when done. */
  next: PageCursor | null
  /** Total number of commits when the host can tell us (often an estimate). */
  totalCount?: number
}

export type PageCursor = string

export interface FetchCommitsOptions {
  branch?: string
  /** Abort in-flight requests when the user cancels a load. */
  signal?: AbortSignal
  /** Called for every page plus every per-commit detail response. */
  onPage?: (info: { commitsInPage: number; cursor: PageCursor | null }) => void
}

/** Progress reporting for the loading UI. */
export interface ProviderProgress {
  requestCount: number
  /** Remaining API quota as reported by response headers, when available. */
  rateRemaining?: number
  rateLimit?: number
  /** Epoch ms when the quota resets. */
  rateReset?: number
  /** True when an authenticated request is being used. */
  authenticated: boolean
}
