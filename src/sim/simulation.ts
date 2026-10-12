import type { ChangeKind, TimelineAuthor, TimelineCommit, TimelineFileChange } from '../timeline/types'
import {
  addVec,
  depthOfPath,
  dirRadiusFor,
  directoryOffset,
  fileArea,
  fileOffset,
  GOURCE,
  hashOffset,
  hashUnit,
  LAYOUT,
  ORIGIN,
  placeFilesInRings,
  relaxDirectories,
  splitPath,
  type ForceNode,
  type Vec3,
} from './layout'

/** Node kinds in the animated tree. */
export type SimNodeKind = 'root' | 'dir' | 'file'

export interface SimNode {
  id: number
  /** Repository-relative path (`''` for the root). */
  path: string
  name: string
  kind: SimNodeKind
  parent: number
  children: number[]
  /** Current (animated) position. */
  position: Vec3
  /** Where the dynamic layout wants this node to be. */
  targetPosition: Vec3
  /** Visual radius in world units (derived from the size mode). */
  radius: number
  /** File size in bytes as reported by the host (0 when unknown). */
  sizeBytes: number
  /** True when `sizeBytes` came from the host instead of being estimated. */
  sizeKnown: boolean
  /** Accumulated added + removed lines (the fallback size proxy). */
  activity: number
  /** Timeline index of the first appearance. */
  bornIndex: number
  /** Index and kind of the most recent change to this node. */
  lastChangeIndex: number
  lastKind: ChangeKind | null
  /** Number of changes recorded in the loaded window. */
  changes: number
  additions: number
  deletions: number
  /** True while the node is visible at the current playback position. */
  visible: boolean
  /** Extent of this node's *own* files (not its whole subtree). */
  ownDiscRadius: number
  /** Actual radius of the ring the node's own files are placed on. */
  contentRadius: number
  /** Area this node's whole subtree occupies, in file areas (Gource's model). */
  subtreeArea: number
  /** False until the node has been given a starting position. */
  positionInitialized: boolean
  /**
   * Radius of everything that belongs to this node: for a file its circle, for a
   * directory the extent of its whole subtree. The parent packs its children by
   * this value, which is what keeps folder clusters from overlapping.
   */
  clusterRadius: number
  /** Previous position after a rename, so the renderer can animate the move. */
  movedFrom?: Vec3
}

/**
 * A short lived link between an author and a file it just changed, drawn as a
 * beam from the avatar to the node (the Gource "tether").
 */
export interface SimTether {
  nodeId: number
  kind: ChangeKind
  /** Simulated time the tether appeared. */
  start: number
  /** Simulated time it disappears. */
  until: number
  /**
   * Size of the change in this file (added + removed lines, or the bytes it
   * gained). Drives how strong the beam is drawn.
   */
  strength: number
  /** Largest change seen in the loaded window, used to normalise `strength`. */
  reference: number
}

/** An author currently present in the scene. */
export interface SimAuthor {
  author: TimelineAuthor
  /** Current position, and the point it is heading to. */
  position: Vec3
  /** Velocity used by the spring that moves the avatar. */
  velocity: Vec3
  target: Vec3
  targetNodeId: number
  lastActiveAt: number
  appearedAt: number
  appliedCommits: number
  lastKind: ChangeKind | null
  visible: boolean
  /** Active beams from this author to recently changed files. */
  tethers: SimTether[]
}

/** Events produced by applying timeline commits; consumed by the renderer. */
export type SimEvent =
  | { type: 'node-added'; node: SimNode }
  | { type: 'node-changed'; node: SimNode; kind: ChangeKind }
  | { type: 'node-removed'; node: SimNode }
  | { type: 'activity'; node: SimNode; kind: ChangeKind; strength: number }
  | { type: 'author'; author: SimAuthor; node: SimNode | null; kind: ChangeKind; strength: number }
  | { type: 'commit'; commit: TimelineCommit; author: SimAuthor | null }

export interface SimulationStats {
  nodes: number
  files: number
  dirs: number
  visibleFiles: number
  appliedCommits: number
  totalCommits: number
  activeAuthors: number
  additions: number
  deletions: number
}

/**
 * How file circles are sized.
 *  - `bytes`    : real file size from the host (falls back to line activity)
 *  - `activity` : accumulated added + removed lines
 *  - `uniform`  : every file the same size
 */
export type SizeMode = 'bytes' | 'activity' | 'uniform'

export interface SimulationOptions {
  /** Seconds of inactivity before an avatar fades out. */
  idleTimeout: number
  /** How many recent commits define the author set after a seek. */
  seekAuthorWindow: number
  /** Spring stiffness of avatar motion (higher = snappier). */
  motionStiffness: number
  /** Upper bound on avatar speed in world units per second. */
  maxSpeed: number
  /** Seconds a tether stays visible after a file change. */
  tetherDuration: number
  /** Maximum number of simultaneous tethers per author. */
  maxTethers: number
}

export const DEFAULT_SIMULATION_OPTIONS: SimulationOptions = {
  idleTimeout: 2.6,
  seekAuthorWindow: 14,
  // Critically damped spring: ~0.4 s to travel between files, never a teleport.
  motionStiffness: 34,
  maxSpeed: 220,
  tetherDuration: 1.6,
  maxTethers: 12,
}

/**
 * The animated repository state: pure logic, no rendering, no DOM, no timers.
 *
 * Determinism: the scene state is a function of the applied commit range, so
 * the same history with the same settings always produces the same sequence of
 * visual events.
 *
 * Structure:
 *  - nodes are append-only (deleted files are flagged, not removed), which
 *    keeps node ids stable for the renderer;
 *  - visibility is derived from per-node *toggle indexes*: a node is visible
 *    when an odd number of add/delete toggles happened at or before the current
 *    index. That makes seeking O(nodes) instead of O(events);
 *  - node mutation counters are accumulated only "fresh" (never replayed), so
 *    seeking backwards and playing forward again cannot double count.
 */
export class Simulation {
  private nodeList: SimNode[] = []
  private nodeByPath = new Map<string, SimNode>()
  private authorList = new Map<string, SimAuthor>()
  private events: SimEvent[] = []
  private options: SimulationOptions

  /** Visibility toggles: first one per node, extras only for re-appearances. */
  private firstToggle: number[] = []
  private extraToggles = new Map<number, number[]>()

  private visibleFiles = 0
  private totalAdditions = 0
  private totalDeletions = 0
  private sizeMode: SizeMode = 'bytes'
  /** Largest file size seen (bytes) and largest line activity, for scaling. */
  private maxBytes = 0
  private maxActivity = 0
  /** Host-reported sizes for the whole snapshot (path → bytes). */
  private fileSizes = new Map<string, number>()
  /** Largest change strength seen, used to normalise beam brightness. */
  private maxChangeStrength = 1
  /** Nodes currently easing towards a new layout position. */
  private movingNodes = new Set<number>()
  /** Nodes that moved since the last drain, for the renderer. */
  private movedNodes: number[] = []
  /** Directories whose layout must be refreshed after the current commit. */
  private pendingReflow = new Set<number>()
  /** Reused buffer for the directory relaxation, and the directory count it holds. */
  private forceBuffer: ForceNode[] = []
  private forceBufferDirCount = -1
  private dirCount = 0
  /** Reflow file rings when files appear, disappear or change size. */
  dynamicLayout = true
  /** Reference size for the circle scale (95th percentile of the snapshot). */
  private sizeReferenceBytes = 1024
  private activitySamples: { position: Vec3; time: number }[] = []
  private time = 0

  /** Highest commit index whose changes have been folded into node state. */
  private maxAppliedIndex = -1
  /** Timeline index of the current playback position (-1 = before the start). */
  currentIndex = -1
  /** Set when visibility changed in bulk and the renderer must resync. */
  needsFullSync = false
  /** Simulated time of a commit index; injected by the engine from the schedule. */
  scheduleTime: (index: number) => number = () => 0

  constructor(
    private commits: readonly TimelineCommit[],
    private authorById: Map<string, TimelineAuthor>,
    options: Partial<SimulationOptions> = {},
  ) {
    this.options = { ...DEFAULT_SIMULATION_OPTIONS, ...options }
    this.reset()
  }

  /**
   * Swap in an extended commit list during incremental loading.
   * Node state is untouched because new commits only append at higher indexes.
   */
  setCommits(commits: readonly TimelineCommit[], authorById: Map<string, TimelineAuthor>): void {
    this.commits = commits
    this.authorById = authorById
  }

  get nodes(): readonly SimNode[] {
    return this.nodeList
  }

  get authors(): IterableIterator<SimAuthor> {
    return this.authorList.values()
  }

  get authorCount(): number {
    return this.authorList.size
  }

  get root(): SimNode {
    return this.nodeList[0]
  }

  get currentTime(): number {
    return this.time
  }

  get(id: number): SimNode | undefined {
    return this.nodeList[id]
  }

  find(path: string): SimNode | undefined {
    return this.nodeByPath.get(path)
  }

  reset(): void {
    this.nodeList = []
    this.nodeByPath.clear()
    this.authorList.clear()
    this.events = []
    this.firstToggle = []
    this.extraToggles.clear()
    this.visibleFiles = 0
    this.totalAdditions = 0
    this.totalDeletions = 0
    this.maxBytes = 0
    this.maxActivity = 0
    this.maxChangeStrength = 1
    this.movingNodes.clear()
    this.movedNodes = []
    this.activitySamples = []
    this.time = 0
    this.maxAppliedIndex = -1
    this.currentIndex = -1
    this.needsFullSync = true

    const root: SimNode = {
      id: 0,
      path: '',
      name: '/',
      kind: 'root',
      parent: -1,
      children: [],
      position: { ...ORIGIN },
      targetPosition: { ...ORIGIN },
      radius: LAYOUT.dirRadius * LAYOUT.rootRadius,
      clusterRadius: dirRadiusFor(0),
      ownDiscRadius: GOURCE.minOwnRadius,
      contentRadius: LAYOUT.dirRadius,
      subtreeArea: 0,
      positionInitialized: true,
      sizeBytes: 0,
      sizeKnown: false,
      activity: 0,
      bornIndex: 0,
      lastChangeIndex: -1,
      lastKind: null,
      changes: 0,
      additions: 0,
      deletions: 0,
      visible: true,
    }
    this.nodeList.push(root)
    this.nodeByPath.set('', root)
    this.dirCount = 1
    this.forceBufferDirCount = -1
    this.firstToggle[0] = 0
  }

  /* ------------------------------------------------------------------ *
   * Dynamic layout — Gource's model
   * ------------------------------------------------------------------ */

  /**
   * Radii of one directory: `sqrt(area) * padding`, exactly as Gource computes
   * them (`RDirNode::calcRadius`).
   *
   * `ownDiscRadius` is the area this directory's *own* files need (Gource's
   * `parent_radius`), `clusterRadius` the area of its whole subtree. Everything
   * scales with the square root of the content, which is why a deep tree stays
   * compact instead of growing with every level of nesting.
   */
  private computeDirRadii(dir: SimNode): void {
    let ownArea = 0
    let subtreeArea = 0
    for (const childId of dir.children) {
      const child = this.nodeList[childId]
      if (!child || !child.visible) continue
      if (child.kind === 'file') {
        const area = fileArea(child.radius)
        ownArea += area
        subtreeArea += area
      } else {
        subtreeArea += child.subtreeArea
      }
    }
    dir.ownDiscRadius = Math.max(GOURCE.minOwnRadius, Math.sqrt(ownArea) * GOURCE.dirPadding)
    dir.subtreeArea = subtreeArea
    dir.clusterRadius = dirRadiusFor(subtreeArea)
  }

  /**
   * Recompute the radii of a directory and of every ancestor. Returns true when
   * any of them changed enough to matter.
   */
  private updateDirRadii(dirId: number): boolean {
    let changed = false
    let current = dirId
    let guard = 0
    while (current >= 0 && guard < 128) {
      const dir = this.nodeList[current]
      if (!dir || dir.kind === 'file') break
      const own = dir.ownDiscRadius
      const cluster = dir.clusterRadius
      this.computeDirRadii(dir)
      if (Math.abs(own - dir.ownDiscRadius) > 1e-3 || Math.abs(cluster - dir.clusterRadius) > 1e-3) changed = true
      current = dir.parent
      guard += 1
    }
    return changed
  }

  /** Move a directory's own files with it, keeping their ring slots. */
  private shiftOwnFiles(dir: SimNode, dx: number, dy: number): void {
    for (const childId of dir.children) {
      const child = this.nodeList[childId]
      if (!child || child.kind !== 'file') continue
      child.targetPosition = { x: child.targetPosition.x + dx, y: child.targetPosition.y + dy, z: 0 }
      this.movingNodes.add(child.id)
    }
  }

  /** Move a whole subtree rigidly (used when a new folder takes its place). */
  private offsetSubtree(node: SimNode, dx: number, dy: number): void {
    for (const childId of node.children) {
      const child = this.nodeList[childId]
      if (!child) continue
      child.targetPosition = { x: child.targetPosition.x + dx, y: child.targetPosition.y + dy, z: 0 }
      this.movingNodes.add(child.id)
      if (child.kind === 'dir') this.offsetSubtree(child, dx, dy)
    }
  }

  /** True while a directory still has a subfolder without a starting position. */
  private hasUninitialisedSubdir(dir: SimNode): boolean {
    for (const childId of dir.children) {
      const child = this.nodeList[childId]
      if (child && child.kind === 'dir' && child.visible && !child.positionInitialized) return true
    }
    return false
  }

  /**
   * Lay out one directory the way Gource does.
   *
   * Files are grouped on concentric rings around their directory
   * (`RDirNode::updateFilePositions`): ring radii step outwards by one file
   * diameter and each ring holds as many files as its circumference allows.
   * Subfolders keep the position the force relaxation gave them; a brand new one
   * starts next to its parent with a hashed offset (`RDirNode::setInitialPosition`).
   */
  reflowDirectory(dirId: number): boolean {
    if (!this.dynamicLayout) return false
    const dir = this.nodeList[dirId]
    if (!dir || dir.kind === 'file') return false

    const files: SimNode[] = []
    const subdirs: SimNode[] = []
    for (const childId of dir.children) {
      const child = this.nodeList[childId]
      if (!child || !child.visible) continue
      if (child.kind === 'file') files.push(child)
      else if (child.kind === 'dir') subdirs.push(child)
    }

    let changed = false
    const base = dir.targetPosition

    const placements = placeFilesInRings(
      files.map((file) => ({ key: file.path, radius: file.radius })),
      { innerRadius: dir.radius },
    )
    let contentRadius = dir.radius
    for (let index = 0; index < files.length; index += 1) {
      const placement = placements[index]
      if (!placement) continue
      const file = files[index]
      const target = { x: base.x + placement.x, y: base.y + placement.y, z: 0 }
      // Files take their slot exactly: a circle that shrank must move inwards
      // too, or it would sit outside the folder's ring extent.
      const dx = target.x - file.targetPosition.x
      const dy = target.y - file.targetPosition.y
      if (dx * dx + dy * dy > 1e-8) {
        file.targetPosition = target
        this.movingNodes.add(file.id)
        changed = true
      }
      const distance = Math.hypot(file.targetPosition.x - base.x, file.targetPosition.y - base.y)
      contentRadius = Math.max(contentRadius, distance + file.radius)
    }
    dir.contentRadius = contentRadius

    for (const child of subdirs) {
      if (child.positionInitialized) continue
      const grandparent = dir.parent >= 0 ? this.nodeList[dir.parent] : undefined
      let directionX = 0
      let directionY = 0
      if (grandparent) {
        const ex = dir.targetPosition.x - grandparent.targetPosition.x
        const ey = dir.targetPosition.y - grandparent.targetPosition.y
        const length = Math.hypot(ex, ey)
        if (length > 1e-4) {
          directionX = (ex / length) * 2
          directionY = (ey / length) * 2
        }
      }
      const jitter = hashOffset(child.path)
      let offsetX = directionX + jitter.x
      let offsetY = directionY + jitter.y
      let length = Math.hypot(offsetX, offsetY)
      if (length < 1e-4) {
        offsetX = 0
        offsetY = -1
        length = 1
      }
      const distance = dir.clusterRadius + child.clusterRadius
      const target = {
        x: dir.targetPosition.x + (offsetX / length) * distance,
        y: dir.targetPosition.y + (offsetY / length) * distance,
        z: 0,
      }
      // The folder may already hold files and subfolders (laid out against its
      // temporary position): they travel with it.
      const moveX = target.x - child.targetPosition.x
      const moveY = target.y - child.targetPosition.y
      child.targetPosition = target
      child.position = { ...target }
      child.positionInitialized = true
      this.movingNodes.delete(child.id)
      if (moveX !== 0 || moveY !== 0) this.offsetSubtree(child, moveX, moveY)
      changed = true
    }
    return changed
  }

  /**
   * Run Gource's directory force relaxation (`RDirNode::applyForces`).
   *
   * Only directories are relaxed — files sit on the rings computed above — so
   * this stays cheap enough to run while the history plays. The work per call is
   * capped by `GOURCE.relaxBudget`: a very large tree relaxes with fewer steps
   * per commit rather than stalling the playback.
   */
  relaxLayout(steps?: number, budget = GOURCE.relaxBudget, forces = true, sweeps = GOURCE.relaxSweeps): void {
    if (!this.dynamicLayout) return
    // One entry per directory, reused between reflows: the buffer is rebuilt only
    // when directories are added.
    const nodes = this.forceBuffer
    if (this.forceBufferDirCount !== this.dirCount) {
      nodes.length = 0
      for (const node of this.nodeList) {
        if (node.kind === 'file') continue
        nodes.push({
          id: node.id,
          parent: node.parent,
          children: node.children,
          ownRadius: node.ownDiscRadius,
          dirRadius: node.clusterRadius,
          collisionRadius: Math.max(node.clusterRadius, node.contentRadius),
          ownCollisionRadius: Math.max(node.ownDiscRadius, node.contentRadius),
          x: node.targetPosition.x,
          y: node.targetPosition.y,
          visible: node.visible,
        })
      }
      this.forceBufferDirCount = this.dirCount
    } else {
      for (const entry of nodes) {
        const node = this.nodeList[entry.id]
        if (!node) continue
        entry.parent = node.parent
        entry.children = node.children
        entry.ownRadius = node.ownDiscRadius
        entry.dirRadius = node.clusterRadius
        // Gource sizes collisions by the subtree area; for a tiny folder the
        // actual extent of its own files is bigger, and that is what must not
        // overlap another folder's content.
        entry.collisionRadius = Math.max(node.clusterRadius, node.contentRadius)
        entry.ownCollisionRadius = Math.max(node.ownDiscRadius, node.contentRadius)
        entry.x = node.targetPosition.x
        entry.y = node.targetPosition.y
        entry.visible = node.visible
      }
    }
    if (nodes.length < 2) return
    const requested = steps ?? GOURCE.relaxSteps
    const stepCount = forces ? Math.max(1, Math.min(requested, Math.floor(budget / nodes.length))) : 0
    relaxDirectories(nodes, { steps: stepCount, gap: GOURCE.collisionGap, sweeps })
    for (const entry of nodes) {
      const node = this.nodeList[entry.id]
      if (!node) continue
      const dx = entry.x - node.targetPosition.x
      const dy = entry.y - node.targetPosition.y
      if (dx * dx + dy * dy < 1e-6) continue
      node.targetPosition = { x: entry.x, y: entry.y, z: 0 }
      this.movingNodes.add(node.id)
      // A directory carries its own files: their rings stay rigid as it drifts.
      // Subfolders relax on their own, so they are not shifted.
      this.shiftOwnFiles(node, dx, dy)
    }
  }

  /** Extent of the tree, used by the camera and the minimap. */
  treeExtent(): number {
    let extent = 0
    for (const node of this.nodeList) {
      if (!node.visible) continue
      extent = Math.max(extent, Math.hypot(node.targetPosition.x, node.targetPosition.y) + node.clusterRadius)
    }
    return extent
  }

  /**
   * Reflow the directories a commit changed, then settle the layout once.
   *
   * A folder that grew changes its own radius (which re-places its files) and the
   * radii of its ancestors (which the relaxation uses to space folders apart).
   * The walk stops as soon as an ancestor has nothing left to do.
   */
  reflowDirs(dirIds: Iterable<number>): void {
    if (!this.dynamicLayout) return
    let touched = false
    for (const dirId of dirIds) {
      this.updateDirRadii(dirId)
      let current = dirId
      let guard = 0
      let first = true
      while (current >= 0 && guard < 128) {
        const node = this.nodeList[current]
        if (!node) break
        const changed = this.reflowDirectory(current)
        const pending = this.hasUninitialisedSubdir(node)
        touched = true
        if (!changed && !pending && !first) break
        first = false
        current = node.parent
        guard += 1
      }
    }
    if (!touched) return
    // The forces run every few commits (they are the expensive part), but the
    // projection runs every time, so nothing overlaps in the meantime.
    this.relaxLayout(undefined, undefined, this.currentIndex % GOURCE.relaxEvery === 0)
  }

  /** Reflow one directory (and whatever its growth affects above it). */
  reflowChain(dirId: number): void {
    this.reflowDirs([dirId])
  }

  /** Put every node back on its path-derived position (static layout). */
  resetToStaticLayout(): void {
    for (const node of this.nodeList) {
      if (node.kind === 'dir' && node.parent >= 0) {
        const parent = this.nodeList[node.parent]
        const target = addVec(parent.targetPosition, directoryOffset(node.path, depthOfPath(node.path)))
        const dx = node.targetPosition.x - target.x
        const dy = node.targetPosition.y - target.y
        if (dx * dx + dy * dy < 0.0004) continue
        node.targetPosition = target
        this.movingNodes.add(node.id)
      }
    }
    for (const node of this.nodeList) {
      if (node.kind !== 'file') continue
      const parent = this.nodeList[node.parent]
      if (!parent) continue
      const target = addVec(parent.targetPosition, fileOffset(node.path))
      const dx = node.targetPosition.x - target.x
      const dy = node.targetPosition.y - target.y
      if (dx * dx + dy * dy < 0.0004) continue
      node.targetPosition = target
      this.movingNodes.add(node.id)
    }
  }

  /**
   * Reflow every directory (after a seek, a size change or a filter).
   *
   * Radii are computed bottom-up — reverse creation order visits children before
   * parents — then every directory places its files, then the relaxation runs
   * long enough to settle.
   */
  reflowAll(): void {
    if (!this.dynamicLayout) return
    for (let index = this.nodeList.length - 1; index >= 0; index -= 1) {
      const node = this.nodeList[index]
      if (node.kind === 'file') continue
      this.computeDirRadii(node)
    }
    for (const node of this.nodeList) {
      if (node.kind === 'file') continue
      this.reflowDirectory(node.id)
    }
    this.relaxLayout(GOURCE.reflowAllSteps, GOURCE.relaxBudget * 6, true, GOURCE.reflowAllSweeps)
  }

  /** Snap a freshly created node onto its layout position (no slide-in). */
  private snapToTarget(node: SimNode): void {
    node.position = { ...node.targetPosition }
    this.movingNodes.delete(node.id)
  }

  /** Node ids that moved since the last call (consumed by the renderer). */
  drainMovedNodes(): number[] {
    if (this.movedNodes.length === 0) return []
    const moved = this.movedNodes
    this.movedNodes = []
    return moved
  }

  /* ------------------------------------------------------------------ *
   * Sizing
   * ------------------------------------------------------------------ */

  /**
   * Radius of a file circle.
   *
   * The mapping is logarithmic so that a few huge files do not flatten the
   * scale of everything else; it is documented in the UI legend.
   */
  private fileRadiusFor(sizeBytes: number, activity: number, sizeKnown: boolean): number {
    if (this.sizeMode === 'uniform') return LAYOUT.fileRadius
    if (this.sizeMode === 'bytes' && sizeKnown && sizeBytes > 0) {
      return fileRadiusForBytes(sizeBytes, this.sizeReferenceBytes)
    }
    // Unknown sizes (or activity mode): fall back to line activity.
    return fileRadiusForActivity(activity, Math.max(8, this.maxActivity))
  }

  /** Switch how file circles are sized and rewrite every radius. */
  setSizeMode(mode: SizeMode): void {
    if (mode === this.sizeMode) return
    this.sizeMode = mode
    for (const node of this.nodeList) {
      if (node.kind !== 'file') continue
      node.radius = this.fileRadiusFor(node.sizeBytes, node.activity, node.sizeKnown)
    }
    this.needsFullSync = true
    this.reflowAll()
  }

  get currentSizeMode(): SizeMode {
    return this.sizeMode
  }

  /**
   * Attach host-reported file sizes (path → bytes).
   * Files that are not in the map keep their activity-based fallback.
   */
  setFileSizes(sizes: Map<string, number>): void {
    if (sizes.size === 0) return
    // Keep the map: files created later (or re-added after a delete) must pick
    // up their size too, not just the nodes that already exist.
    let scaleChanged = false
    for (const [path, bytes] of sizes) {
      if (!this.fileSizes.has(path)) scaleChanged = true
      this.fileSizes.set(path, bytes)
      if (bytes > this.maxBytes) this.maxBytes = bytes
    }
    if (scaleChanged) {
      const reference = sizeReferenceFrom(this.fileSizes.values())
      if (reference !== this.sizeReferenceBytes) {
        this.sizeReferenceBytes = reference
        scaleChanged = true
      }
    }

    let touched = 0
    for (const node of this.nodeList) {
      if (node.kind !== 'file') continue
      const bytes = this.fileSizes.get(node.path)
      if (bytes === undefined) continue
      if (node.sizeKnown && node.sizeBytes === bytes) continue
      node.sizeBytes = bytes
      node.sizeKnown = true
      touched += 1
    }

    // Recompute every radius when the reference changed, otherwise only the
    // nodes that actually received a size.
    if (scaleChanged) {
      for (const node of this.nodeList) {
        if (node.kind !== 'file') continue
        node.radius = this.fileRadiusFor(node.sizeBytes, node.activity, node.sizeKnown)
      }
    } else if (touched > 0) {
      for (const node of this.nodeList) {
        if (node.kind !== 'file') continue
        const bytes = this.fileSizes.get(node.path)
        if (bytes === undefined) continue
        node.radius = this.fileRadiusFor(node.sizeBytes, node.activity, node.sizeKnown)
      }
    }
    if (scaleChanged || touched > 0) {
      this.needsFullSync = true
      // Sizes change radii, so the rings have to be recomputed.
      this.reflowAll()
    }
  }

  /** Reference values used by the size legend in the UI. */
  get sizeReference(): { bytes: number; activity: number; mode: SizeMode } {
    return {
      bytes: this.sizeReferenceBytes,
      activity: Math.max(8, this.maxActivity),
      mode: this.sizeMode,
    }
  }

  /** Number of file nodes whose size is known, and the total file count. */
  sizeCoverage(): { known: number; total: number; bytes: number } {
    let known = 0
    let total = 0
    let bytes = 0
    for (const node of this.nodeList) {
      if (node.kind !== 'file') continue
      total += 1
      if (node.sizeKnown) {
        known += 1
        bytes += node.sizeBytes
      }
    }
    return { known, total, bytes }
  }

  /* ------------------------------------------------------------------ *
   * Visibility bookkeeping
   * ------------------------------------------------------------------ */

  private recordToggle(nodeId: number, index: number): void {
    if (this.firstToggle[nodeId] === undefined) {
      this.firstToggle[nodeId] = index
      return
    }
    const list = this.extraToggles.get(nodeId)
    if (list) list.push(index)
    else this.extraToggles.set(nodeId, [index])
  }

  /** True when the node is visible at `index` (odd number of toggles ≤ index). */
  private isVisible(nodeId: number, index: number): boolean {
    const first = this.firstToggle[nodeId]
    if (first === undefined || first > index) return false
    let count = 1
    const extras = this.extraToggles.get(nodeId)
    if (extras) {
      for (const toggle of extras) {
        if (toggle <= index) count += 1
        else break
      }
    }
    return count % 2 === 1
  }

  private refreshVisibility(index: number): void {
    this.visibleFiles = 0
    for (const node of this.nodeList) {
      const visible = this.isVisible(node.id, index)
      node.visible = visible
      if (visible && node.kind === 'file') this.visibleFiles += 1
    }
  }

  /* ------------------------------------------------------------------ *
   * Playback
   * ------------------------------------------------------------------ */

  /** Apply commits until `index` has been consumed. Returns how many were applied. */
  applyUpTo(index: number): number {
    let applied = 0
    while (this.currentIndex < index) {
      const next = this.currentIndex + 1
      if (next >= this.commits.length) break
      this.applyCommit(next)
      applied += 1
    }
    return applied
  }

  /**
   * Move to a commit index without replaying effects.
   *
   * Node state (counters) always reflects the highest applied index, while the
   * visible flags and the author set are re-derived for the requested index.
   */
  seek(index: number): void {
    const target = Math.max(-1, Math.min(this.commits.length - 1, Math.floor(index)))
    if (target === this.currentIndex) return

    // Seeking forward past everything applied so far must still materialize the
    // tree: node state is built by applying commits, so replay them silently.
    const applied = target > this.maxAppliedIndex
    if (applied) this.applyUpTo(target)

    this.refreshVisibility(target)
    this.currentIndex = target
    this.time = target >= 0 ? this.scheduleTime(target) : 0
    this.authorList.clear()
    this.activitySamples = []

    const from = Math.max(0, target - this.options.seekAuthorWindow + 1)
    for (let position = from; position <= target; position += 1) {
      const commit = this.commits[position]
      if (!commit) continue
      const author = this.touchAuthor(commit)
      if (!author) continue
      author.appliedCommits += 1
      author.lastActiveAt = this.scheduleTime(position)
      author.visible = position >= Math.max(0, target - 2)
      const node = this.lastTouchedNode(commit)
      if (node) {
        author.targetNodeId = node.id
        author.target = { ...node.position }
        if (author.appliedCommits === 1) {
          author.position = { ...node.position }
          author.velocity = { x: 0, y: 0, z: 0 }
        }
      }
    }

    this.events = []
    this.needsFullSync = true
    this.movingNodes.clear()
    // A forward seek replayed the commits, so the layout is exactly the one
    // playback produces. A jump that hides or reveals nodes has to rebuild the
    // rings instead, because the visible files changed.
    if (!applied) this.reflowAll()
    // Seeked state is instant: place everything without animation.
    for (const node of this.nodeList) {
      node.position = { ...node.targetPosition }
      this.movedNodes.push(node.id)
    }
  }

  private applyCommit(index: number): void {
    const commit = this.commits[index]
    if (!commit) return
    const fresh = index > this.maxAppliedIndex
    if (fresh) this.maxAppliedIndex = index
    this.time = this.scheduleTime(index)
    this.currentIndex = index

    const author = this.touchAuthor(commit)
    if (author) {
      author.appliedCommits += 1
      author.lastActiveAt = this.time
      author.visible = true
    }

    const touched: SimNode[] = []
    this.pendingReflow.clear()
    for (const change of commit.changes) {
      const node = this.applyChange(change, index, author, fresh)
      if (node) touched.push(node)
    }
    if (this.pendingReflow.size > 0) this.reflowDirs(this.pendingReflow)
    this.pendingReflow.clear()

    if (author) {
      const focus = touched.length > 0 ? touched[touched.length - 1] : this.root
      author.targetNodeId = focus.id
      if (touched.length > 1) {
        let x = 0
        let y = 0
        let z = 0
        for (const node of touched) {
          x += node.position.x
          y += node.position.y
          z += node.position.z
        }
        author.target = { x: x / touched.length, y: y / touched.length, z: z / touched.length }
      } else {
        author.target = { ...focus.position }
      }

      // A brand new avatar flies in from outside the tree instead of appearing
      // on top of the file it is about to touch.
      if (author.appliedCommits <= 1 && this.currentIndex > 0) {
        author.position = spawnPositionFor(author, focus.position)
        author.velocity = { x: 0, y: 0, z: 0 }
      }

      // Tether the author to every file this commit touched.
      this.attachTethers(author, touched, focus, commit.changes)

      this.pushEvent({
        type: 'author',
        author,
        node: focus,
        kind: focus.lastKind ?? 'modify',
        strength: touched.length,
      })
    }

    if (touched.length > 0) this.recordActivity(touched[touched.length - 1].position)
    this.pushEvent({ type: 'commit', commit, author })
  }

  private applyChange(
    change: TimelineFileChange,
    index: number,
    author: SimAuthor | null,
    fresh: boolean,
  ): SimNode | null {
    if (change.kind === 'rename' && change.from) {
      const existing = this.nodeByPath.get(change.from)
      if (existing && existing.kind === 'file') return this.renameNode(existing, change.path, index, change, author, fresh)
      // A rename from an unknown source is indistinguishable from an addition.
    }

    if (change.kind === 'delete') {
      const node = this.ensureFile(change.path, index, fresh)
      if (node.visible) {
        node.visible = false
        if (fresh) this.recordToggle(node.id, index)
        this.visibleFiles = Math.max(0, this.visibleFiles - 1)
        this.pendingReflow.add(node.parent)
      }
      if (fresh) {
        node.lastKind = 'delete'
        node.lastChangeIndex = index
        node.changes += 1
        node.deletions += change.deletions
        this.totalDeletions += change.deletions
      }
      this.pushEvent({ type: 'node-changed', node, kind: 'delete' })
      this.pushEvent({ type: 'node-removed', node })
      this.pushEvent({ type: 'activity', node, kind: 'delete', strength: change.deletions + 1 })
      if (author) author.lastKind = 'delete'
      return node
    }

    const node = this.ensureFile(change.path, index, fresh)
    const kind: ChangeKind = node.changes === 0 ? 'add' : 'modify'
    if (fresh) {
      node.lastKind = kind
      node.lastChangeIndex = index
      node.changes += 1
      node.additions += change.additions
      node.deletions += change.deletions
      node.activity += change.additions + change.deletions
      this.maxActivity = Math.max(this.maxActivity, node.activity)
      this.totalAdditions += change.additions
      this.totalDeletions += change.deletions
      const previousRadius = node.radius
      node.radius = this.fileRadiusFor(node.sizeBytes, node.activity, node.sizeKnown)
      node.clusterRadius = node.radius
      // A growing circle needs more room: let the layout adapt (once per
      // directory per commit, not once per changed file).
      if (Math.abs(node.radius - previousRadius) > 0.01) this.pendingReflow.add(node.parent)
    }
    this.pushEvent({ type: 'node-changed', node, kind })
    this.pushEvent({ type: 'activity', node, kind, strength: change.additions + change.deletions + 1 })
    if (author) author.lastKind = kind
    return node
  }

  private renameNode(
    node: SimNode,
    newPath: string,
    index: number,
    change: TimelineFileChange,
    author: SimAuthor | null,
    fresh: boolean,
  ): SimNode {
    const oldPath = node.path
    if (node.path === newPath) return node
    const { parent: parentPath, name } = splitPath(newPath)
    const parent = this.ensureDirectory(parentPath, index, fresh)
    if (node.parent !== parent.id) {
      const previousParent = this.nodeList[node.parent]
      previousParent.children = previousParent.children.filter((id) => id !== node.id)
      node.parent = parent.id
      parent.children.push(node.id)
    }
    this.nodeByPath.delete(oldPath)
    this.nodeByPath.set(newPath, node)
    const previousParent = node.parent
    node.movedFrom = { ...node.position }
    node.path = newPath
    node.name = name
    node.position = addVec(parent.position, fileOffset(newPath))
    node.targetPosition = { ...node.position }
    // Sizes belong to paths: a renamed file takes its new path's size.
    const renamedSize = this.fileSizes.get(newPath)
    if (renamedSize !== undefined) {
      node.sizeBytes = renamedSize
      node.sizeKnown = true
      this.maxBytes = Math.max(this.maxBytes, renamedSize)
    }
    if (fresh) {
      node.lastKind = 'rename'
      node.lastChangeIndex = index
      node.changes += 1
      node.additions += change.additions
      node.deletions += change.deletions
      this.totalAdditions += change.additions
      this.totalDeletions += change.deletions
    }
    this.pushEvent({ type: 'node-changed', node, kind: 'rename' })
    this.pushEvent({ type: 'activity', node, kind: 'rename', strength: change.additions + change.deletions + 1 })
    if (author) author.lastKind = 'rename'
    // Reflow both the old and the new directory (and their ancestors).
    if (previousParent !== node.parent) this.pendingReflow.add(previousParent)
    this.pendingReflow.add(node.parent)
    return node
  }

  /** Get or create a file node, creating missing parent directories. */
  private ensureFile(path: string, index: number, fresh: boolean): SimNode {
    const existing = this.nodeByPath.get(path)
    if (existing) {
      if (!existing.visible) {
        existing.visible = true
        if (fresh) this.recordToggle(existing.id, index)
        this.visibleFiles += 1
        this.pendingReflow.add(existing.parent)
        this.movingNodes.add(existing.id)
      }
      return existing
    }
    const { parent: parentPath, name } = splitPath(path)
    const parent = this.ensureDirectory(parentPath, index, fresh)
    const node: SimNode = {
      id: this.nodeList.length,
      path,
      name,
      kind: 'file',
      parent: parent.id,
      children: [],
      position: addVec(parent.position, fileOffset(path)),
      targetPosition: addVec(parent.position, fileOffset(path)),
      radius: LAYOUT.fileRadius,
      clusterRadius: LAYOUT.fileRadius,
      ownDiscRadius: LAYOUT.fileRadius,
      contentRadius: LAYOUT.fileRadius,
      subtreeArea: 0,
      positionInitialized: true,
      sizeBytes: 0,
      sizeKnown: false,
      activity: 0,
      bornIndex: index,
      lastChangeIndex: index,
      lastKind: null,
      changes: 0,
      additions: 0,
      deletions: 0,
      visible: true,
    }
    const knownSize = this.fileSizes.get(path)
    if (knownSize !== undefined) {
      node.sizeBytes = knownSize
      node.sizeKnown = true
      this.maxBytes = Math.max(this.maxBytes, knownSize)
    }
    node.radius = this.fileRadiusFor(node.sizeBytes, node.activity, node.sizeKnown)
    node.clusterRadius = node.radius
    this.nodeList.push(node)
    this.nodeByPath.set(path, node)
    parent.children.push(node.id)
    if (fresh) this.recordToggle(node.id, index)
    this.visibleFiles += 1
    this.pushEvent({ type: 'node-added', node })
    // The new file takes its slot (applied once per commit with the other
    // reflows) and does not slide in from elsewhere.
    this.pendingReflow.add(parent.id)
    this.snapToTarget(node)
    return node
  }

  /** Get or create a directory node. */
  ensureDirectory(path: string, index: number, fresh: boolean): SimNode {
    if (!path) return this.root
    const existing = this.nodeByPath.get(path)
    if (existing) return existing
    const { parent: parentPath, name } = splitPath(path)
    const parent = this.ensureDirectory(parentPath, index, fresh)
    const depth = depthOfPath(path)
    const node: SimNode = {
      id: this.nodeList.length,
      path,
      name,
      kind: 'dir',
      parent: parent.id,
      children: [],
      position: addVec(parent.position, directoryOffset(path, depth)),
      targetPosition: addVec(parent.position, directoryOffset(path, depth)),
      radius: LAYOUT.dirRadius * (1 + Math.min(0.6, hashUnit(path, 7) * 0.6)),
      clusterRadius: dirRadiusFor(0),
      ownDiscRadius: GOURCE.minOwnRadius,
      contentRadius: LAYOUT.dirRadius,
      subtreeArea: 0,
      positionInitialized: false,
      sizeBytes: 0,
      sizeKnown: false,
      activity: 0,
      bornIndex: index,
      lastChangeIndex: index,
      lastKind: null,
      changes: 0,
      additions: 0,
      deletions: 0,
      visible: true,
    }
    this.nodeList.push(node)
    this.nodeByPath.set(path, node)
    parent.children.push(node.id)
    this.dirCount += 1
    if (fresh) this.recordToggle(node.id, index)
    this.pushEvent({ type: 'node-added', node })
    return node
  }

  private touchAuthor(commit: TimelineCommit): SimAuthor | null {
    const existing = this.authorList.get(commit.authorId)
    if (existing) return existing
    const author = this.authorById.get(commit.authorId)
    if (!author) return null
    const state: SimAuthor = {
      author,
      position: { ...ORIGIN },
      velocity: { x: 0, y: 0, z: 0 },
      target: { ...ORIGIN },
      targetNodeId: this.root.id,
      lastActiveAt: this.time,
      appearedAt: this.time,
      appliedCommits: 0,
      lastKind: null,
      visible: true,
      tethers: [],
    }
    this.authorList.set(author.id, state)
    return state
  }

  private lastTouchedNode(commit: TimelineCommit): SimNode | null {
    for (let index = commit.changes.length - 1; index >= 0; index -= 1) {
      const node = this.nodeByPath.get(commit.changes[index].path)
      if (node) return node
    }
    return null
  }

  /** Remember which files a commit touched so beams can be drawn to them. */
  private attachTethers(author: SimAuthor, touched: SimNode[], fallback: SimNode, changes: TimelineFileChange[]): void {
    // Strength per file: how much this particular file changed.
    const strengthOf = (path: string): number => {
      let lines = 0
      let bytes = 0
      for (const change of changes) {
        if (change.path !== path) continue
        lines += change.additions + change.deletions
        // A big file changing at all is a bigger event than a tiny one.
        if (change.sizeBytes !== undefined) bytes = Math.max(bytes, change.sizeBytes)
      }
      // Line churn dominates, with the file's size as a secondary factor.
      return Math.max(lines, bytes / 200, 1)
    }
    const until = this.time + this.options.tetherDuration
    const targets = touched.length > 0 ? touched : [fallback]
    for (const node of targets) {
      const kind = node.lastKind ?? 'modify'
      const strength = strengthOf(node.path)
      this.maxChangeStrength = Math.max(this.maxChangeStrength, strength)
      const existing = author.tethers.find((tether) => tether.nodeId === node.id)
      if (existing) {
        existing.kind = kind
        existing.start = this.time
        existing.until = until
        existing.strength = strength
        existing.reference = this.maxChangeStrength
        continue
      }
      author.tethers.push({
        nodeId: node.id,
        kind,
        start: this.time,
        until,
        strength,
        reference: this.maxChangeStrength,
      })
    }
    if (author.tethers.length > this.options.maxTethers) {
      author.tethers.splice(0, author.tethers.length - this.options.maxTethers)
    }
  }

  /**
   * Advance avatar motion and fade idle authors. Called once per frame.
   *
   * Motion is a critically damped spring with a speed limit: avatars travel
   * visibly between files (like Gource) instead of teleporting, and they settle
   * without oscillating.
   */
  update(dt: number, time: number): void {
    // Track the playback clock: tethers and highlights are timed in simulated
    // seconds, so they scale with the playback speed like the commits do.
    this.time = time
    const step = Math.min(Math.max(dt, 0), 0.1)
    const stiffness = this.options.motionStiffness
    const damping = 2 * Math.sqrt(stiffness)
    if (this.movingNodes.size > 0) {
      const rate = 1 - Math.exp(-step * LAYOUT.reflowRate)
      for (const id of this.movingNodes) {
        const node = this.nodeList[id]
        if (!node) {
          this.movingNodes.delete(id)
          continue
        }
        const target = node.targetPosition
        const nx = node.position.x + (target.x - node.position.x) * rate
        const ny = node.position.y + (target.y - node.position.y) * rate
        node.position = { x: nx, y: ny, z: 0 }
        this.movedNodes.push(id)
        const remainingX = target.x - nx
        const remainingY = target.y - ny
        if (remainingX * remainingX + remainingY * remainingY < 0.0004) {
          node.position = { ...target }
          this.movingNodes.delete(id)
        }
      }
    }

    for (const author of this.authorList.values()) {
      const dx = author.target.x - author.position.x
      const dy = author.target.y - author.position.y
      const dz = author.target.z - author.position.z
      // Spring acceleration towards the target, with damping.
      let vx = author.velocity.x + (dx * stiffness - author.velocity.x * damping) * step
      let vy = author.velocity.y + (dy * stiffness - author.velocity.y * damping) * step
      let vz = author.velocity.z + (dz * stiffness - author.velocity.z * damping) * step

      // Clamp the speed so a far away target cannot cause a jump.
      const speed = Math.hypot(vx, vy, vz)
      const limit = this.options.maxSpeed
      if (speed > limit) {
        const scale = limit / speed
        vx *= scale
        vy *= scale
        vz *= scale
      }

      author.velocity = { x: vx, y: vy, z: vz }
      author.position = {
        x: author.position.x + vx * step,
        y: author.position.y + vy * step,
        z: author.position.z + vz * step,
      }

      if (author.tethers.length > 0) {
        author.tethers = author.tethers.filter((tether) => tether.until > time)
      }

      if (author.visible && time - author.lastActiveAt > this.options.idleTimeout) {
        author.visible = false
        this.pushEvent({ type: 'author', author, node: null, kind: author.lastKind ?? 'modify', strength: 0 })
      }
    }
  }

  /** True while the author is travelling (used for trails). */
  authorSpeed(author: SimAuthor): number {
    return Math.hypot(author.velocity.x, author.velocity.y)
  }

  /** Drop long-idle authors so memory stays bounded on huge histories. */
  pruneAuthors(time: number, keep: number): void {
    if (this.authorList.size <= keep) return
    const sorted = [...this.authorList.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    for (const author of sorted.slice(keep)) {
      if (time - author.lastActiveAt > 30) this.authorList.delete(author.author.id)
    }
  }

  private recordActivity(position: Vec3): void {
    this.activitySamples.push({ position: { ...position }, time: this.time })
    if (this.activitySamples.length > 64) this.activitySamples.shift()
  }

  /** Centroid of recent activity, used as the default camera focus. */
  recentActivityCenter(windowSeconds: number): Vec3 | null {
    const cutoff = this.time - windowSeconds
    let x = 0
    let y = 0
    let z = 0
    let count = 0
    for (let index = this.activitySamples.length - 1; index >= 0; index -= 1) {
      const sample = this.activitySamples[index]
      if (sample.time < cutoff) break
      x += sample.position.x
      y += sample.position.y
      z += sample.position.z
      count += 1
    }
    if (count === 0) return null
    return { x: x / count, y: y / count, z: z / count }
  }

  /** Centroid of the currently visible authors. */
  authorCentroid(): Vec3 | null {
    let x = 0
    let y = 0
    let z = 0
    let count = 0
    for (const author of this.authorList.values()) {
      if (!author.visible) continue
      x += author.position.x
      y += author.position.y
      z += author.position.z
      count += 1
    }
    if (count === 0) return null
    return { x: x / count, y: y / count, z: z / count }
  }

  /** Bounding box of the currently visible nodes (for camera framing). */
  bounds(): { center: Vec3; radius: number } {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of this.nodeList) {
      if (!node.visible) continue
      const { position } = node
      if (position.x < minX) minX = position.x
      if (position.y < minY) minY = position.y
      if (position.x > maxX) maxX = position.x
      if (position.y > maxY) maxY = position.y
    }
    if (!Number.isFinite(minX)) return { center: { ...ORIGIN }, radius: 10 }
    const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: 0 }
    const radius = Math.max(6, Math.hypot(maxX - minX, maxY - minY) / 2)
    return { center, radius }
  }

  stats(): SimulationStats {
    let dirs = 0
    let active = 0
    for (const node of this.nodeList) if (node.kind === 'dir') dirs += 1
    for (const author of this.authorList.values()) if (author.visible) active += 1
    return {
      nodes: this.nodeList.length,
      files: this.nodeList.length - dirs - 1,
      dirs,
      visibleFiles: this.visibleFiles,
      appliedCommits: this.currentIndex + 1,
      totalCommits: this.commits.length,
      activeAuthors: active,
      additions: this.totalAdditions,
      deletions: this.totalDeletions,
    }
  }

  private pushEvent(event: SimEvent): void {
    this.events.push(event)
  }

  drainEvents(): SimEvent[] {
    if (this.events.length === 0) return []
    const events = this.events
    this.events = []
    return events
  }
}

function clampRadius(value: number): number {
  return Math.min(LAYOUT.maxFileRadius, Math.max(LAYOUT.minFileRadius, value))
}

/** Exponent applied to the normalised size; >1 spreads the mid range apart. */
const SIZE_CURVE = 1.35

/**
 * Circle radius for a file of `bytes` bytes, given the reference size (the
 * 95th percentile of the repository, so a single generated file cannot squash
 * everything else).
 *
 * The mapping is logarithmic with a mild power curve: circle sizes stay
 * readable across four orders of magnitude while differences between ordinary
 * files remain clearly visible. The UI legend uses the same function.
 */
export function fileRadiusForBytes(bytes: number, referenceBytes: number): number {
  const reference = Math.max(1024, referenceBytes)
  const normalised = Math.log1p(Math.max(0, bytes)) / Math.log1p(reference)
  const shaped = Math.pow(Math.min(1, Math.max(0, normalised)), SIZE_CURVE)
  return clampRadius(LAYOUT.minFileRadius + (LAYOUT.maxFileRadius - LAYOUT.minFileRadius) * shaped)
}

/** 95th percentile of a list of sizes, used as the size reference. */
export function sizeReferenceFrom(sizes: Iterable<number>): number {
  const values = [...sizes].filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
  if (values.length === 0) return 1024
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * 0.95) - 1))
  return Math.max(1024, values[index])
}

/** Circle radius used when only line activity is known. */
export function fileRadiusForActivity(activity: number, referenceActivity: number): number {
  const reference = Math.max(8, referenceActivity)
  const ratio = Math.log1p(Math.max(0, activity)) / Math.log1p(reference)
  return clampRadius(LAYOUT.fileRadius * (0.7 + 0.9 * ratio))
}

/**
 * Deterministic "fly in" start position: outside the tree, in the direction of
 * the node the author is heading to, so the avatar enters from the edge.
 */
function spawnPositionFor(author: SimAuthor, target: Vec3): Vec3 {
  const length = Math.hypot(target.x, target.y)
  if (length < 0.001) return { x: target.x + 30, y: target.y + 18, z: 0 }
  const scale = 1.55
  const jitter = (hashUnit(author.author.id, 5) - 0.5) * 12
  return {
    x: target.x * scale + jitter,
    y: target.y * scale + jitter * 0.6,
    z: 0,
  }
}
