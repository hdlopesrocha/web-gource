/**
 * A small in-memory GitHub API used by the tests.
 *
 * It implements just enough of the REST shape (`/repos/:o/:r`,
 * `/repos/:o/:r/commits`, `/repos/:o/:r/commits/:sha`) to exercise pagination,
 * rate limiting and error handling without touching the network.
 */

export interface MockFile {
  filename: string
  previous_filename?: string
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied'
  additions?: number
  deletions?: number
}

export interface MockCommit {
  sha: string
  message: string
  author: { name: string; email?: string; login?: string; avatar_url?: string }
  date: string
  parents?: string[]
  files?: MockFile[]
  /** When set, the detail request for this commit fails with this status. */
  detailStatus?: number
  /** When true the detail response omits the `files` array entirely. */
  omitFiles?: boolean
}

export interface MockGithubOptions {
  owner?: string
  repo?: string
  /** Commits newest first, as GitHub returns them. */
  commits: MockCommit[]
  /** Remaining anonymous quota reported on every response. */
  rateRemaining?: number
  rateLimit?: number
  /** Paths that should fail with a given status. */
  failures?: { path: RegExp; status: number; body?: string }[]
  /** Make `/commits?page=1` return 409 ("empty repository"). */
  empty?: boolean
  defaultBranch?: string
  /** Artificial latency per request in milliseconds. */
  latencyMs?: number
}

export interface MockRequest {
  url: string
  method: string
  headers: Record<string, string>
}

export interface MockApi {
  fetch: typeof fetch
  requests: MockRequest[]
  /** Count of detail (`/commits/:sha`) requests. */
  detailRequests: () => number
  /** Count of list requests. */
  listRequests: () => number
  /** Adjust the reported quota mid-test. */
  setRateRemaining: (value: number) => void
  /** Replace the commit list (e.g. to simulate new commits). */
  setCommits: (commits: MockCommit[]) => void
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export function createMockGithub(options: MockGithubOptions): MockApi {
  const owner = options.owner ?? 'acme'
  const repo = options.repo ?? 'widget'
  let commits = [...options.commits]
  let rateRemaining = options.rateRemaining ?? 5000
  const requests: MockRequest[] = []

  const rateHeaders = (): Record<string, string> => ({
    'x-ratelimit-limit': String(options.rateLimit ?? 5000),
    'x-ratelimit-remaining': String(Math.max(0, rateRemaining)),
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800),
    'x-ratelimit-resource': 'core',
  })

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const method = init?.method ?? 'GET'
    const headers: Record<string, string> = {}
    const rawHeaders = init?.headers as Record<string, string> | undefined
    if (rawHeaders) for (const [key, value] of Object.entries(rawHeaders)) headers[key.toLowerCase()] = String(value)
    requests.push({ url, method, headers })

    if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs))

    for (const failure of options.failures ?? []) {
      if (failure.path.test(url)) {
        rateRemaining = Math.max(0, rateRemaining - 1)
        return json({ message: failure.body ?? 'Request failed' }, failure.status, rateHeaders())
      }
    }

    if (rateRemaining <= 0) {
      return json({ message: 'API rate limit exceeded' }, 403, rateHeaders())
    }
    rateRemaining -= 1

    const parsed = new URL(url)
    const path = parsed.pathname

    // Repository metadata
    if (path === `/repos/${owner}/${repo}`) {
      if (options.empty) return json({ message: 'Git Repository is empty.' }, 409, rateHeaders())
      return json(
        {
          name: repo,
          full_name: `${owner}/${repo}`,
          owner: { login: owner },
          html_url: `https://github.com/${owner}/${repo}`,
          description: 'Mock repository',
          default_branch: options.defaultBranch ?? 'main',
          size: 1024,
          stargazers_count: 42,
          language: 'TypeScript',
          private: false,
          pushed_at: '2024-01-01T00:00:00Z',
          created_at: '2020-01-01T00:00:00Z',
        },
        200,
        rateHeaders(),
      )
    }

    // Commit detail
    const detailMatch = new RegExp(`^/repos/${owner}/${repo}/commits/([0-9a-f]+)$`).exec(path)
    if (detailMatch) {
      const sha = detailMatch[1]
      const commit = commits.find((entry) => entry.sha === sha)
      if (!commit) return json({ message: 'No commit found for SHA' }, 404, rateHeaders())
      if (commit.detailStatus) {
        return json({ message: 'Mock failure' }, commit.detailStatus, rateHeaders())
      }
      const body: Record<string, unknown> = {
        sha: commit.sha,
        commit: {
          author: { name: commit.author.name, email: commit.author.email, date: commit.date },
          committer: { name: commit.author.name, email: commit.author.email, date: commit.date },
          message: commit.message,
        },
        author: commit.author.login ? { login: commit.author.login, avatar_url: commit.author.avatar_url } : null,
        parents: (commit.parents ?? []).map((parent) => ({ sha: parent })),
      }
      if (commit.files && !commit.omitFiles) {
        body.files = commit.files
        body.stats = {
          additions: commit.files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
          deletions: commit.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
        }
      }
      return json(body, 200, rateHeaders())
    }

    // Commit list
    if (path === `/repos/${owner}/${repo}/commits`) {
      if (options.empty) return json({ message: 'Git Repository is empty.' }, 409, rateHeaders())
      const perPage = Number(parsed.searchParams.get('per_page') ?? '30')
      const page = Number(parsed.searchParams.get('page') ?? '1')
      const start = (page - 1) * perPage
      const slice = commits.slice(start, start + perPage)
      const lastPage = Math.max(1, Math.ceil(commits.length / perPage))
      const body = slice.map((commit) => ({
        sha: commit.sha,
        commit: {
          author: { name: commit.author.name, email: commit.author.email, date: commit.date },
          committer: { name: commit.author.name, email: commit.author.email, date: commit.date },
          message: commit.message,
        },
        author: commit.author.login ? { login: commit.author.login, avatar_url: commit.author.avatar_url } : null,
        parents: (commit.parents ?? []).map((parent) => ({ sha: parent })),
      }))
      const headers = rateHeaders()
      if (page < lastPage) {
        headers.link = [
          `<https://api.github.com/repositories/1/commits?per_page=${perPage}&page=${page + 1}>; rel="next"`,
          `<https://api.github.com/repositories/1/commits?per_page=${perPage}&page=${lastPage}>; rel="last"`,
        ].join(', ')
      }
      return json(body, 200, headers)
    }

    return json({ message: 'Not Found' }, 404, rateHeaders())
  }

  return {
    fetch: fetchImpl,
    requests,
    detailRequests: () => requests.filter((request) => /\/commits\/[0-9a-f]+$/.test(new URL(request.url).pathname)).length,
    listRequests: () => requests.filter((request) => new URL(request.url).pathname.endsWith('/commits')).length,
    setRateRemaining: (value: number) => {
      rateRemaining = value
    },
    setCommits: (next: MockCommit[]) => {
      commits = [...next]
    },
  }
}

/** Deterministic commit generator for large-history tests. */
export function generateCommits(count: number, options: { filesPerCommit?: number; startYear?: number } = {}): MockCommit[] {
  const filesPerCommit = options.filesPerCommit ?? 2
  const start = Date.UTC(options.startYear ?? 2020, 0, 1)
  const commits: MockCommit[] = []
  for (let index = 0; index < count; index += 1) {
    const files: MockFile[] = []
    for (let fileIndex = 0; fileIndex < filesPerCommit; fileIndex += 1) {
      files.push({
        filename: `src/module-${(index * filesPerCommit + fileIndex) % 37}/file-${fileIndex}.ts`,
        status: index % 7 === 0 ? 'added' : 'modified',
        additions: 3 + (index % 11),
        deletions: index % 5,
      })
    }
    commits.push({
      sha: `${index.toString(16).padStart(7, '0')}${'a'.repeat(33)}`.slice(0, 40),
      message: `commit ${index}\n\nbody ${index}`,
      author: { name: `Author ${index % 4}`, email: `author${index % 4}@example.com`, login: `author${index % 4}` },
      date: new Date(start + index * 86_400_000).toISOString(),
      parents: index === 0 ? [] : [`${(index - 1).toString(16).padStart(7, '0')}${'a'.repeat(33)}`.slice(0, 40)],
      files,
    })
  }
  return commits.reverse() // GitHub returns newest first
}
