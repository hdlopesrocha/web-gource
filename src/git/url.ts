/**
 * Repository URL normalization.
 *
 * Users paste all sorts of things:
 *   https://github.com/vuejs/core
 *   github.com/vuejs/core.git
 *   git@github.com:vuejs/core.git
 *   https://github.com/vuejs/core/tree/main/packages
 *   vuejs/core
 *
 * `parseRepoInput` turns them into a host + path pair that providers can match
 * against, without performing any network request.
 */

export interface RepoInput {
  /** Lower-cased hostname, e.g. `github.com`. Empty for bare `owner/repo`. */
  host: string
  /** Path segments, e.g. `['vuejs', 'core']` or `['group', 'sub', 'project']`. */
  segments: string[]
  /** Full path string, without leading/trailing slashes. */
  path: string
  /** Original input after trimming. */
  raw: string
}

const SCP_LIKE = /^(?:[a-z0-9._-]+@)?([a-z0-9.-]+\.[a-z]{2,}):(?!\/)(.+)$/i
const KNOWN_PREFIXES = ['tree', 'blob', 'commits', 'commit', 'branches', 'releases', 'tags', 'issues', 'pull', 'merge_requests', '-', 'src', 'wiki']

export function parseRepoInput(input: string): RepoInput | null {
  const raw = input.trim()
  if (!raw) return null

  let host = ''
  let path = ''

  const scp = SCP_LIKE.exec(raw)
  if (scp && !raw.includes('://')) {
    host = scp[1].toLowerCase()
    path = scp[2]
  } else {
    let value = raw
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      // Bare `owner/repo` (2 segments, no dots) or `host/owner/repo`.
      const segments = value.split('/').filter(Boolean)
      if (segments.length >= 3 && segments[0].includes('.')) {
        value = `https://${value}`
      } else if (segments.length === 2) {
        return { host: '', segments, path: `${segments[0]}/${segments[1]}`, raw }
      } else {
        value = `https://${value}`
      }
    }
    try {
      const url = new URL(value)
      host = url.hostname.toLowerCase()
      path = url.pathname
    } catch {
      return null
    }
  }

  path = path.replace(/^\/+|\/+$/g, '')
  if (!path) return null
  let segments = path.split('/').filter(Boolean)
  // Drop a `.git` suffix (`repo.git`).
  if (segments.length > 0) {
    const last = segments[segments.length - 1]
    if (last.toLowerCase().endsWith('.git') && last.length > 4) {
      segments = [...segments.slice(0, -1), last.slice(0, -4)]
    }
  }
  // Drop trailing UI routes such as `/tree/main/packages`.
  const cutIndex = segments.findIndex((segment, index) => index >= 2 && KNOWN_PREFIXES.includes(segment))
  if (cutIndex > 0) segments = segments.slice(0, cutIndex)

  if (segments.length < 2) return null
  return { host, segments, path: segments.join('/'), raw }
}

/** Join a base URL and path fragments without duplicate slashes. */
export function joinUrl(base: string, ...parts: (string | number | undefined)[]): string {
  const cleanBase = base.replace(/\/+$/, '')
  const rest = parts
    .filter((part) => part !== undefined && part !== '')
    .map((part) => String(part).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
  return rest.length > 0 ? `${cleanBase}/${rest.join('/')}` : cleanBase
}

/** Encode a nested project path (`group/sub/project`) for GitLab style APIs. */
export function encodeProjectPath(path: string): string {
  return encodeURIComponent(path.replace(/^\/+|\/+$/g, ''))
}
