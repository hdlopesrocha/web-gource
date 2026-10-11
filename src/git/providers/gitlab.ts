import { GitError } from '../errors'
import { requestJson, type RateLimitSnapshot } from '../http'
import { apiCache } from '../cache'
import { encodeProjectPath, joinUrl } from '../url'
import { mapConcurrent } from '../pool'
import type { CommitPage, PageCursor, ProviderProgress, RawCommit, RawFileChange, RepoInfo } from '../types'
import type { GitProvider, HydrateOptions, LoadPageOptions, ParsedRepoUrl, ProviderAuth } from './types'
import { decodePageCursor, encodePageCursor } from './types'

/* ------------------------------- payloads ------------------------------- */

interface GlProject {
  id: number
  name: string
  path_with_namespace: string
  web_url: string
  description: string | null
  default_branch: string | null
  star_count?: number
  statistics?: { repository_size?: number; commit_count?: number }
  visibility?: string
  forked_from_project?: unknown
  created_at?: string
  last_activity_at?: string
}

interface GlCommit {
  id: string
  parent_ids?: string[]
  title?: string
  message?: string
  author_name?: string
  author_email?: string
  authored_date?: string
  committed_date?: string
  created_at?: string
  stats?: { additions?: number; deletions?: number; total?: number }
}

interface GlDiff {
  old_path: string
  new_path: string
  new_file?: boolean
  renamed_file?: boolean
  deleted_file?: boolean
  diff?: string
}

/** Requests kept in flight while hydrating per-commit diffs. */
const DETAIL_CONCURRENCY = 6
const QUOTA_RESERVE = 3

/**
 * GitLab.com and self-managed GitLab (beta).
 *
 * Implemented against the documented v4 REST API and sharing the exact same
 * normalized output as the GitHub provider. It is exercised less in practice,
 * so it is labelled beta in the UI.
 */
export class GitLabProvider implements GitProvider {
  readonly id = 'gitlab'
  readonly name = 'GitLab (beta)'
  readonly supportsAnonymous = true
  readonly notes =
    'GitLab REST API v4. Commit lists include diff stats; file paths cost one `/diff` request per commit (beta support).'

  parse(url: URL): ParsedRepoUrl | null {
    const host = url.hostname.toLowerCase()
    const isDotCom = host === 'gitlab.com' || host === 'www.gitlab.com'
    const looksSelfHosted = !isDotCom && host.includes('gitlab')
    if (!isDotCom && !looksSelfHosted) return null

    const segments = url.pathname.split('/').filter(Boolean).map((segment) => segment.replace(/\.git$/i, ''))
    if (segments.length < 2) return null

    // Drop UI routes: `group/project/-/tree/main/...`
    const dashIndex = segments.indexOf('-')
    const cleanSegments = dashIndex > 1 ? segments.slice(0, dashIndex) : segments
    if (cleanSegments.length < 2) return null
    const projectPath = cleanSegments.join('/')

    return {
      providerId: this.id,
      owner: cleanSegments.slice(0, -1).join('/'),
      repo: cleanSegments[cleanSegments.length - 1],
      htmlUrl: `https://${host}/${projectPath}`,
      host,
      params: { projectPath, apiBase: `https://${host}/api/v4` },
    }
  }

  commitUrl(repo: ParsedRepoUrl, sha: string): string {
    return `${repo.htmlUrl}/-/commit/${sha}`
  }

  private apiBase(repo: ParsedRepoUrl): string {
    return repo.params?.apiBase ?? `https://${repo.host}/api/v4`
  }

  private projectId(repo: ParsedRepoUrl): string {
    return encodeProjectPath(repo.params?.projectPath ?? `${repo.owner}/${repo.repo}`)
  }

  private headers(auth?: ProviderAuth): Record<string, string> {
    const headers: Record<string, string> = {}
    const token = auth?.token?.trim()
    if (token) headers['private-token'] = token
    return headers
  }

  private report(options: { onProgress?: (progress: ProviderProgress) => void }, snapshot: RateLimitSnapshot, count = 1): void {
    if (!options.onProgress) return
    const progress: ProviderProgress = { requestCount: count, authenticated: true }
    if (snapshot.limit !== undefined) progress.rateLimit = snapshot.limit
    if (snapshot.remaining !== undefined) progress.rateRemaining = snapshot.remaining
    if (snapshot.resetAt !== undefined) progress.rateReset = snapshot.resetAt
    options.onProgress(progress)
  }

  async fetchRepoInfo(
    repo: ParsedRepoUrl,
    options: { signal?: AbortSignal; auth?: ProviderAuth } = {},
  ): Promise<RepoInfo> {
    const cacheKey = `gitlab:repo:${repo.params?.projectPath ?? `${repo.owner}/${repo.repo}`}`
    const cached = await apiCache.get<RepoInfo>(cacheKey)
    if (cached) return cached

    const response = await requestJson<GlProject>(joinUrl(this.apiBase(repo), 'projects', this.projectId(repo)), {
      signal: options.signal,
      headers: this.headers(options.auth),
    })
    const data = response.data
    if (!data || !data.path_with_namespace) {
      throw new GitError('unknown', `Unexpected project metadata for ${repo.owner}/${repo.repo}.`)
    }
    const info: RepoInfo = {
      provider: this.id,
      owner: data.path_with_namespace.split('/').slice(0, -1).join('/') || repo.owner,
      name: data.name,
      fullName: data.path_with_namespace,
      htmlUrl: data.web_url,
      description: data.description ?? undefined,
      defaultBranch: data.default_branch || 'main',
      stars: data.star_count,
      isPrivate: data.visibility ? data.visibility !== 'public' : false,
      isFork: Boolean(data.forked_from_project),
      createdAt: data.created_at,
      pushedAt: data.last_activity_at,
      commitCountEstimate: data.statistics?.commit_count,
      sizeKb: data.statistics?.repository_size ? Math.round(data.statistics.repository_size / 1024) : undefined,
    }
    await apiCache.set(cacheKey, info, 10 * 60 * 1000)
    return info
  }

  async loadCommitPage(repo: ParsedRepoUrl, options: LoadPageOptions): Promise<CommitPage> {
    const page = decodePageCursor(options.cursor)
    const perPage = clamp(options.limit)
    const url = `${joinUrl(this.apiBase(repo), 'projects', this.projectId(repo), 'repository', 'commits')}?${new URLSearchParams(
      {
        per_page: String(perPage),
        page: String(page),
        with_stats: 'true',
        ...(options.branch ? { ref_name: options.branch } : {}),
      },
    ).toString()}`

    const response = await requestJson<GlCommit[]>(url, {
      signal: options.signal,
      headers: this.headers(options.auth),
      onResponse: ({ rateLimit }) => this.report(options, rateLimit),
    })

    const items = Array.isArray(response.data) ? response.data : []
    const nextPageHeader = response.headers.get('x-next-page')
    const nextPage = nextPageHeader ? Number(nextPageHeader) : undefined
    const cursor: PageCursor | null = nextPage && nextPage > page ? encodePageCursor(nextPage) : null
    const totalPages = Number(response.headers.get('x-total-pages') ?? '') || undefined
    return {
      commits: items.map((item) => this.normalize(item)),
      next: cursor,
      totalCount: totalPages ? totalPages * perPage : undefined,
    }
  }

  async hydrateFiles(repo: ParsedRepoUrl, commits: RawCommit[], options: HydrateOptions): Promise<void> {
    const prefix = `gitlab:diff:${repo.params?.projectPath ?? `${repo.owner}/${repo.repo}`}:`
    const pending: RawCommit[] = []
    await Promise.all(
      commits.map(async (commit) => {
        const cached = await apiCache.get<RawCommit>(prefix + commit.sha)
        if (cached) {
          commit.files = cached.files
          commit.filesMissing = cached.filesMissing
          commit.stats = cached.stats ?? commit.stats
        } else {
          pending.push(commit)
        }
      }),
    )
    if (pending.length === 0) return

    let done = 0
    await mapConcurrent(
      pending,
      DETAIL_CONCURRENCY,
      async (commit) => {
        try {
          const response = await requestJson<GlDiff[]>(
            joinUrl(this.apiBase(repo), 'projects', this.projectId(repo), 'repository', 'commits', commit.sha, 'diff'),
            {
              signal: options.signal,
              headers: this.headers(options.auth),
              retries: 2,
              onResponse: ({ rateLimit }) => this.report(options, rateLimit),
            },
          )
          commit.files = (response.data ?? []).map<RawFileChange>((diff) => {
            const change: RawFileChange = {
              path: diff.new_path ?? diff.old_path,
              kind: diff.new_file ? 'add' : diff.deleted_file ? 'delete' : diff.renamed_file ? 'rename' : 'modify',
              additions: 0,
              deletions: 0,
            }
            if (diff.renamed_file && diff.old_path && diff.old_path !== diff.new_path) change.previousPath = diff.old_path
            if (diff.diff) countDiffLines(diff.diff, change)
            return change
          })
          if (commit.files.length === 0 && commit.isMerge) commit.filesMissing = 'merge-parents'
          else commit.filesMissing = undefined
          await apiCache.set(prefix + commit.sha, commit)
        } catch (error) {
          commit.files = null
          commit.filesMissing = error instanceof GitError && error.kind === 'rate-limit' ? 'rate-limit' : 'error'
        }
        done += 1
        options.onProgress?.({ requestCount: 1, authenticated: Boolean(options.auth?.token) })
      },
      { signal: options.signal },
    )
    void done
  }

  private normalize(item: GlCommit): RawCommit {
    const parents = item.parent_ids ?? []
    return {
      sha: item.id,
      parents,
      isMerge: parents.length > 1,
      timestamp: Date.parse(item.committed_date ?? item.authored_date ?? item.created_at ?? '') || 0,
      message: item.message ?? item.title ?? '',
      author: { name: item.author_name || 'Unknown author', email: item.author_email },
      files: null,
      filesMissing: 'not-requested',
      stats: item.stats ? { additions: item.stats.additions ?? 0, deletions: item.stats.deletions ?? 0 } : undefined,
    }
  }
}

function clamp(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 100
  return Math.max(1, Math.min(100, Math.floor(limit)))
}

/** Count added/removed lines in a unified diff, ignoring file headers. */
export function countDiffLines(diff: string, target: { additions: number; deletions: number }): void {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  target.additions = additions
  target.deletions = deletions
}

export { QUOTA_RESERVE }
