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
  /** Distance from a directory to its files. */
  fileDistance: 2.7,
  /** Spread of file placement. */
  fileSpread: 1.2,
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

/** Position of a file node relative to its directory. */
export function fileOffset(path: string): Vec3 {
  const angle = hashUnit(path, 11) * Math.PI * 2
  const distance = LAYOUT.fileDistance + hashUnit(path, 13) * LAYOUT.fileSpread
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
 * Split a path into its parent directory path and file name.
 * `''` means the repository root.
 */
export function splitPath(path: string): { parent: string; name: string } {
  const index = path.lastIndexOf('/')
  if (index === -1) return { parent: '', name: path }
  return { parent: path.slice(0, index), name: path.slice(index + 1) }
}
