import type { ActivityBucket, TimelineCommit } from './types'

/**
 * Deterministic playback schedule.
 *
 * Gource-style playback compresses idle time: a repository whose commits are
 * days apart should not take days to watch, but quiet periods should still feel
 * longer than a burst of activity. The model follows Gource's "seconds per day"
 * idea with two safety nets:
 *
 *   gapTime_i = min(secondsPerDay * gapDays_i, maxGapSeconds)
 *   step_i    = minSpacing + min(gapTime_i, remainingIdleBudget)
 *
 * Three properties make this a good fit for streaming loads:
 *  - the formula is *local* (it only depends on the gap between neighbours), so
 *    appending newer commits never changes the times of earlier commits;
 *  - a single long silence is capped, so one quiet year cannot dominate;
 *  - total idle time is bounded by `idleBudget`, so the runtime stays sane for
 *    histories with thousands of long gaps.
 *
 * Everything derives from the commit list and the options, so the same history
 * with the same settings always produces exactly the same schedule.
 */
export interface ScheduleOptions {
  /** Minimum simulated seconds between consecutive commits. */
  minSpacing: number
  /** Simulated seconds per real day of idle time (Gource's seconds-per-day). */
  secondsPerDay: number
  /** Maximum simulated seconds a single gap may contribute. */
  maxGapSeconds: number
  /** Total simulated seconds that may be spent on gaps. */
  idleBudget: number
  /** Extra simulated seconds appended after the last commit. */
  tail: number
}

export const DEFAULT_SCHEDULE_OPTIONS: ScheduleOptions = {
  minSpacing: 0.26,
  secondsPerDay: 0.35,
  maxGapSeconds: 12,
  idleBudget: 240,
  tail: 2.4,
}

const DAY_SECONDS = 86_400

export interface Schedule {
  options: ScheduleOptions
  /** Simulated time (seconds, ascending) at which each commit is applied. */
  readonly times: Float64Array
  /** Real commit timestamps (epoch ms) aligned with `times`. */
  readonly realTimes: Float64Array
  /** Simulated duration in seconds. */
  duration: number
  /** Commit count. */
  count: number
  realStart: number
  realEnd: number
  /** Idle budget already spent (kept so extensions stay consistent). */
  idleUsed: number
  /** Index of the last commit applied at or before simulated time `t`. */
  indexAt(t: number): number
  /** Interpolated real timestamp (epoch ms) at simulated time `t`. */
  realTimeAt(t: number): number
  /** Inverse of {@link realTimeAt}. */
  simTimeAtRealTime(ms: number): number
  /** Activity histogram in simulated time, for the scrubber. */
  activity(buckets: number, commits: readonly TimelineCommit[]): ActivityBucket[]
}

/**
 * Build a schedule.
 *
 * When `previous` is supplied and the new commit list extends it with the exact
 * same prefix (the incremental loading case), the existing times are reused and
 * only the new commits are scheduled. Otherwise everything is recomputed.
 */
export function buildSchedule(
  commits: readonly TimelineCommit[],
  overrides: Partial<ScheduleOptions> = {},
  previous?: Schedule,
): Schedule {
  const options: ScheduleOptions = { ...DEFAULT_SCHEDULE_OPTIONS, ...(previous?.options ?? {}), ...overrides }
  const count = commits.length
  const canExtend =
    previous !== undefined &&
    previous.count > 0 &&
    count > previous.count &&
    samePrefix(commits, previous, previous.count) &&
    previous.options.minSpacing === options.minSpacing &&
    previous.options.secondsPerDay === options.secondsPerDay &&
    previous.options.maxGapSeconds === options.maxGapSeconds &&
    previous.options.idleBudget === options.idleBudget

  const times = new Float64Array(count)
  const realTimes = new Float64Array(count)
  let t = 0
  let idleUsed = 0
  const startIndex = canExtend ? previous.count : 0

  if (canExtend) {
    times.set(previous.times.subarray(0, previous.count))
    realTimes.set(previous.realTimes.subarray(0, previous.count))
    t = previous.times[previous.count - 1]
    idleUsed = previous.idleUsed
  }

  for (let index = startIndex; index < count; index += 1) {
    realTimes[index] = commits[index].timestamp
    if (index > 0) {
      const gapSeconds = Math.max(0, (commits[index].timestamp - commits[index - 1].timestamp) / 1000)
      const gapDays = gapSeconds / DAY_SECONDS
      const compressed = Math.min(gapDays * options.secondsPerDay, options.maxGapSeconds)
      const contribution = Math.max(0, Math.min(compressed, options.idleBudget - idleUsed))
      idleUsed += contribution
      t += options.minSpacing + contribution
    }
    times[index] = t
  }

  const duration = count > 0 ? t + options.tail : 0
  return makeSchedule(options, times, realTimes, duration, count, idleUsed)
}

function samePrefix(commits: readonly TimelineCommit[], previous: Schedule, length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (commits[index]?.timestamp !== previous.realTimes[index]) return false
  }
  return true
}

function makeSchedule(
  options: ScheduleOptions,
  times: Float64Array,
  realTimes: Float64Array,
  duration: number,
  count: number,
  idleUsed: number,
): Schedule {
  const realStart = count > 0 ? realTimes[0] : 0
  const realEnd = count > 0 ? realTimes[count - 1] : 0

  const indexAt = (t: number): number => {
    if (count === 0) return -1
    if (t < times[0]) return -1
    if (t >= times[count - 1]) return count - 1
    let low = 0
    let high = count - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (times[mid] <= t) low = mid
      else high = mid - 1
    }
    return low
  }

  const realTimeAt = (t: number): number => {
    if (count === 0) return 0
    if (t <= 0) return realTimes[0]
    if (t >= duration) return realTimes[count - 1]
    const index = indexAt(t)
    if (index >= count - 1) return realTimes[count - 1]
    const span = times[index + 1] - times[index]
    const ratio = span > 0 ? (t - times[index]) / span : 0
    return realTimes[index] + (realTimes[index + 1] - realTimes[index]) * Math.max(0, Math.min(1, ratio))
  }

  const simTimeAtRealTime = (ms: number): number => {
    if (count === 0) return 0
    if (ms <= realTimes[0]) return 0
    if (ms >= realTimes[count - 1]) return duration
    let low = 0
    let high = count - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (realTimes[mid] <= ms) low = mid
      else high = mid - 1
    }
    if (low >= count - 1) return times[count - 1]
    const spanReal = realTimes[low + 1] - realTimes[low]
    const ratio = spanReal > 0 ? (ms - realTimes[low]) / spanReal : 0
    return times[low] + (times[low + 1] - times[low]) * Math.max(0, Math.min(1, ratio))
  }

  const activity = (buckets: number, commits: readonly TimelineCommit[]): ActivityBucket[] => {
    const result: ActivityBucket[] = Array.from({ length: buckets }, (_, index) => ({
      t: duration > 0 ? (index / buckets) * duration : 0,
      commits: 0,
      additions: 0,
      deletions: 0,
    }))
    if (duration <= 0) return result
    for (let index = 0; index < count; index += 1) {
      const bucketIndex = Math.min(buckets - 1, Math.floor((times[index] / duration) * buckets))
      const commit = commits[index]
      const bucket = result[bucketIndex]
      bucket.commits += 1
      if (commit) {
        bucket.additions += commit.additions
        bucket.deletions += commit.deletions
      }
    }
    return result
  }

  return {
    options,
    times,
    realTimes,
    duration,
    count,
    realStart,
    realEnd,
    idleUsed,
    indexAt,
    realTimeAt,
    simTimeAtRealTime,
    activity,
  }
}

/** Format a simulated duration (seconds) as `m:ss`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (minutes < 60) return `${minutes}:${String(rest).padStart(2, '0')}`
  const hours = Math.floor(minutes / 60)
  return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

/** Human readable date (YYYY-MM-DD) used across the UI. */
export function formatDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  return `${formatDate(ms)} ${hours}:${minutes}`
}

/** Relative time such as `3 days ago`, used in commit tooltips. */
export function formatRelative(ms: number, now = Date.now()): string {
  const diff = now - ms
  const abs = Math.abs(diff)
  const units: [number, string][] = [
    [1000 * 60 * 60 * 24 * 365, 'year'],
    [1000 * 60 * 60 * 24 * 30, 'month'],
    [1000 * 60 * 60 * 24 * 7, 'week'],
    [1000 * 60 * 60 * 24, 'day'],
    [1000 * 60 * 60, 'hour'],
    [1000 * 60, 'minute'],
  ]
  for (const [size, label] of units) {
    if (abs >= size) {
      const value = Math.round(abs / size)
      return `${value} ${label}${value === 1 ? '' : 's'} ${diff >= 0 ? 'ago' : 'from now'}`
    }
  }
  return 'just now'
}
