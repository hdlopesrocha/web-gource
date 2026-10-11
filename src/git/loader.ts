import { GitError, isAbortError } from './errors'
import { authFor, type ResolvedRepo } from './providers'
import { QUOTA_RESERVE } from './providers/github'
import type { GitProvider, ParsedRepoUrl, ProviderAuth } from './providers/types'
import type { ProviderProgress, RawCommit, RepoInfo } from './types'

/**
 * Which slice of history to load. Large repositories cannot be fetched
 * completely within an API quota, so the user picks a window and the loader
 * stops gracefully when the budget runs out.
 */
export type HistoryRange = 'latest' | 'earliest'

export interface LoadOptions {
  /** Maximum number of commits to load (the snapshot size). */
  maxCommits: number
  /** Which end of the history to start from. */
  range: HistoryRange
  branch?: string
  /** Optional personal access token. */
  token?: string
  /** Called as data arrives so the UI can render progressive results. */
  onStage?: (stage: LoadStage) => void
  /** Called with repository metadata before any commit is fetched. */
  onRepo?: (repo: RepoInfo) => void
  /**
   * Called as soon as file sizes are known, so the visualization can size its
   * circles while the file changes are still being hydrated.
   */
  onFileSizes?: (info: { fileSizes: Map<string, number>; truncated: boolean; source: string }) => void
  /** Called with chronologically ordered commits, oldest batch first. */
  onCommits?: (commits: RawCommit[]) => void
  signal?: AbortSignal
}

export type LoadStage =
  | { kind: 'info'; status: string }
  | {
      kind: 'fetching'
      status: string
      loaded: number
      target: number
      requests: number
      rateRemaining?: number
    }
  | { kind: 'done'; status: string; loaded: number; requests: number; truncated: boolean }

export interface LoadResult {
  provider: GitProvider
  parsed: ParsedRepoUrl
  repo: RepoInfo
  /** Chronologically ordered (oldest first). */
  commits: RawCommit[]
  /** Host-reported file sizes for the newest commit in the window. */
  fileSizes: Map<string, number>
  sizesTruncated: boolean
  sizeSource: string
  /** True when the whole requested window was retrieved. */
  complete: boolean
  /** True when older history exists beyond the loaded window. */
  truncated: boolean
  requestCount: number
  warnings: string[]
  rateRemaining?: number
  /** Commits that still miss file level data, with the reason. */
  missingFiles: number
}

/** How many commits are hydrated between playback updates. */
const HYDRATE_BATCH = 10

/** Read the page number out of a `pN` cursor (0 when it is not a page cursor). */
function decodeCursorPage(cursor: string): number {
  const match = /^p(\d+)$/.exec(cursor)
  return match ? Number(match[1]) : 0
}

/**
 * Load repository history as a chronologically ordered window of commits.
 *
 * The three phases are deliberately separate so the UI can start rendering as
 * early as possible and so errors stay attributable:
 *  1. repository metadata (1 request);
 *  2. cheap commit-list pages until the window is filled;
 *  3. file-level hydration in small oldest-first batches. Each batch is
 *     emitted immediately, so the visualization can start mid-load.
 *
 * Quota exhaustion is not an error: whatever was fetched is kept and the gaps
 * are reported through `warnings` / `missingFiles`.
 */
export async function loadHistory(resolved: ResolvedRepo, options: LoadOptions): Promise<LoadResult> {
  const { provider, parsed } = resolved
  const auth: ProviderAuth = authFor(provider.id, options.token)
  const warnings: string[] = []
  let requestCount = 0
  let rateRemaining: number | undefined

  const emitStage = (stage: LoadStage) => options.onStage?.(stage)
  const trackProgress = (progress: ProviderProgress) => {
    requestCount += progress.requestCount
    if (progress.rateRemaining !== undefined) rateRemaining = progress.rateRemaining
  }

  emitStage({ kind: 'info', status: `Requesting repository metadata from ${provider.name}…` })
  const repo = await provider.fetchRepoInfo(parsed, { signal: options.signal, auth })
  if (repo.isPrivate) {
    warnings.push('This repository is private: only the history visible to your token is loaded.')
  }
  // Report metadata immediately: the UI can then show the repository and start
  // building the timeline as soon as the first commits arrive.
  options.onRepo?.(repo)

  const target = Math.max(1, Math.floor(options.maxCommits))
  const collected: RawCommit[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  let totalCount: number | undefined
  let exhausted = false
  let walkComplete = false

  const collect = (commits: RawCommit[]): number => {
    let added = 0
    for (const commit of commits) {
      if (seen.has(commit.sha)) continue
      seen.add(commit.sha)
      collected.push(commit)
      added += 1
    }
    return added
  }

  const earliest = options.range === 'earliest'

  if (earliest) {
    // Start at the first page of history, then walk page numbers *downwards*
    // (the provider's `next` cursor normally points at newer pages, which is
    // the opposite of what "from the first commit" needs).
    emitStage({ kind: 'info', status: 'Locating the first commits of the repository…' })
    const page = provider.loadEarliestPage
      ? await provider.loadEarliestPage(parsed, { auth, signal: options.signal, limit: 100, onProgress: trackProgress })
      : await provider.loadCommitPage(parsed, { auth, signal: options.signal, limit: 100, onProgress: trackProgress })
    collect(page.commits)
    totalCount = page.totalCount
    cursor = page.next ?? undefined
    walkComplete = cursor === undefined
  }

  emitStage({
    kind: 'fetching',
    status: 'Fetching commit list…',
    loaded: 0,
    target,
    requests: requestCount,
    rateRemaining,
  })

  while (collected.length < target) {
    if (options.signal?.aborted) throw new GitError('aborted', 'Loading cancelled')

    if (earliest) {
      const pageNumber = cursor ? decodeCursorPage(cursor) : undefined
      if (pageNumber === undefined || pageNumber < 1) {
        walkComplete = true
        break
      }
      const page = await provider.loadCommitPage(parsed, {
        auth,
        signal: options.signal,
        cursor: `p${pageNumber}`,
        branch: options.branch,
        // Full pages keep the collected range contiguous from the first commit.
        limit: 100,
        onProgress: trackProgress,
      })
      const added = collect(page.commits)
      totalCount = page.totalCount ?? totalCount
      cursor = pageNumber > 1 ? `p${pageNumber - 1}` : undefined
      if (cursor === undefined) walkComplete = true
      if (added === 0 && page.commits.length === 0) break
    } else {
      if (exhausted) break
      const page = await provider.loadCommitPage(parsed, {
        auth,
        signal: options.signal,
        cursor,
        branch: options.branch,
        // Always request full pages: page numbers only line up when the page
        // size is consistent across requests. The window is trimmed afterwards.
        limit: 100,
        onProgress: trackProgress,
      })
      totalCount = page.totalCount ?? totalCount
      const added = collect(page.commits)
      cursor = page.next ?? undefined
      exhausted = page.next === null
      if (added === 0) break
    }

    emitStage({
      kind: 'fetching',
      status: `Fetching commit list… ${collected.length} commits`,
      loaded: collected.length,
      target: Math.min(target, Math.max(collected.length, totalCount ?? target)),
      requests: requestCount,
      rateRemaining,
    })
  }

  if (earliest && cursor === undefined) walkComplete = true

  if (collected.length === 0) {
    throw new GitError('unsupported', 'This repository has no commits to visualize.')
  }

  // Providers return each page newest-first and the "earliest" mode walks pages
  // backwards, so sort everything: the buffer order is not chronological.
  const ordered = [...collected].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
    return a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0
  })
  const window = earliest ? ordered.slice(0, target) : ordered.slice(-target)

  const historyExhausted = earliest ? walkComplete && collected.length <= window.length : exhausted && collected.length <= window.length
  const hasOlderHistory = earliest ? !walkComplete : !historyExhausted
  if (hasOlderHistory) {
    const known = totalCount !== undefined ? ` of roughly ${totalCount}` : ''
    warnings.push(
      `Showing ${earliest ? 'the first' : 'the newest'} ${window.length}${known} commits. ` +
        'Increase the snapshot size, pick a different range, or add a token for more history.',
    )
  }

  // ---- File sizes (one cheap request) ------------------------------------
  let fileSizes = new Map<string, number>()
  let sizesTruncated = false
  let sizeSource = 'unavailable'
  const newestSha = window[window.length - 1]?.sha
  const quotaTight = rateRemaining !== undefined && rateRemaining <= QUOTA_RESERVE
  if (provider.fetchFileSizes && newestSha && !quotaTight) {
    emitStage({
      kind: 'info',
      status: 'Fetching file sizes for circle sizing…',
    })
    try {
      const sizes = await provider.fetchFileSizes(parsed, {
        ref: options.branch || newestSha,
        signal: options.signal,
        auth,
      })
      if (sizes && sizes.sizes.size > 0) {
        fileSizes = sizes.sizes
        sizesTruncated = sizes.truncated
        sizeSource = sizes.source
        requestCount += 1
        options.onFileSizes?.({ fileSizes, truncated: sizesTruncated, source: sizeSource })
        if (sizes.truncated) {
          warnings.push(
            'The host truncated the file listing, so some circles use line activity instead of the real file size.',
          )
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      warnings.push(
        `File sizes could not be fetched (${(error as Error).message}); circles are sized by line activity instead.`,
      )
    }
  } else if (provider.fetchFileSizes && quotaTight) {
    warnings.push(
      'File sizes were skipped because the API quota was nearly exhausted; circles are sized by line activity instead.',
    )
  }

  // ---- File-level hydration, oldest first, emitted in batches -------------
  let missingFiles = 0
  let stoppedHydrating = false

  for (let index = 0; index < window.length; index += HYDRATE_BATCH) {
    const batch = window.slice(index, index + HYDRATE_BATCH)
    const needsHydration = batch.some((commit) => commit.files === null)
    if (stoppedHydrating) {
      for (const commit of batch) {
        if (commit.files === null) commit.filesMissing = commit.filesMissing ?? 'rate-limit'
      }
      missingFiles += batch.filter((commit) => commit.files === null).length
      options.onCommits?.(batch)
      continue
    }

    if (needsHydration) {
      try {
        await provider.hydrateFiles(parsed, batch, { auth, signal: options.signal, onProgress: trackProgress })
      } catch (error) {
        if (isAbortError(error)) throw error
        for (const commit of batch) {
          if (commit.files === null) commit.filesMissing = commit.filesMissing ?? 'error'
        }
        warnings.push(
          `File change data stopped at commit ${index + 1}: ${(error as Error).message}. ` +
            'The visualization continues with the commits already loaded.',
        )
        stoppedHydrating = true
      }
    }

    const batchMissing = batch.filter((commit) => commit.files === null).length
    missingFiles += batchMissing
    if (batchMissing > 0) {
      const rateLimited = batch.some((commit) => commit.filesMissing === 'rate-limit')
      if (rateLimited) {
        stoppedHydrating = true
        warnings.push(
          'API quota exhausted: remaining commits are loaded without file changes. ' +
            'Add a personal access token in Settings and reload — cached commits are reused.',
        )
      }
    }

    const loadedCount = Math.min(index + HYDRATE_BATCH, window.length)
    emitStage({
      kind: 'fetching',
      status: `Loading file changes ${loadedCount}/${window.length}…`,
      loaded: loadedCount,
      target: window.length,
      requests: requestCount,
      rateRemaining,
    })
    options.onCommits?.(batch)
  }

  const result: LoadResult = {
    provider,
    parsed,
    repo,
    commits: window,
    fileSizes,
    sizesTruncated,
    sizeSource,
    complete: !hasOlderHistory,
    truncated: hasOlderHistory,
    requestCount,
    warnings,
    rateRemaining,
    missingFiles,
  }
  emitStage({
    kind: 'done',
    status: 'Ready',
    loaded: window.length,
    requests: requestCount,
    truncated: hasOlderHistory,
  })
  return result
}
