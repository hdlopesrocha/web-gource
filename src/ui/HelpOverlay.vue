<script setup lang="ts">
defineEmits<{ (event: 'close'): void }>()

const shortcuts: { keys: string; action: string }[] = [
  { keys: 'Space', action: 'Play / pause' },
  { keys: '← / →', action: 'Previous / next commit' },
  { keys: 'Shift + ← / →', action: 'Seek 5 seconds' },
  { keys: 'Home / End', action: 'Jump to the start / end' },
  { keys: '+ / −', action: 'Faster / slower playback' },
  { keys: 'R', action: 'Restart playback' },
  { keys: 'Drag', action: 'Orbit the 3D camera' },
  { keys: 'Right-drag', action: 'Pan the view (or Shift-drag)' },
  { keys: 'Wheel', action: 'Zoom around the pointer' },
  { keys: 'C', action: 'Reset the camera view' },
  { keys: 'Click', action: 'Recalibrate head tracking (gyroscope on)' },
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
          The tree is laid out on a plane but rendered in 3D as a tabletop: the camera up vector is the plane
          normal, so dragging left/right spins around the tree and dragging up/down changes the elevation while the
          ground recedes into the distance. Right-drag (or Shift-drag) pans and the wheel zooms around the pointer.
          Files and folders stay as camera-facing billboards at a fixed on-screen size, so they remain readable from
          every angle. The <strong>2D</strong> button switches to a flat top-down view where dragging pans;
          <strong>Reset</strong> (or <code>C</code>) returns to the default 3D view. Manual input pauses the
          automatic view for a few seconds.
        </p>
      </section>

      <section>
        <h3>Multiple projects</h3>
        <p class="muted small">
          <strong>Add repository</strong> adds another URL row to the landing page, and the <strong>✕</strong>
          button removes one. Once more than one row is filled, the main button reads
          <strong>Load N repositories</strong>; the examples fill an empty row or add a new one. The
          projects share one scene but keep separate trees and separate author instances: paths are
          prefixed with <code>owner/name/</code>, so the same file path in two repositories stays
          distinct, and the same person appears once per project. The Authors panel counts
          <em>author instances</em> and badges each with its project.
        </p>
        <p class="muted small">
          Author filters are project-scoped: hiding an instance hides that person only in that project,
          while the same person in another project stays visible. Tokens are per host, and a
          <strong>Token host</strong> selector appears when the rows mix providers. Projects load one at
          a time — the first streams live, and later ones join the scene when complete — and a failed
          repository does not abort the rest: the successful projects stay loaded with a warning and a
          status such as <strong>Ready · N of M repositories failed</strong>.
        </p>
      </section>

      <section>
        <h3>Gamepad & head tracking</h3>
        <p class="muted small">
          <strong>Settings → Camera</strong> can hand the camera to a gamepad or to the device's gyroscope. The pad
          flies a free 6-DOF camera: the left stick rotates (yaw and pitch), the right stick rolls and thrusts, the
          D-pad strafes and rises or sinks, and <kbd>A</kbd> recalibrates the head tracking. Rotation is a quaternion
          applied in the camera's own frame, so the sticks feel like a head rotation and roll is possible at all; the
          orbit view is remembered, so <strong>Reset</strong> or a mouse drag hands the camera straight back.
        </p>
        <p class="muted small">
          Head tracking follows the gyroscope: the camera orientation comes from the device and its up vector is the
          device's up rotated by the gyroscope, so the horizon follows your head. <strong>Clicking the scene</strong>
          (or pressing <kbd>A</kbd>) recalibrates — the current pose becomes the reference and the view does not move —
          which is how you aim the scene exactly at the orientation you are holding.
        </p>
      </section>

      <section>
        <h3>VR & spheres</h3>
        <p class="muted small">
          The <strong>VR</strong> button opens the scene in an immersive WebXR session when the browser has a headset;
          otherwise the button is disabled and says why. Entering VR puts the camera on a rig so the tree sits in front
          of you at table height, and <strong>files become real 3D spheres</strong> — instanced geometry with a light,
          world-scaled instead of camera-facing sprites — because flat discs read badly once you have stereo depth.
          Leaving the session (or taking the headset off) restores the exact view you had. The same sphere
          representation is available without a headset under Settings → Visual → 3D file spheres; directories keep
          their rings.
        </p>
        <p class="muted small">
          Inside the session you stand at the scene origin at the same eye height the flat view uses, and the
          <strong>timeline travels with you</strong>: a panel placed ahead of the headset and raised into the upper part
          of the view draws the commit histogram, the playhead, the date and the progress with four controls — restart,
          previous, play/pause and next — plus the strip itself, where dwelling seeks to that point. It is driven by
          <strong>gaze</strong>: the circular crosshair at the centre of your view activates whatever it rests on for
          <strong>two seconds</strong>, the ring filling as it waits and the hovered control lighting up; looking away
          resets it, so nothing fires by accident.
        </p>
      </section>

      <section>
        <h3>Reading the activity</h3>
        <p class="muted small">
          Every commit is shown while it happens: the changed files pulse in the colour of the change (green added,
          amber modified, red deleted, violet renamed) and a beam connects each of them to the author who made the
          change. The bigger the change in a file, the wider and brighter its beam — a 1000-line commit draws a
          strong ray, a one-line tweak a thin one. Authors are drawn above the rays, circles and branches so they are
          never hidden, and they move with a spring rather than jumping, so you can follow a contributor across the
          tree.
        </p>
      </section>

      <section>
        <h3>Music & microphone</h3>
        <p class="muted small">
          Settings → Music loads an MP3 and can switch on the audio-reactive visuals. The track is analysed once
          (bass, low mids, midrange, the vocal range and short clap transients), so the same performance drives
          live playback and the exported video: bass rotates the plasma's hue, claps cycle and flash the file
          colours, low mids pulse the folder rings, the midrange brightens the branches, and the vocal range makes
          the author avatars breathe. The reaction follows the same fade-in and fade-out envelope as the audio, and
          the toggle leaves the track playing — it only stops the animation from reacting to it.
        </p>
        <p class="muted small">
          The same tab can take its audio from the <strong>microphone</strong> instead of the file. It is analysed
          live with the same bands and drives the visuals in real time through the same fade envelope, so reactions
          fade in and out with the recording in either mode, and nothing is played back through the speakers. Live
          recordings mix the faded microphone in place of the file; the deterministic frame-by-frame export is
          video-only while the microphone is selected, because a live input cannot be replayed identically twice.
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
        <h3>Beams</h3>
        <p class="muted small">
          A commit sends a beam from the author to every file it changed. By default that beam is directional: a bright
          head leaves the avatar, travels to the element and lights the rest of the line as it arrives, with a comet
          tail behind it. Rays are depth tested like the rest of the scene, so a beam that passes behind a file circle
          or a folder ring disappears behind it instead of painting across it. Settings → Visual switches between
          <em>Travelling head</em> and the classic <em>Solid ray</em> (a full-length line drawn immediately) and sets
          the travel time.
        </p>
      </section>

      <section>
        <h3>Activity</h3>
        <p class="muted small">
          The Activity panel (<kbd>H</kbd>) shows when the work happened. The first chart is a density heatmap of
          commits per weekday and hour of day (UTC) — horizontal is the hour, vertical the weekday. The second is a
          GitHub-style contribution calendar for the last 53 weeks, where the rightmost column is the week of the
          current commit date, so it slides as the animation plays and days that have not happened yet stay empty.
          Both charts count only what has already happened at the playback position — scrubbing backwards removes
          the future — and both follow the active filters, so hiding authors, folders or a date range changes what
          they count.
        </p>
      </section>

      <section>
        <h3>Video export</h3>
        <p class="muted small">
          The default export renders the animation frame by frame from the beginning at exactly 60 fps, following the
          playback speed you selected, using the browser's WebCodecs encoders (hardware when available, software
          otherwise). The video includes the info panel, the timeline, the overview (with its heading and the
          directories/files/authors legend) and the activity charts, drawn with the same code as the on-screen panels,
          with the panel rectangles laid out so they never overlap at any frame size.
          Because the clock is driven by the frame index rather than by real time, a slow machine produces the same
          video as a fast one — it just takes longer. WebM (VP9) is the default; MP4 (H.264) is offered when the
          browser can encode it. Frames are streamed straight to the encoder, so memory stays flat, and the file is
          finalised (encoder flushed, durations patched) before it is offered for download. The live capture mode is
          still there for capturing manual camera moves in real time.
        </p>
        <p class="muted small">
          A background MP3 loaded in Settings → Music is looped under the animation and included in both export
          modes. The fade-out ends with the final animation frame, and the exported audio is rendered to the exact
          video length: Opus for WebM, AAC for MP4. If the browser lacks the audio encoder for the chosen container,
          export stops with an explanation — choose WebM or remove the track. Live capture adds the music when the
          selected format supports audio, and otherwise records video only. With the microphone selected, live
          capture records the faded microphone instead and the deterministic export is video-only.
        </p>
      </section>

      <section>
        <h3>Filters</h3>
        <p class="muted small">
          Settings → Filters hides folders: the ignore list removes whole trees from the visualization —
          vendored dependencies, generated output, anything you do not want to watch. An entry such as
          <code>third_party</code> hides any folder with that name at any depth (case-insensitively);
          <code>third*</code> is a glob and <code>src/vendor</code> matches one path. Hidden folders — any folder
          whose name starts with a dot, such as <code>.github</code> or <code>.vscode</code> — have their own
          toggle, because they are tooling rather than code; hidden <em>files</em> like <code>.gitignore</code> are
          left alone. Commits are never dropped by
          the ignore list: a commit that only touched ignored folders still plays, it just has no files to highlight,
          and the +/- counters only count what is left.
        </p>
      </section>

      <section>
        <h3>Plasma</h3>
        <p class="muted small">
          Files are drawn from Gource's own ball sprite — a highlight above and to the left, darkening towards the
          rim — so each circle reads as a small sphere, and the colours stay saturated because the palette is
          authored in sRGB.
        </p>
        <p class="muted small">
          The <strong>activity plasma</strong> is a ray-marched volume that forms around the files
          with the most recent changes. Every change adds heat to the file it touched, the heat decays over a few
          seconds, and the hottest files become glowing blobs whose size and strength follow that heat — so the
          plasma grows where work is happening and fades away when it stops. It is drawn after the branch lines and
          the circles, with the depth test on, so their silhouettes clip the volume and it never brightens a file or
          a folder; particles, beams, avatars and labels still draw on top. The bass rotates and breathes its hue,
          and Settings → Visual exposes the toggle, intensity, opacity, sharpness, metaball weight, radius, decay
          time, volume height and march quality.
        </p>
      </section>

      <section>
        <h3>Dynamic layout</h3>
        <p class="muted small">
          Folder and file placement follows Gource's own algorithm. A folder's radius is the square root of the area
          its subtree needs, and its parent keeps it that far away, so a folder that grows pushes its siblings
          outwards instead of overlapping them. Inside a folder, files are grouped on concentric rings — one file
          diameter apart, as many per ring as its circumference allows — and a circle that grows with its file size
          expands the rings smoothly. Directories are placed by a force relaxation: gravity towards their ideal
          distance from the parent, an outward push, and repulsion from their siblings, with a projection pass that
          guarantees no two circles ever overlap. Positions are derived from the repository state alone, so the same
          history always produces the same map. Settings → Visual can pin every node to its path-derived position
          instead.
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
