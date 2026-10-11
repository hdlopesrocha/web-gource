import { GitError, isAbortError } from '../errors'
import { mergeRateLimit, requestJson, type RateLimitSnapshot } from '../http'
import { apiCache } from '../cache'
import { joinUrl } from '../url'
import { mapConcurrent } from '../pool'
import type {
  CommitPage,
  FileSizeResult,
  PageCursor,
  ProviderProgress,
  RawAuthor,
  RawCommit,
  RawFileChange,
  RepoInfo,
} from '../types'
import type { GitProvider, HydrateOptions, LoadPageOptions, ParsedRepoUrl, ProviderAuth } from './types'
import { decodePageCursor, encodePageCursor } from './types'

/* ------------------------------------------------------------------ *
 * GitHub REST API payload shapes (only the fields we consume).
 * ------------------------------------------------------------------ */

interface GhUser {
  login?: string
  avatar_url?: string
}

interface GhCommitListItem {
  sha: string
  commit: {
    author: { name?: string; email?: string; date?: string } | null
    committer: { name?: string; email?: string; date?: string } | null
    message?: string
  }
  author?: GhUser | null
  committer?: GhUser | null
  parents?: { sha: string }[]
}

interface GhFile {
  filename: string
  previous_filename?: string
  status: string
  additions?: number
  deletions?: number
}

interface GhCommitDetail extends GhCommitListItem {
  stats?: { additions?: number; deletions?: number; total?: number }
  files?: GhFile[]
}

interface GhTreeEntry {
  path: string
  mode?: string
  type: 'blob' | 'tree' | 'commit'
  size?: number
}

interface GhTree {
  sha: string
  truncated?: boolean
  tree?: GhTreeEntry[]
}

interface GhRepo {
  name: string
  full_name: string
  owner: { login: string }
  html_url: string
  description: string | null
  default_branch: string
  size?: number
  stargazers_count?: number
  language?: string | null
  private: boolean
  fork?: boolean
  pushed_at?: string
  created_at?: string
}

/** GitHub truncates the per-commit file list at 300 entries. */
export const GH_FILE_CAP = 300
/** Requests we always keep in reserve so the UI can still fetch metadata. */
export const QUOTA_RESERVE = 3

export interface GitHubProviderOptions {
  detailConcurrency?: number
}

function normalizeStatus(status: string): RawFileChange['kind'] {
  switch (status) {
    case 'added':
      return 'add'
    case 'removed':
      return 'delete'
    case 'renamed':
    case 'copied':
      return 'rename'
    default:
      return 'modify'
  }
}

function normalizeAuthor(
  user: GhUser | null | undefined,
  fallback: { name?: string; email?: string } | null | undefined,
): RawAuthor {
  return {
    name: user?.login || fallback?.name || 'Unknown author',
    email: fallback?.email,
    login: user?.login,
    avatarUrl: user?.avatar_url,
  }
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Parse a `Link` header and return the page number marked `rel="last"`. */
export function parseLastPage(linkHeader: string | null): number | undefined {
  if (!linkHeader) return undefined
  for (const part of linkHeader.split(',')) {
    if (!/rel="last"/.test(part)) continue
    const match = /[?&]page=(\d+)/.exec(part)
    if (match) return Number(match[1])
  }
  return undefined
}

function withQuery(url: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `${url}?${query}` : url
}

function clampPageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100
  return Math.max(1, Math.min(100, Math.floor(limit)))
}

/**
 * GitHub.com and GitHub Enterprise.
 *
 * Cost model: the commit list is cheap (1 request per 100 commits) while file
 * changes need one request per commit. Anonymous quota is 60 requests/hour, so
 * the loader budgets requests and the provider stops cleanly when the quota
 * runs out, flagging commits instead of failing the load.
 */
export class GitHubProvider implements GitProvider {
  readonly id = 'github'
  readonly name = 'GitHub'
  readonly supportsAnonymous = true
  readonly notes =
    'GitHub REST API. Commit lists are cheap; file changes cost one request per commit (anonymous quota: 60 requests/hour).'

  private readonly options: GitHubProviderOptions

  constructor(options: GitHubProviderOptions = {}) {
    this.options = options
  }

  private apiBase(repo: ParsedRepoUrl): string {
    return repo.params?.apiBase || 'https://api.github.com'
  }

  private headers(auth?: ProviderAuth): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    }
    const token = auth?.token?.trim()
    if (token) headers.authorization = `Bearer ${token}`
    return headers
  }

  parse(url: URL): ParsedRepoUrl | null {
    const host = url.hostname.toLowerCase()
    const isDotCom = host === 'github.com' || host === 'www.github.com'
    // Self-hosted GitHub Enterprise instances are conventionally named `github.*`.
    const isEnterprise = !isDotCom && host.includes('github')
    if (!isDotCom && !isEnterprise) return null

    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length < 2) return null
    return this.buildParsed(host, segments[0], segments[1], isEnterprise)
  }

  buildParsed(host: string, owner: string, repo: string, enterprise = false): ParsedRepoUrl {
    const cleanRepo = repo.replace(/\.git$/i, '')
    const params: Record<string, string> = {}
    if (enterprise) params.apiBase = `https://${host}/api/v3`
    return {
      providerId: this.id,
      owner,
      repo: cleanRepo,
      htmlUrl: `https://${host}/${owner}/${cleanRepo}`,
      host,
      params,
    }
  }

  commitUrl(repo: ParsedRepoUrl, sha: string): string {
    return `${repo.htmlUrl}/commit/${sha}`
  }

  async fetchRepoInfo(
    repo: ParsedRepoUrl,
    options: { signal?: AbortSignal; auth?: ProviderAuth } = {},
  ): Promise<RepoInfo> {
    const cacheKey = `github:repo:${repo.owner}/${repo.repo}`
    const cached = await apiCache.get<RepoInfo>(cacheKey)
    if (cached) return cached

    const response = await requestJson<GhRepo>(joinUrl(this.apiBase(repo), 'repos', repo.owner, repo.repo), {
      signal: options.signal,
      headers: this.headers(options.auth),
    })
    const data = response.data
    if (!data || typeof data !== 'object' || !data.name) {
      throw new GitError('unknown', `Unexpected repository metadata for ${repo.owner}/${repo.repo}.`)
    }
    const info: RepoInfo = {
      provider: this.id,
      owner: data.owner?.login ?? repo.owner,
      name: data.name,
      fullName: data.full_name,
      htmlUrl: data.html_url,
      description: data.description ?? undefined,
      defaultBranch: data.default_branch || 'main',
      sizeKb: data.size,
      stars: data.stargazers_count,
      language: data.language ?? undefined,
      isPrivate: Boolean(data.private),
      isFork: data.fork,
      pushedAt: data.pushed_at,
      createdAt: data.created_at,
    }
    await apiCache.set(cacheKey, info, 10 * 60 * 1000)
    return info
  }

  async loadCommitPage(repo: ParsedRepoUrl, options: LoadPageOptions): Promise<CommitPage> {
    const page = decodePageCursor(options.cursor)
    const perPage = clampPageSize(options.limit)
    const url = withQuery(joinUrl(this.apiBase(repo), 'repos', repo.owner, repo.repo, 'commits'), {
      per_page: perPage,
      page,
      sha: options.branch,
    })

    let response
    try {
      response = await requestJson<GhCommitListItem[]>(url, {
        signal: options.signal,
        headers: this.headers(options.auth),
        onResponse: ({ rateLimit }) => this.reportQuota(options, rateLimit),
      })
    } catch (error) {
      throw this.decorateListError(error, repo)
    }

    const items = Array.isArray(response.data) ? response.data : []
    const lastPage = parseLastPage(response.headers.get('link'))
    const commits = items.map((item) => this.normalizeListItem(item))
    const hasNext = lastPage !== undefined ? page < lastPage : items.length >= perPage
    const cursor: PageCursor | null = hasNext && items.length > 0 ? encodePageCursor(page + 1) : null
    return {
      commits,
      next: cursor,
      totalCount: lastPage !== undefined ? lastPage * perPage : undefined,
    }
  }

  /** Jump straight to the oldest page of history (2 requests at most). */
  async loadEarliestPage(repo: ParsedRepoUrl, options: LoadPageOptions): Promise<CommitPage> {
    const perPage = clampPageSize(options.limit)
    const build = (page: number) =>
      withQuery(joinUrl(this.apiBase(repo), 'repos', repo.owner, repo.repo, 'commits'), {
        per_page: perPage,
        page,
        sha: options.branch,
      })

    const first = await requestJson<GhCommitListItem[]>(build(1), {
      signal: options.signal,
      headers: this.headers(options.auth),
      onResponse: ({ rateLimit }) => this.reportQuota(options, rateLimit),
    })
    const lastPage = parseLastPage(first.headers.get('link')) ?? 1
    const response =
      lastPage === 1
        ? first
        : await requestJson<GhCommitListItem[]>(build(lastPage), {
            signal: options.signal,
            headers: this.headers(options.auth),
            onResponse: ({ rateLimit }) => this.reportQuota(options, rateLimit),
          })

    const items = Array.isArray(response.data) ? response.data : []
    return {
      commits: items.map((item) => this.normalizeListItem(item)),
      next: lastPage > 1 ? encodePageCursor(lastPage - 1) : null,
      totalCount: lastPage * perPage,
    }
  }

  /**
   * File sizes for one snapshot of the repository.
   *
   * GitHub returns the whole recursive tree (with blob sizes) in a single
   * request, which is why circle sizes can be based on real file sizes without
   * spending one request per file.
   */
  async fetchFileSizes(
    repo: ParsedRepoUrl,
    options: { ref?: string; signal?: AbortSignal; auth?: ProviderAuth } = {},
  ): Promise<FileSizeResult | null> {
    const ref = options.ref?.trim()
    if (!ref) return null
    const cacheKey = `github:sizes:${repo.owner}/${repo.repo}:${ref}`
    const cached = await apiCache.get<FileSizeResult>(cacheKey)
    if (cached) return cached

    const url = withQuery(joinUrl(this.apiBase(repo), 'repos', repo.owner, repo.repo, 'git', 'trees', ref), {
      recursive: 1,
    })
    const response = await requestJson<GhTree>(url, {
      signal: options.signal,
      headers: this.headers(options.auth),
      retries: 1,
      // A missing tree (empty repository, unusual ref) simply means "no sizes".
      allow404: true,
    })
    if (response.status === 404 || !response.data) return null
    const sizes = new Map<string, number>()
    for (const entry of response.data?.tree ?? []) {
      if (entry.type !== 'blob' || typeof entry.size !== 'number') continue
      sizes.set(entry.path, entry.size)
    }
    if (sizes.size === 0) return null
    const result: FileSizeResult = {
      sizes,
      truncated: Boolean(response.data?.truncated),
      source: 'git-tree',
    }
    // Sizes for a commit are immutable, so this can be cached for a long time.
    await apiCache.set(cacheKey, result, 30 * 60 * 1000)
    return result
  }

  async hydrateFiles(repo: ParsedRepoUrl, commits: RawCommit[], options: HydrateOptions): Promise<void> {
    const cachePrefix = `github:commit:${repo.owner}/${repo.repo}:`
    const base = this.apiBase(repo)
    const concurrency = this.options.detailConcurrency ?? 6

    // Cache first: hydration is free for commits we have seen before.
    const pending: RawCommit[] = []
    await Promise.all(
      commits.map(async (commit) => {
        const cached = await apiCache.get<RawCommit>(cachePrefix + commit.sha)
        if (cached) {
          commit.files = cached.files
          commit.filesMissing = cached.filesMissing
          commit.filesTruncated = cached.filesTruncated
          commit.filesTotal = cached.filesTotal
          commit.stats = cached.stats ?? commit.stats
        } else {
          pending.push(commit)
        }
      }),
    )
    if (pending.length === 0) return

    let quotaHit = false

    await mapConcurrent(
      pending,
      concurrency,
      async (commit) => {
        if (quotaHit) {
          commit.files = null
          commit.filesMissing = 'rate-limit'
          return
        }
        try {
          const response = await requestJson<GhCommitDetail>(
            joinUrl(base, 'repos', repo.owner, repo.repo, 'commits', commit.sha),
            {
              signal: options.signal,
              headers: this.headers(options.auth),
              retries: 2,
              onResponse: ({ rateLimit }) => {
                // Every request is reported exactly once, here.
                this.reportQuota(options, rateLimit)
                if (rateLimit.remaining !== undefined && rateLimit.remaining <= QUOTA_RESERVE) quotaHit = true
              },
            },
          )
          this.attachFiles(commit, response.data)
          await apiCache.set(cachePrefix + commit.sha, commit)
        } catch (error) {
          if (isAbortError(error)) throw error
          commit.files = null
          commit.filesMissing = error instanceof GitError && error.kind === 'rate-limit' ? 'rate-limit' : 'error'
          if (commit.filesMissing === 'rate-limit') quotaHit = true
        }
      },
      { signal: options.signal },
    )
  }

  private reportQuota(options: { onProgress?: (progress: ProviderProgress) => void }, snapshot: RateLimitSnapshot): void {
    if (!options.onProgress) return
    const progress = mergeRateLimit({ requestCount: 1, authenticated: false }, snapshot)
    options.onProgress(progress)
  }

  private normalizeListItem(item: GhCommitListItem): RawCommit {
    const parents = (item.parents ?? []).map((parent) => parent.sha)
    return {
      sha: item.sha,
      parents,
      isMerge: parents.length > 1,
      timestamp: parseTimestamp(item.commit?.author?.date ?? item.commit?.committer?.date),
      message: item.commit?.message ?? '',
      author: normalizeAuthor(item.author, item.commit?.author ?? item.commit?.committer),
      committer: normalizeAuthor(item.committer, item.commit?.committer),
      files: null,
      filesMissing: 'not-requested',
    }
  }

  private attachFiles(commit: RawCommit, detail: GhCommitDetail): void {
    const files = detail.files
    if (detail.stats) {
      commit.stats = { additions: detail.stats.additions ?? 0, deletions: detail.stats.deletions ?? 0 }
    }
    if (!files || files.length === 0) {
      commit.files = []
      // A merge commit is frequently reported without a file list.
      if (commit.isMerge) commit.filesMissing = 'merge-parents'
      return
    }
    commit.files = files.map<RawFileChange>((file) => {
      const change: RawFileChange = {
        path: file.filename,
        kind: normalizeStatus(file.status),
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      }
      if (file.previous_filename) change.previousPath = file.previous_filename
      return change
    })
    commit.filesMissing = undefined
    if (files.length >= GH_FILE_CAP) commit.filesTruncated = true
  }

  private decorateListError(error: unknown, repo: ParsedRepoUrl): unknown {
    if (error instanceof GitError && error.status === 409) {
      return new GitError('unsupported', `${repo.owner}/${repo.repo} is an empty repository: it has no commits yet.`, {
        status: 409,
      })
    }
    return error
  }
}
