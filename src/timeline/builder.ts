import type { RawCommit, RawFileChange, RepoInfo } from '../git/types'
import {
  authorKey,
  projectPath,
  scopedAuthorId,
  type ActivityBucket,
  type Timeline,
  type TimelineAuthor,
  type TimelineCommit,
  type TimelineFileChange,
  type TimelineProject,
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
  /** Avatars keep their colour across projects: base identity → colour index. */
  private baseColors = new Map<string, number>()

  constructor(private readonly repo: Timeline['repo']) {}

  /** Add raw commits (any order). Returns the number of new commits added. */
  addCommits(raw: RawCommit[]): number {
    let added = 0
    for (const commit of raw) {
      // The same SHA can exist in two projects (forks, mirrors): dedupe per project.
      const seenKey = commit.projectKey ? `${commit.projectKey}\u0000${commit.sha}` : commit.sha
      if (this.seen.has(seenKey)) continue
      this.seen.add(seenKey)
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
      // Stable across projects: the project key breaks ties when two projects
      // share a SHA or commit exactly at the same instant.
      const projectA = a.projectKey ?? ''
      const projectB = b.projectKey ?? ''
      if (projectA !== projectB) return projectA < projectB ? -1 : 1
      return a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0
    })
    for (let index = 0; index < this.commits.length; index += 1) this.commits[index].index = index
  }

  private normalize(commit: RawCommit): TimelineCommit {
    const projectKey = commit.projectKey?.trim() || undefined
    const projectName = commit.projectName?.trim() || projectKey
    const changes: TimelineFileChange[] = []
    for (const change of commit.files ?? []) {
      const path = change.path?.trim()
      if (!path) continue
      const mapped: TimelineFileChange = {
        // Namespacing paths here means every downstream consumer (layout,
        // nodes, beams, labels, sizes) gets project separation for free.
        path: projectPath(projectKey, path),
        kind: change.kind,
        additions: change.additions ?? 0,
        deletions: change.deletions ?? 0,
      }
      // A rename without a previous path is really a modification.
      if (change.kind === 'rename') {
        if (change.previousPath && change.previousPath !== path) {
          mapped.from = projectPath(projectKey, change.previousPath)
        } else {
          mapped.kind = 'modify'
        }
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
      projectKey,
      projectName,
      shortSha: commit.sha.slice(0, 7),
      parents: commit.parents,
      isMerge: Boolean(commit.isMerge ?? commit.parents.length > 1),
      timestamp: commit.timestamp,
      authorId: scopedAuthorId(
        projectKey,
        authorKey({ login: commit.author.login, email: commit.author.email, name: commit.author.name }),
      ),
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
    const baseId = authorKey({ login: raw.author.login, email: raw.author.email, name: raw.author.name })
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
    // The same person keeps the same colour in every project they appear in,
    // while remaining a separate node and stats row per project.
    let colorIndex = this.baseColors.get(baseId)
    if (colorIndex === undefined) {
      colorIndex = this.baseColors.size
      this.baseColors.set(baseId, colorIndex)
    }
    this.authors.set(id, {
      id,
      baseId,
      projectKey: commit.projectKey,
      projectName: commit.projectName,
      name: raw.author.name || 'Unknown author',
      email: raw.author.email,
      login: raw.author.login,
      avatarUrl: raw.author.avatarUrl,
      commits: 1,
      first: commit.timestamp,
      last: commit.timestamp,
      additions: commit.additions,
      deletions: commit.deletions,
      colorIndex,
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
      projects: [],
      commits,
      authors,
      authorById,
      fileSizes: new Map<string, number>(),
      sizesTruncated: false,
      warnings: [...this.warnings],
      truncated: this.truncated,
      stats: {
        commits: commits.length,
        authors: authors.length,
        files: this.filePaths.size,
        uniquePaths: { files: this.filePaths.size, dirs: this.dirPaths.size },
        filesWithSize: 0,
        totalBytes: 0,
        largestFileBytes: 0,
        sizeSource: 'unavailable',
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

/** Project metadata supplied by the loader (counts are derived after filtering). */
export interface TimelineProjectInput {
  key: string
  repo: RepoInfo
  truncated?: boolean
  warnings?: string[]
  sizeSource?: string
}

export interface BuildTimelineOptions {
  /** Keep only commits matching this predicate (author/date filters). */
  filter?: (commit: RawCommit) => boolean
  /**
   * Drop individual file changes whose path matches (the folder ignore list).
   * A commit keeps its other changes, its message and its author; a rename whose
   * *new* path is ignored disappears, and one that moves a file *out* of an
   * ignored folder is kept as an addition.
   */
  fileFilter?: (path: string) => boolean
  truncated?: boolean
  warnings?: string[]
  /** Host-reported file sizes for this snapshot. */
  fileSizes?: Map<string, number>
  sizesTruncated?: boolean
  sizeSource?: string
  /** Custom activity bucketing, e.g. based on a schedule in simulated time. */
  activity?: (commits: TimelineCommit[]) => ActivityBucket[]
  /** Projects loaded in this run, in load order. */
  projects?: TimelineProjectInput[]
}

/**
 * Build a complete {@link Timeline} from raw commits.
 *
 * Used both for the initial load and whenever filters change; rebuilding from
 * the raw commit set keeps filtering side-effect free and reproducible.
 */
export function buildTimeline(repo: RepoInfo, commits: readonly RawCommit[], options: BuildTimelineOptions = {}): Timeline {
  const builder = new TimelineBuilder(repo)
  let selected = options.filter ? commits.filter(options.filter) : (commits as RawCommit[])
  let ignoredFileChanges = 0
  const ignoredPaths = new Set<string>()
  if (options.fileFilter) {
    const filtered: RawCommit[] = []
    for (const commit of selected) {
      const result = filterCommitFiles(commit, options.fileFilter)
      if (result.dropped > 0) {
        ignoredFileChanges += result.dropped
        for (const path of result.ignoredPaths) ignoredPaths.add(path)
      }
      filtered.push(result.commit)
    }
    selected = filtered
  }
  builder.addCommits(selected)
  builder.markTruncated(Boolean(options.truncated))
  if (options.warnings) builder.addWarnings(options.warnings)
  const timeline = builder.build(options.activity)
  if (options.projects) {
    // Counts are derived from the filtered commits, so the project list in the
    // UI always agrees with the statistics above it.
    const perProject = new Map<string, { commits: number; authors: Set<string> }>()
    for (const commit of timeline.commits) {
      const key = commit.projectKey ?? ''
      let entry = perProject.get(key)
      if (!entry) {
        entry = { commits: 0, authors: new Set() }
        perProject.set(key, entry)
      }
      entry.commits += 1
      entry.authors.add(commit.authorId)
    }
    timeline.projects = options.projects.map((project): TimelineProject => {
      const entry = perProject.get(project.key)
      return {
        key: project.key,
        repo: project.repo,
        commits: entry?.commits ?? 0,
        authors: entry?.authors.size ?? 0,
        truncated: Boolean(project.truncated),
        warnings: project.warnings ?? [],
        sizeSource: project.sizeSource ?? 'unavailable',
      }
    })
  }
  const fileSizes = options.fileSizes ?? new Map<string, number>()
  timeline.fileSizes = fileSizes
  if (fileSizes.size > 0) {
    for (const commit of timeline.commits) {
      for (const change of commit.changes) {
        const size = fileSizes.get(change.path)
        if (size !== undefined) change.sizeBytes = size
      }
    }
  }
  timeline.sizesTruncated = Boolean(options.sizesTruncated)
  timeline.stats.sizeSource = options.sizeSource ?? (fileSizes.size > 0 ? 'unknown' : 'unavailable')

  // Size statistics only cover files that actually appear in the loaded window.
  const touched = new Set<string>()
  for (const commit of timeline.commits) {
    for (const change of commit.changes) touched.add(change.path)
  }
  let filesWithSize = 0
  let totalBytes = 0
  let largestFileBytes = 0
  for (const path of touched) {
    const bytes = fileSizes.get(path)
    if (bytes === undefined) continue
    filesWithSize += 1
    totalBytes += bytes
    if (bytes > largestFileBytes) largestFileBytes = bytes
  }
  timeline.stats.filesWithSize = filesWithSize
  timeline.stats.totalBytes = totalBytes
  timeline.stats.largestFileBytes = largestFileBytes
  if (options.fileFilter) {
    timeline.stats.ignoredFileChanges = ignoredFileChanges
    timeline.stats.ignoredFiles = ignoredPaths.size
  }
  return timeline
}

/**
 * Drop the file changes of one commit that the ignore list matches.
 *
 * The commit itself is kept (its author and message are still part of history),
 * and its additions/deletions are recomputed from the changes that remain, so
 * the counters never include ignored folders.
 */
function filterCommitFiles(
  commit: RawCommit,
  ignore: (path: string) => boolean,
): { commit: RawCommit; dropped: number; ignoredPaths: string[] } {
  if (!commit.files || commit.files.length === 0) return { commit, dropped: 0, ignoredPaths: [] }
  const kept: RawFileChange[] = []
  const ignoredPaths: string[] = []
  let dropped = 0
  let rewritten = false
  for (const file of commit.files) {
    const path = file.path?.trim()
    if (!path) continue
    if (ignore(path)) {
      dropped += 1
      ignoredPaths.push(path)
      continue
    }
    // A rename out of an ignored folder reads as an addition of the new path.
    if (file.previousPath && ignore(file.previousPath)) {
      // The old path is hidden, so the rename cannot be followed: the file
      // simply appears at its new path.
      kept.push({ ...file, previousPath: undefined, kind: file.kind === 'rename' ? 'add' : file.kind })
      rewritten = true
      continue
    }
    kept.push(file)
  }
  if (dropped === 0 && !rewritten) return { commit, dropped: 0, ignoredPaths: [] }
  const additions = kept.reduce((sum, file) => sum + file.additions, 0)
  const deletions = kept.reduce((sum, file) => sum + file.deletions, 0)
  return {
    commit: dropped > 0 ? { ...commit, files: kept, stats: { additions, deletions } } : { ...commit, files: kept },
    dropped,
    ignoredPaths,
  }
}
