import type { RawCommit, RepoInfo } from '../git/types'
import {
  authorKey,
  type ActivityBucket,
  type Timeline,
  type TimelineAuthor,
  type TimelineCommit,
  type TimelineFileChange,
} from './types'

/**
 * Incremental timeline builder.
 *
 * Commits arrive in batches while the repository is still loading, so the
 * builder accepts commits at any time, keeps them chronologically sorted and
 * re-derives author statistics on demand. Ordering is deterministic: ties are
 * broken by SHA, never by arrival order.
 */
export class TimelineBuilder {
  private commits: TimelineCommit[] = []
  private authors = new Map<string, TimelineAuthor>()
  private seen = new Set<string>()
  private warnings: string[] = []
  private truncated = false
  private filePaths = new Set<string>()
  private dirPaths = new Set<string>()
  private extensions = new Map<string, number>()

  constructor(private readonly repo: Timeline['repo']) {}

  /** Add raw commits (any order). Returns the number of new commits added. */
  addCommits(raw: RawCommit[]): number {
    let added = 0
    for (const commit of raw) {
      if (this.seen.has(commit.sha)) continue
      this.seen.add(commit.sha)
      const timelineCommit = this.normalize(commit)
      this.commits.push(timelineCommit)
      this.trackAuthor(timelineCommit, commit)
      for (const change of timelineCommit.changes) {
        this.filePaths.add(change.path)
        // Record every ancestor directory so GPU buffers can be sized exactly.
        let cursor = change.path.lastIndexOf('/')
        while (cursor > 0) {
          const dir = change.path.slice(0, cursor)
          if (this.dirPaths.has(dir)) break
          this.dirPaths.add(dir)
          cursor = dir.lastIndexOf('/')
        }
        const extension = extensionOf(change.path)
        if (extension) this.extensions.set(extension, (this.extensions.get(extension) ?? 0) + 1)
      }
      added += 1
    }
    if (added > 0) this.sort()
    return added
  }

  addWarnings(messages: string[]): void {
    for (const message of messages) if (!this.warnings.includes(message)) this.warnings.push(message)
  }

  markTruncated(value: boolean): void {
    this.truncated = value
  }

  private sort(): void {
    this.commits.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
      return a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0
    })
    for (let index = 0; index < this.commits.length; index += 1) this.commits[index].index = index
  }

  private normalize(commit: RawCommit): TimelineCommit {
    const changes: TimelineFileChange[] = []
    for (const change of commit.files ?? []) {
      const path = change.path?.trim()
      if (!path) continue
      const mapped: TimelineFileChange = {
        path,
        kind: change.kind,
        additions: change.additions ?? 0,
        deletions: change.deletions ?? 0,
      }
      // A rename without a previous path is really a modification.
      if (change.kind === 'rename') {
        if (change.previousPath && change.previousPath !== path) mapped.from = change.previousPath
        else mapped.kind = 'modify'
      }
      changes.push(mapped)
    }

    const rawStats = commit.stats
    const additions = rawStats?.additions ?? changes.reduce((sum, change) => sum + change.additions, 0)
    const deletions = rawStats?.deletions ?? changes.reduce((sum, change) => sum + change.deletions, 0)

    const message = commit.message ?? ''
    const newline = message.indexOf('\n')
    const subject = (newline === -1 ? message : message.slice(0, newline)).trim() || '(no commit message)'
    const body = newline === -1 ? '' : message.slice(newline + 1).trim()

    return {
      index: 0,
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      parents: commit.parents,
      isMerge: Boolean(commit.isMerge ?? commit.parents.length > 1),
      timestamp: commit.timestamp,
      authorId: authorKey({ login: commit.author.login, email: commit.author.email, name: commit.author.name }),
      message,
      subject,
      body,
      changes,
      filesKnown: commit.files !== null,
      filesMissingReason: commit.files === null ? commit.filesMissing ?? 'not-requested' : undefined,
      filesTruncated: Boolean(commit.filesTruncated),
      filesTotal: commit.filesTotal,
      additions,
      deletions,
    }
  }

  private trackAuthor(commit: TimelineCommit, raw: RawCommit): void {
    const id = commit.authorId
    const existing = this.authors.get(id)
    if (existing) {
      existing.commits += 1
      existing.first = Math.min(existing.first, commit.timestamp)
      existing.last = Math.max(existing.last, commit.timestamp)
      existing.additions += commit.additions
      existing.deletions += commit.deletions
      if (!existing.avatarUrl && raw.author.avatarUrl) existing.avatarUrl = raw.author.avatarUrl
      if (!existing.email && raw.author.email) existing.email = raw.author.email
      if (!existing.login && raw.author.login) existing.login = raw.author.login
      return
    }
    this.authors.set(id, {
      id,
      name: raw.author.name || 'Unknown author',
      email: raw.author.email,
      login: raw.author.login,
      avatarUrl: raw.author.avatarUrl,
      commits: 1,
      first: commit.timestamp,
      last: commit.timestamp,
      additions: commit.additions,
      deletions: commit.deletions,
      colorIndex: this.authors.size,
      unattributed: !raw.author.login && !raw.author.email,
    })
  }

  /** Build the immutable timeline snapshot handed to the engine. */
  build(schedule?: (commits: TimelineCommit[]) => ActivityBucket[]): Timeline {
    const commits = this.commits.map((commit) => ({ ...commit, changes: [...commit.changes] }))
    const authors = [...this.authors.values()].sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name))
    const authorById = new Map(authors.map((author) => [author.id, author]))

    const activity = schedule ? schedule(commits) : bucketActivity(commits)
    const start = commits.length > 0 ? commits[0].timestamp : 0
    const end = commits.length > 0 ? commits[commits.length - 1].timestamp : 0

    return {
      repo: this.repo,
      commits,
      authors,
      authorById,
      warnings: [...this.warnings],
      truncated: this.truncated,
      stats: {
        commits: commits.length,
        authors: authors.length,
        files: this.filePaths.size,
        uniquePaths: { files: this.filePaths.size, dirs: this.dirPaths.size },
        merges: commits.filter((commit) => commit.isMerge).length,
        withoutFileData: commits.filter((commit) => !commit.filesKnown).length,
        additions: commits.reduce((sum, commit) => sum + commit.additions, 0),
        deletions: commits.reduce((sum, commit) => sum + commit.deletions, 0),
        start,
        end,
        activity,
        topAuthors: authors.slice(0, 12),
        topExtensions: [...this.extensions.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 12)
          .map(([extension, count]) => ({ extension, count })),
      },
    }
  }
}

/** Default activity bucketing over real time, used before a schedule exists. */
export function bucketActivity(commits: TimelineCommit[], buckets = 400): ActivityBucket[] {
  if (commits.length === 0) return []
  const start = commits[0].timestamp
  const end = commits[commits.length - 1].timestamp
  const span = Math.max(1, end - start)
  const result: ActivityBucket[] = Array.from({ length: buckets }, (_, index) => ({
    t: (index / buckets) * span,
    commits: 0,
    additions: 0,
    deletions: 0,
  }))
  for (const commit of commits) {
    const index = Math.min(buckets - 1, Math.floor(((commit.timestamp - start) / span) * buckets))
    const bucket = result[index]
    bucket.commits += 1
    bucket.additions += commit.additions
    bucket.deletions += commit.deletions
  }
  return result
}

export function extensionOf(path: string): string {
  const slash = path.lastIndexOf('/')
  const name = slash === -1 ? path : path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

export interface BuildTimelineOptions {
  /** Keep only commits matching this predicate (author/date filters). */
  filter?: (commit: RawCommit) => boolean
  truncated?: boolean
  warnings?: string[]
  /** Custom activity bucketing, e.g. based on a schedule in simulated time. */
  activity?: (commits: TimelineCommit[]) => ActivityBucket[]
}

/**
 * Build a complete {@link Timeline} from raw commits.
 *
 * Used both for the initial load and whenever filters change; rebuilding from
 * the raw commit set keeps filtering side-effect free and reproducible.
 */
export function buildTimeline(repo: RepoInfo, commits: readonly RawCommit[], options: BuildTimelineOptions = {}): Timeline {
  const builder = new TimelineBuilder(repo)
  const selected = options.filter ? commits.filter(options.filter) : commits
  builder.addCommits(selected as RawCommit[])
  builder.markTruncated(Boolean(options.truncated))
  if (options.warnings) builder.addWarnings(options.warnings)
  return builder.build(options.activity)
}
