<script setup lang="ts">
import { computed, ref } from 'vue'
import { controller } from '../engine/controller'
import { PLAYBACK_SPEEDS } from '../engine/speeds'
import { store } from '../state/store'
import { formatDateTime, formatDuration } from '../timeline/schedule'
import TimelineScrubber from './TimelineScrubber.vue'

const SPEEDS = PLAYBACK_SPEEDS
const scrubbing = ref(false)
const scrubTime = ref(0)
const jumpDate = ref('')
const jumpSha = ref('')
const jumpMessage = ref('')

const hud = computed(() => store.hud)
const duration = computed(() => (scrubbing.value ? scrubTime.value : hud.value?.duration ?? controller.duration()))
const time = computed(() => (scrubbing.value ? scrubTime.value : hud.value?.time ?? 0))
const range = computed(() => controller.realRange())

const filterFrom = computed(() =>
  store.dateRange.from !== null ? controller.simTimeAtRealTime(store.dateRange.from) : null,
)
const filterTo = computed(() =>
  store.dateRange.to !== null ? controller.simTimeAtRealTime(store.dateRange.to) : null,
)

const filterLabel = computed(() => {
  const from = store.dateRange.from
  const to = store.dateRange.to
  if (from === null && to === null) return null
  return `${from !== null ? formatDateTime(from).slice(0, 10) : 'start'} → ${
    to !== null ? formatDateTime(to).slice(0, 10) : 'end'
  }`
})

const scrubDate = computed(() => {
  if (!scrubbing.value) return hud.value ? formatDateTime(hud.value.date) : '—'
  return formatDateTime(controller.realTimeAt(scrubTime.value))
})

const activity = computed(() => {
  // `timelineStats` changes identity on every timeline rebuild.
  void store.timelineStats
  return controller.activityBuckets(320)
})

function onSeek(value: number): void {
  if (scrubbing.value) scrubTime.value = value
  else controller.seek(value)
}

function onScrubStart(): void {
  scrubbing.value = true
  scrubTime.value = hud.value?.time ?? 0
}

function onScrubEnd(): void {
  controller.seek(scrubTime.value)
  scrubbing.value = false
}

function onFilter(rangeValue: { from: number | null; to: number | null }): void {
  controller.applyFilters({
    from: rangeValue.from !== null ? controller.realTimeAt(rangeValue.from) : null,
    to: rangeValue.to !== null ? controller.realTimeAt(rangeValue.to) : null,
  })
}

function applyDateJump(): void {
  jumpMessage.value = ''
  if (!jumpDate.value) return
  const ms = Date.parse(`${jumpDate.value}T00:00:00Z`)
  if (!Number.isFinite(ms)) {
    jumpMessage.value = 'Invalid date'
    return
  }
  controller.seekToDate(ms)
  jumpMessage.value = `Jumped to ${jumpDate.value}`
}

function applyShaJump(): void {
  jumpMessage.value = ''
  const index = controller.jumpToSha(jumpSha.value)
  jumpMessage.value = index === null ? 'No commit found with that SHA prefix' : `Commit #${index + 1}`
}

function setSpeed(value: number): void {
  controller.setSpeed(value)
}
</script>

<template>
  <div class="playback panel">
    <div class="controls">
      <button class="btn icon" type="button" title="Restart (R)" @click="controller.restart()">⟲</button>
      <button class="btn icon" type="button" title="Previous commit (←)" @click="controller.step(-1)">⏮</button>
      <button class="btn primary play" type="button" :title="hud?.playing ? 'Pause (Space)' : 'Play (Space)'" @click="controller.togglePlay()">
        {{ hud?.playing ? '❚❚' : '▶' }}
      </button>
      <button class="btn icon" type="button" title="Next commit (→)" @click="controller.step(1)">⏭</button>
      <div class="speed">
        <select :value="hud?.speed ?? 1" title="Playback speed" @change="setSpeed(Number(($event.target as HTMLSelectElement).value))">
          <option v-for="speed in SPEEDS" :key="speed" :value="speed">{{ speed }}×</option>
        </select>
      </div>
    </div>

    <div class="scrub-area">
      <TimelineScrubber
        :activity="activity"
        :duration="hud?.duration ?? 0"
        :time="time"
        :filter-from="filterFrom"
        :filter-to="filterTo"
        @seek="onSeek"
        @scrub-start="onScrubStart"
        @scrub-end="onScrubEnd"
        @filter="onFilter"
      />
      <div class="scrub-meta">
        <span class="mono date">{{ scrubDate }}</span>
        <span v-if="filterLabel" class="chip">date filter: {{ filterLabel }}</span>
        <span class="faint mono">
          {{ formatDuration(time) }} / {{ formatDuration(duration) }} · commit
          {{ Math.max(1, (hud?.index ?? 0) + 1) }}/{{ hud?.total ?? 0 }}
        </span>
        <span class="faint mono hidden-small">{{ formatDateTime(range.start).slice(0, 10) }} → {{ formatDateTime(range.end).slice(0, 10) }}</span>
      </div>
    </div>

    <div class="jump">
      <div class="jump-row">
        <input v-model="jumpDate" type="date" title="Jump to a date" aria-label="Jump to date" />
        <button class="btn small" type="button" @click="applyDateJump">Go</button>
      </div>
      <div class="jump-row">
        <input v-model="jumpSha" type="text" placeholder="commit SHA" spellcheck="false" @keyup.enter="applyShaJump" />
        <button class="btn small" type="button" @click="applyShaJump">Find</button>
      </div>
      <span v-if="jumpMessage" class="jump-message faint">{{ jumpMessage }}</span>
    </div>
  </div>
</template>

<style scoped>
.playback {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  z-index: 6;
}

.controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.play {
  min-width: 46px;
  font-size: 15px;
}

.speed select {
  width: 74px;
  padding: 6px 8px;
}

.scrub-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.scrub-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11.5px;
  flex-wrap: wrap;
}

.date {
  font-size: 12.5px;
  color: #dff1ff;
}

.jump {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: none;
  width: 190px;
}

.jump-row {
  display: flex;
  gap: 6px;
}

.jump-row input {
  padding: 5px 8px;
  font-size: 12px;
}

.jump-message {
  font-size: 11px;
}

@media (max-width: 1100px) {
  .jump {
    display: none;
  }

  .hidden-small {
    display: none;
  }
}

@media (max-width: 760px), (max-width: 949px) and (max-height: 480px) {
  .playback {
    left: calc(var(--safe-left) + 8px);
    right: calc(var(--safe-right) + 8px);
    bottom: calc(var(--safe-bottom) + 8px);
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 8px 10px;
  }

  .controls {
    justify-content: space-between;
    gap: 4px;
  }

  .controls .btn {
    min-width: 36px;
    min-height: 36px;
  }

  .controls .play {
    min-width: 52px;
  }

  .speed select {
    width: 68px;
    min-height: 36px;
    padding: 6px;
  }

  .scrub-area {
    gap: 4px;
  }

  .scrub-meta {
    gap: 2px 10px;
    font-size: 11px;
    line-height: 1.35;
  }

  .date {
    font-size: 12px;
  }
}

/*
 * Landscape phones have width but little height. Put the transport beside the
 * scrubber again so the bar stays short and the scene keeps most of the screen.
 */
@media (max-width: 949px) and (max-height: 480px) {
  .playback {
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
  }

  .controls {
    flex: none;
    justify-content: flex-start;
    gap: 4px;
  }

  .controls .btn {
    min-width: 34px;
    min-height: 36px;
    padding: 0 6px;
  }

  .controls .play {
    min-width: 42px;
  }

  .speed select {
    width: 60px;
    min-height: 36px;
    padding: 4px;
  }

  .scrub-area {
    flex: 1;
    min-width: 0;
  }

  .scrub-area :deep(.scrubber) {
    height: 44px;
  }

  .scrub-meta {
    flex-wrap: wrap;
    font-size: 10.5px;
  }
}
</style>
