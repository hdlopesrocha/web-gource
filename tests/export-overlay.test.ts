import { describe, expect, it } from 'vitest'
import { ExportOverlay, overlayLayout, type OverlayFrame, type OverlayRect } from '../src/engine/export/overlay'
import { MINIMAP_DOT_COLORS } from '../src/render/minimap'
import type { Simulation, SimNode } from '../src/sim/simulation'

/**
 * jsdom has no canvas, so the overlay is driven through a recording 2D context
 * that tracks the translation stack and records every primitive in frame
 * coordinates. That is enough to prove where the overview chrome, its tree dots
 * and the camera crosshair land.
 */

interface FillCall {
  x: number
  y: number
  width: number
  height: number
  fill: string
}

interface RectCall {
  x: number
  y: number
  width: number
  height: number
}

interface TextCall {
  text: string
  x: number
  y: number
  align: string
  font: string
}

interface ArcCall {
  x: number
  y: number
  r: number
  filled: boolean
  stroked: boolean
  fill: string
}

class RecordingContext {
  fillStyle = '#000000'
  strokeStyle = '#000000'
  lineWidth = 1
  font = '10px sans-serif'
  textAlign = 'start'
  textBaseline = 'alphabetic'

  readonly fills: FillCall[] = []
  readonly roundRects: RectCall[] = []
  readonly rects: RectCall[] = []
  readonly clears: RectCall[] = []
  readonly texts: TextCall[] = []
  readonly arcs: ArcCall[] = []
  readonly points: { x: number; y: number }[] = []

  private transform = { x: 0, y: 0 }
  private readonly stack: { x: number; y: number }[] = []
  private readonly pendingArcs: ArcCall[] = []
  private readonly pendingPoints: { x: number; y: number }[] = []

  save(): void {
    this.stack.push({ ...this.transform })
  }

  restore(): void {
    const previous = this.stack.pop()
    if (previous) this.transform = previous
  }

  translate(x: number, y: number): void {
    this.transform.x += x
    this.transform.y += y
  }

  setTransform(_a: number, _b: number, _c: number, _d: number, e: number, f: number): void {
    this.transform = { x: e, y: f }
  }

  beginPath(): void {
    this.pendingArcs.length = 0
    this.pendingPoints.length = 0
  }

  moveTo(x: number, y: number): void {
    const point = this.absolute(x, y)
    this.pendingPoints.push(point)
    this.points.push(point)
  }

  lineTo(x: number, y: number): void {
    this.moveTo(x, y)
  }

  arc(x: number, y: number, r: number, _start: number, _end: number): void {
    const center = this.absolute(x, y)
    const call: ArcCall = { x: center.x, y: center.y, r, filled: false, stroked: false, fill: this.fillStyle }
    this.pendingArcs.push(call)
    this.arcs.push(call)
  }

  rect(x: number, y: number, width: number, height: number): void {
    this.rects.push({ ...this.absolute(x, y), width, height })
  }

  roundRect(x: number, y: number, width: number, height: number, _r?: number): void {
    this.roundRects.push({ ...this.absolute(x, y), width, height })
  }

  fill(): void {
    for (const arc of this.pendingArcs) {
      arc.filled = true
      arc.fill = this.fillStyle
    }
  }

  stroke(): void {
    for (const arc of this.pendingArcs) arc.stroked = true
  }

  clip(): void {
    /* no-op */
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    this.clears.push({ ...this.absolute(x, y), width, height })
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.fills.push({ ...this.absolute(x, y), width, height, fill: this.fillStyle })
  }

  strokeRect(x: number, y: number, width: number, height: number): void {
    this.rects.push({ ...this.absolute(x, y), width, height })
  }

  fillText(text: string, x: number, y: number): void {
    const position = this.absolute(x, y)
    this.texts.push({ text, x: position.x, y: position.y, align: this.textAlign, font: this.font })
  }

  measureText(text: string): { width: number } {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10)
    return { width: text.length * size * 0.55 }
  }

  private absolute(x: number, y: number): { x: number; y: number } {
    return { x: x + this.transform.x, y: y + this.transform.y }
  }
}

const context = (): CanvasRenderingContext2D => new RecordingContext() as unknown as CanvasRenderingContext2D

function node(id: number, overrides: Partial<SimNode> = {}): SimNode {
  return {
    id,
    path: `src/file-${id}.ts`,
    name: `file-${id}.ts`,
    kind: 'file',
    parent: 0,
    children: [],
    position: { x: 0, y: 0, z: 0 },
    targetPosition: { x: 0, y: 0, z: 0 },
    radius: 0.2,
    clusterRadius: 0.2,
    ownDiscRadius: 0.2,
    contentRadius: 0.2,
    subtreeArea: 0,
    positionInitialized: true,
    sizeBytes: 0,
    sizeKnown: false,
    activity: 0,
    bornIndex: id,
    lastChangeIndex: id,
    lastKind: null,
    changes: 0,
    additions: 0,
    deletions: 0,
    visible: true,
    ...overrides,
  }
}

/** A small tree, enough to exercise directory/file dots and author rings. */
function fakeSimulation(): Simulation {
  const nodes: SimNode[] = [node(0, { kind: 'root', path: '' })]
  const dirs = ['src', 'lib', 'docs']
  dirs.forEach((path, index) => {
    nodes.push(node(10 + index, { kind: 'dir', path, name: path, position: { x: Math.cos(index) * 12, y: Math.sin(index) * 12, z: 0 } }))
  })
  for (let index = 0; index < 24; index += 1) {
    const angle = index * 0.6
    nodes.push(node(100 + index, { position: { x: Math.cos(angle) * 18, y: Math.sin(angle) * 18, z: 0 }, lastChangeIndex: 200 + index }))
  }
  const authors = [
    { visible: true, position: { x: 6, y: 4, z: 0 }, author: { id: 'a1', name: 'Priya', colorIndex: 0 }, appliedCommits: 3, lastActiveAt: 1 },
    { visible: true, position: { x: -9, y: -5, z: 0 }, author: { id: 'a2', name: 'Frances', colorIndex: 3 }, appliedCommits: 2, lastActiveAt: 2 },
  ]
  const sim = {
    nodes,
    authors,
    currentIndex: 220,
    bounds: () => ({ center: { x: 0, y: 0, z: 0 }, radius: 24 }),
    stats: () => ({ visibleFiles: 24, dirs: 4, files: 24, additions: 10, deletions: 3 }),
  }
  return sim as unknown as Simulation
}

function fakeFrame(width: number, height: number): OverlayFrame {
  return {
    width,
    height,
    simTime: 60,
    duration: 281,
    sim: fakeSimulation(),
    cameraTarget: { x: 4, y: 3 },
    date: Date.UTC(2021, 0, 10, 14, 21),
    commit: null,
    buckets: Array.from({ length: 120 }, (_, index) => ({
      t: index,
      commits: Math.round(8 * Math.abs(Math.sin(index / 7))),
      additions: 0,
      deletions: 0,
    })),
    timeline: { files: 1019, totalBytes: 68.4 * 1024 * 1024, authors: 8 },
    fps: 60,
  }
}

const SIZES: [number, number][] = [
  [1280, 720],
  [1920, 1080],
  [720, 1280],
]

function overlaps(a: OverlayRect, b: OverlayRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function inside(rect: OverlayRect, x: number, y: number, slack = 0): boolean {
  return x >= rect.x - slack && x <= rect.x + rect.width + slack && y >= rect.y - slack && y <= rect.y + rect.height + slack
}

describe('export overlay overview', () => {
  it('lays the overview out inside the frame without overlapping any other panel', () => {
    for (const [width, height] of SIZES) {
      const layout = overlayLayout(width, height)
      const { overview } = layout

      // A sane, visible size with a square map.
      expect(overview.width).toBeGreaterThanOrEqual(72)
      expect(overview.height).toBeGreaterThanOrEqual(overview.width)
      expect(overview.map.width).toBeGreaterThanOrEqual(44)
      expect(overview.map.width).toBe(overview.map.height)

      // Inside the frame.
      expect(overview.x).toBeGreaterThanOrEqual(0)
      expect(overview.y).toBeGreaterThanOrEqual(0)
      expect(overview.x + overview.width).toBeLessThanOrEqual(width)
      expect(overview.y + overview.height).toBeLessThanOrEqual(height)

      // Never covers the timeline, the info panel or the activity charts.
      expect(overlaps(overview, layout.timeline)).toBe(false)
      expect(overlaps(overview, layout.info)).toBe(false)
      expect(overlaps(overview, layout.charts)).toBe(false)

      // The map sits inside its own panel.
      expect(overview.map.x).toBeGreaterThanOrEqual(overview.x)
      expect(overview.map.y).toBeGreaterThanOrEqual(overview.y)
      expect(overview.map.y + overview.map.height).toBeLessThanOrEqual(overview.y + overview.height)
    }
  })

  it('draws the OVERVIEW heading, the legend row and the map inside the panel', () => {
    for (const [width, height] of SIZES) {
      const frame = fakeFrame(width, height)
      const layout = overlayLayout(width, height)
      const ctx = context()
      const overlay = new ExportOverlay([], [], { repository: 'synthetic-repository' })
      overlay.draw(ctx, frame)

      const recording = ctx as unknown as RecordingContext
      const overview = layout.overview

      const heading = recording.texts.find((call) => call.text === 'OVERVIEW')
      expect(heading, `OVERVIEW heading at ${width}x${height}`).toBeDefined()
      expect(inside(overview, heading!.x, heading!.y)).toBe(true)

      const repository = recording.texts.find((call) => call.text === 'synthetic-repository')
      expect(repository, `repository label at ${width}x${height}`).toBeDefined()
      expect(inside(overview, repository!.x, repository!.y)).toBe(true)

      for (const label of ['directories', 'files', 'authors']) {
        const call = recording.texts.find((entry) => entry.text === label)
        expect(call, `${label} legend at ${width}x${height}`).toBeDefined()
        expect(inside(overview, call!.x, call!.y)).toBe(true)
      }

      // Legend swatches use the same colours as the map dots.
      const dirSwatch = recording.fills.find((fill) => fill.fill === MINIMAP_DOT_COLORS.dir)
      const fileSwatch = recording.fills.find((fill) => fill.fill === MINIMAP_DOT_COLORS.file)
      expect(dirSwatch).toBeDefined()
      expect(fileSwatch).toBeDefined()
      expect(inside(overview, dirSwatch!.x, dirSwatch!.y)).toBe(true)

      const authorSwatch = recording.arcs.find((arc) => arc.filled && arc.fill === MINIMAP_DOT_COLORS.author)
      expect(authorSwatch, `author legend dot at ${width}x${height}`).toBeDefined()
      expect(inside(overview, authorSwatch!.x, authorSwatch!.y)).toBe(true)

      // The panel itself is drawn behind the map.
      expect(recording.roundRects.some((rect) => rect.x === overview.x && rect.y === overview.y && rect.width === overview.width)).toBe(true)

      // Tree dots and the crosshair stay inside the map square.
      const map = overview.map
      const mapDots = recording.fills.filter((fill) => inside(map, fill.x, fill.y, 6) && fill.width <= map.width)
      expect(mapDots.length, `tree dots at ${width}x${height}`).toBeGreaterThan(0)
      for (const dot of mapDots) expect(inside(map, dot.x, dot.y, 6)).toBe(true)

      // The camera crosshair: a stroked ring plus the four arms.
      const crosshair = recording.arcs.find((arc) => arc.stroked && !arc.filled && inside(map, arc.x, arc.y, 8))
      expect(crosshair, `crosshair at ${width}x${height}`).toBeDefined()
      const arms = recording.points.filter((point) => inside(map, point.x, point.y, 10))
      expect(arms.length).toBeGreaterThan(0)
    }
  })

  it('skips the whole overview when overview: false', () => {
    const frame = fakeFrame(1280, 720)
    const layout = overlayLayout(1280, 720, { overview: false })
    const ctx = context()
    const overlay = new ExportOverlay([], [], { overview: false })
    overlay.draw(ctx, frame)

    const recording = ctx as unknown as RecordingContext
    expect(recording.texts.some((call) => call.text === 'OVERVIEW')).toBe(false)
    for (const label of ['directories', 'files', 'authors']) {
      expect(recording.texts.some((call) => call.text === label)).toBe(false)
    }
    const map = layout.overview.map
    expect(recording.fills.some((fill) => inside(map, fill.x, fill.y, 4))).toBe(false)
  })
})
