import type { ChangeKind, TimelineAuthor, TimelineCommit, TimelineFileChange } from '../timeline/types'
import {
  addVec,
  depthOfPath,
  directoryOffset,
  fileOffset,
  hashUnit,
  LAYOUT,
  ORIGIN,
  splitPath,
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
  position: Vec3
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
  /** Previous position after a rename, so the renderer can animate the move. */
  movedFrom?: Vec3
}

/** An author currently present in the scene. */
export interface SimAuthor {
  author: TimelineAuthor
  /** Smoothed position and the point it is heading to. */
  position: Vec3
  target: Vec3
  targetNodeId: number
  lastActiveAt: number
  appearedAt: number
  appliedCommits: number
  lastKind: ChangeKind | null
  visible: boolean
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
}

export const DEFAULT_SIMULATION_OPTIONS: SimulationOptions = {
  idleTimeout: 2.6,
  seekAuthorWindow: 14,
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
      radius: LAYOUT.dirRadius * LAYOUT.rootRadius,
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
    this.firstToggle[0] = 0
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
    if (scaleChanged || touched > 0) this.needsFullSync = true
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
    if (target > this.maxAppliedIndex) this.applyUpTo(target)

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
        if (author.appliedCommits === 1) author.position = { ...node.position }
      }
    }

    this.events = []
    this.needsFullSync = true
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
    for (const change of commit.changes) {
      const node = this.applyChange(change, index, author, fresh)
      if (node) touched.push(node)
    }

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
      node.radius = this.fileRadiusFor(node.sizeBytes, node.activity, node.sizeKnown)
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
    node.movedFrom = { ...node.position }
    node.path = newPath
    node.name = name
    node.position = addVec(parent.position, fileOffset(newPath))
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
      radius: LAYOUT.fileRadius,
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
    this.nodeList.push(node)
    this.nodeByPath.set(path, node)
    parent.children.push(node.id)
    if (fresh) this.recordToggle(node.id, index)
    this.visibleFiles += 1
    this.pushEvent({ type: 'node-added', node })
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
      radius: LAYOUT.dirRadius * (1 + Math.min(0.6, hashUnit(path, 7) * 0.6)),
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
      target: { ...ORIGIN },
      targetNodeId: this.root.id,
      lastActiveAt: this.time,
      appearedAt: this.time,
      appliedCommits: 0,
      lastKind: null,
      visible: true,
    }
    // First sighting during a seek should not snap the avatar to the origin.
    if (this.currentIndex >= 0) state.position = { ...ORIGIN }
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

  /** Advance avatar motion and fade idle authors. Called once per frame. */
  update(dt: number, time: number): void {
    const smoothing = 1 - Math.exp(-dt / 0.055)
    for (const author of this.authorList.values()) {
      author.position = {
        x: author.position.x + (author.target.x - author.position.x) * smoothing,
        y: author.position.y + (author.target.y - author.position.y) * smoothing,
        z: author.position.z + (author.target.z - author.position.z) * smoothing,
      }
      if (author.visible && time - author.lastActiveAt > this.options.idleTimeout) {
        author.visible = false
        this.pushEvent({ type: 'author', author, node: null, kind: author.lastKind ?? 'modify', strength: 0 })
      }
    }
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
