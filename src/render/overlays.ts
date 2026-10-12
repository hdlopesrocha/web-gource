/**
 * Canvas drawing for the panel content that appears both on screen and in an
 * exported video: the timeline histogram, the weekday × hour heatmap and the
 * contribution calendar.
 *
 * Everything here is a plain function of `(context, geometry, data)` with no DOM
 * lookups, so the Vue panels and the export compositor draw the same pixels from
 * the same code — and tests can drive it with a stub context.
 */

import { shadeLevel, WEEKDAY_LABELS, type ContributionCalendar, type WeekdayHourGrid } from '../timeline/activity'

/** Shade ramp shared by both charts: empty, then four steps of the accent. */
export const SHADES = [
  'rgba(255,255,255,0.06)',
  'rgba(94,200,255,0.28)',
  'rgba(94,200,255,0.5)',
  'rgba(139,150,255,0.72)',
  'rgba(185,140,255,0.95)',
]

export const TEXT_COLOR = 'rgba(255,255,255,0.55)'
export const TEXT_STRONG = 'rgba(255,255,255,0.85)'

export interface ActivityBarsOptions {
  width: number
  height: number
  /** Commit counts per simulated-time bucket. */
  buckets: { commits: number }[]
  /** Playback position in seconds and the total duration. */
  position: number
  duration: number
  /** Optional window (filters highlight a sub-range). */
  window?: { from: number; to: number } | null
  font?: string
}

/** The timeline histogram: one bar per bucket, brighter once played. */
export function drawActivityBars(ctx: CanvasRenderingContext2D, options: ActivityBarsOptions): void {
  const { width, height, buckets, position, duration } = options
  ctx.clearRect(0, 0, width, height)

  let max = 0
  for (const bucket of buckets) max = Math.max(max, bucket.commits)
  if (max === 0) max = 1

  ctx.fillStyle = 'rgba(255,255,255,0.04)'
  ctx.fillRect(0, height - 2, width, 2)

  const barWidth = buckets.length > 0 ? width / buckets.length : width
  const playedSeconds = Math.max(0, Math.min(duration, position))
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index]
    const x = index * barWidth
    const ratio = bucket.commits / max
    const barHeight = Math.max(1, ratio * (height - 6))
    const played = buckets.length > 0 && (index / buckets.length) * duration <= playedSeconds
    ctx.fillStyle = played ? 'rgba(120, 205, 255, 0.85)' : 'rgba(120, 160, 220, 0.35)'
    ctx.fillRect(x, height - barHeight - 2, Math.max(1, barWidth - 1), barHeight)
  }

  if (options.window && duration > 0) {
    const fromX = (Math.max(0, options.window.from) / duration) * width
    const toX = (Math.min(duration, options.window.to) / duration) * width
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)'
    ctx.fillRect(fromX, 0, Math.max(0, toX - fromX), height)
    ctx.strokeStyle = 'rgba(94, 200, 255, 0.7)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(fromX + 0.5, 0)
    ctx.lineTo(fromX + 0.5, height)
    ctx.moveTo(toX - 0.5, 0)
    ctx.lineTo(toX - 0.5, height)
    ctx.stroke()
  }

  // Playhead.
  if (duration > 0) {
    const x = (playedSeconds / duration) * width
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.fillRect(Math.max(0, Math.min(width - 2, x - 1)), 0, 2, height)
  }
  void options.font
}

export interface ChartLayout {
  cellWidth: number
  cellHeight: number
  gap: number
  labelWidth: number
  labelHeight: number
}

/** Cell geometry of the weekday × hour chart, shared by drawing and hit-testing. */
export function weekdayHourLayout(width: number, height: number): ChartLayout {
  const labelWidth = Math.max(24, Math.round(width * 0.11))
  const labelHeight = Math.max(12, Math.round(height * 0.16))
  const gap = Math.max(1, Math.round(width * 0.006))
  const cellWidth = Math.max(2, Math.floor((width - labelWidth - gap * 23) / 24))
  const cellHeight = Math.max(2, Math.floor((height - labelHeight - gap * 6) / 7))
  return { cellWidth, cellHeight, gap, labelWidth, labelHeight }
}

/** Cell geometry of the contribution calendar, shared by drawing and hit-testing. */
export function calendarLayout(width: number, height: number, columns: number): ChartLayout {
  const labelWidth = Math.max(16, Math.round(width * 0.06))
  const labelHeight = Math.max(10, Math.round(height * 0.2))
  const gap = Math.max(1, Math.round(width * 0.003))
  const cellWidth = Math.max(2, Math.floor((width - labelWidth - gap * Math.max(0, columns - 1)) / Math.max(1, columns)))
  const cellHeight = Math.max(2, Math.floor((height - labelHeight - gap * 6) / 7))
  return { cellWidth, cellHeight, gap, labelWidth, labelHeight }
}

export interface WeekdayHourOptions {
  width: number
  height: number
  grid: WeekdayHourGrid
  font?: string
}

/** Commits per weekday (rows, Sunday first) and hour (columns). */
export function drawWeekdayHour(ctx: CanvasRenderingContext2D, options: WeekdayHourOptions): void {
  const { width, height, grid } = options
  ctx.clearRect(0, 0, width, height)

  const { cellWidth: cell, cellHeight: rowHeight, gap, labelWidth, labelHeight } = weekdayHourLayout(width, height)

  ctx.font = options.font ?? `${Math.max(8, Math.round(height * 0.11))}px "Inter", system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillStyle = TEXT_COLOR
  for (let hour = 0; hour < 24; hour += 3) {
    ctx.fillText(String(hour).padStart(2, '0'), labelWidth + hour * (cell + gap) + cell / 2, labelHeight / 2)
  }

  ctx.textAlign = 'right'
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const y = labelHeight + weekday * (rowHeight + gap)
    ctx.fillStyle = TEXT_COLOR
    ctx.fillText(WEEKDAY_LABELS[weekday], labelWidth - gap * 2, y + rowHeight / 2)
    for (let hour = 0; hour < 24; hour += 1) {
      const count = grid.counts[weekday]?.[hour] ?? 0
      ctx.fillStyle = SHADES[shadeLevel(count, grid.max)]
      const x = labelWidth + hour * (cell + gap)
      ctx.fillRect(x, y, cell, rowHeight)
    }
  }
}

export interface CalendarOptions {
  width: number
  height: number
  calendar: ContributionCalendar
  font?: string
}

/** GitHub-style contribution calendar: 53 week columns, Sunday-first rows. */
export function drawContributionCalendar(ctx: CanvasRenderingContext2D, options: CalendarOptions): void {
  const { width, height, calendar } = options
  ctx.clearRect(0, 0, width, height)

  const columns = Math.max(1, calendar.weeks.length)
  const { cellWidth: cell, cellHeight: rowHeight, gap, labelWidth, labelHeight } = calendarLayout(width, height, columns)

  ctx.font = options.font ?? `${Math.max(8, Math.round(height * 0.14))}px "Inter", system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = TEXT_COLOR
  for (const { column, label } of calendar.months) {
    ctx.fillText(label, labelWidth + column * (cell + gap), labelHeight / 2)
  }

  ctx.textAlign = 'right'
  for (const weekday of [1, 3, 5]) {
    ctx.fillStyle = TEXT_COLOR
    ctx.fillText(
      WEEKDAY_LABELS[weekday],
      labelWidth - gap * 2,
      labelHeight + weekday * (rowHeight + gap) + rowHeight / 2,
    )
  }

  for (let column = 0; column < columns; column += 1) {
    const week = calendar.weeks[column]
    for (let offset = 0; offset < 7; offset += 1) {
      const value = week[offset]
      const x = labelWidth + column * (cell + gap)
      const y = labelHeight + offset * (rowHeight + gap)
      ctx.fillStyle = value.future ? 'rgba(255,255,255,0.03)' : SHADES[shadeLevel(value.count, calendar.max)]
      ctx.fillRect(x, y, cell, rowHeight)
    }
  }
}

/** Rounded translucent panel behind a chart, matching the app's chrome. */
export function drawPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  options: { radius?: number; background?: string; border?: string } = {},
): void {
  const radius = options.radius ?? Math.max(4, Math.round(Math.min(width, height) * 0.06))
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, width, height, radius)
  else ctx.rect(x, y, width, height)
  ctx.fillStyle = options.background ?? 'rgba(9,13,24,0.72)'
  ctx.fill()
  ctx.strokeStyle = options.border ?? 'rgba(255,255,255,0.09)'
  ctx.lineWidth = 1
  ctx.stroke()
}
