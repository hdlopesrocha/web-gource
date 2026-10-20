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
  /** Distance from a directory to its child directories at depth 1 (static layout). */
  baseDistance: 9,
  /** Additional distance per level of depth (static layout). */
  distancePerDepth: 2.4,
  /** Innermost radius at which a directory's files start (static layout). */
  fileRingRadius: 1.1,
  /** How fast nodes ease towards a new layout position (per second). */
  reflowRate: 4.5,
  /** Node radii (world units, before the file-size scale is applied). */
  dirRadius: 0.5,
  fileRadius: 0.34,
  /** Root node scale multiplier. */
  rootRadius: 1.1,
  /**
   * Smallest and largest file circle radii after size scaling. Kept compact so a
   * folder's rings stay dense.
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

/**
 * Gource's layout model, generalised to files of different sizes.
 *
 * Mirrors `RDirNode::calcRadius`, `RDirNode::updateFilePositions`,
 * `RDirNode::calcFileDest` and `RDirNode::applyForces` from the original Gource
 * source (src/dirnode.cpp), with the one difference this project asks for: files
 * have a size, so every "one file diameter" step in the original becomes a step
 * based on the actual circle radii.
 *
 *  - A directory's radius is the square root of the area its subtree needs times
 *    a padding factor (`radius = sqrt(area) * 1.5`). That is what keeps the tree
 *    compact: the extent grows with sqrt(files), not with nesting depth.
 *  - Files are grouped on concentric rings around their directory, one file
 *    diameter apart, each ring holding as many files as its circumference
 *    allows, spread evenly with a half-slot offset.
 *  - Directories are placed by relaxing Gource's four forces.
 */
export const GOURCE = {
  /** Padding applied to sqrt(area) when computing a directory radius. */
  dirPadding: 1.5,
  /** Gource's gravity constant: pulls a node to its ideal distance from its parent. */
  gravity: 10,
  /** Minimum radius of a directory node's cluster (rarely reached, as in Gource). */
  minDirRadius: 0.5,
  /** Minimum radius of the area a directory's own files occupy. */
  minOwnRadius: 0.5,
  /** Free space kept between neighbouring file circles. */
  fileGap: 0.35,
  /** Free space kept between the clusters of two directories. */
  collisionGap: 0.06,
  /** Extra clearance between the enclosing circles of two project volumes. */
  projectGap: 0.6,
  /** Projection sweeps per per-commit relaxation, and per full reflow. */
  relaxSweeps: 12,
  reflowAllSweeps: 48,
  /** Relaxation steps per layout update, and the step size. */
  relaxSteps: 16,
  /**
   * Run the forces every Nth commit. The projection still runs after every
   * commit, so nothing ever overlaps; the folders just take a few commits to
   * drift into their final places, which the easing hides anyway.
   */
  relaxEvery: 4,
  relaxDt: 1 / 30,
  /**
   * Work cap for one relaxation call, in node-steps. A big tree relaxes with
   * fewer steps per commit instead of stalling the playback.
   */
  relaxBudget: 1200,
  /** Steps requested for a full reflow (seeks, size changes), work cap allowing. */
  reflowAllSteps: 400,
}

/** Area a circle of this radius occupies (Gource counts file area as pi r^2). */
export function fileArea(radius: number): number {
  return Math.PI * radius * radius
}

/** Directory radius from the area of its whole subtree: Gource's sqrt(area) * padding. */
export function dirRadiusFor(area: number, minRadius = GOURCE.minDirRadius): number {
  return Math.max(minRadius, Math.sqrt(Math.max(0, area)) * GOURCE.dirPadding)
}

export interface RingFile {
  key: string
  radius: number
}

export interface RingPosition {
  x: number
  y: number
  /** Which ring the file ended up on (1 = innermost). */
  ring: number
}

/**
 * Place a directory's files on concentric rings, the way Gource groups the files
 * of one folder.
 *
 * Ring radii step outwards by one "file diameter" and each ring holds as many
 * files as fit around its circumference. Slots are proportional to each file's
 * own diameter, so a big file gets the room it needs.
 */
export function placeFilesInRings(
  files: readonly RingFile[],
  options: { innerRadius: number; spacing?: number; gap?: number },
): RingPosition[] {
  const positions: RingPosition[] = []
  if (files.length === 0) return positions
  const gap = options.gap ?? GOURCE.fileGap
  let widest = 0
  for (const file of files) widest = Math.max(widest, file.radius)
  const spacing = options.spacing ?? widest * 2 + gap
  // The innermost ring clears both the directory node and the widest circle.
  const base = options.innerRadius + widest + gap
  /** Angle a circle of this radius takes up on a ring of that radius. */
  const widthOf = (radius: number, ringRadius: number): number =>
    2 * Math.asin(Math.min(1, (radius + gap * 0.5) / Math.max(1e-6, ringRadius)))

  let index = 0
  let ring = 1
  while (index < files.length) {
    // Gource starts the first ring at the directory and steps outwards by one
    // file diameter; we start just outside the directory node so the folder ring
    // itself stays visible.
    const radius = base + (ring - 1) * spacing
    const start = index
    // Capacity of this ring: as many circles as fit around its circumference.
    let arc = 0
    while (index < files.length) {
      const width = widthOf(files[index].radius, radius)
      if (arc + width > Math.PI * 2 + 1e-9) break
      arc += width
      index += 1
    }
    if (index === start) {
      // One circle too wide for this ring: it gets the ring to itself.
      index += 1
    }
    const count = index - start
    // Half-slot offset on even rings, like Gource's even distribution.
    let cursor = ring % 2 === 0 ? Math.PI / count : 0
    for (let slot = 0; slot < count; slot += 1) {
      const file = files[start + slot]
      const width = widthOf(file.radius, radius)
      const angle = cursor + width * 0.5
      positions[start + slot] = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, ring }
      cursor += width
    }
    ring += 1
  }
  return positions
}

export interface ForceNode {
  id: number
  /** -1 for the root. */
  parent: number
  children: number[]
  /** Radius of the area this node's own files occupy (Gource's `parent_radius`). */
  ownRadius: number
  /** Radius of this node's whole subtree (Gource's `dir_radius`). */
  dirRadius: number
  /**
   * Radius used to keep nodes apart. Defaults to `dirRadius` (Gource sizes the
   * collision by the area of the subtree), but a caller can pass the actual
   * extent of the node's own files, which is larger for tiny folders.
   */
  collisionRadius?: number
  /** Same, for the area the node's own files occupy. Defaults to `ownRadius`. */
  ownCollisionRadius?: number
  x: number
  y: number
  visible: boolean
}

/**
 * Deterministic pseudo-random offset for a path (Gource uses `vec2Hash`), used to
 * give a brand new directory its starting position.
 */
export function hashOffset(path: string, scale = 4): { x: number; y: number } {
  const angle = hashUnit(path, 41) * Math.PI * 2
  const length = scale * (0.35 + hashUnit(path, 42) * 0.65)
  return { x: Math.cos(angle) * length, y: Math.sin(angle) * length }
}

/**
 * Relax directory positions with Gource's forces (dirnode.cpp
 * `RDirNode::applyForces`):
 *
 *  1. gravity towards the ideal clearance from the parent,
 *  2. a push along the parent's own direction, so children fan outwards,
 *  3. repulsion from siblings, scaled by the parent's radius over its child
 *     count — this is what spreads a folder's subfolders around it,
 *  4. overlap resolution against every nearby directory.
 *
 * Gource resolves (4) with a spring that is much weaker than its gravity, so
 * crowded parents end up with overlapping clusters. Here every step ends with a
 * projection sweep instead: bodies that overlap are pushed apart by the smallest
 * distance that clears them. The layout keeps Gource's look — folders fan out and
 * settle at their ideal distance — but nothing ever overlaps.
 *
 * Positions are updated in place, and the result depends only on the tree shape
 * and the radii, so the same history always relaxes to the same layout.
 */
export function relaxDirectories(
  nodes: ForceNode[],
  options: { steps?: number; dt?: number; gravity?: number; sweeps?: number; gap?: number } = {},
): void {
  const steps = options.steps ?? GOURCE.relaxSteps
  const dt = options.dt ?? GOURCE.relaxDt
  const gravity = options.gravity ?? GOURCE.gravity
  const maxSweeps = options.sweeps ?? GOURCE.relaxSweeps
  const gap = options.gap ?? 0
  const byId = new Map<number, ForceNode>()
  const collide = new Map<number, number>()
  const ownCollide = new Map<number, number>()
  let widest = 0
  let radiusSum = 0
  let counted = 0
  for (const node of nodes) {
    const collideRadius = node.collisionRadius ?? node.dirRadius
    byId.set(node.id, node)
    collide.set(node.id, collideRadius)
    ownCollide.set(node.id, node.ownCollisionRadius ?? node.ownRadius)
    if (!node.visible) continue
    widest = Math.max(widest, collideRadius)
    radiusSum += collideRadius
    counted += 1
  }
  const median = counted > 0 ? radiusSum / counted : 1
  // The grid is sized for the common node; a rare huge node scans more cells.
  const cell = Math.max(1, median * 3)
  const root = nodes.find((node) => node.parent < 0)
  /**
   * True when one of the two is an ancestor of the other. A node is allowed to
   * sit inside the cluster of its ancestors (that is what keeps a deep tree
   * compact); it only has to clear the ancestor's own files.
   */
  const related = (a: ForceNode, b: ForceNode): boolean => {
    let current = a.parent
    let guard = 0
    while (current >= 0 && guard < 512) {
      if (current === b.id) return true
      const parent = byId.get(current)
      if (!parent) return false
      current = parent.parent
      guard += 1
    }
    return false
  }
  // Visible children per parent: the sibling force needs them every step.
  const siblingList = new Map<number, ForceNode[]>()
  for (const node of nodes) {
    if (!node.visible) continue
    const parent = byId.get(node.parent)
    if (!parent) continue
    const list = siblingList.get(node.parent)
    if (list) list.push(node)
    else siblingList.set(node.parent, [node])
  }

  for (let step = 0; step < steps; step += 1) {
    for (const node of nodes) {
      if (!node.visible || node.parent < 0) continue
      const parent = byId.get(node.parent)
      if (!parent) continue
      const nodeRadius = collide.get(node.id) ?? node.dirRadius
      const parentOwn = ownCollide.get(parent.id) ?? parent.ownRadius
      let ax = 0
      let ay = 0

      // 1. Gravity towards the ideal clearance from the parent.
      let dx = parent.x - node.x
      let dy = parent.y - node.y
      let distance = Math.hypot(dx, dy)
      if (distance < 1e-4) {
        dx = 0
        dy = -1
        distance = 1e-4
      }
      const clearance = distance - (nodeRadius + parentOwn)
      ax += gravity * clearance * (dx / distance)
      ay += gravity * clearance * (dy / distance)

      // 2. Push along the parent's own direction so children sit outside it.
      const grandparent = parent.parent >= 0 ? byId.get(parent.parent) : undefined
      if (grandparent) {
        let ex = parent.x - grandparent.x
        let ey = parent.y - grandparent.y
        const edge = Math.hypot(ex, ey)
        if (edge > 1e-4) {
          ex /= edge
          ey /= edge
          // Gource: parent->getRadius() + getRadius(), i.e. the subtree radii.
          const target = parent.dirRadius + node.dirRadius
          ax += parent.x + target * ex - node.x
          ay += parent.y + target * ey - node.y
        }
      }

      // 3. Siblings: spread around the parent, scaled by its radius.
      const siblings = siblingList.get(node.parent)
      if (siblings && siblings.length > 1) {
        let sx = 0
        let sy = 0
        for (const sibling of siblings) {
          if (sibling.id === node.id) continue
          const ddx = sibling.x - node.x
          const ddy = sibling.y - node.y
          const length = Math.hypot(ddx, ddy)
          if (length < 1e-4) continue
          sx -= ddx / length
          sy -= ddy / length
        }
        const slice = (parent.dirRadius * Math.PI) / (siblings.length + 1)
        ax += sx * slice
        ay += sy * slice
      }

      node.x += ax * dt
      node.y += ay * dt
    }

    if (root) {
      root.x = 0
      root.y = 0
    }
  }

  // 4. Projection: separate whatever still overlaps. Gource resolves overlaps
  // with a spring that is far weaker than its gravity, so crowded parents keep
  // overlapping clusters; projecting instead makes the layout collision free
  // while the forces above still decide where folders want to sit.
  if (maxSweeps > 0) {
    const grid = new Map<number, ForceNode[]>()
    const key = (gx: number, gy: number): number => (gx + 8192) * 16384 + (gy + 8192)
    for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
      grid.clear()
      for (const node of nodes) {
        if (!node.visible || node.parent < 0) continue
        const k = key(Math.floor(node.x / cell), Math.floor(node.y / cell))
        const bucket = grid.get(k)
        if (bucket) bucket.push(node)
        else grid.set(k, [node])
      }
      let resolved = 0
      for (const node of nodes) {
        if (!node.visible || node.parent < 0) continue
        const nodeRadius = collide.get(node.id) ?? node.dirRadius
        const cx = Math.floor(node.x / cell)
        const cy = Math.floor(node.y / cell)
        const range = 1 + Math.floor((nodeRadius + widest) / cell)
        for (let gx = cx - range; gx <= cx + range; gx += 1) {
          for (let gy = cy - range; gy <= cy + range; gy += 1) {
            // Each pair is handled once: only the cells at or after the node's own.
            if (gy < cy || (gy === cy && gx < cx)) continue
            const bucket = grid.get(key(gx, gy))
            if (!bucket) continue
            for (const other of bucket) {
              // Each pair is handled once: cells before the node's own are
              // skipped, and inside the node's own cell only higher ids are.
              if (other.id === node.id) continue
              if (gx === cx && gy === cy && other.id < node.id) continue
              let ox = other.x - node.x
              let oy = other.y - node.y
              let length = Math.hypot(ox, oy)
              const otherRadius = collide.get(other.id) ?? other.dirRadius
              let sum = nodeRadius + otherRadius + gap
              if (length < sum) {
                // Ancestor and descendant only have to clear the ancestor's own
                // files; every other pair clears full clusters.
                if (related(node, other)) sum = nodeRadius + (ownCollide.get(other.id) ?? other.ownRadius) + gap
                else if (related(other, node)) sum = (ownCollide.get(node.id) ?? node.ownRadius) + otherRadius + gap
              }
              if (length >= sum) continue
              if (length >= sum) continue
              if (length < 1e-4) {
                // Coincident bodies: push them apart deterministically.
                const angle = hashUnit(String(node.id), 7) * Math.PI * 2
                ox = Math.cos(angle)
                oy = Math.sin(angle)
                length = 1e-4
              }
              const push = (sum - length) * 0.5
              const ux = (ox / length) * push
              const uy = (oy / length) * push
              node.x -= ux
              node.y -= uy
              other.x += ux
              other.y += uy
              resolved += 1
            }
          }
        }
      }
      if (root) {
        root.x = 0
        root.y = 0
      }
      if (resolved === 0) break
    }
  }
}

export function splitPath(path: string): { parent: string; name: string } {
  const index = path.lastIndexOf('/')
  if (index === -1) return { parent: '', name: path }
  return { parent: path.slice(0, index), name: path.slice(index + 1) }
}
