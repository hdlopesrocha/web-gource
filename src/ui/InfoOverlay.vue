<script setup lang="ts">
import { computed } from 'vue'
import { store } from '../state/store'
import { formatBytes } from '../util/format'
import { buildInfoPanelModel } from '../render/info-panel'

const hud = computed(() => store.hud)
const stats = computed(() => store.timelineStats)

/**
 * The same model the video compositor draws, so the panel and the exported
 * frame always show the same content.
 */
function shortProject(project: string): string {
  const parts = project.split('/')
  return parts[parts.length - 1] ?? project
}

const model = computed(() =>
  buildInfoPanelModel({
    date: hud.value?.date ?? 0,
    time: hud.value?.time ?? 0,
    duration: hud.value?.duration ?? 0,
    fps: hud.value?.fps ?? 0,
    commit: hud.value?.commit ?? null,
    visibleFiles: hud.value?.visibleFiles ?? 0,
    visibleDirs: hud.value?.visibleDirs ?? 0,
    totalFiles: hud.value?.totalFiles ?? 0,
    totalBytes: hud.value?.totalBytes ?? 0,
    authors: stats.value?.authors ?? 0,
    activeAuthors: hud.value?.activeAuthors ?? [],
  }),
)
</script>

<template>
  <div class="info panel">
    <div class="head">
      <div class="date-block">
        <span class="date mono">{{ model.dateLabel }}</span>
        <span class="faint mono">
          {{ model.timeLabel }}
          <template v-if="hud"> · {{ model.fpsLabel }}</template>
        </span>
      </div>
      <span v-if="model.isMerge" class="badge">merge</span>
    </div>

    <div class="commit">
      <p class="subject" :title="model.subject">{{ model.subject }}</p>
      <div class="commit-meta">
        <span v-if="model.author" class="author-dot" :style="{ background: model.author.color }" />
        <span class="author">{{ model.author?.name ?? '—' }}</span>
        <span v-if="model.project" class="badge project">{{ model.project }}</span>
        <span v-if="model.author" class="mono faint">{{ model.author.shortSha }}</span>
        <span v-if="model.author" class="faint mono">
          +{{ model.author.additions }} / −{{ model.author.deletions }}
        </span>
      </div>
    </div>

    <div v-if="model.changes.length > 0" class="changes scroll">
      <div v-for="change in model.changes" :key="change.path + change.kind" class="change-row">
        <span class="chip" :class="change.kind">{{ change.label }}</span>
        <span class="path mono" :title="change.path">{{ change.path }}</span>
        <span v-if="change.size !== undefined" class="size mono faint">{{ formatBytes(change.size) }}</span>
      </div>
      <div v-if="model.moreFiles > 0" class="faint more">
        +{{ model.moreFiles }} more files in this commit
      </div>
      <div v-if="model.truncated" class="faint more">
        The host truncated this commit's file list at 300 entries.
      </div>
    </div>

    <div v-else-if="model.missing" class="notice">
      <span class="badge warn">no file data</span>
      <span class="faint">{{ model.missing }}</span>
    </div>

    <div class="stats">
      <div v-for="stat in model.stats" :key="stat.label" class="stat">
        <span class="stat-value">{{ stat.value }}</span>
        <span class="stat-label">{{ stat.label }}</span>
      </div>
    </div>

    <div v-if="model.workingNow.length > 0" class="authors">
      <span class="section-label">working now</span>
      <div class="author-list">
        <span v-for="author in model.workingNow" :key="author.id" class="author-chip" :title="author.project">
          <span class="author-dot" :style="{ background: author.color }" />
          {{ author.name }}
          <span v-if="author.project" class="faint project-tag">{{ shortProject(author.project) }}</span>
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

.badge.project {
  font-size: 9.5px;
  padding: 1px 6px;
  color: #bfe3ff;
  background: rgba(47, 125, 224, 0.16);
  border-color: rgba(94, 200, 255, 0.28);
}

.project-tag {
  font-size: 9.5px;
  opacity: 0.75;
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

.size {
  flex: none;
  font-size: 10px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
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

@media (max-width: 860px), (max-width: 949px) and (max-height: 480px) {
  .info {
    display: none;
  }
}
</style>
