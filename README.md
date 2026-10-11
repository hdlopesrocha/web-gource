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

## Using it

1. Paste a repository URL — `https://github.com/owner/repository`, `owner/repository`,
   `git@github.com:owner/repository.git` and GitHub Enterprise / GitLab URLs all work.
2. Optionally add a token (see below) for a much larger quota and private repos.
3. Press **Load Repository**. Commit metadata is fetched first, then file changes are hydrated in
   small batches; the visualization starts as soon as the first batch is ready.
4. Play with it: scrub, seek, filter, and export a video.

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
    schedule.ts             deterministic playback schedule and date ↔ time mapping
  sim/                      repository state, independent of rendering
    layout.ts               deterministic path → position mapping (stable under filtering/seeking)
    simulation.ts           path tree, visibility over time, authors, activity events
  render/                   WebGL layers (Three.js)
    renderer.ts             scene composition, event consumption, settings, sizing
    nodes.ts                instanced file/directory nodes with capacity growth
    edges.ts                branch edges as a single growable line buffer
    particles.ts            additive particle pool for activity effects and author trails
    authors.ts              pooled avatar sprites with a texture cache
    labels.ts               world-space labels, constant screen size, LRU texture cache
    camera.ts               orbit camera with Gource-style automatic framing
    minimap.ts              2D overview of the tree, authors and camera position
    palette.ts              extension/author/change colours
    textures.ts             canvas texture caches (labels, avatars, glows)
  engine/
    engine.ts               playback clock, simulation driving, camera, HUD, recording hooks
    controller.ts           app orchestration: load, filters, seek, settings, recording
    recorder.ts             MediaRecorder + canvas.captureStream export
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

* Files and directories are two `InstancedMesh` objects — flat discs for files, rings for
  directories — viewed through an orthographic camera, with per-instance colour and matrix updates
  only for changed nodes. Both grow by reallocating and copying instance buffers when a repository
  turns out to be larger than expected.
* Branch edges share one `LineSegments` buffer with two vertices per node.
* Activity effects and author trails come from a single additive `Points` pool with a free-list (no
  allocations per commit); particle sizes are given in screen pixels, so sparks stay the same size
  at any zoom level.
* Author→file beams are one dynamic mesh rebuilt per frame (two quads per beam: glow + core), so a
  commit touching twenty files still costs a single draw call.
* Labels are pooled sprites with an LRU canvas-texture cache and screen-space overlap rejection, so
  dense repositories stay readable. File labels can include the host-reported size.
* A camera-following background gradient and grid keep panning and zooming readable, and the
  minimap shows the whole tree with the current view position.
* Resizing, device pixel ratio and full disposal (geometries, materials, textures, renderer) are
  handled in one place (`SceneRenderer`).

### Dynamic layout

![Files packed on rings around their directories](docs/screenshot-rings.png)

Files are packed onto one or more concentric rings around their directory, and
those rings reflow while history plays:

* the ring radius follows the circles that have to fit (arc length *and* the
  chord between neighbouring slots), so a folder full of large files gets a
  wider ring and its contents never overlap;
* adding a file pushes its siblings to new slots, and deleting one closes the
  gap — both eased over ~0.7 s instead of jumping;
* a circle that grows with its file size (or with accumulated line activity in
  activity mode) expands its ring and pushes its neighbours outwards;
* order is by path, so a new file shifts the ring by one slot deterministically
  rather than reshuffling it;
* positions remain a pure function of the applied commits, so seeking to a point
  in history produces exactly the layout that playing to it would;
* Settings → Visual can switch the dynamic layout off, which eases every file
  back to its path-derived position for a static map.

### Reading the activity

![A beam connecting an author to the file it just changed](docs/screenshot-beams.png)

Every commit is visible while it happens:

* the files it touched **pulse** in the colour of the change (green added, amber modified, red
  deleted, violet renamed) and briefly grow, so a one-line edit in a large tree is still findable;
* a **beam** (the Gource tether) connects each changed file to the author who made the change: a
  bright core with a soft glow, drawn as camera-facing quads so the width is controllable, fading
  out after about 1.6 simulated seconds;
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
* dynamic layout: ring packing never overlaps circles, grows with item count and radius, uses
  concentric rings for crowds, is deterministic and order independent; in the simulation, adding,
  deleting or growing a file moves its siblings smoothly, seek and playback produce identical
  layouts, and the static mode pins files to their path-derived positions;
* rendering bookkeeping: instance allocation, capacity growth, hidden nodes, edge buffers, particle
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
