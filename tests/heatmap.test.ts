import { describe, expect, it } from 'vitest'
import {
  ActivityCursor,
  CALENDAR_WEEKS,
  contributionCalendar,
  dailyActivity,
  dayNumber,
  dayStartMs,
  shadeLevel,
  weekdayHourGrid,
  weekdayOfDay,
  WEEKDAY_LABELS,
} from '../src/timeline/activity'
import type { TimelineCommit } from '../src/timeline/types'

/**
 * Heatmap aggregations: weekday × hour density and the sliding contribution
 * calendar. Both bucket by UTC so the same history always produces the same
 * charts.
 */

function commit(timestamp: number): TimelineCommit {
  return {
    index: 0,
    sha: `sha-${timestamp}`,
    shortSha: 'sha',
    parents: [],
    isMerge: false,
    timestamp,
    authorId: 'a',
    message: 'm',
    subject: 'm',
    body: '',
    changes: [],
    filesKnown: true,
    filesTruncated: false,
    additions: 0,
    deletions: 0,
  }
}

/** 2024-03-06 is a Wednesday; 14:30 UTC. */
const WEDNESDAY_1430 = Date.UTC(2024, 2, 6, 14, 30)

describe('weekdayOfDay / dayNumber', () => {
  it('counts days from the epoch and knows the weekday', () => {
    expect(dayNumber(0)).toBe(0)
    expect(dayNumber(DAY_ONE)).toBe(1)
    // 1970-01-01 was a Thursday, 1970-01-04 a Sunday.
    expect(weekdayOfDay(0)).toBe(4)
    expect(weekdayOfDay(3)).toBe(0)
    expect(WEEKDAY_LABELS[weekdayOfDay(3)]).toBe('Sun')
    expect(dayStartMs(3)).toBe(3 * 86_400_000)
  })
})

const DAY_ONE = 86_400_000

describe('weekdayHourGrid', () => {
  it('buckets commits by UTC weekday and hour', () => {
    const grid = weekdayHourGrid([
      commit(WEDNESDAY_1430),
      commit(WEDNESDAY_1430 + 60_000),
      commit(WEDNESDAY_1430 + 2 * 3_600_000), // 16:30
      commit(Date.UTC(2024, 2, 10, 9, 5)), // Sunday 09:05
    ])
    expect(grid.total).toBe(4)
    expect(grid.counts[3][14]).toBe(2) // Wednesday 14:00
    expect(grid.counts[3][16]).toBe(1)
    expect(grid.counts[0][9]).toBe(1) // Sunday 09:00
    expect(grid.max).toBe(2)
    expect(grid.busiest).toEqual({ weekday: 3, hour: 14, count: 2 })
    // Every other cell stays zero.
    expect(grid.counts.flat().filter((value) => value > 0)).toHaveLength(3)
  })

  it('only counts commits up to the current time', () => {
    const commits = [
      commit(WEDNESDAY_1430), // Wednesday 14:00
      commit(WEDNESDAY_1430 + 3_600_000), // Wednesday 15:00
      commit(WEDNESDAY_1430 + 2 * DAY_ONE), // Friday
    ]
    // At the first commit only that one exists; the future is not shown.
    const early = weekdayHourGrid(commits, { until: WEDNESDAY_1430 })
    expect(early.total).toBe(1)
    expect(early.counts[3][14]).toBe(1)
    expect(early.counts[3][15]).toBe(0)
    expect(early.counts[5][14]).toBe(0)

    // Midway, two; at the end, all three.
    expect(weekdayHourGrid(commits, { until: WEDNESDAY_1430 + 3_600_000 }).total).toBe(2)
    expect(weekdayHourGrid(commits, { until: WEDNESDAY_1430 + 3 * DAY_ONE }).total).toBe(3)
    expect(weekdayHourGrid(commits).total).toBe(3)
  })

  it('handles an empty history and unusable timestamps', () => {
    const empty = weekdayHourGrid([])
    expect(empty.total).toBe(0)
    expect(empty.max).toBe(0)
    expect(empty.busiest).toBeNull()
    expect(empty.counts).toHaveLength(7)
    expect(empty.counts[0]).toHaveLength(24)
    expect(weekdayHourGrid([commit(0), commit(Number.NaN)]).total).toBe(0)
  })
})

describe('dailyActivity', () => {
  it('counts only the days that have happened', () => {
    const commits = [
      commit(WEDNESDAY_1430),
      commit(WEDNESDAY_1430 + 2 * DAY_ONE),
    ]
    const early = dailyActivity(commits, { until: WEDNESDAY_1430 })
    expect(early.total).toBe(1)
    expect(early.counts.get(dayNumber(WEDNESDAY_1430))).toBe(1)
    expect(early.counts.get(dayNumber(WEDNESDAY_1430) + 2)).toBeUndefined()
    expect(early.lastDay).toBe(dayNumber(WEDNESDAY_1430))
  })

  it('counts commits per day and reports the range', () => {
    const daily = dailyActivity([
      commit(WEDNESDAY_1430),
      commit(WEDNESDAY_1430 + 3_600_000),
      commit(WEDNESDAY_1430 + 2 * DAY_ONE),
    ])
    expect(daily.total).toBe(3)
    expect(daily.max).toBe(2)
    expect(daily.firstDay).toBe(dayNumber(WEDNESDAY_1430))
    expect(daily.lastDay).toBe(dayNumber(WEDNESDAY_1430) + 2)
    expect(daily.counts.get(dayNumber(WEDNESDAY_1430))).toBe(2)
  })
})

describe('contributionCalendar', () => {
  const daily = dailyActivity([
    commit(WEDNESDAY_1430), // Wednesday of the current week
    commit(WEDNESDAY_1430 - 7 * DAY_ONE), // same weekday, one week earlier
    commit(WEDNESDAY_1430 - 30 * DAY_ONE),
  ])

  it('builds 53 columns of 7 days ending with the current week', () => {
    const calendar = contributionCalendar(daily, WEDNESDAY_1430)
    expect(calendar.weeks).toHaveLength(CALENDAR_WEEKS)
    for (const week of calendar.weeks) expect(week).toHaveLength(7)

    // The rightmost column starts on the Sunday of the current week.
    const lastColumn = calendar.weeks[CALENDAR_WEEKS - 1]
    expect(lastColumn[0].day).toBe(dayNumber(WEDNESDAY_1430) - 3)
    expect(weekdayOfDay(lastColumn[0].day)).toBe(0)
    // And the current day sits in it, with the count from the history.
    expect(lastColumn[3].day).toBe(dayNumber(WEDNESDAY_1430))
    expect(lastColumn[3].count).toBe(1)
    expect(lastColumn[3].future).toBe(false)
    // The rest of the current week has not happened yet.
    expect(lastColumn[4].future).toBe(true)
    expect(lastColumn[4].count).toBe(0)
  })

  it('places earlier commits in their own columns', () => {
    const calendar = contributionCalendar(daily, WEDNESDAY_1430)
    const previousWeek = calendar.weeks[CALENDAR_WEEKS - 2]
    expect(previousWeek[3].count).toBe(1)
    const monthAgo = calendar.weeks[CALENDAR_WEEKS - 5]
    expect(monthAgo.reduce((sum, cell) => sum + cell.count, 0)).toBe(1)
    expect(calendar.total).toBe(3)
    expect(calendar.before).toBe(0)
  })

  it('slides with the current time and drops days that scroll out', () => {
    const later = contributionCalendar(daily, WEDNESDAY_1430 + 8 * DAY_ONE)
    const lastColumn = later.weeks[CALENDAR_WEEKS - 1]
    // The window moved a week on: the old "current" week is now the second last.
    expect(later.weeks[CALENDAR_WEEKS - 2][3].count).toBe(1)
    expect(lastColumn[3].count).toBe(0)
    // A week later all three commits are still inside the 53-week window.
    expect(later.total).toBe(3)
    expect(later.before).toBe(0)

    // Far enough in the future, the oldest commit leaves the window.
    const muchLater = contributionCalendar(daily, WEDNESDAY_1430 + 400 * DAY_ONE)
    expect(muchLater.total).toBe(0)
    expect(muchLater.before).toBe(3)
  })

  it('labels the months that start inside the window', () => {
    const calendar = contributionCalendar(daily, Date.UTC(2024, 11, 20))
    expect(calendar.months.length).toBeGreaterThan(6)
    expect(calendar.months.every((entry) => /^[A-Z][a-z]{2}$/.test(entry.label))).toBe(true)
    // Columns are in ascending order.
    const columns = calendar.months.map((entry) => entry.column)
    expect([...columns].sort((a, b) => a - b)).toEqual(columns)
  })

  it('handles an empty history', () => {
    const empty = contributionCalendar(dailyActivity([]), WEDNESDAY_1430)
    expect(empty.total).toBe(0)
    expect(empty.max).toBe(0)
    expect(empty.weeks).toHaveLength(CALENDAR_WEEKS)
  })
})

describe('ActivityCursor', () => {
  it('grows with the clock and rebuilds when it jumps backwards', () => {
    const commits = [
      commit(WEDNESDAY_1430),
      commit(WEDNESDAY_1430 + 3_600_000),
      commit(WEDNESDAY_1430 + 2 * DAY_ONE),
    ]
    const cursor = new ActivityCursor(commits)

    cursor.advanceTo(WEDNESDAY_1430)
    expect(cursor.grid.total).toBe(1)
    expect(cursor.daily.total).toBe(1)

    cursor.advanceTo(WEDNESDAY_1430 + 2 * DAY_ONE)
    expect(cursor.grid.total).toBe(3)
    expect(cursor.daily.total).toBe(3)

    // Rewinding must not keep the future in the totals.
    cursor.advanceTo(WEDNESDAY_1430)
    expect(cursor.grid.total).toBe(1)
    expect(cursor.daily.total).toBe(1)

    // A new timeline resets the cursor.
    cursor.setCommits([commit(WEDNESDAY_1430 + 5 * DAY_ONE)])
    cursor.advanceTo(WEDNESDAY_1430 + 6 * DAY_ONE)
    expect(cursor.grid.total).toBe(1)
  })

  it('matches the pure aggregations', () => {
    const commits = [
      commit(WEDNESDAY_1430),
      commit(WEDNESDAY_1430 + 3_600_000),
      commit(WEDNESDAY_1430 + 2 * DAY_ONE),
      commit(WEDNESDAY_1430 + 30 * DAY_ONE),
    ]
    const cursor = new ActivityCursor(commits)
    for (const until of [WEDNESDAY_1430, WEDNESDAY_1430 + 3_600_000, WEDNESDAY_1430 + 31 * DAY_ONE]) {
      cursor.advanceTo(until)
      const grid = weekdayHourGrid(commits, { until })
      const daily = dailyActivity(commits, { until })
      expect(cursor.grid.total).toBe(grid.total)
      expect(cursor.grid.max).toBe(grid.max)
      expect(cursor.grid.counts).toEqual(grid.counts)
      expect(cursor.daily.total).toBe(daily.total)
      expect(cursor.daily.counts).toEqual(daily.counts)
    }
  })
})

describe('shadeLevel', () => {
  it('maps counts to five steps, GitHub style', () => {
    expect(shadeLevel(0, 10)).toBe(0)
    expect(shadeLevel(1, 10)).toBe(1)
    expect(shadeLevel(3, 10)).toBe(2)
    expect(shadeLevel(6, 10)).toBe(3)
    expect(shadeLevel(10, 10)).toBe(4)
    // A single-commit day still shows as a full cell.
    expect(shadeLevel(1, 1)).toBe(4)
  })
})
