import { describe, expect, it } from 'vitest'
import { buildSchedule, DEFAULT_SCHEDULE_OPTIONS, formatDate, formatDuration } from '../src/timeline/schedule'
import type { TimelineCommit } from '../src/timeline/types'

function commit(index: number, timestamp: number, additions = 1, deletions = 0): TimelineCommit {
  return {
    index,
    sha: `sha${index}`,
    shortSha: `sha${index}`,
    parents: [],
    isMerge: false,
    timestamp,
    authorId: 'author',
    message: `commit ${index}`,
    subject: `commit ${index}`,
    body: '',
    changes: [],
    filesKnown: true,
    filesTruncated: false,
    additions,
    deletions,
  }
}

const DAY = 86_400_000

describe('buildSchedule', () => {
  it('produces monotonically increasing times', () => {
    const commits = [0, 1, 2, 3].map((index) => commit(index, Date.UTC(2020, 0, 1) + index * DAY))
    const schedule = buildSchedule(commits)
    expect(schedule.count).toBe(4)
    for (let index = 1; index < schedule.count; index += 1) {
      expect(schedule.times[index]).toBeGreaterThan(schedule.times[index - 1])
    }
    expect(schedule.duration).toBeGreaterThan(schedule.times[3])
  })

  it('compresses idle time instead of playing it in real time', () => {
    // One commit per day for 200 days is 200 days of history.
    const commits = Array.from({ length: 200 }, (_, index) => commit(index, Date.UTC(2020, 0, 1) + index * DAY))
    const schedule = buildSchedule(commits)
    const realSeconds = (200 * DAY) / 1000
    expect(schedule.duration).toBeLessThan(realSeconds / 1000)
    // Total idle contribution is bounded by the configured budget.
    const idleTotal = schedule.duration - commits.length * DEFAULT_SCHEDULE_OPTIONS.minSpacing
    expect(idleTotal).toBeLessThanOrEqual(DEFAULT_SCHEDULE_OPTIONS.idleBudget + DEFAULT_SCHEDULE_OPTIONS.tail + 0.001)
  })

  it('is deterministic', () => {
    const commits = Array.from({ length: 40 }, (_, index) => commit(index, Date.UTC(2021, 0, 1) + index * DAY * 3))
    const a = buildSchedule(commits)
    const b = buildSchedule(commits)
    expect([...a.times]).toEqual([...b.times])
  })

  it('keeps earlier times stable when newer commits are appended', () => {
    const head = Array.from({ length: 30 }, (_, index) => commit(index, Date.UTC(2021, 0, 1) + index * DAY))
    const tail = Array.from({ length: 20 }, (_, index) => commit(30 + index, Date.UTC(2021, 1, 5) + index * DAY * 2))
    const first = buildSchedule(head)
    const extended = buildSchedule([...head, ...tail], {}, first)
    for (let index = 0; index < first.count; index += 1) {
      expect(extended.times[index]).toBeCloseTo(first.times[index], 10)
    }
    expect(extended.count).toBe(50)
    expect(extended.duration).toBeGreaterThan(first.duration)
  })

  it('maps simulated time to commits and real dates', () => {
    const commits = Array.from({ length: 10 }, (_, index) => commit(index, Date.UTC(2022, 0, 1) + index * DAY))
    const schedule = buildSchedule(commits)
    expect(schedule.indexAt(-1)).toBe(-1)
    expect(schedule.indexAt(0)).toBe(0)
    expect(schedule.indexAt(schedule.times[4])).toBe(4)
    expect(schedule.indexAt(schedule.duration)).toBe(9)

    const realMid = schedule.realTimeAt(schedule.times[4])
    expect(realMid).toBe(commits[4].timestamp)
    const midPoint = (schedule.times[4] + schedule.times[5]) / 2
    const midway = schedule.realTimeAt(midPoint)
    expect(midway).toBeGreaterThan(commits[4].timestamp)
    expect(midway).toBeLessThan(commits[5].timestamp)

    // Round trip
    const t = schedule.simTimeAtRealTime(commits[7].timestamp)
    expect(t).toBeCloseTo(schedule.times[7], 6)
  })

  it('handles a single commit and an empty history', () => {
    const single = buildSchedule([commit(0, Date.UTC(2020, 0, 1))])
    expect(single.count).toBe(1)
    expect(single.times[0]).toBe(0)
    expect(single.duration).toBeGreaterThan(0)
    expect(single.indexAt(0)).toBe(0)

    const empty = buildSchedule([])
    expect(empty.count).toBe(0)
    expect(empty.duration).toBe(0)
    expect(empty.indexAt(1)).toBe(-1)
  })

  it('buckets activity in simulated time', () => {
    const commits = Array.from({ length: 20 }, (_, index) => commit(index, Date.UTC(2023, 0, 1) + index * DAY, index, 0))
    const schedule = buildSchedule(commits)
    const buckets = schedule.activity(10, commits)
    expect(buckets).toHaveLength(10)
    expect(buckets.reduce((sum, bucket) => sum + bucket.commits, 0)).toBe(20)
    expect(buckets[0].t).toBe(0)
  })
})

describe('formatting helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(3725)).toBe('1:02:05')
  })

  it('formats dates in UTC', () => {
    expect(formatDate(Date.UTC(2024, 2, 9))).toBe('2024-03-09')
    expect(formatDate(0)).toBe('—')
  })
})
