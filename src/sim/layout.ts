/**
 * Deterministic layout for the repository tree — planar (2D).
 *
 * Positions are derived purely from a node's path (and recursively from its
 * parent's position), never from arrival order. That makes the layout stable
 * when history is filtered, when commits are loaded incrementally, or when the
 * user seeks around: the same path is always in the same place.
 *
 * Everything lives on the XY plane; `z` is kept at 0 so the geometry helpers
 * stay interchangeable with the rest of the pipeline.
 */

export interface Vec2 {
  x: number
  y: number
}

export interface Vec3 {
  x: number
  y: number
  /** Always 0 in the 2D scene. */
  z: number
}

/** FNV-1a hash, stable across runs and platforms. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Deterministic pseudo-random value in [0,1) from a hash and salt. */
export function hashUnit(text: string, salt: number): number {
  return (hashString(`${salt}:${text}`) % 100000) / 100000
}

export const LAYOUT = {
  /** Distance from a directory to its child directories at depth 1. */
  baseDistance: 9,
  /** Additional distance per level of depth. */
  distancePerDepth: 2.4,
  /** Innermost radius of the ring that holds a directory's files. */
  fileRingRadius: 2.7,
  /** Gap kept between neighbouring file circles. */
  fileGap: 0.55,
  /** A ring is closed and a new one started beyond this radius. */
  maxRingRadius: 7.5,
  /** Hard cap on concentric rings per directory. */
  maxRings: 5,
  /** How fast nodes ease towards a new layout position (per second). */
  reflowRate: 4.5,
  /** Node radii (world units, before the file-size scale is applied). */
  dirRadius: 0.5,
  fileRadius: 0.34,
  /** Root node scale multiplier. */
  rootRadius: 1.1,
  /** Smallest and largest file circle radii after size scaling. */
  minFileRadius: 0.14,
  maxFileRadius: 1.5,
}

export function depthOfPath(path: string): number {
  if (!path) return 0
  let depth = 0
  for (let index = 0; index < path.length; index += 1) if (path.charCodeAt(index) === 47) depth += 1
  return depth + 1
}

const GOLDEN = 2.399963229728653

/**
 * Position of a directory node relative to its parent directory.
 * The angle is hashed from the full path, with a golden-angle term so sibling
 * directories spread around the parent instead of stacking on one axis.
 */
export function directoryOffset(path: string, depth: number): Vec3 {
  const angle = hashUnit(path, 1) * Math.PI * 2 + depth * GOLDEN
  const distance =
    LAYOUT.baseDistance + depth * LAYOUT.distancePerDepth + hashUnit(path, 3) * LAYOUT.baseDistance * 0.45
  return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance, z: 0 }
}

/**
 * Position of a file node relative to its directory when the dynamic ring
 * layout is disabled (or before a directory has been laid out).
 */
export function fileOffset(path: string): Vec3 {
  const angle = hashUnit(path, 11) * Math.PI * 2
  const distance = LAYOUT.fileRingRadius + hashUnit(path, 13) * 0.8
  return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance, z: 0 }
}

export function addVec(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: 0 }
}

export function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

export function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: 0 }
}

export const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 }

export interface RingItem {
  /** Stable ordering key (the node path). */
  key: string
  /** Current circle radius of the item. */
  radius: number
}

export interface RingPlacement {
  /** Offset from the directory centre. */
  x: number
  y: number
  /** Which concentric ring the item ended up on. */
  ring: number
  angle: number
}

export interface RingOptions {
  /** Innermost ring radius. */
  minRadius: number
  /** Free space kept between neighbouring circles. */
  gap: number
  /** Radius at which a ring is considered full. */
  maxRingRadius: number
  /** Maximum number of rings (the last one may exceed the soft limit). */
  maxRings: number
  /** Angular phase of the first item. */
  startAngle: number
}

export const DEFAULT_RING_OPTIONS: RingOptions = {
  minRadius: LAYOUT.fileRingRadius,
  gap: LAYOUT.fileGap,
  maxRingRadius: LAYOUT.maxRingRadius,
  maxRings: LAYOUT.maxRings,
  startAngle: 0,
}

/**
 * Lay items out on one or more concentric rings around a centre.
 *
 * The ring radius grows with the total diameter that has to fit, so a folder
 * with many files — or with a few large ones — automatically gets a wider ring
 * and its neighbours are pushed outwards. Ordering is by `key`, so inserting a
 * new file reflows the ring deterministically (everything shifts by one slot)
 * instead of shuffling.
 */
export function placeOnRings(
  items: readonly RingItem[],
  options: Partial<RingOptions> = {},
): RingPlacement[] {
  const config: RingOptions = { ...DEFAULT_RING_OPTIONS, ...options }
  const sorted = [...items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const placements: RingPlacement[] = []
  if (sorted.length === 0) return placements

  let ring: RingItem[] = []
  let innerRadius = config.minRadius
  let ringIndex = 0

  /**
   * Radius needed to hold `entries` on a single ring without touching.
   *
   * Two constraints: the total arc length must fit (packing by circumference)
   * and neighbouring circles must not touch, which depends on the *chord*
   * between adjacent slots rather than the arc.
   */
  const radiusFor = (entries: readonly RingItem[], inner: number): number => {
    let demand = 0
    let widest = 0
    for (const entry of entries) {
      demand += entry.radius * 2 + config.gap
      widest = Math.max(widest, entry.radius)
    }
    const arcRadius = demand / (2 * Math.PI)
    if (entries.length < 2) return Math.max(inner, arcRadius)
    const chordRadius = ((widest * 2 + config.gap) / (2 * Math.sin(Math.PI / entries.length))) * 1.05
    return Math.max(inner, arcRadius, chordRadius)
  }

  const flush = (): void => {
    if (ring.length === 0) return
    const radius = radiusFor(ring, innerRadius)
    const step = (Math.PI * 2) / ring.length
    // A per-ring phase offset keeps the layout from looking mechanical without
    // breaking the even spacing the packing math relies on.
    const phase = (hashUnit(ring[0].key, 23) - 0.5) * step
    for (let index = 0; index < ring.length; index += 1) {
      const angle = config.startAngle + phase + index * step
      placements.push({
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        ring: ringIndex,
        angle,
      })
    }
    let widest = 0
    for (const item of ring) widest = Math.max(widest, item.radius)
    // The next ring sits outside this one.
    innerRadius = radius + config.gap + widest
    ring = []
    ringIndex += 1
  }

  for (const item of sorted) {
    if (ring.length > 0) {
      const candidate = [...ring, item]
      const radius = radiusFor(candidate, innerRadius)
      const ringsLeft = config.maxRings - ringIndex
      if (radius > config.maxRingRadius && ringsLeft > 1) {
        flush()
      } else {
        ring = candidate
        continue
      }
    }
    ring = [item]
  }
  flush()

  // Keep the placement order aligned with the sorted input.
  const byKey = new Map<string, RingPlacement>()
  for (let index = 0; index < sorted.length; index += 1) {
    const placement = placements[index]
    if (placement) byKey.set(sorted[index].key, placement)
  }
  return sorted.map((item) => byKey.get(item.key) ?? { x: 0, y: 0, ring: 0, angle: 0 })
}

/** Extent (max distance from the centre) of a set of placements. */
export function ringExtent(placements: readonly RingPlacement[]): number {
  let extent = 0
  for (const placement of placements) extent = Math.max(extent, Math.hypot(placement.x, placement.y))
  return extent
}

/**
 * Split a path into its parent directory path and file name.
 * `''` means the repository root.
 */
export function splitPath(path: string): { parent: string; name: string } {
  const index = path.lastIndexOf('/')
  if (index === -1) return { parent: '', name: path }
  return { parent: path.slice(0, index), name: path.slice(index + 1) }
}
