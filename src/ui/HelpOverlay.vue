<script setup lang="ts">
defineEmits<{ (event: 'close'): void }>()

const shortcuts: { keys: string; action: string }[] = [
  { keys: 'Space', action: 'Play / pause' },
  { keys: '← / →', action: 'Previous / next commit' },
  { keys: 'Shift + ← / →', action: 'Seek 5 seconds' },
  { keys: 'Home / End', action: 'Jump to the start / end' },
  { keys: '+ / −', action: 'Faster / slower playback' },
  { keys: 'R', action: 'Restart playback' },
  { keys: 'C', action: 'Recentre the camera' },
  { keys: 'L', action: 'Toggle labels' },
  { keys: 'M', action: 'Toggle the minimap' },
  { keys: 'A', action: 'Toggle the authors panel' },
  { keys: 'S', action: 'Toggle settings' },
  { keys: 'F', action: 'Fullscreen' },
  { keys: '?', action: 'This help' },
]
</script>

<template>
  <div class="help-backdrop" @click.self="$emit('close')">
    <div class="help panel scroll">
      <header class="head">
        <h2>How Web Gource works</h2>
        <button class="btn ghost small" type="button" @click="$emit('close')">✕</button>
      </header>

      <section>
        <h3>Keyboard & mouse</h3>
        <ul class="grid">
          <li v-for="shortcut in shortcuts" :key="shortcut.keys">
            <span class="keys mono">{{ shortcut.keys }}</span>
            <span class="muted">{{ shortcut.action }}</span>
          </li>
        </ul>
        <p class="faint small">
          Drag to orbit · right-drag or shift-drag to pan · scroll to zoom. Manual input pauses the automatic camera
          for a few seconds.
        </p>
      </section>

      <section>
        <h3>Where the data comes from</h3>
        <p class="muted small">
          Repository history is read straight from the host's REST API in your browser — nothing is uploaded to a
          server by this app, and no repository is cloned. Commits, authors, timestamps, messages and changed file
          paths are taken verbatim from the API. When a host cannot deliver file-level data (GitHub rate limits,
          merge commits the API reports without files, truncated 300-file commits), the commit is still shown and the
          gap is marked instead of being filled with invented data.
        </p>
      </section>

      <section>
        <h3>Rate limits & quotas</h3>
        <ul class="bullets muted small">
          <li>GitHub allows <strong>60 requests/hour</strong> anonymously. The commit list is cheap (1 request per 100 commits) but file changes cost one request per commit, so anonymous loads stop at roughly 50 commits.</li>
          <li>Add a personal access token in the repository screen (it is stored only in your browser) to raise the quota to 5,000 requests/hour and to load private repositories.</li>
          <li>Everything fetched is cached locally, so reloading the same repository costs almost no quota.</li>
          <li>When a quota runs out mid-load, the commits already retrieved are kept and the rest are marked as missing file data.</li>
          <li>Very large repositories are loaded as a window: pick a snapshot size, or start from the first commit to watch the project grow from its beginning.</li>
        </ul>
      </section>

      <section>
        <h3>Deterministic playback</h3>
        <p class="muted small">
          The same history with the same settings always produces the same sequence of events: scheduling, layout and
          visibility are derived purely from commit data (idle gaps are compressed with a fixed, documented curve).
          Seeking re-evaluates the scene from the timeline rather than replaying it, so scrubbing is instant and still
          exact.
        </p>
      </section>

      <section>
        <h3>Video export</h3>
        <p class="muted small">
          Export uses the browser's <code>MediaRecorder</code> with <code>canvas.captureStream()</code>. Recording
          renders at a fixed resolution and advances the timeline by exactly one frame step per captured frame, so the
          exported video is a faithful sampling of the animation. Available codecs depend on the browser — WebM
          (VP9/VP8) is offered where supported, MP4 (H.264) in browsers that can produce it. Keep the tab focused while
          recording; background tabs throttle rendering and produce a stuttery file.
        </p>
      </section>

      <section>
        <h3>Not affiliated</h3>
        <p class="faint small">
          Inspired by the original Gource by Andrew Caudwell. This is an independent browser implementation with its
          own renderer; it shares no code with the original.
        </p>
      </section>

      <footer>
        <button class="btn primary" type="button" @click="$emit('close')">Got it</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.help-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(3, 5, 10, 0.72);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  z-index: 20;
}

.help {
  width: min(720px, 100%);
  max-height: 100%;
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.head h2 {
  font-size: 18px;
}

section h3 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-faint);
  margin-bottom: 8px;
}

section p {
  margin: 0;
}

.small {
  font-size: 12.5px;
}

.grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 6px 16px;
  font-size: 12.5px;
}

.grid li {
  display: flex;
  align-items: center;
  gap: 10px;
}

.keys {
  min-width: 96px;
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--panel-border);
  font-size: 11.5px;
  text-align: center;
}

.bullets {
  margin: 0;
  padding-left: 18px;
}

.bullets li {
  margin-bottom: 6px;
}

footer {
  display: flex;
  justify-content: flex-end;
}
</style>
