/**
 * Activity aggregations for the heatmap panel.
 *
 * Both charts bucket commits by *UTC* day and hour — the same convention the rest
 * of the app uses for dates — so a given history produces the same charts on
 * every machine. Everything here is a pure function of the commit list, which is
 * what makes the panel cheap to redraw while playback slides the calendar.
 */

import type { TimelineCommit } from './types'

export const DAY_MS = 86_400_000
/** Rows are Sunday-first, like GitHub's contribution calendar. */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const WEEKDAY_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
export const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Columns in the contribution calendar: 53 weeks covers a year plus a day. */
export const CALENDAR_WEEKS = 53

/** Days since the Unix epoch (UTC), the key both charts bucket on. */
export function dayNumber(ms: number): number {
  return Math.floor(ms / DAY_MS)
}

/** Midnight UTC of a day number. */
export function dayStartMs(day: number): number {
  return day * DAY_MS
}

/** Weekday of a day number, Sunday = 0. */
export function weekdayOfDay(day: number): number {
  // 1970-01-01 was a Thursday (4).
  return (((day % 7) + 7 + 4) % 7)
}

export interface WeekdayHourGrid {
  /** `counts[weekday][hour]`, weekday 0 = Sunday, hours 0–23 in UTC. */
  counts: number[][]
  /** Largest cell (0 when there are no commits). */
  max: number
  total: number
  /** Busiest cell, or null when there are no commits. */
  busiest: { weekday: number; hour: number; count: number } | null
}

/** Commits per weekday and hour of day (UTC). */
export function weekdayHourGrid(commits: readonly TimelineCommit[]): WeekdayHourGrid {
  const counts: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  let total = 0
  let max = 0
  let busiest: WeekdayHourGrid['busiest'] = null
  for (const commit of commits) {
    if (!Number.isFinite(commit.timestamp) || commit.timestamp <= 0) continue
    const date = new Date(commit.timestamp)
    const weekday = date.getUTCDay()
    const hour = date.getUTCHours()
    const next = (counts[weekday][hour] ?? 0) + 1
    counts[weekday][hour] = next
    total += 1
    if (next > max) {
      max = next
      busiest = { weekday, hour, count: next }
    }
  }
  return { counts, max, total, busiest }
}

export interface DailyActivity {
  /** Commit counts per UTC day number. */
  counts: Map<number, number>
  max: number
  total: number
  /** Day numbers of the first and last commit, or 0/0 when there are none. */
  firstDay: number
  lastDay: number
}

/** Commits per UTC day, keyed by day number. */
export function dailyActivity(commits: readonly TimelineCommit[]): DailyActivity {
  const counts = new Map<number, number>()
  let total = 0
  let max = 0
  let firstDay = 0
  let lastDay = 0
  for (const commit of commits) {
    if (!Number.isFinite(commit.timestamp) || commit.timestamp <= 0) continue
    const day = dayNumber(commit.timestamp)
    const next = (counts.get(day) ?? 0) + 1
    counts.set(day, next)
    total += 1
    if (next > max) max = next
    if (firstDay === 0 || day < firstDay) firstDay = day
    if (day > lastDay) lastDay = day
  }
  return { counts, max, total, firstDay, lastDay }
}

export interface CalendarCell {
  /** Day number (UTC). */
  day: number
  count: number
  /** True for days after the current one: drawn empty, like GitHub's future. */
  future: boolean
}

export interface ContributionCalendar {
  /** `weeks[column][row]`: column 0 is the oldest week, the last column the current one. */
  weeks: CalendarCell[][]
  max: number
  /** Commits inside the visible window. */
  total: number
  /** Columns that begin a month, for the axis labels. */
  months: { column: number; label: string }[]
  /** First and last day of the window. */
  start: number
  end: number
  /** Number of commits before the window (the part of the history that scrolled out). */
  before: number
}

/**
 * The last `weeks` weeks ending with the week that contains `currentMs`.
 *
 * The rightmost column is always the week of the current playback position, so
 * the calendar slides as the animation advances and days that have not happened
 * yet stay empty.
 */
export function contributionCalendar(
  daily: DailyActivity,
  currentMs: number,
  weeks = CALENDAR_WEEKS,
): ContributionCalendar {
  const currentDay = dayNumber(Number.isFinite(currentMs) ? currentMs : 0)
  const lastColumnStart = currentDay - weekdayOfDay(currentDay)
  const columns = Math.max(1, Math.floor(weeks))
  const start = lastColumnStart - (columns - 1) * 7
  const end = lastColumnStart + 6

  const grid: CalendarCell[][] = []
  let max = 0
  let total = 0
  for (let column = 0; column < columns; column += 1) {
    const rowStart = start + column * 7
    const row: CalendarCell[] = []
    for (let offset = 0; offset < 7; offset += 1) {
      const day = rowStart + offset
      const future = day > currentDay
      const count = future ? 0 : (daily.counts.get(day) ?? 0)
      if (count > max) max = count
      total += count
      row.push({ day, count, future })
    }
    grid.push(row)
  }

  // Month labels: a column is labelled when it contains the 1st of a month.
  const months: { column: number; label: string }[] = []
  let lastLabel = ''
  for (let column = 0; column < columns; column += 1) {
    const rowStart = start + column * 7
    for (let offset = 0; offset < 7; offset += 1) {
      const date = new Date(dayStartMs(rowStart + offset))
      if (date.getUTCDate() !== 1) continue
      const label = MONTH_LABELS[date.getUTCMonth()]
      if (label !== lastLabel) {
        months.push({ column, label })
        lastLabel = label
      }
      break
    }
  }

  let before = 0
  for (const [day, count] of daily.counts) if (day < start) before += count

  return { weeks: grid, max, total, months, start, end, before }
}

/** Five-step shade index (0 = empty) for a count, GitHub style. */
export function shadeLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0
  if (max <= 1) return 4
  const ratio = count / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}
