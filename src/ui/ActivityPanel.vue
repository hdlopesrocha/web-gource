<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { controller } from '../engine/controller'
import { store } from '../state/store'
import {
  CALENDAR_WEEKS,
  contributionCalendar,
  dailyActivity,
  dayStartMs,
  shadeLevel,
  weekdayHourGrid,
  WEEKDAY_LABELS,
  type DailyActivity,
  type WeekdayHourGrid,
} from '../timeline/activity'
import { formatDate } from '../timeline/schedule'

const emit = defineEmits<{ (event: 'close'): void }>()

/** Shade ramp for both charts: empty, then four steps of the accent. */
const SHADES = ['rgba(255,255,255,0.06)', 'rgba(94,200,255,0.28)', 'rgba(94,200,255,0.5)', 'rgba(139,150,255,0.72)', 'rgba(185,140,255,0.95)']

const gridCanvas = ref<HTMLCanvasElement | null>(null)
const calendarCanvas = ref<HTMLCanvasElement | null>(null)
const gridHover = ref<string | null>(null)
const calendarHover = ref<string | null>(null)

/** Recompute when the timeline is rebuilt (filters, incremental loading). */
const commits = computed(() => {
  void store.timelineStats
  return controller.currentTimeline?.commits ?? []
})

// Reactive, so the summaries and the calendar follow filter changes.
const gridData = shallowRef<WeekdayHourGrid>(weekdayHourGrid(commits.value))
const daily = shallowRef<DailyActivity>(dailyActivity(commits.value))

/** Simulated "now": the interpolated commit date, so the calendar slides. */
const currentMs = computed(() => store.hud?.date ?? 0)
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

const GRID_LABEL_WIDTH = 30
const GRID_LABEL_HEIGHT = 16

/** Weekday × hour density: horizontal is the hour of day, vertical the weekday. */
function drawGrid(): void {
  const canvas = gridCanvas.value
  if (!canvas) return
  const width = canvas.clientWidth || 360
  const columns = 24
  const rows = 7
  const cell = Math.max(6, Math.floor((width - GRID_LABEL_WIDTH) / columns) - 2)
  const height = GRID_LABEL_HEIGHT + rows * (cell + 2)
  const ctx = prepare(canvas, width, height)
  if (!ctx) return

  ctx.font = '9px "Inter", system-ui, sans-serif'
  ctx.textBaseline = 'middle'

  // Hour labels every three hours.
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.textAlign = 'center'
  for (let hour = 0; hour < columns; hour += 3) {
    ctx.fillText(String(hour).padStart(2, '0'), GRID_LABEL_WIDTH + hour * (cell + 2) + cell / 2, 8)
  }

  for (let weekday = 0; weekday < rows; weekday += 1) {
    const y = GRID_LABEL_HEIGHT + weekday * (cell + 2)
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.textAlign = 'right'
    ctx.fillText(WEEKDAY_LABELS[weekday], GRID_LABEL_WIDTH - 6, y + cell / 2)
    for (let hour = 0; hour < columns; hour += 1) {
      const count = gridData.value.counts[weekday]?.[hour] ?? 0
      ctx.fillStyle = SHADES[shadeLevel(count, gridData.value.max)]
      ctx.beginPath()
      const x = GRID_LABEL_WIDTH + hour * (cell + 2)
      ctx.roundRect?.(x, y, cell, cell, 2)
      if (!ctx.roundRect) ctx.rect(x, y, cell, cell)
      ctx.fill()
    }
  }
}

/** GitHub-style contribution calendar, anchored to the current week. */
function drawCalendar(): void {
  const canvas = calendarCanvas.value
  if (!canvas) return
  const width = canvas.clientWidth || 360
  const rows = 7
  const value = calendar.value
  const labelHeight = 14
  const weekdayWidth = 22
  const cell = Math.max(4, Math.min(11, Math.floor((width - weekdayWidth) / CALENDAR_WEEKS) - 2))
  const height = labelHeight + rows * (cell + 2) + 4
  const ctx = prepare(canvas, width, height)
  if (!ctx) return

  ctx.font = '9px "Inter", system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  for (const { column, label } of value.months) {
    ctx.fillText(label, weekdayWidth + column * (cell + 2), 7)
  }
  ctx.textAlign = 'right'
  for (const weekday of [1, 3, 5]) {
    ctx.fillText(WEEKDAY_LABELS[weekday], weekdayWidth - 6, labelHeight + weekday * (cell + 2) + cell / 2)
  }

  for (let column = 0; column < value.weeks.length; column += 1) {
    const week = value.weeks[column]
    for (let offset = 0; offset < rows; offset += 1) {
      const cellValue = week[offset]
      const x = weekdayWidth + column * (cell + 2)
      const y = labelHeight + offset * (cell + 2)
      ctx.fillStyle = cellValue.future ? 'rgba(255,255,255,0.03)' : SHADES[shadeLevel(cellValue.count, value.max)]
      ctx.beginPath()
      ctx.roundRect?.(x, y, cell, cell, 2)
      if (!ctx.roundRect) ctx.rect(x, y, cell, cell)
      ctx.fill()
    }
  }
}

function draw(): void {
  drawGrid()
  drawCalendar()
}

function cellAt(event: MouseEvent, canvas: HTMLCanvasElement, cell: number, labelWidth: number, labelHeight: number): { column: number; row: number } | null {
  const rect = canvas.getBoundingClientRect()
  const x = event.clientX - rect.left - labelWidth
  const y = event.clientY - rect.top - labelHeight
  if (x < 0 || y < 0) return null
  const column = Math.floor(x / (cell + 2))
  const row = Math.floor(y / (cell + 2))
  if (row < 0 || row > 6) return null
  return { column, row }
}

function onGridMove(event: MouseEvent): void {
  const canvas = gridCanvas.value
  if (!canvas) return
  const width = canvas.clientWidth || 360
  const cell = Math.max(6, Math.floor((width - GRID_LABEL_WIDTH) / 24) - 2)
  const hit = cellAt(event, canvas, cell, GRID_LABEL_WIDTH, GRID_LABEL_HEIGHT)
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
  const width = canvas.clientWidth || 360
  const cell = Math.max(4, Math.min(11, Math.floor((width - 22) / CALENDAR_WEEKS) - 2))
  const hit = cellAt(event, canvas, cell, 22, 14)
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

function refresh(): void {
  gridData.value = weekdayHourGrid(commits.value)
  daily.value = dailyActivity(commits.value)
  draw()
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
  refresh()
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

// Recompute when the history changes, redraw when the clock slides.
watch(commits, () => refresh())
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
