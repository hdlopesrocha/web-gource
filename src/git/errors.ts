/** Error types shared by every Git provider. */

export type GitErrorKind =
  | 'not-found'
  | 'private'
  | 'rate-limit'
  | 'network'
  | 'auth'
  | 'unsupported'
  | 'aborted'
  | 'unknown'

/**
 * Provider errors carry a machine readable `kind` so the UI can show an
 * actionable message (for example "add a token" for rate limits) instead of a
 * raw HTTP status.
 */
export class GitError extends Error {
  readonly kind: GitErrorKind
  /** HTTP status when the failure came from a response. */
  readonly status?: number
  /** Epoch ms at which the rate limit window resets, when known. */
  readonly resetAt?: number
  readonly retryable: boolean

  constructor(
    kind: GitErrorKind,
    message: string,
    options: { status?: number; resetAt?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'GitError'
    this.kind = kind
    this.status = options.status
    this.resetAt = options.resetAt
    this.retryable = options.retryable ?? (kind === 'network' || kind === 'unknown')
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof GitError) return error.kind === 'aborted'
  if (error instanceof DOMException) return error.name === 'AbortError'
  return false
}

/** Human readable, actionable description of a Git error. */
export function describeGitError(error: unknown): string {
  if (error instanceof GitError) {
    switch (error.kind) {
      case 'not-found':
        return 'Repository not found. Check the URL — the repository may be private, renamed or deleted.'
      case 'private':
        return 'This repository is private. Add a personal access token with `repo` (GitHub) or `read_api` (GitLab) scope to load it.'
      case 'rate-limit': {
        const when = error.resetAt ? new Date(error.resetAt).toLocaleTimeString() : 'shortly'
        return `API rate limit reached (resets ${when}). Add a personal access token in Settings for a much higher quota, or try again later.`
      }
      case 'auth':
        return 'Authentication failed. The personal access token was rejected or has insufficient scopes.'
      case 'network':
        return 'Network request failed. Check your connection and try again.'
      case 'unsupported':
        return error.message
      case 'aborted':
        return 'Loading was cancelled.'
      default:
        return error.message
    }
  }
  if (error instanceof Error) return error.message
  return String(error)
}
