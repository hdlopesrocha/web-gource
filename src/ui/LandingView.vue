<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { controller } from '../engine/controller'
import { loadingPercent, providerDescriptors, store } from '../state/store'
import TokenField from './TokenField.vue'

const SNAPSHOT_CHOICES = [
  { value: 50, label: '50 commits', hint: 'Works with the anonymous GitHub quota.' },
  { value: 150, label: '150 commits', hint: 'Default. Needs a token for GitHub (60 requests/hour without one).' },
  { value: 400, label: '400 commits', hint: 'Recommended with a personal access token.' },
  { value: 1000, label: '1000 commits', hint: 'Large snapshot, a token is strongly recommended.' },
  { value: 4000, label: '4000 commits', hint: 'Very large snapshot. Expect a long load and heavy GPU usage.' },
]

// A one-click set of projects for the multi-repository scene. The bare
// `hdlopesrocha/` owner page is not a repository, so it is intentionally left out.
const BULK_REPOSITORIES = [
  'hdlopesrocha/lithos-engine',
  'hdlopesrocha/vulkan-engine',
  'hdlopesrocha/infinity-edge-web',
  'hdlopesrocha/card-generator',
  'hdlopesrocha/lora-control',
  'hdlopesrocha/opencode-talk',
  'hdlopesrocha/web-gource',
  'hdlopesrocha/hdlopesrocha.github.io',
  'hdlopesrocha/sdf-smoke',
  'hdlopesrocha/hydrogen-vulkan',
  'hdlopesrocha/cardgame',
]
const bulkFillLabel = `Fill all ${BULK_REPOSITORIES.length} repositories`

// Pre-fill the projects from the last run. Profiles saved before multiple
// projects only have `lastUrl`, which the store already migrated to `urls`.
const initialUrls = store.loadOptions.urls.length > 0
  ? [...store.loadOptions.urls]
  : store.url.trim()
    ? [store.url]
    : []
const rows = ref<string[]>(initialUrls.length > 0 ? initialUrls : [''])
const focusedRow = ref<number | null>(null)
const tokenStatus = ref<string | null>(null)

const filledRows = computed(() => rows.value.map((row) => row.trim()).filter(Boolean))
const detections = computed(() =>
  filledRows.value.map((url) => ({ url, resolved: controller.resolve(url) })),
)
const invalidRows = computed(() =>
  detections.value.filter((entry) => !entry.resolved).map((entry) => entry.url),
)
const providerIds = computed(() => [
  ...new Set(
    detections.value.flatMap((entry) => (entry.resolved ? [entry.resolved.providerId] : [])),
  ),
])
const providerNames = computed(() =>
  providerIds.value.map((id) => providerDescriptors.find((descriptor) => descriptor.id === id)?.name ?? id),
)

// The token field edits one host at a time. It follows the first detected host,
// and mixed lists get a small selector so a token can be stored for each one.
const tokenProviderId = ref<string | null>(providerIds.value[0] ?? null)
watch(providerIds, (ids) => {
  if (!tokenProviderId.value || !ids.includes(tokenProviderId.value)) tokenProviderId.value = ids[0] ?? null
})
const tokenDescriptor = computed(
  () => providerDescriptors.find((descriptor) => descriptor.id === tokenProviderId.value) ?? null,
)

const tokenSaved = computed(
  () => Boolean(store.loadOptions.draftToken) || Object.keys(store.loadOptions.tokens).length > 0,
)
// Reopen the token section when a token is already stored.
const showAdvanced = ref(tokenSaved.value)

const error = computed(() => store.loading.error)
const busy = computed(() => store.loading.active)
const loadLabel = computed(() =>
  busy.value
    ? 'Cancel'
    : filledRows.value.length > 1
      ? `Load ${filledRows.value.length} repositories`
      : 'Load Repository',
)

function providerName(id: string): string {
  return providerDescriptors.find((descriptor) => descriptor.id === id)?.name ?? id
}

function rowProvider(index: number): { providerId: string; label: string } | null {
  const value = rows.value[index]?.trim()
  return value ? controller.resolve(value) : null
}

/** Keep the single-URL view of the store in sync with the first project. */
function syncUrl(): void {
  // `setUrl` also clears a provider forced by a previous run (the demo), so a
  // real URL typed afterwards is detected from its host, not as the demo.
  controller.setUrl(filledRows.value[0] ?? '')
}

function submit(): void {
  if (busy.value) {
    controller.cancelLoad()
    return
  }
  const urls = filledRows.value
  if (urls.length === 0) {
    store.loading.error = 'Add at least one repository URL.'
    return
  }
  const invalid = urls.filter((url) => !controller.resolve(url))
  if (invalid.length > 0) {
    store.loading.error = `No provider matches ${invalid.join(', ')}. Supported: github.com, GitHub Enterprise, gitlab.com.`
    return
  }
  void controller.loadMany(urls)
}

function loadDemo(): void {
  rows.value = ['demo/synthetic-repository']
  store.url = 'demo/synthetic-repository'
  void controller.loadDemo()
}

function addRow(): void {
  rows.value.push('')
  focusedRow.value = rows.value.length - 1
}

function removeRow(index: number): void {
  rows.value.splice(index, 1)
  if (rows.value.length === 0) rows.value.push('')
  if (focusedRow.value !== null) {
    if (focusedRow.value === index) focusedRow.value = null
    else if (focusedRow.value > index) focusedRow.value -= 1
  }
  syncUrl()
}

/** Put an example in the first empty row, or add a new project for it. */
function applyExample(url: string): void {
  const empty = rows.value.findIndex((row) => !row.trim())
  if (empty >= 0) rows.value[empty] = url
  else rows.value.push(url)
  store.loading.error = null
  syncUrl()
}

/**
 * Replace the rows with a prepared multi-repository list. This only fills the
 * form: loading still starts from the primary load button.
 */
function fillAllRepositories(): void {
  rows.value = [...BULK_REPOSITORIES]
  focusedRow.value = null
  store.loading.error = null
  syncUrl()
}

const examples = [
  { url: 'https://github.com/hdlopesrocha/vulkan-engine', label: 'hdlopesrocha/vulkan-engine' },
  { url: 'https://github.com/hdlopesrocha/opencode-talk', label: 'hdlopesrocha/opencode-talk' },
  { url: 'https://github.com/vuejs/core', label: 'vuejs/core' },
  { url: 'https://gitlab.com/gitlab-org/gitlab-foss', label: 'gitlab-foss (GitLab, beta)' },
]
</script>

<template>
  <div class="landing">
    <div class="backdrop" aria-hidden="true">
      <div class="glow glow-a" />
      <div class="glow glow-b" />
      <div class="grid" />
    </div>

    <div class="content scroll">
      <header class="hero">
        <div class="logo">
          <span class="dot" />
          <h1>Web Gource</h1>
        </div>
        <p class="tagline">
          Add one or more public Git repositories and watch their histories grow side by side in one animated 3D
          map — commits, authors, and files and folders drawn as lit spheres sized by their real file size, rendered
          with WebGL in your browser. Each project keeps its own tree and its own people: the same contributor
          appears once per project. Orbit, pan and zoom with the mouse or a touch gesture.
        </p>
      </header>

      <form class="panel card" @submit.prevent="submit">
        <div class="repo-list">
          <div v-for="(row, index) in rows" :key="index" class="repo-row">
            <div class="url-field" :class="{ focused: focusedRow === index }">
              <input
                :value="row"
                type="text"
                inputmode="url"
                spellcheck="false"
                autocomplete="off"
                :placeholder="rows.length > 1 ? `Repository ${index + 1} URL` : 'https://github.com/owner/repository'"
                aria-label="Repository URL"
                @focus="focusedRow = index"
                @blur="focusedRow = null"
                @input="rows[index] = ($event.target as HTMLInputElement).value; syncUrl()"
              />
              <span v-if="rowProvider(index)" class="provider-badge">{{ rowProvider(index)?.label }}</span>
            </div>
            <button
              class="icon-btn"
              type="button"
              :title="`Remove repository ${index + 1}`"
              :aria-label="`Remove repository ${index + 1}`"
              @click="removeRow(index)"
            >
              ✕
            </button>
          </div>
        </div>

        <div class="repo-actions">
          <button class="btn small add-repo" type="button" @click="addRow">＋ Add repository</button>
          <span class="grow" />
          <button class="btn primary load" type="submit">
            <span v-if="busy" class="spinner" />
            {{ loadLabel }}
          </button>
          <button class="btn primary demo" type="button" @click="loadDemo">Try the synthetic demo</button>
        </div>

        <div class="provider-line">
          <span v-if="invalidRows.length > 0" class="muted">
            No provider matches <strong>{{ invalidRows.join(', ') }}</strong> — supported: github.com, GitHub
            Enterprise, gitlab.com.
          </span>
          <span v-else-if="providerNames.length > 0" class="muted">
            {{ filledRows.length === 1 ? 'Detected provider' : 'Detected providers' }}:
            <strong>{{ providerNames.join(', ') }}</strong>
            <template v-if="filledRows.length > 1"> · {{ filledRows.length }} projects will share one scene</template>
          </span>
          <span v-else class="muted">No cloning, no uploads, no CLI — history is fetched straight from the host API.</span>
        </div>

        <div v-if="store.loading.active || store.loading.status" class="progress-block">
          <div class="progress-head">
            <span class="row">
              <span v-if="store.loading.active" class="spinner" />
              <span>{{ store.loading.status || 'Working…' }}</span>
            </span>
            <span class="muted mono">
              {{ store.loading.loaded }}/{{ store.loading.target || store.loadOptions.maxCommits }} commits ·
              {{ store.loading.requests }} requests
              <template v-if="store.loading.rateRemaining !== undefined">
                · {{ store.loading.rateRemaining }} left
              </template>
            </span>
          </div>
          <div class="bar">
            <div class="bar-fill" :style="{ width: `${Math.max(4, loadingPercent)}%` }" />
          </div>
        </div>

        <div v-if="error" class="alert error">
          <strong>Could not load the repository.</strong>
          <span>{{ error }}</span>
        </div>

        <div class="options">
          <div class="field">
            <label for="snapshot">Snapshot size</label>
            <select id="snapshot" v-model.number="store.loadOptions.maxCommits">
              <option v-for="choice in SNAPSHOT_CHOICES" :key="choice.value" :value="choice.value">
                {{ choice.label }}
              </option>
            </select>
          </div>
          <div class="field">
            <label for="range">History range</label>
            <select id="range" v-model="store.loadOptions.range">
              <option value="latest">Newest commits</option>
              <option value="earliest">From the first commit</option>
            </select>
          </div>
          <div class="field">
            <label for="branch">Branch or ref (optional)</label>
            <input id="branch" v-model="store.loadOptions.branch" type="text" placeholder="default branch" />
          </div>
        </div>

        <p class="hint muted">
          {{
            SNAPSHOT_CHOICES.find((choice) => choice.value === store.loadOptions.maxCommits)?.hint ??
            'Pick how much history to visualize.'
          }}
        </p>

        <div class="card-footer">
          <button class="btn ghost small" type="button" @click="showAdvanced = !showAdvanced">
            {{ showAdvanced ? 'Hide' : 'Advanced' }} · token &amp; rate limits{{ tokenSaved ? ' ✓' : '' }}
          </button>
        </div>

        <div v-if="showAdvanced" class="advanced">
          <div v-if="providerIds.length > 1" class="field token-provider">
            <label for="token-provider">Token host</label>
            <select id="token-provider" v-model="tokenProviderId">
              <option v-for="id in providerIds" :key="id" :value="id">{{ providerName(id) }}</option>
            </select>
          </div>
          <TokenField :provider-id="tokenProviderId" @saved="tokenStatus = null" />
          <p class="hint muted">
            Create a token:
            <a v-if="tokenDescriptor?.tokenUrl" :href="tokenDescriptor.tokenUrl" target="_blank" rel="noreferrer noopener">
              {{ tokenDescriptor.name }} token settings
            </a>
            <span v-else>GitHub: Settings → Developer settings → Personal access tokens; GitLab: User settings → Access tokens.</span>
          </p>
          <p class="hint muted">
            GitHub allows 60 requests/hour anonymously. Since file changes cost one request per commit, anonymous
            loads are limited to roughly 50 commits; a token raises the limit to 5000 requests/hour. The limit is
            per host, so each host needs its own token.
          </p>
        </div>
      </form>

      <section class="examples">
        <span class="muted">Examples:</span>
        <button
          v-for="example in examples"
          :key="example.url"
          class="btn small"
          type="button"
          @click="applyExample(example.url)"
        >
          {{ example.label }}
        </button>
        <button
          class="btn small fill-all"
          type="button"
          :title="`Replace the list with all ${BULK_REPOSITORIES.length} hdlopesrocha repositories`"
          @click="fillAllRepositories"
        >
          {{ bulkFillLabel }}
        </button>
      </section>

      <section class="features">
        <div class="feature">
          <h3>Real history</h3>
          <p>
            Commit messages, authors, timestamps and changed files come from the provider API. When a host cannot
            deliver file data, the app says so instead of inventing it.
          </p>
        </div>
        <div class="feature">
          <h3>3D Gource-style map</h3>
          <p>
            Instanced lit spheres on a Gource-style plane, seen through a perspective camera: folders branch out,
            files are sized by their real file size, author avatars move between them, and effects are colour-coded
            per change type. Orbit, pan and zoom with the mouse or a touch gesture.
          </p>
        </div>
        <div class="feature">
          <h3>Playback & export</h3>
          <p>
            Seek, scrub, filter by author or date, change pacing, switch sphere sizing between file size and line
            activity, then export the animation to WebM/MP4 with the browser's own recorder.
          </p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.landing {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.backdrop {
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 20% 15%, #0d1730 0%, var(--bg-0) 55%);
}

.glow {
  position: absolute;
  width: 60vw;
  height: 60vw;
  border-radius: 50%;
  filter: blur(90px);
  opacity: 0.35;
}

.glow-a {
  top: -20vw;
  left: -10vw;
  background: rgba(47, 125, 224, 0.4);
}

.glow-b {
  bottom: -30vw;
  right: -15vw;
  background: rgba(143, 123, 255, 0.32);
}

.grid {
  position: absolute;
  inset: 0;
  background-image: linear-gradient(rgba(120, 160, 220, 0.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(120, 160, 220, 0.07) 1px, transparent 1px);
  background-size: 46px 46px;
  mask-image: radial-gradient(circle at 50% 40%, black 0%, transparent 70%);
}

.content {
  position: relative;
  height: 100%;
  max-width: 940px;
  margin: 0 auto;
  padding: 48px 24px 64px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.hero h1 {
  font-size: 34px;
  letter-spacing: -0.02em;
}

.logo {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #b6ecff, #2f7de0);
  box-shadow: 0 0 18px rgba(94, 200, 255, 0.8);
}

.tagline {
  margin: 10px 0 0;
  color: var(--text-dim);
  max-width: 720px;
  font-size: 15px;
}

.card {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.repo-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.repo-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.url-field {
  position: relative;
  flex: 1;
  min-width: 220px;
  display: flex;
  align-items: center;
}

.url-field input {
  padding: 13px 14px;
  font-size: 15px;
  padding-right: 120px;
}

.icon-btn {
  width: 36px;
  flex: none;
  border-radius: var(--radius-sm);
  border: 1px solid var(--panel-border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
}

.icon-btn:hover {
  color: #ffd9de;
  border-color: rgba(255, 93, 108, 0.45);
  background: rgba(255, 93, 108, 0.1);
}

.repo-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: stretch;
}

.repo-actions .grow {
  flex: 1;
}

.add-repo {
  align-self: center;
}

.token-provider {
  max-width: 260px;
}

.provider-badge {
  position: absolute;
  right: 10px;
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #bfe3ff;
  background: rgba(47, 125, 224, 0.22);
  border: 1px solid rgba(94, 200, 255, 0.35);
  border-radius: 999px;
  padding: 4px 10px;
  pointer-events: none;
}

.load,
.demo {
  padding: 0 22px;
  font-size: 15px;
}

.provider-line {
  font-size: 13px;
}

.progress-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.progress-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.bar {
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #2f7de0, #6ad6ff);
  transition: width 0.25s ease;
}

.alert {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
}

.alert.error {
  background: rgba(255, 93, 108, 0.12);
  border: 1px solid rgba(255, 93, 108, 0.4);
  color: #ffd9de;
}

.options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.hint {
  font-size: 12px;
  margin: 0;
}

.hint.ok {
  color: var(--add);
}

.hint.warn {
  color: var(--modify);
}

.card-footer {
  display: flex;
  gap: 8px;
  border-top: 1px solid var(--panel-border);
  padding-top: 12px;
  margin-top: 2px;
}

.advanced {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: var(--radius-sm);
  background: rgba(8, 12, 22, 0.6);
  border: 1px solid var(--panel-border);
}

.token-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.token-row input {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 12.5px;
}

.examples {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
}

.fill-all {
  border-color: rgba(94, 200, 255, 0.38);
  background: rgba(47, 125, 224, 0.16);
  color: #d6efff;
}

.fill-all:hover:not(:disabled) {
  border-color: rgba(94, 200, 255, 0.6);
  background: rgba(47, 125, 224, 0.26);
}

.features {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
  margin-top: 4px;
}

.feature {
  padding: 16px;
  border-radius: var(--radius);
  border: 1px solid var(--panel-border);
  background: rgba(10, 15, 27, 0.6);
}

.feature h3 {
  font-size: 14px;
  margin-bottom: 6px;
  color: #cfe6ff;
}

.feature p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-dim);
}

@media (max-width: 720px) {
  .content {
    padding: 24px 16px 40px;
    gap: 18px;
  }

  .hero h1 {
    font-size: clamp(26px, 7vw, 34px);
  }

  .tagline {
    margin-top: 8px;
    font-size: 14px;
  }

  .card {
    padding: 16px;
    gap: 12px;
  }

  .repo-list {
    gap: 10px;
  }

  .url-field {
    min-width: 0;
  }

  .url-field input {
    padding: 12px;
    font-size: 14px;
  }

  /* The detected-provider line below the form already names every host. */
  .provider-badge {
    display: none;
  }

  .icon-btn {
    width: 44px;
    min-height: 44px;
    font-size: 15px;
  }

  .repo-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .repo-actions .grow {
    display: none;
  }

  .add-repo {
    align-self: stretch;
    min-height: 44px;
  }

  .load,
  .demo {
    width: 100%;
    min-height: 48px;
    padding: 0 18px;
    white-space: normal;
  }

  .provider-line,
  .hint,
  .alert {
    overflow-wrap: anywhere;
  }

  .progress-head {
    flex-direction: column;
    gap: 4px;
  }

  .options {
    grid-template-columns: 1fr;
  }

  .options select,
  .options input,
  .token-provider select {
    min-height: 44px;
  }

  .token-provider {
    max-width: none;
  }

  .card-footer .btn {
    min-height: 44px;
  }

  .advanced {
    padding: 12px;
  }

  .advanced :deep(.token-field .row) {
    flex-wrap: wrap;
  }

  .advanced :deep(.token-field .row .btn),
  .advanced :deep(.token-input) {
    min-height: 44px;
  }

  .examples {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .examples .btn {
    width: 100%;
    min-height: 44px;
    white-space: normal;
  }

  .features {
    grid-template-columns: 1fr;
    gap: 12px;
  }
}

@media (max-width: 480px) {
  .content {
    padding: 20px 12px 32px;
    gap: 16px;
  }

  .hero h1 {
    font-size: clamp(24px, 8vw, 30px);
  }

  .tagline {
    font-size: 13.5px;
  }

  .card {
    padding: 14px;
  }

  .repo-row {
    flex-direction: column;
    gap: 6px;
  }

  .repo-row .icon-btn {
    align-self: flex-end;
    width: 44px;
    min-height: 44px;
  }

  .advanced :deep(.token-input) {
    flex: 1 1 100%;
  }

  .advanced :deep(.token-field .row .btn) {
    flex: 1 1 auto;
  }

  .alert {
    padding: 10px 12px;
  }

  .feature {
    padding: 14px;
  }
}
</style>
