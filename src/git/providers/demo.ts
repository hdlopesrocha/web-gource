import type { CommitPage, FileSizeResult, RawCommit, RepoInfo } from '../types'
import type { GitProvider, HydrateOptions, LoadPageOptions, ParsedRepoUrl } from './types'

/**
 * Synthetic provider used for offline demos, development and load testing.
 *
 * It produces a *fictional* repository history with a deterministic PRNG. The
 * UI labels it clearly as synthetic data — it exists so the visualization can be
 * exercised without spending API quota, never to stand in for real repository
 * data.
 */
export interface DemoOptions {
  commits?: number
  seed?: number
}

const FIRST_NAMES = [
  'Ada', 'Grace', 'Alan', 'Linus', 'Margaret', 'Ken', 'Barbara', 'Dennis', 'Radia', 'Guido',
  'Anita', 'Vint', 'Katherine', 'Donald', 'Frances', 'Bjarne', 'Sophie', 'Yuki', 'Omar', 'Priya',
]

const AREAS = ['core', 'ui', 'api', 'docs', 'tests', 'build', 'vendor', 'plugins', 'net', 'storage']
const LEAF_DIRS = ['src', 'lib', 'components', 'utils', 'models', 'hooks']
const EXTENSIONS = ['ts', 'tsx', 'js', 'vue', 'css', 'md', 'json', 'py', 'go', 'rs', 'sh', 'yml']
const TOPICS = ['parser', 'renderer', 'cache', 'client', 'server', 'schema', 'router', 'store', 'logger', 'config', 'auth', 'stream']

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export class DemoProvider implements GitProvider {
  readonly id = 'demo'
  readonly name = 'Demo (synthetic data)'
  readonly supportsAnonymous = true
  readonly notes = 'Generates a fictional repository history in the browser. No network requests, no real repository data.'

  private readonly options: DemoOptions

  constructor(options: DemoOptions = {}) {
    this.options = options
  }

  parse(url: URL): ParsedRepoUrl | null {
    if (url.protocol !== 'demo:' && url.hostname !== 'demo') return null
    const segments = url.pathname.split('/').filter(Boolean)
    const owner = segments[0] ?? url.hostname
    const repo = segments[1] ?? 'synthetic-repository'
    return {
      providerId: this.id,
      owner: owner || 'demo',
      repo,
      htmlUrl: `demo://${owner || 'demo'}/${repo}`,
      host: 'demo',
      params: { seed: String(fnv1a(`${owner}/${repo}`) % 100000) },
    }
  }

  commitUrl(repo: ParsedRepoUrl, sha: string): string {
    return `demo://${repo.owner}/${repo.repo}/${sha}`
  }

  async fetchRepoInfo(repo: ParsedRepoUrl): Promise<RepoInfo> {
    const total = this.options.commits ?? 420
    return {
      provider: this.id,
      owner: repo.owner,
      name: repo.repo,
      fullName: `${repo.owner}/${repo.repo}`,
      htmlUrl: repo.htmlUrl,
      description: 'Synthetic repository generated in the browser for demonstration purposes.',
      defaultBranch: 'main',
      isPrivate: false,
      stars: 128,
      language: 'TypeScript',
      commitCountEstimate: total,
    }
  }

  async loadCommitPage(repo: ParsedRepoUrl, options: LoadPageOptions): Promise<CommitPage> {
    const page = Number(/^p(\d+)$/.exec(options.cursor ?? 'p1')?.[1] ?? 1)
    const perPage = Math.max(1, Math.min(100, options.limit ?? 100))
    const seed = this.options.seed ?? Number(repo.params?.seed ?? 1234)
    const total = this.options.commits ?? 420

    const commits: RawCommit[] = []
    for (let i = 0; i < perPage; i += 1) {
      const index = (page - 1) * perPage + i
      if (index >= total) break
      commits.push(this.generateCommit(seed, total - 1 - index, total))
    }
    const next = page * perPage < total ? `p${page + 1}` : null
    options.onProgress?.({ requestCount: 1, authenticated: false, rateRemaining: 1000, rateLimit: 1000 })
    // Simulate a little latency so the loading UI is exercised.
    await new Promise((resolve) => setTimeout(resolve, 60))
    return { commits, next, totalCount: total }
  }

  /**
   * Synthetic file sizes: the demo has no real blobs, so it derives a stable
   * size per path (clearly labelled `synthetic` in the UI).
   */
  async fetchFileSizes(repo: ParsedRepoUrl): Promise<FileSizeResult | null> {
    const seed = this.options.seed ?? Number(repo.params?.seed ?? 1234)
    const total = this.options.commits ?? 420
    const sizes = new Map<string, number>()
    for (let index = 0; index < total; index += 1) {
      const commit = this.generateCommit(seed, index, total)
      for (const file of commit.files ?? []) {
        if (sizes.has(file.path)) continue
        const rand = mulberry32(fnv1a(`${seed}:${file.path}`))
        // Skewed distribution: most files small, a few large.
        const bytes = Math.round(120 + Math.pow(rand(), 3) * 260_000 + rand() * 4_000)
        sizes.set(file.path, bytes)
      }
    }
    return { sizes, truncated: false, source: 'synthetic' }
  }

  /** The demo provider already generates complete commits, so this is a no-op. */
  async hydrateFiles(_repo: ParsedRepoUrl, _commits: RawCommit[], _options: HydrateOptions): Promise<void> {
    return
  }

  async loadEarliestPage(repo: ParsedRepoUrl, options: LoadPageOptions): Promise<CommitPage> {
    const total = this.options.commits ?? 420
    const seed = this.options.seed ?? Number(repo.params?.seed ?? 1234)
    const perPage = Math.max(1, Math.min(100, options.limit ?? 100))
    const firstPageCount = Math.min(perPage, total)
    const commits: RawCommit[] = []
    for (let i = 0; i < firstPageCount; i += 1) commits.push(this.generateCommit(seed, i, total))
    const pages = Math.ceil(total / perPage)
    return { commits, next: pages > 1 ? `p${pages - 1}` : null, totalCount: total }
  }

  /** Build one commit deterministically from its chronological index. */
  private generateCommit(seed: number, chronoIndex: number, total: number): RawCommit {
    const rand = mulberry32(seed + chronoIndex * 2654435761)
    const authorIndex = Math.floor(rand() * 8)
    const name = FIRST_NAMES[(seed + authorIndex) % FIRST_NAMES.length]
    const dayMs = 86_400_000
    const start = Date.UTC(2021, 0, 4)
    const timestamp = start + chronoIndex * (0.4 + rand() * 2.6) * dayMs

    const changeCount = 1 + Math.floor(rand() * 5)
    const files = []
    for (let i = 0; i < changeCount; i += 1) {
      const area = AREAS[Math.floor(rand() * AREAS.length)]
      const leaf = LEAF_DIRS[Math.floor(rand() * LEAF_DIRS.length)]
      const topic = TOPICS[Math.floor(rand() * TOPICS.length)]
      const ext = EXTENSIONS[Math.floor(rand() * EXTENSIONS.length)]
      const depthRoll = rand()
      const dirs = depthRoll > 0.65 ? `${area}/${leaf}` : depthRoll > 0.3 ? area : ''
      const path = `${dirs ? `${dirs}/` : ''}${topic}${rand() > 0.6 ? `-${Math.floor(rand() * 9)}` : ''}.${ext}`
      const roll = rand()
      const early = chronoIndex < total * 0.55
      const kind: 'add' | 'modify' | 'delete' | 'rename' =
        roll < (early ? 0.45 : 0.16) ? 'add' : roll < 0.86 ? 'modify' : roll < 0.94 ? 'delete' : 'rename'
      files.push({
        path,
        kind,
        previousPath: kind === 'rename' ? path.replace(/(\.[a-z]+)$/, `.old$1`) : undefined,
        additions: kind === 'delete' ? 0 : Math.floor(rand() * 60),
        deletions: kind === 'add' ? 0 : Math.floor(rand() * 40),
      })
    }

    const sha = fnv1a(`${seed}:${chronoIndex}:${name}`).toString(16).padStart(8, '0').repeat(5)
    return {
      sha,
      parents: chronoIndex === 0 ? [] : [`${chronoIndex}-parent`],
      isMerge: chronoIndex > 0 && rand() > 0.94,
      timestamp,
      message: `${pick(TOPICS, rand)}: ${pick(['fix', 'feat', 'refactor', 'docs', 'test', 'perf'], rand)} ${pick(TOPICS, rand)} handling`,
      author: {
        name,
        email: `${name.toLowerCase()}@example.com`,
        login: name.toLowerCase(),
        avatarUrl: undefined,
      },
      files,
      stats: files.reduce(
        (acc, file) => ({ additions: acc.additions + file.additions, deletions: acc.deletions + file.deletions }),
        { additions: 0, deletions: 0 },
      ),
    }
  }
}

function pick<T>(items: readonly T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length)] as T
}
