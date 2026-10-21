// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  XR_SCREEN_CANVAS_HEIGHT,
  XR_SCREEN_CANVAS_WIDTH,
  XR_SCREEN_DISTANCE,
  XR_SCREEN_RISE,
  XrScreenPanel,
  drawXrScreen,
  hitTestScreen,
  screenLayout,
  screenPose,
  xrScreenAction,
  xrScreenKey,
  xrScreenTargetId,
  type XrScreenState,
} from '../src/render/xr-screen'
import type { InfoPanelModel } from '../src/render/info-panel'

/**
 * The complete in-scene VR interface.
 *
 * jsdom has no canvas, so drawing runs through a recording context. The tests
 * cover the pure geometry (which control is where), the state transitions
 * (view/tab/page/settings), and that every panel's content really reaches the
 * canvas. The WebGL plane wrapper is tested with a fake canvas as well.
 */

interface Recorded {
  method: string
  args: unknown[]
}

function recordingContext(): { ctx: CanvasRenderingContext2D; calls: Recorded[] } {
  const calls: Recorded[] = []
  const target: Record<string, unknown> = {}
  const ctx = new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property as string]
      if (typeof property !== 'string') return undefined
      const fn = (...args: unknown[]): unknown => {
        calls.push({ method: property, args })
        if (property === 'measureText') return { width: String(args[0] ?? '').length * 8 }
        return undefined
      }
      object[property] = fn
      return fn
    },
    set(object, property, value) {
      object[property as string] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}

function texts(calls: Recorded[]): string[] {
  return calls.filter((call) => call.method === 'fillText').map((call) => String(call.args[0]))
}

const info: InfoPanelModel = {
  dateLabel: '2024-03-06 14:30',
  timeLabel: '0:30 / 2:00',
  fpsLabel: '60 fps',
  isMerge: false,
  subject: 'Add the VR dashboard',
  project: 'acme/web-gource',
  author: { name: 'Ada Lovelace', color: '#9fd4ff', shortSha: 'abc1234', additions: 42, deletions: 7 },
  changes: [{ kind: 'add', label: 'added', path: 'src/ui/dashboard.ts' }],
  moreFiles: 0,
  truncated: false,
  missing: null,
  stats: [{ value: '40', label: 'files in history' }],
  workingNow: [{ id: 'ada', name: 'Ada Lovelace', color: '#9fd4ff', commits: 12 }],
}

function grid() {
  return {
    counts: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
    max: 0,
    total: 0,
    busiest: null,
  }
}

function calendar() {
  return {
    weeks: Array.from({ length: 53 }, (_, column) =>
      Array.from({ length: 7 }, (_, row) => ({ day: column * 7 + row, count: 0, future: false })),
    ),
    max: 0,
    total: 0,
    months: [{ column: 2, label: 'Feb' }],
    start: 0,
    end: 370,
    before: 0,
  }
}

function screenState(overrides: Partial<XrScreenState> = {}): XrScreenState {
  return {
    view: 'stage',
    settingsTab: 'visual',
    hovered: null,
    repoLabel: 'acme/web-gource',
    repoTitle: 'acme/web-gource',
    summary: '120 commits · 3 authors',
    providers: ['github'],
    partialHistory: false,
    loading: {
      active: false,
      streaming: false,
      status: '',
      loaded: 0,
      target: 0,
      requests: 0,
      error: null,
    },
    warnings: [],
    xrError: null,
    recording: null,
    info,
    stats: {
      commits: 120,
      authors: 3,
      files: 40,
      dirs: 10,
      additions: 500,
      deletions: 20,
      totalBytes: 1_048_576,
      merges: 2,
      withoutFileData: 0,
    },
    playback: {
      buckets: Array.from({ length: 20 }, (_, index) => ({ t: index, commits: 3, additions: 0, deletions: 0 })),
      position: 30,
      duration: 120,
      date: '2024-03-06 14:30',
      progress: 0.25,
      playing: true,
      speed: 2,
      cameraMode: 'free',
      index: 30,
      total: 120,
      startDate: '2024-01-01',
      endDate: '2024-02-01',
      filterLabel: null,
    },
    authors: {
      rows: [
        { id: 'ada', name: 'Ada Lovelace', color: '#9fd4ff', commits: 12, hidden: false },
        { id: 'grace', name: 'Grace Hopper', color: '#ffd479', commits: 8, hidden: true },
      ],
      page: 0,
      pages: 1,
      total: 2,
      hiddenCount: 1,
    },
    activity: {
      grid: grid(),
      calendar: calendar(),
      summary: '120 commits · busiest Wed 14:00 UTC',
      calendarSummary: '120 commits · 2024-01-01 → 2024-12-31',
    },
    settings: {
      showLabels: true,
      showDirectoryLabels: true,
      showFileLabels: true,
      showFileSizes: true,
      showAuthorNames: true,
      showEdges: true,
      showDirs: true,
      showGrid: true,
      showBeams: true,
      showPlasma: true,
      audioReactive: true,
      followActivity: true,
      autoZoom: true,
      dynamicLayout: true,
      gamepad: false,
      hideHiddenFolders: true,
      sizeMode: 'bytes',
      fileColorMode: 'extension',
      xrViewHeight: 1.8,
    },
    projects: [{ name: 'acme/web-gource', commits: 120, authors: 3 }],
    minimapVisible: true,
    music: { fileName: 'loop.mp3', source: 'file', volume: 0.7, reactive: true },
    drawMinimap: vi.fn(),
    ...overrides,
  }
}

function control(layout: ReturnType<typeof screenLayout>, id: string) {
  const found = layout.controls.find((entry) => entry.id === id)
  if (!found) throw new Error(`missing control ${id}`)
  return found
}

function centre(rect: { x: number; y: number; width: number; height: number }): [number, number] {
  return [rect.x + rect.width / 2, rect.y + rect.height / 2]
}

describe('screenLayout', () => {
  it('lays out the complete stage inside the canvas', () => {
    const layout = screenLayout(screenState())
    expect(layout.info).not.toBeNull()
    expect(layout.minimap).not.toBeNull()
    expect(layout.content).toBeNull()

    const ids = layout.controls.map((entry) => entry.id)
    for (const id of [
      'view-activity',
      'view-authors',
      'map',
      'view-settings',
      'view-help',
      'recenter',
      'exit-vr',
      'restart',
      'prev',
      'play',
      'next',
      'speed',
      'camera',
      'recenter-footer',
      'jump-start',
      'jump-end',
    ]) {
      expect(ids).toContain(id)
    }

    for (const entry of layout.controls) {
      expect(entry.rect.x).toBeGreaterThanOrEqual(0)
      expect(entry.rect.y).toBeGreaterThanOrEqual(0)
      expect(entry.rect.x + entry.rect.width).toBeLessThanOrEqual(XR_SCREEN_CANVAS_WIDTH)
      expect(entry.rect.y + entry.rect.height).toBeLessThanOrEqual(XR_SCREEN_CANVAS_HEIGHT)
    }
    expect(layout.timeline.y + layout.timeline.height).toBeLessThan(layout.footer.y + layout.footer.height)
  })

  it('moves to a larger content card for each panel and hides the stage cards', () => {
    for (const view of ['activity', 'authors', 'settings', 'help', 'warnings'] as const) {
      const layout = screenLayout(screenState({ view }))
      expect(layout.content).not.toBeNull()
      expect(layout.info).toBeNull()
      expect(layout.minimap).toBeNull()
      expect(control(layout, 'close').action).toEqual({ kind: 'close' })
    }
  })

  it('presents the author list in pages and disables the edge buttons', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      id: `author-${index}`,
      name: `Author ${index}`,
      color: '#fff',
      commits: 12 - index,
      hidden: index === 2,
    }))
    const first = screenLayout(
      screenState({ view: 'authors', authors: { rows, page: 0, pages: 2, total: 12, hiddenCount: 1 } }),
    )
    expect(first.controls.filter((entry) => entry.id.startsWith('author:'))).toHaveLength(10)
    expect(control(first, 'authors-prev').disabled).toBe(true)
    expect(control(first, 'authors-next').disabled).toBe(false)
    // A disabled control is not hit-testable.
    const [prevX, prevY] = centre(control(first, 'authors-prev').rect)
    expect(hitTestScreen(first, prevX, prevY)).toBeNull()
    expect(control(first, 'author:author-2').value).toBe('10')

    const second = screenLayout(
      screenState({ view: 'authors', authors: { rows, page: 1, pages: 2, total: 12, hiddenCount: 1 } }),
    )
    expect(second.controls.filter((entry) => entry.id.startsWith('author:'))).toHaveLength(2)
    expect(control(second, 'authors-prev').disabled).toBe(false)
    expect(control(second, 'authors-next').disabled).toBe(true)
  })

  it('gives settings one tab per category and the right rows for each', () => {
    const visual = screenLayout(screenState({ view: 'settings', settingsTab: 'visual' }))
    expect(visual.controls.filter((entry) => entry.role === 'tab')).toHaveLength(5)
    expect(control(visual, 'setting:showLabels').value).toBe('On')
    expect(control(visual, 'setting:showPlasma').value).toBe('On')

    const camera = screenLayout(screenState({ view: 'settings', settingsTab: 'camera' }))
    expect(camera.controls.map((entry) => entry.id)).toContain('cycle:sizeMode')
    expect(camera.controls.map((entry) => entry.id)).toContain('cycle:camera')

    const filters = screenLayout(screenState({ view: 'settings', settingsTab: 'filters' }))
    expect(filters.controls.map((entry) => entry.id)).toContain('setting:hideHiddenFolders')
    expect(control(filters, 'filters-date').disabled).toBe(true)

    const music = screenLayout(screenState({ view: 'settings', settingsTab: 'music' }))
    expect(music.controls.map((entry) => entry.id)).toContain('audio-source-microphone')
    expect(music.controls.map((entry) => entry.id)).toContain('music-volume-up')

    const data = screenLayout(screenState({ view: 'settings', settingsTab: 'data' }))
    expect(data.controls.filter((entry) => entry.role === 'row')).toHaveLength(0)
  })

  it('shows load and warning notices only on the stage', () => {
    const loading = screenLayout(
      screenState({
        loading: { active: true, streaming: false, status: 'Reading commits', loaded: 50, target: 150, requests: 6, error: null },
        warnings: ['History was truncated'],
      }),
    )
    expect(control(loading, 'stop-loading').action).toEqual({ kind: 'cancelLoad' })
    expect(control(loading, 'warnings').action).toEqual({ kind: 'view', view: 'warnings' })

    const activity = screenLayout(
      screenState({
        view: 'activity',
        loading: { active: true, streaming: false, status: 'Reading commits', loaded: 50, target: 150, requests: 6, error: null },
      }),
    )
    expect(activity.controls.map((entry) => entry.id)).not.toContain('stop-loading')
  })
})

describe('hitTestScreen', () => {
  it('returns the action under the gaze point', () => {
    const layout = screenLayout(screenState())
    const [x, y] = centre(control(layout, 'play').rect)
    const hit = hitTestScreen(layout, x, y)
    expect(hit).toEqual({ kind: 'control', id: 'play', action: { kind: 'togglePlay' } })
    expect(xrScreenAction(hit!)).toEqual({ kind: 'togglePlay' })
    expect(xrScreenTargetId(hit)).toBe('play')
  })

  it('maps the timeline strip to a seek ratio', () => {
    const layout = screenLayout(screenState())
    const timeline = layout.timeline
    const hit = hitTestScreen(layout, timeline.x + timeline.width * 0.75, timeline.y + timeline.height / 2)
    expect(hit).toEqual({ kind: 'timeline', ratio: 0.75 })
    expect(xrScreenAction(hit!)).toEqual({ kind: 'seek', ratio: 0.75 })
    expect(xrScreenTargetId(hit)).toBe('timeline')
  })

  it('returns null in the transparent middle of the stage', () => {
    const layout = screenLayout(screenState())
    expect(hitTestScreen(layout, 900, 400)).toBeNull()
  })
})

describe('xrScreenKey', () => {
  it('changes when visible UI state changes', () => {
    const base = screenState()
    const key = xrScreenKey(base)
    expect(xrScreenKey({ ...base, hovered: 'play' })).not.toBe(key)
    expect(xrScreenKey({ ...base, view: 'help' })).not.toBe(key)
    expect(xrScreenKey({ ...base, playback: { ...base.playback, speed: 4 } })).not.toBe(key)
    expect(xrScreenKey({ ...base, minimapVisible: false })).not.toBe(key)
    expect(xrScreenKey({ ...base, settings: { ...base.settings, showLabels: false } })).not.toBe(key)
  })
})

describe('drawXrScreen', () => {
  it('paints the repository, commit, playback and gaze hint on the stage', () => {
    const { ctx, calls } = recordingContext()
    drawXrScreen(ctx, screenState())
    const painted = texts(calls)
    expect(painted).toContain('acme/web-gource')
    expect(painted).toContain('Add the VR dashboard')
    expect(painted).toContain('Pause')
    expect(painted).toContain('Speed 2×')
    expect(painted).toContain('View Standard')
    expect(painted).toContain('Restart')
    expect(painted.some((text) => text.includes('Gaze for 2 s'))).toBe(true)
    expect(painted.some((text) => text.includes('WEB GOURCE'))).toBe(true)

    // The histogram is drawn in local coordinates and translated into its
    // clipped timeline card, instead of being clipped away at the canvas origin.
    const layout = screenLayout(screenState())
    const translates = calls.filter((call) => call.method === 'translate').map((call) => call.args)
    expect(translates).toContainEqual([layout.timeline.x + 14, layout.timeline.y + 38])
    const fills = calls.filter((call) => call.method === 'fillRect')
    expect(fills.some((call) => Number(call.args[2]) > layout.timeline.width * 0.5)).toBe(true)
  })

  it('paints loading, warnings, recording and errors', () => {
    const { ctx, calls } = recordingContext()
    drawXrScreen(
      ctx,
      screenState({
        loading: {
          active: true,
          streaming: false,
          status: 'Reading commits',
          loaded: 50,
          target: 150,
          requests: 6,
          error: null,
        },
        warnings: ['History was truncated to 150 commits'],
        recording: { width: 1920, height: 1080, fps: 30, speed: 1, percent: 42, elapsed: 12 },
      }),
    )
    const painted = texts(calls)
    expect(painted).toContain('Reading commits')
    expect(painted.some((text) => text.includes('150 commits'))).toBe(true)
    expect(painted.some((text) => text.includes('Recording 1920×1080'))).toBe(true)
    expect(painted).toContain('Stop')
  })

  it('paints both activity charts', () => {
    const { ctx, calls } = recordingContext()
    drawXrScreen(ctx, screenState({ view: 'activity' }))
    const painted = texts(calls)
    expect(painted).toContain('Activity')
    expect(painted).toContain('Commits per weekday and hour')
    expect(painted).toContain('Contributions · last 53 weeks')
    expect(painted.some((text) => text.includes('120 commits · busiest Wed 14:00 UTC'))).toBe(true)
    expect(painted).toContain('Close')
  })

  it('paints authors, visibility and page controls', () => {
    const { ctx, calls } = recordingContext()
    drawXrScreen(ctx, screenState({ view: 'authors' }))
    const painted = texts(calls)
    expect(painted).toContain('Authors & filters')
    expect(painted).toContain('Ada Lovelace')
    expect(painted).toContain('Grace Hopper')
    expect(painted).toContain('visible')
    expect(painted).toContain('hidden')
    expect(painted).toContain('Show all')
  })

  it('paints settings and the data page', () => {
    const { ctx, calls } = recordingContext()
    drawXrScreen(
      ctx,
      screenState({
        view: 'settings',
        settingsTab: 'visual',
        settings: { ...screenState().settings, showPlasma: false },
      }),
    )
    let painted = texts(calls)
    expect(painted).toContain('Settings')
    expect(painted).toContain('Directory labels')
    expect(painted).toContain('On')
    expect(painted).toContain('Off')
    expect(painted).toContain('Rest the reticle on a row for 2 s · settings are shared with the desktop UI')

    const data = recordingContext()
    drawXrScreen(data.ctx, screenState({ view: 'settings', settingsTab: 'data' }))
    painted = texts(data.calls)
    expect(painted).toContain('Commits in view')
    expect(painted).toContain('Tracked size')
    expect(painted).toContain('acme/web-gource (120 commits, 3 authors)')

    const camera = recordingContext()
    drawXrScreen(camera.ctx, screenState({ view: 'settings', settingsTab: 'camera' }))
    painted = texts(camera.calls)
    expect(painted).toContain('Camera view')
    expect(painted).toContain('Standard')
    expect(painted).toContain('VR height −')
    expect(painted).toContain('VR height +')
    expect(painted).toContain('1.8 m')
  })

  it('paints the help and warnings pages', () => {
    const { ctx, calls } = recordingContext()
    drawXrScreen(ctx, screenState({ view: 'help' }))
    let painted = texts(calls)
    expect(painted).toContain('How the immersive screen works')
    expect(painted).toContain('Gaze & dwell')
    expect(painted).toContain('Recenter')
    expect(painted.some((text) => text.startsWith('Standard:'))).toBe(true)

    const warnings = recordingContext()
    drawXrScreen(
      warnings.ctx,
      screenState({ view: 'warnings', warnings: ['Only the latest 150 commits are loaded.'] }),
    )
    painted = texts(warnings.calls)
    expect(painted).toContain('Warnings & load status')
    expect(painted.some((text) => text.includes('Only the latest 150 commits'))).toBe(true)
    expect(painted).toContain('LOAD STATUS')
  })
})

describe('screenPose', () => {
  function head(position: [number, number, number], yaw = 0, pitch = 0): THREE.Matrix4 {
    const rotation = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(0, 0, yaw))
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2 + pitch, 0, 0)))
    return new THREE.Matrix4().compose(new THREE.Vector3(...position), rotation, new THREE.Vector3(1, 1, 1))
  }

  it('floats ahead and faces the viewer', () => {
    const eye: [number, number, number] = [0.4, -0.2, 1.6]
    const { position, quaternion } = screenPose(head(eye))
    expect(position.x).toBeCloseTo(eye[0])
    expect(position.y).toBeCloseTo(eye[1] + XR_SCREEN_DISTANCE)
    expect(position.z).toBeCloseTo(eye[2] + XR_SCREEN_RISE)
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion)
    expect(normal.y).toBeCloseTo(-1)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion)
    expect(up.z).toBeCloseTo(1)
  })

  it('ignores pitch and follows yaw', () => {
    const level = screenPose(head([0, 0, 1.6]))
    const pitched = screenPose(head([0, 0, 1.6], 0, -0.7))
    expect(pitched.position.distanceTo(level.position)).toBeLessThan(1e-9)
    expect(pitched.quaternion.angleTo(level.quaternion)).toBeLessThan(1e-9)

    const turned = screenPose(head([0, 0, 1.6], Math.PI / 2))
    expect(turned.position.x).toBeCloseTo(-XR_SCREEN_DISTANCE)
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(turned.quaternion)
    expect(normal.x).toBeCloseTo(1)
  })
})

describe('XrScreenPanel', () => {
  it('repaints only when the visible state changes', () => {
    const { ctx } = recordingContext()
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
    const panel = new XrScreenPanel({ canvas })
    const state = screenState()

    expect(panel.redraw(state)).toBe(true)
    expect(panel.redraw(state)).toBe(false)
    expect(panel.redraw({ ...state, hovered: 'play' })).toBe(true)
    expect(panel.canvasElement).toBe(canvas)

    // A front-facing twin rotated 180 degrees makes the back read correctly.
    const material = panel.mesh.material as THREE.MeshBasicMaterial
    expect(material.side).toBe(THREE.FrontSide)
    const back = panel.mesh.children[0] as THREE.Mesh
    expect(back).toBeInstanceOf(THREE.Mesh)
    expect(back.rotation.y).toBeCloseTo(Math.PI, 6)
    expect(back.material).toBe(material)
    expect(back.geometry).toBe(panel.mesh.geometry)
    panel.dispose()
  })
})
