import * as THREE from 'three'

/**
 * Canvas texture caches.
 *
 * Text is expensive to rasterize, so labels and avatars are rendered into
 * canvases and cached by content. The caches are bounded to keep memory in
 * check on long sessions.
 */

interface CacheEntry<T> {
  value: T
  lastUsed: number
}

class TextureCache<T extends THREE.Texture> {
  private entries = new Map<string, CacheEntry<T>>()

  constructor(
    private readonly capacity: number,
    private readonly factory: (key: string, data: string) => T,
  ) {}

  get(key: string, data: string): T {
    const existing = this.entries.get(key)
    if (existing) {
      existing.lastUsed = performance.now()
      return existing.value
    }
    const value = this.factory(key, data)
    this.entries.set(key, { value, lastUsed: performance.now() })
    if (this.entries.size > this.capacity) this.evict()
    return value
  }

  private evict(): void {
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    const removeCount = Math.max(1, Math.floor(this.capacity * 0.2))
    for (const [key, entry] of sorted.slice(0, removeCount)) {
      entry.value.dispose()
      this.entries.delete(key)
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.value.dispose()
    this.entries.clear()
  }
}

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')
  return { canvas, ctx }
}

/**
 * Plain white texture, used when there is no 2D canvas (headless tests): the
 * generated sprites only exist to be looked at, so a flat fallback keeps the
 * render bookkeeping testable.
 */
function fallbackTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
  texture.needsUpdate = true
  return texture
}

export interface LabelStyle {
  color?: string
  background?: string
  font?: string
  padding?: number
  radius?: number
}

/** Create a crisp text label texture (device pixel ratio aware). */
function createLabelTexture(text: string, data: string): THREE.CanvasTexture {
  const style: LabelStyle = JSON.parse(data) as LabelStyle
  const padding = style.padding ?? 10
  const radius = style.radius ?? 8
  const font = style.font ?? '600 30px "Inter", "Segoe UI", system-ui, sans-serif'
  const measure = makeCanvas(8, 8)
  measure.ctx.font = font
  const metrics = measure.ctx.measureText(text)
  const textWidth = Math.ceil(metrics.width)
  const textHeight = Math.ceil(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent || 30)
  const width = textWidth + padding * 2
  const height = textHeight + padding * 2
  const { canvas, ctx } = makeCanvas(width, height)

  if (style.background) {
    ctx.fillStyle = style.background
    roundRect(ctx, 0, 0, width, height, radius)
    ctx.fill()
  }
  ctx.font = font
  ctx.fillStyle = style.color ?? '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillText(text, width / 2, height / 2 + 1)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.anisotropy = 2
  // Store the aspect ratio so sprites can be scaled correctly.
  texture.userData.aspect = width / height
  return texture
}

/** Circular avatar with initials, plus optional name text underneath. */
function createAvatarTexture(_key: string, data: string): THREE.CanvasTexture {
  const parsed = JSON.parse(data) as { color: string; name?: string; initials: string }
  const size = 256
  const showName = Boolean(parsed.name)
  const nameHeight = showName ? 78 : 0
  const { canvas, ctx } = makeCanvas(size, size + nameHeight)

  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2)
  ctx.fillStyle = parsed.color
  ctx.fill()
  ctx.lineWidth = 6
  ctx.strokeStyle = 'rgba(255,255,255,0.65)'
  ctx.stroke()

  ctx.fillStyle = 'rgba(8,10,18,0.85)'
  ctx.font = '700 104px "Inter", "Segoe UI", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(parsed.initials, size / 2, size / 2 + 6)

  if (showName && parsed.name) {
    ctx.font = '600 40px "Inter", "Segoe UI", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const label = parsed.name.length > 18 ? `${parsed.name.slice(0, 17)}…` : parsed.name
    const textWidth = ctx.measureText(label).width
    ctx.fillStyle = 'rgba(6,9,16,0.72)'
    roundRect(ctx, (size - textWidth) / 2 - 14, size + nameHeight / 2 - 30, textWidth + 28, 60, 30)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.95)'
    ctx.fillText(label, size / 2, size + nameHeight / 2)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.userData.aspect = size / (size + nameHeight)
  return texture
}

/** Soft radial sprite used for glows and particle cores. */
function createGlowTexture(key: string, data: string): THREE.CanvasTexture {
  const { color, softness } = JSON.parse(data) as { color: string; softness: number }
  const size = 128
  const { canvas, ctx } = makeCanvas(size, size)
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, color)
  gradient.addColorStop(Math.max(0.05, softness), color)
  gradient.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  void key
  return texture
}

export const labelTextures = new TextureCache<THREE.CanvasTexture>(420, createLabelTexture)
export const avatarTextures = new TextureCache<THREE.CanvasTexture>(160, createAvatarTexture)
export const glowTextures = new TextureCache<THREE.CanvasTexture>(24, createGlowTexture)

/**
 * Gource's file sprite: a ball lit from above-left (`data/file.png` in the Gource
 * source). The texture is greyscale, so the per-instance colour tints it and a
 * file still reads as its own colour, just shaded like a sphere.
 */
let ballTextureValue: THREE.Texture | null = null

export function ballTexture(): THREE.Texture {
  if (ballTextureValue) return ballTextureValue
  try {
    return (ballTextureValue = createBallTexture())
  } catch {
    return (ballTextureValue = fallbackTexture())
  }
}

function createBallTexture(): THREE.Texture {
  const size = 256
  const { canvas, ctx } = makeCanvas(size, size)
  const centre = size / 2
  const radius = size * 0.47

  ctx.save()
  ctx.beginPath()
  ctx.arc(centre, centre, radius, 0, Math.PI * 2)
  ctx.clip()
  // Highlight up and to the left, darkening towards the rim (file.png runs from
  // about 0.90 down to 0.68 of white).
  const gradient = ctx.createRadialGradient(
    centre - radius * 0.42,
    centre - radius * 0.5,
    radius * 0.05,
    centre,
    centre,
    radius * 1.3,
  )
  gradient.addColorStop(0, 'rgb(235,235,235)')
  gradient.addColorStop(0.3, 'rgb(228,228,228)')
  gradient.addColorStop(0.65, 'rgb(203,203,203)')
  gradient.addColorStop(1, 'rgb(173,173,173)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  ctx.restore()

  // Feather the rim so the circle stays smooth when zoomed in.
  ctx.globalCompositeOperation = 'destination-in'
  const rim = ctx.createRadialGradient(centre, centre, radius * 0.9, centre, centre, radius)
  rim.addColorStop(0, 'rgba(255,255,255,1)')
  rim.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = rim
  ctx.fillRect(0, 0, size, size)
  ctx.globalCompositeOperation = 'source-over'

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  return texture
}

export function labelAspect(texture: THREE.Texture): number {
  return (texture.userData.aspect as number) ?? 4
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

export function disposeTextureCaches(): void {
  labelTextures.dispose()
  avatarTextures.dispose()
  glowTextures.dispose()
  ballTextureValue?.dispose()
  ballTextureValue = null
}
