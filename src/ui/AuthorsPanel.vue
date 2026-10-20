<script setup lang="ts">
import { computed, ref } from 'vue'
import { controller } from '../engine/controller'
import { store } from '../state/store'
import { formatDate } from '../timeline/schedule'

const emit = defineEmits<{ (event: 'close'): void }>()

const search = ref('')
const authors = computed(() => {
  // Recompute whenever the timeline is rebuilt (filters, incremental loading).
  void store.timelineStats
  return controller.timelineAuthors()
})
const hidden = computed(() => new Set(store.hiddenAuthors))
const totalCommits = computed(() => store.timelineStats?.commits ?? 1)
const projectCount = computed(() => store.repos.length)
const multiProject = computed(() => projectCount.value > 1)

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase()
  const list = authors.value
  if (!needle) return list
  return list.filter(
    (author) =>
      author.name.toLowerCase().includes(needle) ||
      author.email?.toLowerCase().includes(needle) ||
      author.projectName?.toLowerCase().includes(needle),
  )
})

const dateFrom = computed({
  get: () => (store.dateRange.from !== null ? formatDate(store.dateRange.from) : ''),
  set: (value: string) => {
    const ms = value ? Date.parse(`${value}T00:00:00Z`) : null
    controller.applyFilters({ from: Number.isFinite(ms) ? (ms as number) : null })
  },
})

const dateTo = computed({
  get: () => (store.dateRange.to !== null ? formatDate(store.dateRange.to) : ''),
  set: (value: string) => {
    const ms = value ? Date.parse(`${value}T23:59:59Z`) : null
    controller.applyFilters({ to: Number.isFinite(ms) ? (ms as number) : null })
  },
})

const rangeLimits = computed(() => ({
  min: formatDate(controller.realRange().start),
  max: formatDate(controller.realRange().end),
}))

function toggle(authorId: string): void {
  controller.toggleAuthor(authorId)
}

function showAll(): void {
  controller.applyFilters({ hiddenAuthors: [] })
}
</script>

<template>
  <aside class="authors panel">
    <header class="head">
      <div>
        <h2>Authors & filters</h2>
        <p class="faint">
          {{ authors.length }} {{ multiProject ? 'author instances' : 'authors' }}
          <template v-if="multiProject">across {{ projectCount }} projects</template>
          · {{ totalCommits.toLocaleString() }} commits in view
        </p>
      </div>
      <button class="btn ghost small" type="button" @click="emit('close')">✕</button>
    </header>

    <div class="filters">
      <div class="field">
        <label>Show commits between</label>
        <div class="date-row">
          <input v-model="dateFrom" type="date" :min="rangeLimits.min" :max="rangeLimits.max" />
          <span class="faint">→</span>
          <input v-model="dateTo" type="date" :min="rangeLimits.min" :max="rangeLimits.max" />
        </div>
        <span class="faint hint">Repository history spans {{ rangeLimits.min }} → {{ rangeLimits.max }}</span>
      </div>
      <div class="row">
        <input v-model="search" type="text" placeholder="Filter authors…" />
        <button class="btn small" type="button" @click="showAll">Show all</button>
      </div>
      <button class="btn small" type="button" @click="controller.clearFilters()">Clear every filter</button>
    </div>

    <ul class="list scroll">
      <li v-for="author in filtered" :key="author.id" :class="{ off: hidden.has(author.id) }">
        <button class="author-row" type="button" @click="toggle(author.id)">
          <span class="toggle">{{ hidden.has(author.id) ? '○' : '●' }}</span>
          <span class="name">{{ author.name }}</span>
          <span class="faint mono">{{ author.commits }}</span>
        </button>
        <div class="bar">
          <div class="bar-fill" :style="{ width: `${Math.max(2, (author.commits / Math.max(1, authors[0]?.commits ?? 1)) * 100)}%` }" />
        </div>
        <div class="meta faint">
          <span v-if="author.login">@{{ author.login }}</span>
          <span v-else-if="author.email" class="mono">{{ author.email }}</span>
          <span v-else class="badge">name only</span>
          <span class="mono">{{ formatDate(author.first) }} → {{ formatDate(author.last) }}</span>
        </div>
        <div v-if="multiProject && author.projectName" class="project-line">
          <span class="badge project">{{ author.projectName }}</span>
        </div>
      </li>
      <li v-if="filtered.length === 0" class="faint empty">No author matches “{{ search }}”.</li>
    </ul>
  </aside>
</template>

<style scoped>
.authors {
  position: absolute;
  left: 12px;
  top: 68px;
  bottom: 200px;
  width: min(340px, calc(100vw - 24px));
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  z-index: 8;
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

.filters {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--panel-border);
}

.date-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.date-row input {
  padding: 5px 7px;
  font-size: 12px;
}

.hint {
  font-size: 10.5px;
}

.hint code {
  padding: 0 3px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 10px;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0 2px 0 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

.list li.off {
  opacity: 0.45;
}

.author-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 3px 0;
  text-align: left;
  font-size: 12.5px;
}

.toggle {
  color: var(--accent);
  font-size: 11px;
  width: 12px;
}

.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar {
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  background: linear-gradient(90deg, rgba(94, 200, 255, 0.8), rgba(143, 123, 255, 0.6));
}

.meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  margin-top: 2px;
}

.project-line {
  margin-top: 3px;
}

.badge.project {
  font-size: 9.5px;
  padding: 1px 6px;
  color: #bfe3ff;
  background: rgba(47, 125, 224, 0.16);
  border-color: rgba(94, 200, 255, 0.28);
}

.empty {
  font-size: 12px;
}
</style>
