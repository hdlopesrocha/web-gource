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

const COMMIT_VERBS = ['fix', 'feat', 'refactor', 'docs', 'test', 'perf'] as const
const DAY_MS = 86_400_000

interface DemoSizeProfile {
  /** Smallest files in this project, in bytes. */
  base: number
  /** Extra bytes at the top of the skewed distribution. */
  spread: number
  /** Higher powers make most files small and a few very large. */
  power: number
  /** Random byte range added after the skew. */
  jitter: number
}

interface DemoProfile {
  /** Repository name segment, e.g. `aurora-ui`. */
  repo: string
  description: string
  language: string
  stars: number
  commits: number
  /** Length of the fictional history ending at {@link DEMO_END}. */
  spanDays: number
  /** Top-level directories (some contain slashes, e.g. `apps/web`). */
  roots: readonly string[]
  /** Second-level directories used in deeper trees. */
  leaves: readonly string[]
  extensions: readonly string[]
  topics: readonly string[]
  hiddenDirs: readonly string[]
  /** Maximum number of files touched by one commit. */
  maxChanges: number
  size: DemoSizeProfile
}

const DEMO_END = Date.UTC(2024, 0, 1)

/**
 * Three deliberately different fictional products: a front end, an API and a
 * rendering engine. Their trees, languages, commit subjects and file-size
 * distributions are disjoint, so a multi-project demo never looks like the same
 * repository repeated three times.
 */
const DEMO_PROFILES: readonly DemoProfile[] = [
  {
    repo: 'aurora-ui',
    description: 'Synthetic design-system and dashboard front end used for the multi-project demo.',
    language: 'TypeScript / Vue',
    stars: 2840,
    commits: 420,
    spanDays: 1092,
    roots: ['apps/web', 'apps/docs', 'packages/ui', 'packages/tokens', 'design', 'public', 'tests'],
    leaves: ['src', 'components', 'composables', 'pages', 'stories', 'fixtures'],
    extensions: ['ts', 'tsx', 'vue', 'css', 'scss', 'svg', 'md', 'json'],
    topics: ['button', 'dialog', 'theme', 'layout', 'chart', 'form', 'table', 'icon', 'toast', 'nav', 'color', 'motion'],
    hiddenDirs: ['.storybook', '.github/workflows', '.vscode'],
    maxChanges: 4,
    size: { base: 90, spread: 90_000, power: 3.2, jitter: 3_000 },
  },
  {
    repo: 'atlas-api',
    description: 'Synthetic multi-tenant billing and identity API used for the multi-project demo.',
    language: 'Go',
    stars: 1760,
    commits: 480,
    spanDays: 1248,
    roots: ['cmd', 'internal', 'pkg', 'proto', 'migrations', 'deploy', 'tests'],
    leaves: ['server', 'store', 'auth', 'queue', 'handlers', 'models', 'scripts'],
    extensions: ['go', 'proto', 'sql', 'yaml', 'json', 'md', 'sh', 'toml'],
    topics: ['auth', 'billing', 'account', 'session', 'webhook', 'job', 'cache', 'ledger', 'tenant', 'gateway', 'schema', 'audit'],
    hiddenDirs: ['.github/workflows', '.vscode', '.config'],
    maxChanges: 5,
    size: { base: 700, spread: 160_000, power: 2, jitter: 8_000 },
  },
  {
    repo: 'forge-engine',
    description: 'Synthetic real-time rendering and physics engine used for the multi-project demo.',
    language: 'Rust / WGSL',
    stars: 5310,
    commits: 360,
    spanDays: 936,
    roots: ['engine', 'render', 'physics', 'assets', 'shaders', 'tools', 'benchmarks', 'third_party'],
    leaves: ['core', 'gpu', 'scene', 'math', 'textures', 'vulkan', 'tests', 'examples'],
    extensions: ['rs', 'wgsl', 'glsl', 'toml', 'bin', 'png', 'exr', 'md'],
    topics: ['texture', 'pipeline', 'shader', 'mesh', 'lighting', 'shadow', 'camera', 'physics', 'buffer', 'swapchain', 'material', 'postfx'],
    hiddenDirs: ['.github/workflows', '.cargo', '.config'],
    maxChanges: 3,
    size: { base: 6_000, spread: 2_200_000, power: 1.5, jitter: 24_000 },
  },
]

/** Inputs shown by the landing page's synthetic demo button. */
export const DEMO_REPOSITORIES: readonly string[] = DEMO_PROFILES.map((profile) => `demo/${profile.repo}`)

const PROFILES_BY_REPO = new Map(DEMO_PROFILES.map((profile) => [profile.repo, profile]))

/** Fallback for ad-hoc `demo/anything` URLs outside the curated sample. */
const DEFAULT_PROFILE: DemoProfile = {
  repo: 'synthetic-repository',
  description: 'Synthetic repository generated in the browser for demonstration purposes.',
  language: 'TypeScript',
  stars: 128,
  commits: 420,
  spanDays: 1092,
  roots: ['core', 'ui', 'api', 'docs', 'tests', 'build', 'vendor', 'plugins', 'net', 'storage'],
  leaves: ['src', 'lib', 'components', 'utils', 'models', 'hooks'],
  extensions: ['ts', 'tsx', 'js', 'vue', 'css', 'md', 'json', 'py', 'go', 'rs', 'sh', 'yml'],
  topics: ['parser', 'renderer', 'cache', 'client', 'server', 'schema', 'router', 'store', 'logger', 'config', 'auth', 'stream'],
  hiddenDirs: ['.github/workflows', '.vscode', '.husky', '.config'],
  maxChanges: 5,
  size: { base: 120, spread: 260_000, power: 3, jitter: 4_000 },
}

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

function pick<T>(items: readonly T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length)] as T
}

export class DemoProvider implements GitProvider {
  readonly id = 'demo'
  readonly name = 'Demo (synthetic data)'
  readonly supportsAnonymous = true
  readonly notes = 'Generates three fictional repository histories in the browser. No network requests, no real repository data.'

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
    const profile = this.profileFor(repo)
    const total = this.totalFor(profile)
    return {
      provider: this.id,
      owner: repo.owner,
      name: repo.repo,
      fullName: `${repo.owner}/${repo.repo}`,
      htmlUrl: repo.htmlUrl,
      description: profile.description,
      defaultBranch: 'main',
      isPrivate: false,
      stars: profile.stars,
      language: profile.language,
      commitCountEstimate: total,
    }
  }

  async loadCommitPage(repo: ParsedRepoUrl, options: LoadPageOptions): Promise<CommitPage> {
    const page = Number(/^p(\d+)$/.exec(options.cursor ?? 'p1')?.[1] ?? 1)
    const perPage = Math.max(1, Math.min(100, options.limit ?? 100))
    const profile = this.profileFor(repo)
    const seed = this.seedFor(repo)
    const total = this.totalFor(profile)

    const commits: RawCommit[] = []
    for (let i = 0; i < perPage; i += 1) {
      const index = (page - 1) * perPage + i
      if (index >= total) break
      commits.push(this.generateCommit(seed, total - 1 - index, total, profile))
    }
    const next = page * perPage < total ? `p${page + 1}` : null
    options.onProgress?.({ requestCount: 1, authenticated: false, rateRemaining: 1000, rateLimit: 1000 })
    // Simulate a little latency so the loading UI is exercised.
    await new Promise((resolve) => setTimeout(resolve, 60))
    return { commits, next, totalCount: total }
  }

  /**
   * Synthetic file sizes: the demo has no real blobs, so it derives a stable
   * size per path (clearly labelled `synthetic` in the UI). Each project has a
   * different distribution, from small UI components to large engine assets.
   */
  async fetchFileSizes(repo: ParsedRepoUrl): Promise<FileSizeResult | null> {
    const profile = this.profileFor(repo)
    const seed = this.seedFor(repo)
    const total = this.totalFor(profile)
    const sizes = new Map<string, number>()
    for (let index = 0; index < total; index += 1) {
      const commit = this.generateCommit(seed, index, total, profile)
      for (const file of commit.files ?? []) {
        if (sizes.has(file.path)) continue
        const rand = mulberry32(fnv1a(`${seed}:${file.path}`))
        const bytes = Math.round(
          profile.size.base +
            Math.pow(rand(), profile.size.power) * profile.size.spread +
            rand() * profile.size.jitter,
        )
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
    const profile = this.profileFor(repo)
    const seed = this.seedFor(repo)
    const total = this.totalFor(profile)
    const perPage = Math.max(1, Math.min(100, options.limit ?? 100))
    const firstPageCount = Math.min(perPage, total)
    const commits: RawCommit[] = []
    for (let i = 0; i < firstPageCount; i += 1) commits.push(this.generateCommit(seed, i, total, profile))
    const pages = Math.ceil(total / perPage)
    return { commits, next: pages > 1 ? `p${pages - 1}` : null, totalCount: total }
  }

  /** Build one commit deterministically from its chronological index. */
  private generateCommit(seed: number, chronoIndex: number, total: number, profile: DemoProfile): RawCommit {
    const rand = mulberry32(seed + chronoIndex * 2654435761)
    const authorIndex = Math.floor(rand() * 8)
    const name = FIRST_NAMES[(seed + authorIndex) % FIRST_NAMES.length] as string
    // All histories end around the same date, so a latest-commit snapshot shows
    // the three projects together even though their overall lengths differ.
    const step = total > 1 ? (profile.spanDays * DAY_MS) / (total - 1) : 0
    const start = DEMO_END - profile.spanDays * DAY_MS
    const timestamp = Math.round(start + chronoIndex * step + (rand() - 0.5) * Math.min(DAY_MS, step * 0.4))

    const changeCount = 1 + Math.floor(rand() * profile.maxChanges)
    const files = []
    for (let i = 0; i < changeCount; i += 1) {
      const root = pick(profile.roots, rand)
      const leaf = pick(profile.leaves, rand)
      const topic = pick(profile.topics, rand)
      const ext = pick(profile.extensions, rand)
      const depthRoll = rand()
      const hiddenRoll = rand()
      const dirs = hiddenRoll > 0.94
        ? pick(profile.hiddenDirs, rand)
        : depthRoll > 0.65
          ? `${root}/${leaf}`
          : depthRoll > 0.3
            ? root
            : ''
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
      message: `${pick(profile.topics, rand)}: ${pick(COMMIT_VERBS, rand)} ${pick(profile.topics, rand)} handling`,
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

  private profileFor(repo: ParsedRepoUrl): DemoProfile {
    return PROFILES_BY_REPO.get(repo.repo) ?? DEFAULT_PROFILE
  }

  private seedFor(repo: ParsedRepoUrl): number {
    return this.options.seed ?? Number(repo.params?.seed ?? 1234)
  }

  private totalFor(profile: DemoProfile): number {
    return this.options.commits ?? profile.commits
  }
}
