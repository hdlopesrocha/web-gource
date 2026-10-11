<script setup lang="ts">
import { computed, ref } from 'vue'
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

const urlInput = ref(store.url)
const urlFocused = ref(false)

const detection = computed(() => (store.url.trim() ? controller.resolve(store.url) : null))
const activeProviderId = computed(() => detection.value?.providerId ?? null)
const activeDescriptor = computed(() =>
  providerDescriptors.find((descriptor) => descriptor.id === activeProviderId.value) ?? null,
)

const tokenSaved = computed(
  () => Boolean(store.loadOptions.draftToken) || Object.keys(store.loadOptions.tokens).length > 0,
)
const tokenStatus = ref<string | null>(null)
// Reopen the token section when a token is already stored.
const showAdvanced = ref(tokenSaved.value)

const error = computed(() => store.loading.error)
const busy = computed(() => store.loading.active)

function submit(): void {
  if (busy.value) {
    controller.cancelLoad()
    return
  }
  store.url = urlInput.value
  void controller.load(urlInput.value)
}

function loadDemo(): void {
  urlInput.value = 'demo/synthetic-repository'
  void controller.loadDemo()
}

function updateUrl(value: string): void {
  urlInput.value = value
  controller.setUrl(value)
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
          Paste a public Git repository and watch its history grow into an animated 2D map — commits, authors,
          directories and files drawn as circles sized by their real file size, rendered with WebGL in your
          browser.
        </p>
      </header>

      <form class="panel card" @submit.prevent="submit">
        <div class="url-row">
          <div class="url-field" :class="{ focused: urlFocused }">
            <input
              :value="urlInput"
              type="text"
              inputmode="url"
              spellcheck="false"
              autocomplete="off"
              placeholder="https://github.com/owner/repository"
              aria-label="Repository URL"
              @focus="urlFocused = true"
              @blur="urlFocused = false"
              @input="updateUrl(($event.target as HTMLInputElement).value)"
            />
            <span v-if="activeDescriptor" class="provider-badge">{{ activeDescriptor.name }}</span>
          </div>
          <button class="btn primary load" type="submit">
            <span v-if="busy" class="spinner" />
            {{ busy ? 'Cancel' : 'Load Repository' }}
          </button>
        </div>

        <div class="provider-line">
          <span v-if="detection" class="muted">
            Detected provider: <strong>{{ detection.label }}</strong>
          </span>
          <span v-else-if="store.url.trim()" class="muted">
            No provider matches this input yet — supported: github.com, GitHub Enterprise, gitlab.com.
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
          <button class="btn ghost small" type="button" @click="loadDemo">Try the synthetic demo</button>
        </div>

        <div v-if="showAdvanced" class="advanced">
          <TokenField :provider-id="activeProviderId" @saved="tokenStatus = null" />
          <p class="hint muted">
            Create a token:
            <a v-if="activeDescriptor?.tokenUrl" :href="activeDescriptor.tokenUrl" target="_blank" rel="noreferrer noopener">
              {{ activeDescriptor.name }} token settings
            </a>
            <span v-else>GitHub: Settings → Developer settings → Personal access tokens; GitLab: User settings → Access tokens.</span>
          </p>
          <p class="hint muted">
            GitHub allows 60 requests/hour anonymously. Since file changes cost one request per commit, anonymous
            loads are limited to roughly 50 commits; a token raises the limit to 5000 requests/hour.
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
          @click="updateUrl(example.url)"
        >
          {{ example.label }}
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
          <h3>Flat Gource-style map</h3>
          <p>
            Instanced WebGL circles on a plane: directories branch out, files are sized by their real file size,
            author avatars move between them, and effects are colour-coded per change type.
          </p>
        </div>
        <div class="feature">
          <h3>Playback & export</h3>
          <p>
            Seek, scrub, filter by author or date, change pacing, switch circle sizing between file size and line
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

.url-row {
  display: flex;
  gap: 10px;
  align-items: stretch;
}

.url-field {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
}

.url-field input {
  padding: 13px 14px;
  font-size: 15px;
  padding-right: 120px;
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

.load {
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
  .url-row {
    flex-direction: column;
  }

  .content {
    padding: 28px 16px 48px;
  }
}
</style>
