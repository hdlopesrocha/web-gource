import type { Simulation } from '../sim/simulation'
import { colorForChange, DIR_COLOR } from './palette'
import type { ChangeKind } from '../timeline/types'

export interface MinimapOptions {
  size: number
  showCamera: boolean
  showAuthors: boolean
}

/**
 * Top-down 2D overview of the repository tree plus the camera frustum.
 *
 * Drawn on a small canvas: directories and files as dots (coloured by the same
 * palette as the main view), authors as bright rings, and the current view
 * target as a crosshair. Updated at a low rate since it is a navigation aid.
 */
export interface MinimapDrawOptions {
  /** Canvas size in device pixels (the drawing is square). */
  size: number
  sim: Simulation
  /** Centre of the 2D view, drawn as a crosshair. */
  cameraTarget: { x: number; y: number; z?: number }
  showCamera?: boolean
  showAuthors?: boolean
}

/**
 * Stateful drawer for the overview.
 *
 * Kept separate from the DOM so the export compositor can draw exactly the same
 * overview into a video frame; the smoothing state is per instance.
 */
export class MinimapDrawer {
  private extent = 60
  private lastCenter = { x: 0, y: 0 }

  draw(ctx: CanvasRenderingContext2D, options: MinimapDrawOptions): void {
    const { sim, cameraTarget } = options
    const size = options.size
    const dpr = Math.max(1, size / 168)
    const half = size / 2

    // Track the visible extent so the minimap keeps the tree in frame.
    const bounds = sim.bounds()
    const targetExtent = Math.max(24, bounds.radius * 1.15)
    this.extent += (targetExtent - this.extent) * 0.08
    this.lastCenter.x += (bounds.center.x - this.lastCenter.x) * 0.08
    this.lastCenter.y += (bounds.center.y - this.lastCenter.y) * 0.08
    const scale = half / this.extent

    ctx.clearRect(0, 0, size, size)
    ctx.fillStyle = 'rgba(6,9,18,0.72)'
    ctx.fillRect(0, 0, size, size)

    const toX = (x: number) => half + (x - this.lastCenter.x) * scale
    // Screen Y grows downwards, world Y upwards.
    const toY = (y: number) => half - (y - this.lastCenter.y) * scale

    // Tree dots.
    const nodes = sim.nodes
    for (const node of nodes) {
      if (!node.visible) continue
      if (node.kind === 'root') continue
      const x = toX(node.position.x)
      const y = toY(node.position.y)
      if (x < -4 || y < -4 || x > size + 4 || y > size + 4) continue
      if (node.kind === 'dir') {
        ctx.fillStyle = 'rgba(120,170,235,0.5)'
        ctx.fillRect(x - 1.2 * dpr, y - 1.2 * dpr, 2.4 * dpr, 2.4 * dpr)
      } else {
        const kind = (node.lastKind ?? 'modify') as ChangeKind
        const alpha = node.lastChangeIndex > sim.currentIndex - 6 ? 0.95 : 0.4
        ctx.fillStyle = alpha > 0.5 ? `rgba(255,235,180,${alpha})` : 'rgba(150,190,255,0.35)'
        void kind
        ctx.fillRect(x, y, 1.4 * dpr, 1.4 * dpr)
      }
    }

    // Authors.
    if (options.showAuthors !== false) {
      for (const author of sim.authors) {
        if (!author.visible) continue
        ctx.beginPath()
        ctx.arc(toX(author.position.x), toY(author.position.y), 3 * dpr, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255,255,255,0.9)'
        ctx.fill()
      }
    }

    // Camera target crosshair.
    if (options.showCamera !== false) {
      const x = toX(cameraTarget.x)
      const y = toY(cameraTarget.y)
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'
      ctx.lineWidth = 1 * dpr
      ctx.beginPath()
      ctx.arc(x, y, 5 * dpr, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(x - 8 * dpr, y)
      ctx.lineTo(x - 2 * dpr, y)
      ctx.moveTo(x + 2 * dpr, y)
      ctx.lineTo(x + 8 * dpr, y)
      ctx.moveTo(x, y - 8 * dpr)
      ctx.lineTo(x, y - 2 * dpr)
      ctx.moveTo(x, y + 2 * dpr)
      ctx.lineTo(x, y + 8 * dpr)
      ctx.stroke()
    }

    void DIR_COLOR
    void colorForChange
  }
}

/** The on-screen overview: a DOM canvas plus the shared drawer. */
export class Minimap {
  private ctx: CanvasRenderingContext2D
  private canvas: HTMLCanvasElement
  private dpr = 1
  private drawer = new MinimapDrawer()

  constructor(canvas: HTMLCanvasElement, private readonly options: MinimapOptions) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Minimap requires a 2D canvas context')
    this.ctx = ctx
    this.resize(options.size)
  }

  resize(size: number): void {
    this.dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    this.canvas.width = Math.floor(size * this.dpr)
    this.canvas.height = Math.floor(size * this.dpr)
    this.canvas.style.width = `${size}px`
    this.canvas.style.height = `${size}px`
  }

  /** Render one frame. `cameraTarget` is the centre of the 2D view. */
  render(sim: Simulation, cameraTarget: { x: number; y: number; z?: number }): void {
    this.drawer.draw(this.ctx, {
      size: this.canvas.width,
      sim,
      cameraTarget,
      showCamera: this.options.showCamera,
      showAuthors: this.options.showAuthors,
    })
  }
}
