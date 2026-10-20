<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { drawActivityBars } from '../render/overlays'
import type { ActivityBucket } from '../timeline/types'

const props = defineProps<{
  activity: ActivityBucket[]
  duration: number
  time: number
  /** Filter range in simulated seconds (null = unbounded). */
  filterFrom: number | null
  filterTo: number | null
}>()

const emit = defineEmits<{
  (event: 'seek', time: number): void
  (event: 'scrub-start'): void
  (event: 'scrub-end'): void
  (event: 'filter', range: { from: number | null; to: number | null }): void
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const root = ref<HTMLDivElement | null>(null)
const width = ref(600)
const height = 58
const dragging = ref<'playhead' | 'from' | 'to' | null>(null)
const hoverTime = ref<number | null>(null)

let observer: ResizeObserver | null = null
let windowListener: (() => void) | null = null

function measure(): void {
  if (root.value) width.value = root.value.clientWidth
}

const positionPercent = computed(() => (props.duration > 0 ? (props.time / props.duration) * 100 : 0))
const fromPercent = computed(() =>
  props.filterFrom !== null && props.duration > 0 ? (props.filterFrom / props.duration) * 100 : 0,
)
const toPercent = computed(() =>
  props.filterTo !== null && props.duration > 0 ? (props.filterTo / props.duration) * 100 : 100,
)

function draw(): void {
  const element = canvas.value
  if (!element) return
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  const cssWidth = Math.max(60, width.value)
  element.width = Math.floor(cssWidth * dpr)
  element.height = Math.floor(height * dpr)
  element.style.width = `${cssWidth}px`
  element.style.height = `${height}px`

  const ctx = element.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  // The histogram itself is shared with the exported video, so both draw the
  // same bars from the same code.
  drawActivityBars(ctx, {
    width: cssWidth,
    height,
    buckets: props.activity,
    position: props.time,
    duration: props.duration,
    window:
      props.filterFrom !== null || props.filterTo !== null
        ? { from: props.filterFrom ?? 0, to: props.filterTo ?? props.duration }
        : null,
  })
}

function timeFromEvent(event: PointerEvent): number {
  const element = root.value
  if (!element) return 0
  const rect = element.getBoundingClientRect()
  const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0
  return Math.max(0, Math.min(1, ratio)) * props.duration
}

function onPointerDown(event: PointerEvent, handle: 'playhead' | 'from' | 'to'): void {
  event.preventDefault()
  event.stopPropagation()
  dragging.value = handle
  if (handle === 'playhead') {
    emit('scrub-start')
    emit('seek', timeFromEvent(event))
  }
  ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onTrackDown(event: PointerEvent): void {
  emit('scrub-start')
  dragging.value = 'playhead'
  emit('seek', timeFromEvent(event))
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) {
    hoverTime.value = timeFromEvent(event)
    return
  }
  const time = timeFromEvent(event)
  if (dragging.value === 'playhead') {
    emit('seek', time)
    return
  }
  if (dragging.value === 'from') {
    const to = props.filterTo ?? props.duration
    emit('filter', { from: Math.min(time, to - 0.4), to: props.filterTo })
  } else {
    const from = props.filterFrom ?? 0
    emit('filter', { from: props.filterFrom, to: Math.max(time, from + 0.4) })
  }
}

function onPointerUp(): void {
  if (dragging.value === 'playhead') emit('scrub-end')
  dragging.value = null
}

function clearFilter(): void {
  emit('filter', { from: null, to: null })
}

watch(
  () => [props.activity, props.time, props.filterFrom, props.filterTo, width.value],
  () => draw(),
)

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => measure())
    if (root.value) observer.observe(root.value)
  } else {
    // Older browsers: fall back to window resize events.
    windowListener = () => measure()
    window.addEventListener('resize', windowListener)
  }
  measure()
  draw()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (windowListener) {
    window.removeEventListener('resize', windowListener)
    windowListener = null
  }
})
</script>

<template>
  <div
    ref="root"
    class="scrubber"
    @pointerdown="onTrackDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointerleave="hoverTime = null"
    @pointercancel="onPointerUp"
  >
    <canvas ref="canvas" class="histogram" />
    <div class="played" :style="{ width: `${positionPercent}%` }" />
    <div class="playhead" :style="{ left: `${positionPercent}%` }" />
    <button
      class="handle from"
      type="button"
      :class="{ active: filterFrom !== null }"
      :style="{ left: `${fromPercent}%` }"
      title="Drag to set the start of the date range"
      @pointerdown="onPointerDown($event, 'from')"
    />
    <button
      class="handle to"
      type="button"
      :class="{ active: filterTo !== null }"
      :style="{ left: `${toPercent}%` }"
      title="Drag to set the end of the date range"
      @pointerdown="onPointerDown($event, 'to')"
    />
    <button v-if="filterFrom !== null || filterTo !== null" class="clear" type="button" @click.stop="clearFilter">
      clear range
    </button>
  </div>
</template>

<style scoped>
.scrubber {
  position: relative;
  width: 100%;
  height: 58px;
  border-radius: var(--radius-sm);
  background: rgba(6, 10, 20, 0.6);
  border: 1px solid var(--panel-border);
  cursor: pointer;
  overflow: hidden;
  touch-action: none;
}

.histogram {
  display: block;
  width: 100%;
  height: 100%;
}

.played {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  background: linear-gradient(90deg, rgba(47, 125, 224, 0.18), rgba(94, 200, 255, 0.06));
  pointer-events: none;
}

.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: #eaf7ff;
  box-shadow: 0 0 10px rgba(180, 230, 255, 0.9);
  pointer-events: none;
}

.handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 12px;
  margin-left: -6px;
  padding: 0;
  background: transparent;
  cursor: ew-resize;
}

.handle::after {
  content: '';
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 5px;
  width: 2px;
  border-radius: 2px;
  background: rgba(150, 190, 240, 0.55);
}

.handle.active::after {
  background: var(--accent);
  box-shadow: 0 0 8px rgba(94, 200, 255, 0.8);
}

.clear {
  position: absolute;
  right: 6px;
  top: 4px;
  font-size: 10.5px;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(10, 16, 28, 0.85);
  border: 1px solid var(--panel-border);
  color: var(--text-dim);
}

.clear:hover {
  color: var(--text);
  border-color: var(--panel-border-strong);
}

/* Wider invisible handles make dragging the filter edges practical on touch. */
@media (max-width: 760px), (max-width: 949px) and (max-height: 480px) {
  .handle {
    width: 28px;
    margin-left: -14px;
  }

  .handle::after {
    left: 13px;
  }

  .clear {
    min-height: 30px;
    padding: 4px 9px;
  }
}
</style>
