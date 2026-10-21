// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  XR_2D_PANEL_CENTER,
  XR_CAMERA_MODE_LABELS,
  XR_CONTROL_ORDER,
  XR_PANEL_CANVAS_HEIGHT,
  XR_PANEL_CANVAS_WIDTH,
  XR_PANEL_DISTANCE,
  XR_PANEL_RISE,
  XR_UI_DWELL_SECONDS,
  XrReticle,
  XrTimelinePanel,
  controlLabel,
  createDwellState,
  drawReticle,
  drawXrPanel,
  dwell,
  dwellProgress,
  hitTargetId,
  hitTest,
  panelLayout,
  panelPose,
  xrCommand,
  xrPanelKey,
  type XrPanelState,
} from '../src/render/xr-ui'
import type { ActivityBucket } from '../src/timeline/types'

/**
 * In-scene VR timeline panel.
 *
 * jsdom has no canvas, so the drawing is driven by a recording 2D context stub:
 * every method call is captured, which is enough to assert that the histogram,
 * the playhead and every control label were painted. The geometry, the hit
 * testing and the dwell accumulator are pure and tested directly.
 */

interface Recorded {
  method: string
  args: unknown[]
}

/** A 2D context that records every call and every property write. */
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

function fakeCanvas(ctx: CanvasRenderingContext2D): HTMLCanvasElement {
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
}

function texts(calls: Recorded[]): string[] {
  return calls.filter((call) => call.method === 'fillText').map((call) => String(call.args[0]))
}

function buckets(count = 40): ActivityBucket[] {
  return Array.from({ length: count }, (_, index) => ({
    t: index,
    commits: (index * 7) % 5,
    additions: index,
    deletions: 0,
  }))
}

function panelState(overrides: Partial<XrPanelState> = {}): XrPanelState {
  return {
    buckets: buckets(),
    position: 30,
    duration: 120,
    date: '2024-03-06 14:30',
    progress: 0.25,
    playing: false,
    speed: 1,
    cameraMode: 'free',
    hovered: null,
    ...overrides,
  }
}

describe('panelLayout', () => {
  it('lays the six controls out in order below the timeline strip', () => {
    const layout = panelLayout(XR_PANEL_CANVAS_WIDTH, XR_PANEL_CANVAS_HEIGHT)
    expect(layout.controls.map((control) => control.id)).toEqual([...XR_CONTROL_ORDER])
    expect(layout.controls.map((control) => control.id)).toEqual([
      'restart',
      'prev',
      'play',
      'next',
      'speed',
      'camera',
    ])

    const timelineBottom = layout.timeline.y + layout.timeline.height
    for (const control of layout.controls) {
      // Every control sits below the timeline and inside the canvas.
      expect(control.rect.y).toBeGreaterThanOrEqual(timelineBottom)
      expect(control.rect.x).toBeGreaterThanOrEqual(0)
      expect(control.rect.y + control.rect.height).toBeLessThanOrEqual(XR_PANEL_CANVAS_HEIGHT)
      expect(control.rect.x + control.rect.width).toBeLessThanOrEqual(XR_PANEL_CANVAS_WIDTH)
    }
    // Left to right, with no overlaps.
    const lefts = layout.controls.map((control) => control.rect.x)
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b))
    for (let index = 1; index < layout.controls.length; index += 1) {
      const previous = layout.controls[index - 1].rect
      expect(layout.controls[index].rect.x).toBeGreaterThanOrEqual(previous.x + previous.width)
    }
  })
})

describe('panelPose', () => {
  /** A headset pose at `position`, facing `yaw` around the room's up (+Z) and
   *  pitched by `pitch` around the head's own right axis. The base rotation is
   *  the rig tilt that maps the headset's -Z onto the room's +Y. */
  function headAt(position: [number, number, number], yaw = 0, pitch = 0): THREE.Matrix4 {
    const rotation = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(0, 0, yaw))
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2 + pitch, 0, 0)))
    return new THREE.Matrix4().compose(
      new THREE.Vector3(...position),
      rotation,
      new THREE.Vector3(1, 1, 1),
    )
  }

  it('floats the panel ahead of the head and above the eye line', () => {
    const eye: [number, number, number] = [0.4, -0.2, 1.6]
    const { position, quaternion } = panelPose(headAt(eye))

    expect(position.x).toBeCloseTo(eye[0])
    expect(position.y).toBeCloseTo(eye[1] + XR_PANEL_DISTANCE)
    expect(position.z).toBeCloseTo(eye[2] + XR_PANEL_RISE)
    // Facing the user: +Z points back at them, +Y stays up, +X is their right.
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion)
    expect(forward.x).toBeCloseTo(0)
    expect(forward.y).toBeCloseTo(-1)
    expect(forward.z).toBeCloseTo(0)
    expect(up.x).toBeCloseTo(0)
    expect(up.y).toBeCloseTo(0)
    expect(up.z).toBeCloseTo(1)
    expect(right.x).toBeCloseTo(1)
    expect(right.y).toBeCloseTo(0)
    expect(right.z).toBeCloseTo(0)
  })

  it('ignores pitch so the panel stays upright and horizontal', () => {
    const level = panelPose(headAt([0, 0, 1.6], 0, 0))
    const looking = panelPose(headAt([0, 0, 1.6], 0, -0.6))
    expect(looking.position.distanceTo(level.position)).toBeLessThan(1e-9)
    expect(looking.quaternion.angleTo(level.quaternion)).toBeLessThan(1e-9)
  })

  it('follows the yaw: the panel is always in front of where the user faces', () => {
    const { position, quaternion } = panelPose(headAt([0, 0, 1.6], Math.PI / 2))
    expect(position.x).toBeCloseTo(-XR_PANEL_DISTANCE)
    expect(position.y).toBeCloseTo(0)
    expect(position.z).toBeCloseTo(1.6 + XR_PANEL_RISE)
    // The panel normal points back at the head (on the +X side).
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion)
    expect(normal.x).toBeCloseTo(1)
  })
})

describe('hitTest', () => {
  const layout = panelLayout()

  it('returns a control when the point is inside its rectangle', () => {
    for (const control of layout.controls) {
      const rect = control.rect
      expect(hitTest(layout, rect.x + rect.width / 2, rect.y + rect.height / 2)).toEqual({
        kind: 'control',
        id: control.id,
      })
    }
  })

  it('returns the timeline ratio for a point on the strip', () => {
    const timeline = layout.timeline
    expect(hitTest(layout, timeline.x + timeline.width * 0.5, timeline.y + timeline.height / 2)).toEqual({
      kind: 'timeline',
      ratio: 0.5,
    })
    expect(hitTest(layout, timeline.x, timeline.y + 1)).toEqual({ kind: 'timeline', ratio: 0 })
    const nearEnd = hitTest(layout, timeline.x + timeline.width, timeline.y + 1)
    expect(nearEnd).toEqual({ kind: 'timeline', ratio: 1 })
  })

  it('returns null for a point on neither', () => {
    expect(hitTest(layout, -5, -5)).toBeNull()
    expect(hitTest(layout, XR_PANEL_CANVAS_WIDTH + 5, XR_PANEL_CANVAS_HEIGHT + 5)).toBeNull()
  })

  it('gives every hit a stable dwell target id', () => {
    expect(hitTargetId(null)).toBeNull()
    expect(hitTargetId({ kind: 'control', id: 'next' })).toBe('control:next')
    expect(hitTargetId({ kind: 'timeline', ratio: 0.4 })).toBe('timeline')
  })
})

describe('dwell', () => {
  it('fires exactly once after the dwell time', () => {
    const state = createDwellState()
    expect(XR_UI_DWELL_SECONDS).toBe(2)
    expect(dwell(state, 'control:play', 1)).toBe(false)
    expect(dwell(state, 'control:play', 0.9)).toBe(false)
    expect(dwellProgress(state)).toBeCloseTo(0.95, 6)
    expect(dwell(state, 'control:play', 0.2)).toBe(true)
    // Staying on the same target must not fire again.
    expect(dwell(state, 'control:play', 0.5)).toBe(false)
    expect(dwell(state, 'control:play', 5)).toBe(false)
  })

  it('resets when the gaze leaves and when the target changes', () => {
    const state = createDwellState()
    expect(dwell(state, 'timeline', 1.5)).toBe(false)
    // Leaving resets the accumulator.
    expect(dwell(state, null, 0.1)).toBe(false)
    expect(dwellProgress(state)).toBe(0)
    expect(dwell(state, 'timeline', 1.9)).toBe(false)
    expect(dwell(state, 'timeline', 0.2)).toBe(true)

    // Switching target starts a fresh dwell.
    expect(dwell(state, 'control:next', 1.9)).toBe(false)
    expect(dwell(state, 'control:next', 0.2)).toBe(true)
    expect(dwell(state, 'control:play', 0.1)).toBe(false)
  })
})

describe('xrCommand', () => {
  it('maps every control and the timeline to the right engine command', () => {
    expect(xrCommand({ kind: 'control', id: 'restart' })).toEqual({ kind: 'restart' })
    expect(xrCommand({ kind: 'control', id: 'prev' })).toEqual({ kind: 'step', delta: -1 })
    expect(xrCommand({ kind: 'control', id: 'play' })).toEqual({ kind: 'togglePlay' })
    expect(xrCommand({ kind: 'control', id: 'next' })).toEqual({ kind: 'step', delta: 1 })
    expect(xrCommand({ kind: 'control', id: 'speed' })).toEqual({ kind: 'cycleSpeed' })
    expect(xrCommand({ kind: 'control', id: 'camera' })).toEqual({ kind: 'cycleCamera' })
    expect(xrCommand({ kind: 'timeline', ratio: 0.25 })).toEqual({ kind: 'seek', ratio: 0.25 })
  })

  it('flips the play label and shows the current speed and view', () => {
    expect(controlLabel('play', false)).toBe('Play')
    expect(controlLabel('play', true)).toBe('Pause')
    expect(controlLabel('restart', false)).toBe('Restart')
    expect(controlLabel('speed', false, 2)).toBe('Speed 2×')
    expect(controlLabel('speed', false, 0.25)).toBe('Speed 0.25×')
    for (const mode of ['free', 'follow'] as const) {
      expect(controlLabel('camera', false, 1, mode)).toBe(`View ${XR_CAMERA_MODE_LABELS[mode]}`)
    }
  })
})

describe('xrPanelKey', () => {
  it('changes when the speed or camera mode changes', () => {
    const base = xrPanelKey(panelState())
    expect(xrPanelKey(panelState({ speed: 2 }))).not.toBe(base)
    expect(xrPanelKey(panelState({ cameraMode: 'follow' }))).not.toBe(base)
    expect(xrPanelKey(panelState({ speed: 1, cameraMode: 'free' }))).toBe(base)
  })
})

describe('drawXrPanel', () => {
  it('paints the histogram, the playhead, the date and every control label', () => {
    const { ctx, calls } = recordingContext()
    drawXrPanel(ctx, panelState())

    // The histogram: one bar per bucket, plus the baseline.
    const bars = calls.filter((call) => call.method === 'fillRect')
    expect(bars.length).toBeGreaterThan(buckets().length)

    // The playhead is a 2px-wide bar drawn over the full strip height.
    expect(bars.some((call) => call.args[2] === 2)).toBe(true)

    const labels = texts(calls)
    for (const control of XR_CONTROL_ORDER) {
      expect(labels).toContain(controlLabel(control, false, 1, 'free'))
    }
    expect(labels).toContain('Speed 1×')
    expect(labels).toContain('View Free')
    expect(labels).toContain('2024-03-06 14:30')
    expect(labels).toContain('25%')
  })

  it('shows Pause and outlines the hovered element', () => {
    const playing = recordingContext()
    drawXrPanel(playing.ctx, panelState({ playing: true, hovered: 'control:play' }))
    const labels = texts(playing.calls)
    expect(labels).toContain('Pause')
    expect(labels).not.toContain('Play')
    // Every button is stroked (its border); the strip only gets the hover ring
    // when the strip itself is hovered.
    expect(playing.calls.some((call) => call.method === 'strokeRect')).toBe(false)

    const onTimeline = recordingContext()
    drawXrPanel(onTimeline.ctx, panelState({ hovered: 'timeline' }))
    expect(onTimeline.calls.some((call) => call.method === 'strokeRect')).toBe(true)
  })
})

describe('XrTimelinePanel', () => {
  it('only repaints when the content changes', () => {
    const { ctx, calls } = recordingContext()
    const panel = new XrTimelinePanel({ canvas: fakeCanvas(ctx) })

    expect(panel.redraw(panelState())).toBe(true)
    const afterFirst = calls.length
    expect(panel.redraw(panelState())).toBe(false)
    expect(calls.length).toBe(afterFirst)

    expect(panel.redraw(panelState({ playing: true }))).toBe(true)
    expect(calls.length).toBeGreaterThan(afterFirst)
    expect(panel.redraw(panelState({ speed: 2 }))).toBe(true)
    expect(panel.redraw(panelState({ cameraMode: 'follow' }))).toBe(true)
    panel.dispose()
  })

  it('is a plane carrying a canvas texture', () => {
    const { ctx } = recordingContext()
    const panel = new XrTimelinePanel({ canvas: fakeCanvas(ctx) })
    const material = panel.mesh.material as THREE.MeshBasicMaterial
    expect(panel.mesh.geometry).toBeInstanceOf(THREE.PlaneGeometry)
    expect(material.map).toBeInstanceOf(THREE.CanvasTexture)
    // The HUD must draw over the tree, never be occluded by it.
    expect(material.depthTest).toBe(false)
    expect(panel.mesh.renderOrder).toBeGreaterThan(0)
    panel.dispose()
  })
})

describe('drawReticle', () => {
  it('draws the ring, the dot and the dwell arc', () => {
    const { ctx, calls } = recordingContext()
    drawReticle(ctx, { progress: 0.5, hovered: true }, 128)
    const arcs = calls.filter((call) => call.method === 'arc')
    // Ring + centre dot + progress arc.
    expect(arcs.length).toBeGreaterThanOrEqual(3)
    // The progress arc ends half a turn on from the top.
    expect(arcs.some((call) => Math.abs(Number(call.args[4]) - Math.PI / 2) < 1e-6)).toBe(true)
  })

  it('draws no progress arc when the gaze is idle', () => {
    const { ctx, calls } = recordingContext()
    drawReticle(ctx, { progress: 0, hovered: false }, 128)
    expect(calls.filter((call) => call.method === 'arc').length).toBe(2)
  })
})

describe('2D panel placement', () => {
  it('keeps the flat dashboard near the far edge of the tabletop', () => {
    expect(XR_2D_PANEL_CENTER.x).toBe(0)
    expect(XR_2D_PANEL_CENTER.y).toBeGreaterThan(0)
    expect(XR_2D_PANEL_CENTER.y).toBeLessThan(0.75)
    expect(XR_2D_PANEL_CENTER.z).toBeGreaterThan(0)
  })
})

describe('XrReticle', () => {
  it('parks the reticle in front of the headset camera', () => {
    const { ctx } = recordingContext()
    const reticle = new XrReticle({ canvas: fakeCanvas(ctx) })
    const camera = new THREE.Matrix4().makeTranslation(1, 2, 3)
    reticle.place(camera, 0.5)
    expect(reticle.mesh.position.x).toBeCloseTo(1, 6)
    expect(reticle.mesh.position.y).toBeCloseTo(2, 6)
    expect(reticle.mesh.position.z).toBeCloseTo(2.5, 6)
    reticle.dispose()
  })

  it('only repaints when the progress or hover state changes', () => {
    const { ctx, calls } = recordingContext()
    const reticle = new XrReticle({ canvas: fakeCanvas(ctx) })
    expect(reticle.update({ progress: 0.5, hovered: false })).toBe(true)
    const afterFirst = calls.length
    expect(reticle.update({ progress: 0.5, hovered: false })).toBe(false)
    expect(calls.length).toBe(afterFirst)
    expect(reticle.update({ progress: 0.5, hovered: true })).toBe(true)
    reticle.dispose()
  })
})
