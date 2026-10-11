/**
 * Deterministic layout for the repository tree.
 *
 * Positions are derived purely from a node's path (and recursively from its
 * parent's position), never from arrival order. That makes the layout stable
 * when history is filtered, when commits are loaded incrementally, or when the
 * user seeks around: the same path is always in the same place.
 */

export interface Vec3 {
  x: number
  y: number
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
  /** Vertical flattening: the tree stays wider than it is tall. */
  verticalScale: 0.62,
  /** Distance from a directory to its files. */
  fileDistance: 2.1,
  /** Spread of file placement. */
  fileSpread: 0.9,
  /** Node radii. */
  dirRadius: 0.42,
  fileRadius: 0.2,
  /** Root node scale multiplier. */
  rootRadius: 0.9,
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
 * Spread is hashed from the full path, with a golden-angle fallback rotation so
 * sibling directories never stack on one axis.
 */
export function directoryOffset(path: string, depth: number): Vec3 {
  const angle = hashUnit(path, 1) * Math.PI * 2 + depth * GOLDEN
  const elevation = (hashUnit(path, 2) - 0.5) * Math.PI * 0.55
  const distance = LAYOUT.baseDistance + depth * LAYOUT.distancePerDepth + hashUnit(path, 3) * LAYOUT.baseDistance * 0.45
  const cosElevation = Math.cos(elevation)
  return {
    x: Math.cos(angle) * cosElevation * distance,
    y: Math.sin(elevation) * distance * LAYOUT.verticalScale,
    z: Math.sin(angle) * cosElevation * distance,
  }
}

/** Position of a file node relative to its directory. */
export function fileOffset(path: string): Vec3 {
  const angle = hashUnit(path, 11) * Math.PI * 2
  const elevation = (hashUnit(path, 12) - 0.5) * Math.PI * 0.8
  const distance = LAYOUT.fileDistance + hashUnit(path, 13) * LAYOUT.fileSpread
  const cosElevation = Math.cos(elevation)
  return {
    x: Math.cos(angle) * cosElevation * distance,
    y: Math.sin(elevation) * distance * 0.8,
    z: Math.sin(angle) * cosElevation * distance,
  }
}

export function addVec(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

export function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

export function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
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
