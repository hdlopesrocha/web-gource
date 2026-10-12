<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { controller } from '../engine/controller'
import { store } from '../state/store'
import {
  CALENDAR_WEEKS,
  contributionCalendar,
  dailyActivity,
  dayStartMs,
  weekdayHourGrid,
  WEEKDAY_LABELS,
} from '../timeline/activity'
import {
  calendarLayout,
  drawContributionCalendar,
  drawWeekdayHour,
  SHADES,
  weekdayHourLayout,
} from '../render/overlays'
import { formatDate } from '../timeline/schedule'

const emit = defineEmits<{ (event: 'close'): void }>()

const gridCanvas = ref<HTMLCanvasElement | null>(null)
const calendarCanvas = ref<HTMLCanvasElement | null>(null)
const gridHover = ref<string | null>(null)
const calendarHover = ref<string | null>(null)

/** Recompute when the timeline is rebuilt (filters, incremental loading). */
const commits = computed(() => {
  void store.timelineStats
  return controller.currentTimeline?.commits ?? []
})

/** Simulated "now": the interpolated commit date the charts must respect. */
const currentMs = computed(() => store.hud?.date ?? 0)

// Both charts only count what has already happened at the playback position,
// so scrubbing backwards removes the future instead of showing the whole
// history at once.
const gridData = computed(() => weekdayHourGrid(commits.value, { until: currentMs.value }))
const daily = computed(() => dailyActivity(commits.value, { until: currentMs.value }))
const calendar = computed(() => contributionCalendar(daily.value, currentMs.value, CALENDAR_WEEKS))

const summary = computed(() => {
  const total = gridData.value.total
  const busiest = gridData.value.busiest
  if (total === 0) return 'No commits in this window.'
  const when = busiest ? `${WEEKDAY_LABELS[busiest.weekday]} ${String(busiest.hour).padStart(2, '0')}:00` : '—'
  return `${total.toLocaleString()} commits · busiest ${when} (${busiest?.count ?? 0})`
})

const calendarSummary = computed(() => {
  const value = calendar.value
  if (value.total === 0) return 'Nothing in the last 53 weeks.'
  const start = formatDate(dayStartMs(value.start))
  const end = formatDate(dayStartMs(value.end))
  return `${value.total.toLocaleString()} commits · ${start} → ${end}`
})

function prepare(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.max(1, Math.round(width * dpr))
  canvas.height = Math.max(1, Math.round(height * dpr))
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  return ctx
}

/** Geometry of the two charts, so hover hit-testing matches the drawing. */
const gridSize = { width: 360, height: 0 }
const calendarSize = { width: 360, height: 0 }

/** Weekday × hour density: horizontal is the hour of day, vertical the weekday. */
function drawGrid(): void {
  const canvas = gridCanvas.value
  if (!canvas) return
  const width = canvas.clientWidth || 360
  const probe = weekdayHourLayout(width, 999)
  const height = probe.labelHeight + 7 * (probe.cellHeight + probe.gap)
  const ctx = prepare(canvas, width, height)
  if (!ctx) return
  gridSize.width = width
  gridSize.height = height
  drawWeekdayHour(ctx, { width, height, grid: gridData.value })
}

/** GitHub-style contribution calendar, anchored to the current week. */
function drawCalendar(): void {
  const canvas = calendarCanvas.value
  if (!canvas) return
  const width = canvas.clientWidth || 360
  const columns = calendar.value.weeks.length
  const probe = calendarLayout(width, 999, columns)
  const height = probe.labelHeight + 7 * (probe.cellHeight + probe.gap) + 4
  const ctx = prepare(canvas, width, height)
  if (!ctx) return
  calendarSize.width = width
  calendarSize.height = height
  drawContributionCalendar(ctx, { width, height, calendar: calendar.value })
}

function draw(): void {
  drawGrid()
  drawCalendar()
}

function cellAt(
  event: MouseEvent,
  canvas: HTMLCanvasElement,
  layout: { cellWidth: number; cellHeight: number; gap: number; labelWidth: number; labelHeight: number },
): { column: number; row: number } | null {
  const rect = canvas.getBoundingClientRect()
  const x = event.clientX - rect.left - layout.labelWidth
  const y = event.clientY - rect.top - layout.labelHeight
  if (x < 0 || y < 0) return null
  const column = Math.floor(x / (layout.cellWidth + layout.gap))
  const row = Math.floor(y / (layout.cellHeight + layout.gap))
  if (row < 0 || row > 6) return null
  return { column, row }
}

function onGridMove(event: MouseEvent): void {
  const canvas = gridCanvas.value
  if (!canvas) return
  const hit = cellAt(event, canvas, weekdayHourLayout(gridSize.width, gridSize.height))
  if (!hit || hit.column < 0 || hit.column > 23) {
    gridHover.value = null
    return
  }
  const count = gridData.value.counts[hit.row]?.[hit.column] ?? 0
  gridHover.value = `${WEEKDAY_LABELS[hit.row]} ${String(hit.column).padStart(2, '0')}:00 UTC · ${count} commit${count === 1 ? '' : 's'}`
}

function onCalendarMove(event: MouseEvent): void {
  const canvas = calendarCanvas.value
  if (!canvas) return
  const hit = cellAt(event, canvas, calendarLayout(calendarSize.width, calendarSize.height, calendar.value.weeks.length))
  if (!hit || hit.column < 0 || hit.column >= calendar.value.weeks.length) {
    calendarHover.value = null
    return
  }
  const value = calendar.value.weeks[hit.column][hit.row]
  const label = formatDate(dayStartMs(value.day))
  calendarHover.value = value.future
    ? `${label} · not yet`
    : `${label} (${WEEKDAY_LABELS[hit.row]}) · ${value.count} commit${value.count === 1 ? '' : 's'}`
}

let observer: ResizeObserver | null = null
let frame = 0

function scheduleDraw(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    draw()
  })
}

onMounted(() => {
  draw()
  if (typeof ResizeObserver !== 'undefined' && gridCanvas.value?.parentElement) {
    observer = new ResizeObserver(() => scheduleDraw())
    observer.observe(gridCanvas.value.parentElement)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (frame) cancelAnimationFrame(frame)
  frame = 0
})

// Redraw when the history, the aggregates or the clock change.
watch([commits, gridData, daily], () => scheduleDraw())
watch(currentMs, () => scheduleDraw())
</script>

<template>
  <aside class="activity panel">
    <header class="head">
      <div>
        <h2>Activity</h2>
        <p class="faint">{{ summary }}</p>
      </div>
      <button class="btn ghost small" type="button" @click="emit('close')">✕</button>
    </header>

    <section class="group">
      <h3>Commits per weekday and hour</h3>
      <div class="chart">
        <canvas ref="gridCanvas" @mousemove="onGridMove" @mouseleave="gridHover = null" />
      </div>
      <p class="faint hint">{{ gridHover ?? 'Horizontal: hour of day (UTC) · vertical: weekday' }}</p>
    </section>

    <section class="group">
      <h3>Contributions · last {{ CALENDAR_WEEKS }} weeks</h3>
      <p class="faint">{{ calendarSummary }}</p>
      <div class="chart">
        <canvas ref="calendarCanvas" @mousemove="onCalendarMove" @mouseleave="calendarHover = null" />
      </div>
      <p class="faint hint">
        {{ calendarHover ?? 'Right column is the current week of the commit date; the calendar slides with playback.' }}
      </p>
      <div class="legend">
        <span class="faint">Less</span>
        <span v-for="(shade, level) in SHADES" :key="level" class="swatch" :style="{ background: shade }" />
        <span class="faint">More</span>
      </div>
    </section>
  </aside>
</template>

<style scoped>
.activity {
  position: absolute;
  right: 12px;
  top: 68px;
  width: min(400px, calc(100vw - 24px));
  max-height: calc(100vh - 260px);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  z-index: 9;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.head h2 {
  font-size: 14px;
}

.head p {
  margin: 2px 0 0;
  font-size: 11.5px;
}

.group h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 0 0 6px;
}

.group p {
  margin: 0 0 6px;
  font-size: 11.5px;
}

.chart {
  width: 100%;
  overflow: hidden;
}

.chart canvas {
  display: block;
  width: 100%;
  cursor: crosshair;
}

.hint {
  font-size: 10.5px;
  min-height: 14px;
  margin: 6px 0 0;
}

.legend {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  font-size: 10px;
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
</style>
