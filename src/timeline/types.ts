import type { FilesMissingReason, RepoInfo } from '../git/types'

/** Visual classification of a file change. */
export type ChangeKind = 'add' | 'modify' | 'delete' | 'rename'

export interface TimelineFileChange {
  /** Path after the change (new path for renames). */
  path: string
  /** Previous path for renames. */
  from?: string
  kind: ChangeKind
  additions: number
  deletions: number
}

/** An author identity as used by the visualization. */
export interface TimelineAuthor {
  /** Stable key: login > email > name. */
  id: string
  name: string
  email?: string
  login?: string
  avatarUrl?: string
  commits: number
  /** Epoch ms of the first and last commit by this author. */
  first: number
  last: number
  additions: number
  deletions: number
  /** Index used to pick a deterministic avatar colour/texture. */
  colorIndex: number
  /** True when the host could not resolve an account (name/email only). */
  unattributed: boolean
}

/** One commit, normalized for playback. */
export interface TimelineCommit {
  /** Position in the timeline (assigned by the builder, chronological). */
  index: number
  sha: string
  shortSha: string
  parents: string[]
  isMerge: boolean
  /** Epoch ms. */
  timestamp: number
  authorId: string
  message: string
  /** First line of the message. */
  subject: string
  /** Remaining lines, trimmed. */
  body: string
  changes: TimelineFileChange[]
  /** False when the provider could not deliver file changes for this commit. */
  filesKnown: boolean
  filesMissingReason?: FilesMissingReason
  /** True when the host truncated the file list (e.g. GitHub's 300 file cap). */
  filesTruncated: boolean
  /** Changed files reported by the host even when the list is truncated. */
  filesTotal?: number
  additions: number
  deletions: number
}

export interface ActivityBucket {
  /** Simulated start time of the bucket, in seconds. */
  t: number
  commits: number
  additions: number
  deletions: number
}

export interface TimelineStats {
  commits: number
  authors: number
  /** Distinct file paths touched anywhere in the loaded window. */
  files: number
  /** Distinct file and directory paths, used to size GPU buffers up front. */
  uniquePaths: { files: number; dirs: number }
  /** Files whose size is known from the host, and the total size of those. */
  filesWithSize: number
  totalBytes: number
  /** Largest file size in the loaded window (bytes), 0 when unknown. */
  largestFileBytes: number
  /** Where the sizes came from (`git-tree`, `synthetic`, or `unavailable`). */
  sizeSource: string
  /** Merge commits in the window. */
  merges: number
  /** Commits that arrived without file-level data. */
  withoutFileData: number
  additions: number
  deletions: number
  /** Epoch ms of the first and last commit. */
  start: number
  end: number
  /** Commits per simulated-time bucket, used by the timeline scrubber. */
  activity: ActivityBucket[]
  /** Busiest authors, most commits first. */
  topAuthors: TimelineAuthor[]
  /** File extension histogram (without the dot), most common first. */
  topExtensions: { extension: string; count: number }[]
}

/** The complete normalized history handed to the engine. */
export interface Timeline {
  repo: RepoInfo
  commits: TimelineCommit[]
  authors: TimelineAuthor[]
  authorById: Map<string, TimelineAuthor>
  stats: TimelineStats
  /** Host-reported file sizes for this snapshot (path → bytes). */
  fileSizes: Map<string, number>
  /** True when the host truncated the size listing. */
  sizesTruncated: boolean
  /** Non-fatal issues to show in the UI (quota, truncated history, ...). */
  warnings: string[]
  /** True when the history window is incomplete. */
  truncated: boolean
}

export function authorKey(parts: { login?: string; email?: string; name: string }): string {
  if (parts.login) return `login:${parts.login.toLowerCase()}`
  if (parts.email) return `email:${parts.email.toLowerCase()}`
  return `name:${parts.name.trim().toLowerCase()}`
}
