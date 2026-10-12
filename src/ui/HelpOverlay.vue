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
          The scene is flat: drag to pan, scroll to zoom (the point under the pointer stays anchored). Manual input
          pauses the automatic view for a few seconds.
        </p>
      </section>

      <section>
        <h3>Reading the activity</h3>
        <p class="muted small">
          Every commit is shown while it happens: the changed files pulse in the colour of the change (green added,
          amber modified, red deleted, violet renamed) and a beam connects each of them to the author who made the
          change. Avatars move with a spring rather than jumping, so you can follow a contributor across the tree,
          and the file labels name what was just touched.
        </p>
      </section>

      <section>
        <h3>Branches</h3>
        <p class="muted small">
          The branch lines follow the Gource convention: they are drawn behind the nodes, so a line
          passing across a file circle or a directory ring disappears behind it, and each line starts
          at the edge of its parent and stops at the edge of its child instead of running into the
          middle of a circle. Edge dimming is adjustable in Settings → Visual.
        </p>
      </section>

      <section>
        <h3>Dynamic layout</h3>
        <p class="muted small">
          The tree is packed hierarchically. Every folder knows the size of its whole cluster — its files plus its
          subfolders, recursively — and its parent packs it by that size, so folders never overlap each other no
          matter how much they grow. Inside a folder, files fill a compact disc and subfolders sit on the ring just
          outside them, each sized by what it has to hold. Adding a file, or a circle growing with its size, smoothly
          pushes the neighbours outwards, and a folder that moves takes its subtree with it. Positions are still derived from
          the repository state alone, so the same history always produces the same map. Settings → Visual can pin
          every node to its path-derived position instead.
        </p>
      </section>

      <section>
        <h3>Circle sizes</h3>
        <p class="muted small">
          File circles grow with the file size. Sizes come from the host's own file listing for the newest commit in
          the loaded window (GitHub: one recursive tree request), so they are real byte counts rather than estimates.
          The scale is logarithmic against the 95th percentile, which keeps small files visible and stops a single
          generated file from flattening the scale. Files the host does not report — and every file when sizes are
          unavailable — fall back to line activity, and the Settings panel shows exactly how many circles use which.
          The mapping can be switched to line activity or to uniform circles, and file labels show the size of the
          files that were just changed.
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
