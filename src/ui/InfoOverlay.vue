<script setup lang="ts">
import { computed } from 'vue'
import { store } from '../state/store'
import { formatDateTime, formatDuration } from '../timeline/schedule'

const hud = computed(() => store.hud)
const stats = computed(() => store.timelineStats)

const changeKindLabel: Record<string, string> = {
  add: 'added',
  modify: 'modified',
  delete: 'deleted',
  rename: 'renamed',
}

const missingLabel = computed(() => {
  const reason = hud.value?.commit?.filesMissingReason
  switch (reason) {
    case 'rate-limit':
      return 'File list unavailable: API quota exhausted'
    case 'merge-parents':
      return 'Merge commit: the host reported no changed files'
    case 'too-large':
      return 'File list unavailable: commit too large'
    case 'error':
      return 'File list unavailable: request failed'
    default:
      return 'File list unavailable'
  }
})

const subject = computed(() => hud.value?.commit?.subject ?? '—')
</script>

<template>
  <div class="info panel">
    <div class="head">
      <div class="date-block">
        <span class="date mono">{{ hud ? formatDateTime(hud.date) : '—' }}</span>
        <span class="faint mono">
          {{ formatDuration(hud?.time ?? 0) }} / {{ formatDuration(hud?.duration ?? 0) }}
          <template v-if="hud"> · {{ hud.fps }} fps</template>
        </span>
      </div>
      <span v-if="hud?.commit?.isMerge" class="badge">merge</span>
    </div>

    <div class="commit">
      <p class="subject" :title="subject">{{ subject }}</p>
      <div class="commit-meta">
        <span v-if="hud?.commit" class="author-dot" :style="{ background: hud.commit.authorColor }" />
        <span class="author">{{ hud?.commit?.author ?? '—' }}</span>
        <span v-if="hud?.commit" class="mono faint">{{ hud.commit.shortSha }}</span>
        <span v-if="hud?.commit" class="faint mono">
          +{{ hud.commit.additions }} / −{{ hud.commit.deletions }}
        </span>
      </div>
    </div>

    <div v-if="hud?.commit && hud.commit.changes.length > 0" class="changes scroll">
      <div v-for="change in hud.commit.changes.slice(0, 9)" :key="change.path + change.kind" class="change-row">
        <span class="chip" :class="change.kind">{{ changeKindLabel[change.kind] }}</span>
        <span class="path mono" :title="change.path">{{ change.path }}</span>
      </div>
      <div v-if="hud.commit.changes.length > 9" class="faint more">
        +{{ hud.commit.changes.length - 9 }} more files in this commit
      </div>
      <div v-if="hud.commit.filesTruncated" class="faint more">
        The host truncated this commit's file list at 300 entries.
      </div>
    </div>

    <div v-else-if="hud?.commit && !hud.commit.filesKnown" class="notice">
      <span class="badge warn">no file data</span>
      <span class="faint">{{ missingLabel }}</span>
    </div>

    <div class="stats">
      <div class="stat">
        <span class="stat-value">{{ hud?.visibleFiles ?? 0 }}</span>
        <span class="stat-label">files in tree</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ hud?.visibleDirs ?? 0 }}</span>
        <span class="stat-label">directories</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ (hud?.totalFiles ?? 0).toLocaleString() }}</span>
        <span class="stat-label">files in history</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ stats?.authors ?? 0 }}</span>
        <span class="stat-label">authors</span>
      </div>
    </div>

    <div v-if="hud && hud.activeAuthors.length > 0" class="authors">
      <span class="section-label">working now</span>
      <div class="author-list">
        <span v-for="author in hud.activeAuthors.slice(0, 4)" :key="author.id" class="author-chip">
          <span class="author-dot" :style="{ background: author.color }" />
          {{ author.name }}
          <span class="faint">{{ author.commits }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.info {
  position: absolute;
  left: 12px;
  bottom: 118px;
  width: min(420px, calc(100vw - 24px));
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  z-index: 5;
  pointer-events: none;
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.date-block {
  display: flex;
  flex-direction: column;
}

.date {
  font-size: 17px;
  color: #e6f4ff;
  letter-spacing: 0.01em;
}

.commit {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.subject {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.commit-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.author-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  box-shadow: 0 0 8px currentColor;
}

.author {
  color: #d6e6ff;
}

.changes {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 150px;
}

.change-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}

.change-row .chip {
  flex: none;
  font-size: 10px;
  padding: 1px 6px;
}

.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
  direction: rtl;
  text-align: left;
}

.more {
  font-size: 11px;
}

.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  border-top: 1px solid var(--panel-border);
  padding-top: 9px;
}

.stat {
  display: flex;
  flex-direction: column;
}

.stat-value {
  font-size: 15px;
  font-weight: 600;
  color: #dcecff;
}

.stat-label {
  font-size: 10px;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.authors {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-faint);
}

.author-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.author-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-dim);
}

@media (max-width: 860px) {
  .info {
    display: none;
  }
}
</style>
