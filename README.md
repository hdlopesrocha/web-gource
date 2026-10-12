# Web Gource

A browser-based, WebGL-powered reimplementation of [Gource](https://gource.io/): paste a public
Git repository URL and watch its history grow into an animated 2D map — directories branching like
a tree, files appearing as circles sized by their real file size, authors flying between the files
they touch, and activity bursts coloured by add / modify / delete / rename.

Nothing is cloned, uploaded, or built on a server. Commit history is read straight from the
hosting provider's REST API in the browser, normalized into a timeline, and rendered with an
independently written Three.js renderer.

![Web Gource visualizing a repository as a 2D map with circles sized by file size](docs/screenshot.png)

```
https://github.com/owner/repository   →   animated 2D repository history
```

**Live:** <https://hdlopesrocha.github.io/web-gource/> — the published build is the same code as
`master`; the demo repository works offline, and real repositories are fetched straight from the
host API in your browser.

## Quick start

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

Other scripts:

```bash
npm run build        # type-check + production bundle (dist/)
npm run preview      # serve the production build
npm test             # unit + component tests (mocked APIs, no network)
npm run test:api     # opt-in integration tests against the real GitHub API
npm run typecheck    # vue-tsc only
```

`npm run test:api` spends API quota; set `GITHUB_TOKEN` to use an authenticated quota and
`WEB_GOURCE_TEST_REPO` to test against another repository.

## Publishing

The site is a static build published to the `gh-pages` branch:

```bash
npm run deploy        # build, then publish dist/ to gh-pages
```

`scripts/deploy-gh-pages.sh` builds the project and copies `dist/` into a throwaway worktree of an
orphan `gh-pages` branch, so `dist/` is never committed and the source history is never rewritten.
It adds `.nojekyll` (so every asset is served verbatim), commits, and force-pushes the branch
(`DEPLOY_REMOTE=...` and `DEPLOY_BRANCH=...` override the defaults). Vite is configured with a
relative `base`, so the same build works both from a domain root and from a project subpath.

On GitHub, Pages must point at the branch once: **Settings → Pages → Source: Deploy from a branch
→ `gh-pages` / `(root)`**. The build then appears at `https://<user>.github.io/<repo>/`.

## Using it

1. Paste a repository URL — `https://github.com/owner/repository`, `owner/repository`,
   `git@github.com:owner/repository.git` and GitHub Enterprise / GitLab URLs all work.
2. Optionally add a token (see below) for a much larger quota and private repos.
3. Press **Load Repository**. Commit metadata is fetched first, then file changes are hydrated in
   small batches; the visualization starts as soon as the first batch is ready.
4. Play with it: scrub, seek, filter, and export a video.

### Exporting video

Two export modes live in Settings → Recording:

**Deterministic render (default).** The animation is rendered frame by frame from
simulated time `t = 0` to the end of the timeline at **exactly 60 fps**, following
the **playback speed selected in the app**, so the file does not depend on how
fast the machine is:

* every frame advances the simulation by `speed / 60 s` and the commit index is
  derived from that time, so every frame is the same on every machine — a slow
  machine just takes longer (a 51 s animation at 4× rendered in software here
  took ~105 s of wall clock and produced the same 765 frames as a fast one);
* the video **contains the panels**: the timeline histogram along the bottom, the
  overview (minimap) in the bottom-right corner, and the activity charts — commits
  per weekday and hour, plus the sliding contribution calendar — in the right
  column. They are drawn with the same canvas routines the on-screen panels use
  (`render/overlays.ts`), composited into each frame, and laid out from the frame
  size so 720p, 1080p and portrait exports all work;
* frames are drawn by the existing WebGL pipeline (`Engine.renderExportFrame`),
  at the resolution you pick, with the camera stepping on a fixed frame cadence
  rather than a wall clock;
* each frame is wrapped in a `VideoFrame` and handed to the browser's
  **WebCodecs** encoder, which is asked for a hardware implementation first and
  falls back to software (`prefer-hardware` → `no-preference` → `prefer-software`);
* frames are never accumulated: each one is encoded and released before the next
  is drawn, and the encoder queue is kept under a few frames, so memory stays
  flat for long exports. Only the compressed stream is retained;
* **WebM (VP9)** is the default output; **MP4 (H.264)** is offered when the
  browser has an AVC encoder. Containers are written in this repository
  (`src/engine/export/webm.ts`, `mp4.ts`) — no muxer dependency, and the track
  declares the export's frame duration so players report the real frame rate;
* progress reports frames rendered, the total frame count, and the simulated
  time reached; cancelling stops cleanly and leaves the session where it was;
* at the end the encoder is flushed and the container is finalised (cluster
  flush, duration patched, MP4 durations patched), so the file is playable and
  contains every frame. `ffprobe` on a 51 s export at 4× reports `vp9`/`h264`,
  `1280x720`, `29999/500` (60 fps), `765` frames, `duration=12.750000`.

The *rendering* is deterministic; the encoder itself is not required to be
bit-exact (parallel VP9/H.264 encoders may vary by a few bytes), so two runs
produce the same frames and duration, not necessarily identical files.

**Live capture.** The older `MediaRecorder` + `captureStream` path samples the
composited frame in real time at 60 fps, following the same playback speed. It can
capture manual panning and zooming and includes the same panels, but the wall
clock decides how many frames reach the file — use the deterministic render when
the result has to be reproducible.

Both modes share the frame rate (60 fps) and the speed: there is no separate
recording speed setting, because the video should look like what you are watching.

### Ignoring folders

Repositories contain trees nobody wants to watch — `node_modules`, `vendor`, `third_party`,
generated output. **Settings → Filters** has an **Ignored folders** list that removes them:

| entry | hides |
| --- | --- |
| `third_party` | any folder with that name, at any depth, case-insensitively |
| `third*` | folders matching the glob (`third_party`, `third-party`, `thirdparty`) |
| `src/vendor` | that one path (and everything under it) |

Folders only: a *file* named `third_party` is untouched, and the last segment of a path is always
treated as the file. Entries are trimmed and deduplicated, so a pasted list works the same on every
host.

**Hidden folders** have a toggle of their own in the same tab (on by default): any folder whose name starts with a dot —
`.github`, `.vscode`, `.husky`, `.cache`, `.idea` — is tooling rather than code, so it stays out of the
visualization. Hidden *files* are left alone: a root `.gitignore` or a `.eslintrc.json` still appears, because
the filter only ever looks at directory segments. `.*` is not an ignore-list entry, precisely because it would
read as a glob that matches every folder.

Ignoring filters **file changes, not commits**: a commit that only touched ignored folders still
plays (its author and message are history), it simply has no files to highlight, and its
additions/deletions are recomputed from the changes that remain — the counters never include hidden
trees. A rename that moves a file *out* of an ignored folder is kept as an addition, because the old
path is not part of the visualization. The list is stored locally and survives a reload;
**Clear every filter** (in Settings → Filters or the Authors panel) empties it along with the hidden-folder
toggle, the author and the date filters. Per-author toggles and the date range stay in the Authors panel
(`A`); the folder filters live in Settings → Filters.

### Personal access tokens

Tokens are optional, never required for public repositories, and always stored locally in the
browser — there is no backend.

* The field is **always editable**, including before a repository URL is known: type or paste a
  token, then paste the URL, and the token is attached to the matching host automatically.
* A **Paste** button reads the clipboard directly where the browser allows it; native
  `Ctrl`/`Cmd`+`V` works too (nothing in the app intercepts paste).
* Pasted values are cleaned up: spaces, line breaks, zero-width characters and an accidental
  `Bearer ` prefix are removed.
* Host attribution uses the token prefix — `ghp_…` / `github_pat_…` for GitHub,
  `glpat-…` / `glrt_…` for GitLab — and a token is **never** sent to a different
  host. Unrecognised tokens are kept until the URL identifies the host.
* Tokens are committed on blur, on Enter, or shortly after typing stops, so a half-typed token is
  never stored. Focusing the field selects the existing value, so one paste replaces it.
* The last repository URL and every token are restored after a page reload.
* A token added mid-session (Settings → Data → Access token) can be applied with
  **Reload repository with this token**: cached commits cost no quota, so this mainly fills in the
  file changes that were skipped when the limit was reached.

### Keyboard and mouse

| Input | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Previous / next commit |
| `Shift` + `←` / `→` | Seek 5 seconds |
| `Home` / `End` | Jump to the start / end |
| `+` / `-` | Faster / slower |
| `R` | Restart playback |
| `C` | Recentre the camera |
| `L` | Toggle labels |
| `M` | Toggle the minimap |
| `A` | Toggle the authors panel |
| `S` | Toggle settings |
| `F` | Fullscreen |
| `?` | Help |

Drag to pan, scroll to zoom (the point under the pointer stays anchored). Manual input pauses the
automatic view for a few seconds.

## How it works

```
src/
  git/                      data acquisition
    url.ts                  URL parsing / normalization (bare, SCP-like, UI routes, .git)
    http.ts                 fetch with retries, backoff, abort and rate-limit classification
    cache.ts                two-level cache (memory + IndexedDB); payloads are immutable by SHA
    pool.ts                 bounded concurrency for per-commit requests
    errors.ts               typed errors + actionable messages
    loader.ts               staged loading: metadata → commit list → batched file hydration
    providers/
      types.ts              GitProvider interface (parse, repo info, commit pages, hydrate, URL)
      github.ts             GitHub.com + GitHub Enterprise
      gitlab.ts             GitLab.com + self-managed (beta)
      demo.ts               deterministic synthetic history for offline demos and load testing
      index.ts              provider registry, URL → provider resolution, token plumbing
  timeline/                 normalized history
    types.ts                Timeline, TimelineCommit, TimelineAuthor, change kinds
    builder.ts              raw commits → timeline (+ author aggregation, stats, filters)
    ignore.ts               folder ignore list (names, globs, path prefixes)
    schedule.ts             deterministic playback schedule and date ↔ time mapping
  sim/                      repository state, independent of rendering
    layout.ts               deterministic path → position mapping (stable under filtering/seeking)
    simulation.ts           path tree, visibility over time, authors, activity events
  render/                   WebGL layers (Three.js)
    renderer.ts             scene composition, event consumption, settings, sizing
    nodes.ts                instanced file/directory nodes with capacity growth
    glow.ts                 Gource's directory bloom (additive halos)
    edges.ts                branch edges as a single growable line buffer
    particles.ts            additive particle pool for activity effects and author trails
    authors.ts              pooled avatar sprites with a texture cache
    labels.ts               world-space labels, constant screen size, LRU texture cache
    camera.ts               orbit camera with Gource-style automatic framing
    minimap.ts              2D overview of the tree, authors and camera position
    palette.ts              extension/author/change colours
    textures.ts             canvas texture caches (labels, avatars, glows, ball + bloom sprites)
  engine/
    engine.ts               playback clock, simulation driving, camera, HUD, recording hooks
    controller.ts           app orchestration: load, filters, seek, settings, recording
    recorder.ts             MediaRecorder + canvas.captureStream export (live capture)
    export/                 deterministic frame-by-frame export
      frames.ts             30 fps frame plan: time, timestamps, keyframes, progress
      encoder.ts            WebCodecs encoders (hardware first, software fallback)
      exporter.ts           frame loop, backpressure, cancellation, finalisation
      webm.ts               WebM/Matroska muxer (VP9/VP8/AV1)
      mp4.ts                fragmented MP4 muxer (H.264)
  state/store.ts            reactive app state, settings persistence, token storage
  ui/*.vue                  landing view, stage, playback bar, scrubber, panels, help
tests/                      unit, component and (opt-in) live API tests
```

The boundaries are deliberate: providers only translate API payloads, the timeline knows nothing
about rendering, the simulation is pure logic, and the renderer reacts to simulation events. That
is what makes seeking, filtering and deterministic replay cheap.

### Data model and honesty about gaps

Every provider returns the same normalized structures (`RawCommit`, `RawFileChange`, `RepoInfo`).
Commits keep their SHA, author identity, timestamps and message verbatim; file changes keep path,
previous path (renames), change type and line counts.

When something cannot be fetched it is **marked, never invented**:

* `filesMissing: 'rate-limit'` — the API quota ran out before file data was fetched.
* `filesMissing: 'merge-parents'` — a merge commit the host reports without a changed-file list.
* `filesMissing: 'error'` — the detail request failed (the commit itself is still shown).
* `filesMissing: 'not-requested'` — the commit list was loaded without file hydration.
* `filesTruncated: true` — the host capped the file list (GitHub: 300 files).

The UI shows these as badges, counts them in the Data tab, and explains them in the notes strip.
Directories, files and authors are only ever created from real commit data.

### Rate limits, caching and incremental loading

GitHub allows **60 requests/hour** anonymously; a token raises this to 5,000. Because file changes
cost one request per commit, the app budgets requests instead of pretending:

* the commit list is cheap (1 request per 100 commits) and always fetched first;
* file hydration runs in batches of 10, oldest first, with bounded concurrency (6 requests), so
  the visualization starts as soon as the first batch arrives and grows while loading;
* commits with detail requests still pending or skipped are rendered without file activity;
* when the quota drops to the reserve, hydration stops, the commits already fetched are kept, and
  a warning explains how to continue (token, smaller snapshot, reload — cached data is reused);
* every fetched repository, commit and hydrated commit is cached (memory + IndexedDB), so reloads
  and re-filters cost almost no quota;
* loading can be cancelled at any time and cleans up in-flight requests.

Snapshot size (50 → 4,000 commits) and range (newest commits, or from the first commit of the
repository) are user choices, because the full history of a large repository cannot fit in any
quota. The app states which window it loaded and why.

### Determinism

Given the same history and settings, the same sequence of events is produced:

* the schedule is a pure function of commit timestamps with a fixed, documented compression curve
  (`gapTime = perGapCap · (1 − e^(−gap/gapTau))`, with a global idle budget);
* node positions derive from the *path* hash, not from arrival order, so the layout is identical
  under filtering, seeking or incremental loading;
* visibility over time is stored as per-node toggle indexes, so `seek(i)` is an exact
  re-evaluation instead of an approximation;
* nothing in the simulation depends on wall-clock time or randomness.

### Rendering

![Files rendered as Gource's lit balls inside a folder's bloom halo](docs/screenshot-glow.png)

* Files and directories are two `InstancedMesh` objects — Gource's lit ball sprite for files, rings
  for directories — viewed through an orthographic camera, with per-instance colour and matrix
  updates only for changed nodes. Layer order: branches (behind), circles, folder glow, activity
  particles, rays, authors, labels (front). Both grow by reallocating and copying instance buffers
  when a repository turns out to be larger than expected.
* File sprites use the ball from Gource's own `data/file.png` (a highlight above and to the left,
  darkening towards the rim), tinted by the instance colour, so a file still carries its own colour
  but reads as a sphere rather than a flat disc.
* Branch edges share one `LineSegments` buffer with two vertices per node. They are opaque and
  depth tested, so the node circles (drawn slightly in front) **occlude** them — a branch disappears
  behind a file circle or a directory ring instead of being painted across it — and every segment is
  trimmed by the radius of both endpoints, so it starts at the parent's edge and stops at the child's
  edge. A branch whose two circles already touch is dropped rather than drawn as a stub inside one.
* Activity effects and author trails come from a single additive `Points` pool with a free-list (no
  allocations per commit); particle sizes are given in screen pixels, so sparks stay the same size
  at any zoom level.
* Author→file beams are one dynamic mesh rebuilt per frame (two quads per beam: glow + core), so a
  commit touching twenty files still costs a single draw call.
* Labels are pooled sprites with an LRU canvas-texture cache and screen-space overlap rejection, so
  dense repositories stay readable. File labels can include the host-reported size.
* A camera-following background gradient and grid keep panning and zooming readable. The grid is a
  transparent overlay, so depth testing (not the draw order) is what keeps it behind the tree: the
  circles write depth first and the grid is rejected wherever they cover it. The depth stack is
  explicit — background −6, grid −5, branches 0, circles +0.25, effects +0.5. The minimap shows the
  whole tree with the current view position.
* The glow is Gource's bloom layer (`GlowField`): one additive halo per directory, sized
  `clusterRadius * 2` and tinted `directoryColour * bloomIntensity`, using a reproduction of
  Gource's `bloom.tga` falloff (`1 - smoothstep(0, 0.72, r)`, peaking at half white). It is drawn
  after the circles (additively, so the dots stay crisp) and before the beams and avatars, so a
  folder's halo washes over its own file cluster the way Gource's does. Settings → Scene switches it
  off or drives the intensity from 0 to 1.5 (Gource's default is 0.75).
* Resizing, device pixel ratio and full disposal (geometries, materials, textures, renderer) are
  handled in one place (`SceneRenderer`).

### Dynamic layout — Gource's model

![Files grouped on rings around their directories](docs/screenshot-rings.png)

Folder and file placement follows the algorithm in Gource's own source
(`src/dirnode.cpp`), adapted for files that have a size:

* **A directory's radius is the square root of the area it needs**
  (`RDirNode::calcRadius`): `radius = sqrt(area) * 1.5`, where the area is the
  sum of the file areas in its whole subtree. A folder's *own* files get their
  own radius (`parent_radius` in Gource), and that is the radius its children are
  placed against. Because everything scales with the square root of the content,
  the extent of the tree grows with `sqrt(files)` rather than with nesting depth.
* **Files are grouped on concentric rings around their folder**
  (`RDirNode::updateFilePositions`, `calcFileDest`). Ring radii step outwards by
  one "file diameter", each ring holds as many files as fit around its
  circumference, and slots are spread with a half-slot offset. Gource spaces its
  rings by the fixed 8-unit file diameter; here the spacing follows the widest
  circle in the folder and each slot's angle comes from the chord that circle
  actually needs, so a folder full of large files still packs tightly without
  overlapping.
* **Directories are placed by a force relaxation** (`RDirNode::applyForces`):
  gravity towards the ideal clearance from the parent
  (`|Δpos| − (dirRadius + parentOwnRadius)`), a push along the parent's own
  direction so children fan outwards, repulsion from siblings scaled by the
  parent's radius over its child count, and overlap resolution against every
  nearby directory.
* Gource resolves overlaps with a spring far weaker than its gravity, so crowded
  parents end up with overlapping clusters. Here each relaxation ends with a
  **projection sweep** instead: overlapping bodies are pushed apart by the
  smallest distance that clears them, and a folder may sit inside its ancestors'
  clusters (it only has to clear their own files). The result keeps Gource's look
  — folders fan out and settle at their ideal distance — while nothing overlaps:
  no two file circles, no two folder rings, and no file crossing a folder that is
  not its parent.
* A new folder starts next to its parent with a hashed offset
  (`RDirNode::setInitialPosition`), and a folder that moves carries its own files
  with it (and, while it is first taking its place, its whole subtree).
* The expensive part (the forces) runs every fourth commit; the projection runs
  after every commit, so a growing circle is separated immediately while folders
  drift into place over a few commits. A full reflow (seek, size change, filter)
  relaxes much longer and projects until clean.

Replaying 5,000 commits over 3,600 files costs a few seconds of layout work, and
the tests assert the no-overlap contract while playing, after host sizes arrive
and after a seek.

* Settings → Visual can switch the dynamic layout off, which eases every file
  back to its path-derived position for a static map.
* Positions remain a pure function of the applied commits, so seeking forward to
  a point in history produces exactly the layout that playing to it would.

### Activity heatmaps

The Activity panel (`H`, or the button in the header) answers "when did this work happen":

* **commits per weekday and hour** — a 7 × 24 density grid in UTC, with a hover readout per cell and the busiest
  slot in the header;
* **contributions over the last 53 weeks** — a GitHub-style calendar of per-day commit counts, five shade steps
  and month labels. The rightmost column is always the week of the *current* commit date, so the calendar slides
  as playback advances (and days that have not happened yet stay empty).

Both charts follow the **playback position**: they count only the commits that have already happened at the
current commit date, so scrubbing backwards removes the future instead of showing the whole history at once, and
the calendar's rightmost column always sits on the current week. They also aggregate the filtered timeline, so
hiding authors, ignoring folders or narrowing the date range changes what they count. Both are drawn on canvas at
device pixel ratio with a hover readout per cell, and the exported video draws the same charts from the same code,
growing frame by frame as the animation plays.

### Reading the activity

![A beam connecting an author to the file it just changed](docs/screenshot-beams.png)

Every commit is visible while it happens:

* the files it touched **pulse** in the colour of the change (green added, amber modified, red
  deleted, violet renamed) and briefly grow, so a one-line edit in a large tree is still findable;
* a **beam** (the Gource tether) connects each changed file to the author who made the change: a
  bright core with a soft glow, drawn as camera-facing quads so the width is controllable, fading
  out after about 1.6 simulated seconds. Its **width and brightness follow the size of that
  change** (line churn, with the file's size as a secondary factor, normalised against the largest
  change in the window), so a 1200-line commit draws a much stronger ray than a one-line tweak;
* authors are drawn **above** everything else — branches, circles, particles and rays — so the
  avatars are never hidden while they work;
* avatars travel between files with a critically damped spring and a speed limit instead of
  jumping, so you can follow a contributor across the tree; new contributors fly in from outside
  the tree;
* timings are in *simulated* seconds, so the highlight and the beams stay in step with the commits
  at any playback speed.

Beams can be switched off or restyled (brightness, width) in Settings → Visual.

### File sizes on screen

Circle size is a first-class signal, not decoration:

* Sizes come from the host's own file listing for the newest commit in the loaded window — one
  extra request (GitHub's recursive tree endpoint), cached, never one request per file.
* The scale is logarithmic with a mild power curve against the **95th percentile** of the window,
  so small files stay visible and a single generated file cannot flatten everything else. The
  Settings panel shows a legend with the exact mapping and reports how many circles use a real size.
* Files the host does not report (or every file, when the listing is unavailable or truncated) fall
  back to accumulated line activity, and the UI says so instead of pretending.
* Labels of just-changed files show the size (`renderer.ts · 14 KB`), the activity overlay lists the
  size of every changed file, and the Data tab reports the tracked total.
* The mapping can be switched between file size, line activity and uniform circles; a global
  multiplier scales all circles.

### Video export

Export uses `MediaRecorder` with `HTMLCanvasElement.captureStream()` — everything stays local.

* Formats are probed at runtime: WebM (VP9/VP8) where supported, MP4 (H.264) where the browser can
  produce it. Unsupported codecs are shown as disabled rather than offered.
* Resolution presets (720p → 1440p, square, vertical), frame rate (15–60) and playback speed during
  recording (0.25× → 16×) are configurable, and the estimated recording time is shown.
* While recording, the renderer switches to the chosen resolution and the clock advances by exactly
  one frame step per captured frame, so the video is a faithful, deterministic sampling of the
  timeline.
* Progress (percent, frames, elapsed, size) is reported live; recording can be stopped manually,
  stops automatically at the end of the timeline, and has a safety time limit.
* Keep the tab focused while recording: background tabs throttle rendering.

## Testing

`npm test` runs 119 tests with mocked provider payloads — no network access:

* URL parsing (bare input, SCP syntax, `.git`, UI routes, nested GitLab groups, Enterprise hosts);
* GitHub provider: pagination, cache reuse, rename/delete/copy mapping, 300-file truncation,
  merge commits, failing detail requests, quota exhaustion, empty repositories, 404/403/401;
* token handling: sanitising pasted values, host detection from prefixes, drafts attached once the
  host is known, no cross-host leakage, clearing, and persistence across reloads;
* timeline builder: ordering, dedupe, author aggregation, rename normalization, missing file data,
  filters, extension/path statistics;
* schedule: monotonicity, idle compression bounds, append stability, time ↔ date mapping;
* simulation: directory creation, delete + re-add visibility, renames, unknown-path modifications,
  merge commits, seek ≡ replay, no double counting on replay, author behaviour, bounds;
* activity: avatar motion is continuous and bounded by the speed limit, tethers are created per
  changed file, refreshed, expired and capped, beams fade, follow both endpoints, scale with zoom
  and respect their capacity;
* branch lines: endpoints stay outside both circles, a branch between touching circles is dropped,
  the material stays opaque so the node pass occludes it, and the dimming is baked into the vertex
  colours;
* activity beams: brightness and width scale with the size of the change, endpoints follow both
  the avatar and the node, and the author layer renders above the rays;
* dynamic layout: Gource's radius model (square root of the area), file grouping on rings (no
  overlaps, grows with count and size, deterministic), the force relaxation (ideal clearance,
  siblings spread, overlaps projected apart), and the no-overlap contract (clusters, file
  circles, file vs. folder rings) while playing, after sizes arrive and after a seek;
  in the simulation, adding, deleting or growing a file moves its siblings smoothly, folder
  clusters (including nested ones) never overlap and stay inside their parent's cluster, growing a
  folder pushes its siblings outwards, seek and playback produce identical layouts, and the static
  mode pins nodes to their path-derived positions;
* export containers: EBML/box structure written back and parsed (clusters per keyframe, simple
  block payloads, patched durations, `avcC`, fragment data offsets, byte-exact sample payloads),
  and the export loop (30 fps frame plan, keyframe cadence, frame release, queue bounds, progress,
  cancellation, encoder errors, MP4 initialisation from the encoder metadata);
* rendering bookkeeping: instance allocation, capacity growth, hidden nodes collapsing on both dirty
  *and* full syncs (a seek or restart must not leave the previous frame on screen), every layer
  dropping its instances when the history is rebuilt (node ids are per simulation, so a filter change
  must not keep rendering the old tree), folder glow (one halo per directory sized from the cluster
  radius, intensity baked into the instance colours), edge buffers, particle
  pool limits and decay, camera panning/zooming;
* controller end-to-end flows with a mocked API: loading, filters, SHA/date jumps, cancellation,
  WebGL-unavailable degradation;
* component smoke tests (jsdom) for the landing view, playback bar, stage, panels and help overlay;
* file sizing: logarithmic mapping monotonicity and bounds, 95th-percentile reference, fallbacks
  for unknown sizes, size-mode switching, sizes arriving after nodes exist, host tree parsing;
* scale checks: 5,000 commits and ~3,600 files build in ~0.1 s and seek in well under a frame.

`npm run test:api` additionally validates the parsers against the real API (field names, pagination
headers, file change shapes) and skips gracefully when the quota is exhausted.

## Limitations

* **GitHub and GitLab only.** Other hosts need a new `GitProvider`; the registry is one entry plus
  a `parse` method.
* **No GraphQL batching.** GitHub's REST API is the only way to get per-commit file paths, so cost
  is one request per commit. Token-authenticated loads make this practical.
* **Windows of history, not full histories.** A very large repository cannot be fully fetched in a
  browser without a token; the UI is explicit about the loaded window.
* **File contents are not fetched.** Only paths, change kinds, line counts and (via the tree
  endpoint) byte sizes for the newest commit in the window.
* **Sizes are a snapshot, not a history.** A file that shrank during the window is drawn at its
  current size; tracking size over time would need one tree request per commit.
* **Synthetic avatars.** Profile pictures from the host are not fetched: generated initials keep the
  scene deterministic and avoid third-party requests.
* **No audio.** Gource's background music has no browser equivalent here.

## Legal

Inspired by the original [Gource](https://gource.io/) by Andrew Caudwell. This is an independent
implementation with its own renderer and shares no code with, and is not affiliated with, the
original project. Repository data belongs to the respective projects and is fetched from their
hosting provider's public API.
