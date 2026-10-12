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
  /** Innermost radius at which a directory's files start. */
  fileRingRadius: 1.1,
  /** Safety bound for the disc packing of a directory's files. */
  maxDiscRadius: 48,
  /**
   * Layout changes are rounded to this step, so growing a file by a pixel does
   * not reflow the whole tree on every commit.
   */
  layoutQuantum: 0.5,
  /**
   * Overlap tolerated before a grown circle is moved. Lets circles grow into the
   * free space around them without shuffling their neighbours.
   */
  growthSlack: 0.25,
  /** Innermost radius of the ring that holds a directory's subdirectories. */
  dirRingRadius: 2.5,
  /** Free space kept between neighbouring directory clusters. */
  clusterGap: 0.6,
  /**
   * A directory ring is closed beyond this radius and a new one started. Kept
   * generous: cluster sizes dominate the radius anyway, and closing rings early
   * would push folders into a long spiral instead of one ring.
   */
  maxDirRingRadius: 60,
  /** Gap kept between neighbouring file circles. */
  fileGap: 0.25,
  /** A ring is closed and a new one started beyond this radius. */
  maxRingRadius: 5,
  /** Hard cap on concentric rings per directory. */
  maxRings: 5,
  /** How fast nodes ease towards a new layout position (per second). */
  reflowRate: 4.5,
  /** Node radii (world units, before the file-size scale is applied). */
  dirRadius: 0.5,
  fileRadius: 0.34,
  /** Root node scale multiplier. */
  rootRadius: 1.1,
  /**
   * Smallest and largest file circle radii after size scaling. Kept compact so a
   * folder's cluster stays dense: ring packing is space hungry, and clusters are
   * what separate folders from each other.
   */
  minFileRadius: 0.08,
  maxFileRadius: 0.75,
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
  /**
   * Radius from the centre where the *circles* of the next ring may start.
   * Kept as a clear radius (not a centre radius) so the rings cannot overlap
   * each other either.
   */
  let clearRadius = config.minRadius
  let ringIndex = 0

  /** Centre radius a ring needs for `entries`, given where its circles may start. */
  const radiusFor = (entries: readonly RingItem[], clear: number): number => {
    let demand = 0
    let widest = 0
    for (const entry of entries) {
      demand += entry.radius * 2 + config.gap
      widest = Math.max(widest, entry.radius)
    }
    // The ring's circles may not reach inside `clear`.
    const packing = Math.max(clear + widest, demand / (2 * Math.PI))
    if (entries.length < 2) return packing
    // Neighbouring circles on the same ring must not touch either. That depends
    // on the chord between *adjacent* slots, so use the widest adjacent pair
    // rather than assuming every neighbour is as big as the largest item.
    let widestPair = 0
    for (let index = 0; index < entries.length; index += 1) {
      const next = entries[(index + 1) % entries.length]
      widestPair = Math.max(widestPair, entries[index].radius + next.radius)
    }
    const chord = ((widestPair + config.gap) / (2 * Math.sin(Math.PI / entries.length))) * 1.02
    return Math.max(packing, chord)
  }

  const flush = (): void => {
    if (ring.length === 0) return
    const radius = radiusFor(ring, clearRadius)
    const step = (Math.PI * 2) / ring.length
    // A per-ring phase offset keeps the layout from looking mechanical without
    // breaking the even spacing the packing math relies on.
    const phase = (hashUnit(ring[0].key, 23) - 0.5) * step
    let widest = 0
    for (const item of ring) widest = Math.max(widest, item.radius)
    for (let index = 0; index < ring.length; index += 1) {
      const angle = config.startAngle + phase + index * step
      placements.push({
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        ring: ringIndex,
        angle,
      })
    }
    // The next ring starts outside this one, including this ring's own radii.
    clearRadius = radius + widest + config.gap
    ring = []
    ringIndex += 1
  }

  for (const item of sorted) {
    if (ring.length > 0) {
      const candidate = [...ring, item]
      const radius = radiusFor(candidate, clearRadius)
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

export const DEFAULT_DISC_OPTIONS: DiscOptions = {
  minRadius: LAYOUT.fileRingRadius,
  gap: LAYOUT.fileGap,
  phase: 0,
  maxRadius: LAYOUT.maxDiscRadius,
}

export interface DiscObstacle {
  x: number
  y: number
  radius: number
}

export interface DiscOptions {
  /** Radius from the centre where the first circle may start. */
  minRadius: number
  /** Free space kept between neighbouring circles. */
  gap: number
  /** Angular phase, so different folders do not look identical. */
  phase: number
  /** Safety bound on the search radius. */
  maxRadius: number
  /**
   * Circles that are already fixed and must not be disturbed. Used for
   * incremental packing: existing files keep their spot and only new or resized
   * ones are placed around them.
   */
  obstacles?: readonly DiscObstacle[]
  /**
   * Where to start looking. Callers can pass the radius of the last placement so
   * a dense folder does not search from the centre every time.
   */
  startRadius?: number
}

export interface DiscPlacement {
  x: number
  y: number
  /** Distance from the centre. */
  radius: number
}

/**
 * Pack items into a disc around a centre, densest-first.
 *
 * A ring layout grows linearly with the number of items (the circumference has
 * to hold them all), which is what pushed subfolders away from their parent.
 * This greedy spiral packing fills the *area* instead, so a folder with many
 * files stays compact (roughly the square root of the count) while still
 * guaranteeing that no two circles touch.
 *
 * Items are placed largest first at the centre and smaller ones fill the gaps,
 * which also makes the result stable: adding a small file does not move the big
 * ones, and the whole layout is a deterministic function of the item list.
 */
export function placeInDisc(
  items: readonly RingItem[],
  options: Partial<DiscOptions> = {},
): DiscPlacement[] {
  const config: DiscOptions = { ...DEFAULT_DISC_OPTIONS, ...options }
  const placements: DiscPlacement[] = []
  if (items.length === 0) return placements

  // Largest first, ties broken by key for determinism.
  const order = [...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.radius - a.item.radius || (a.item.key < b.item.key ? -1 : 1))

  let widest = 0
  for (const item of items) widest = Math.max(widest, item.radius)
  for (const obstacle of config.obstacles ?? []) widest = Math.max(widest, obstacle.radius)

  // A candidate only needs to look at the nine cells around it.
  const cell = Math.max(0.5, widest * 2 + config.gap)
  const cellKey = (x: number, y: number): string => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`
  const grid = new Map<string, { x: number; y: number; radius: number }[]>()

  const addObstacle = (circle: { x: number; y: number; radius: number }): void => {
    const key = cellKey(circle.x, circle.y)
    const bucket = grid.get(key)
    if (bucket) bucket.push(circle)
    else grid.set(key, [circle])
  }
  for (const obstacle of config.obstacles ?? []) addObstacle(obstacle)

  const collides = (x: number, y: number, radius: number): boolean => {
    const cx = Math.floor(x / cell)
    const cy = Math.floor(y / cell)
    for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
      for (let gy = cy - 1; gy <= cy + 1; gy += 1) {
        const bucket = grid.get(`${gx}:${gy}`)
        if (!bucket) continue
        for (const other of bucket) {
          const dx = other.x - x
          const dy = other.y - y
          const minDistance = radius + other.radius + config.gap
          if (dx * dx + dy * dy < minDistance * minDistance) return true
        }
      }
    }
    return false
  }

  const remember = (index: number, x: number, y: number, radius: number): void => {
    placements[index] = { x, y, radius }
    addObstacle({ x, y, radius })
  }

  const GOLDEN = 2.399963229728653
  // Radial step and the search bound both follow the item sizes, so the number
  // of candidates stays proportional to the space that has to be explored.
  const step = Math.max(0.45, config.gap * 1.2)
  // The search has to reach past whatever is already there, otherwise a dense
  // folder would keep falling back to positions outside the free space.
  let occupiedReach = 0
  for (const obstacle of config.obstacles ?? []) {
    occupiedReach = Math.max(occupiedReach, Math.hypot(obstacle.x, obstacle.y) + obstacle.radius)
  }
  const denseRadius = Math.sqrt(items.length + 1) * (widest * 2 + config.gap) + config.minRadius
  const searchLimit = Math.min(
    config.maxRadius,
    Math.max(config.minRadius + widest, denseRadius, occupiedReach + widest + config.gap),
  )

  for (let slot = 0; slot < order.length; slot += 1) {
    const { item, index } = order[slot]
    let placed = false
    // Start where the last placement ended (dense folders) but never closer than
    // the centre allows.
    const start = Math.max(config.minRadius + item.radius, (config.startRadius ?? 0) - step * 2)
    for (let radius = start; radius <= searchLimit; radius += step) {
      const samples = Math.min(
        12,
        Math.max(6, Math.round((Math.PI * 2 * radius) / Math.max(0.5, (item.radius + config.gap) * 2.4))),
      )
      const phase = config.phase + slot * GOLDEN
      for (let sample = 0; sample < samples; sample += 1) {
        const angle = phase + (sample / samples) * Math.PI * 2
        const x = Math.cos(angle) * radius
        const y = Math.sin(angle) * radius
        if (collides(x, y, item.radius)) continue
        remember(index, x, y, radius)
        placed = true
        break
      }
      if (placed) break
    }
    if (!placed) {
      // Very dense input: keep walking the spiral outwards until the circle fits,
      // so the fallback can never stack two files on the same spot.
      let radius = searchLimit + item.radius + config.gap
      let angle = config.phase + slot * GOLDEN
      let guard = 0
      while (collides(Math.cos(angle) * radius, Math.sin(angle) * radius, item.radius) && guard < 512) {
        radius += step
        angle += GOLDEN * 0.5
        guard += 1
      }
      remember(index, Math.cos(angle) * radius, Math.sin(angle) * radius, radius)
    }
  }

  return placements
}

/**
 * Indices of circles that overlap each other (used to decide whether an
 * incremental layout is still valid).
 */
export function findOverlaps(circles: readonly DiscObstacle[], gap = 0): number[] {
  const offenders: number[] = []
  if (circles.length < 2) return offenders
  let widest = 0
  for (const circle of circles) widest = Math.max(widest, circle.radius)
  const cell = Math.max(0.5, widest * 2 + gap)
  const grid = new Map<string, number[]>()
  for (let index = 0; index < circles.length; index += 1) {
    const circle = circles[index]
    const cx = Math.floor(circle.x / cell)
    const cy = Math.floor(circle.y / cell)
    for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
      for (let gy = cy - 1; gy <= cy + 1; gy += 1) {
        const bucket = grid.get(`${gx}:${gy}`)
        if (!bucket) continue
        for (const other of bucket) {
          const dx = circles[other].x - circle.x
          const dy = circles[other].y - circle.y
          const minDistance = circle.radius + circles[other].radius + gap
          if (dx * dx + dy * dy < minDistance * minDistance) {
            if (!offenders.includes(index)) offenders.push(index)
            if (!offenders.includes(other)) offenders.push(other)
          }
        }
      }
    }
    const key = `${cx}:${cy}`
    const bucket = grid.get(key)
    if (bucket) bucket.push(index)
    else grid.set(key, [index])
  }
  return offenders
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
