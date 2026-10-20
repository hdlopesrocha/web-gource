import { describe, expect, it } from 'vitest'
import { buildTimeline, TimelineBuilder, extensionOf } from '../src/timeline/builder'
import type { RawCommit, RepoInfo } from '../src/git/types'

const repo: RepoInfo = {
  provider: 'github',
  owner: 'acme',
  name: 'widget',
  fullName: 'acme/widget',
  htmlUrl: 'https://github.com/acme/widget',
  defaultBranch: 'main',
  isPrivate: false,
}

function raw(partial: Partial<RawCommit> & { sha: string; timestamp: number }): RawCommit {
  return {
    parents: [],
    message: 'message',
    author: { name: 'Dev', email: 'dev@example.com' },
    files: [],
    ...partial,
  }
}

describe('TimelineBuilder', () => {
  it('sorts commits chronologically regardless of arrival order', () => {
    const builder = new TimelineBuilder(repo)
    builder.addCommits([
      raw({ sha: 'c', timestamp: 3000 }),
      raw({ sha: 'a', timestamp: 1000 }),
      raw({ sha: 'b', timestamp: 2000 }),
    ])
    const timeline = builder.build()
    expect(timeline.commits.map((commit) => commit.sha)).toEqual(['a', 'b', 'c'])
    expect(timeline.commits.map((commit) => commit.index)).toEqual([0, 1, 2])
    expect(timeline.stats.start).toBe(1000)
    expect(timeline.stats.end).toBe(3000)
  })

  it('deduplicates commits by SHA', () => {
    const builder = new TimelineBuilder(repo)
    builder.addCommits([raw({ sha: 'a', timestamp: 1000 })])
    builder.addCommits([raw({ sha: 'a', timestamp: 1000 }), raw({ sha: 'b', timestamp: 2000 })])
    expect(builder.build().commits).toHaveLength(2)
  })

  it('aggregates authors across identities', () => {
    const builder = new TimelineBuilder(repo)
    builder.addCommits([
      raw({
        sha: 'a',
        timestamp: 1000,
        author: { name: 'Ada', email: 'ada@example.com', login: 'ada' },
        stats: { additions: 10, deletions: 2 },
      }),
      raw({
        sha: 'b',
        timestamp: 2000,
        author: { name: 'Ada Lovelace', email: 'ada@example.com', login: 'ada' },
        stats: { additions: 5, deletions: 1 },
      }),
      raw({ sha: 'c', timestamp: 3000, author: { name: 'Unknown Person No Email' } }),
    ])
    const timeline = builder.build()
    expect(timeline.authors).toHaveLength(2)
    const ada = timeline.authors.find((author) => author.login === 'ada')
    expect(ada?.commits).toBe(2)
    expect(ada?.additions).toBe(15)
    expect(ada?.first).toBe(1000)
    expect(ada?.last).toBe(2000)
    const unknown = timeline.authors.find((author) => author.name === 'Unknown Person No Email')
    expect(unknown?.unattributed).toBe(true)
  })

  it('keeps people with a repeated username separate when their emails differ', () => {
    const builder = new TimelineBuilder(repo)
    builder.addCommits([
      raw({
        sha: 'a',
        timestamp: 1000,
        author: { name: 'Ada', email: 'ada@one.example', login: 'ada' },
      }),
      raw({
        sha: 'b',
        timestamp: 2000,
        author: { name: 'Ada', email: 'ada@two.example', login: 'ada' },
      }),
      raw({
        sha: 'c',
        timestamp: 3000,
        author: { name: 'Ada', email: 'ada@one.example', login: 'ada' },
      }),
    ])

    const timeline = builder.build()
    const authors = timeline.authors.filter((author) => author.login === 'ada')
    expect(authors).toHaveLength(2)
    expect(authors.map((author) => author.email).sort()).toEqual(['ada@one.example', 'ada@two.example'])
    expect(authors[0].id).not.toBe(authors[1].id)
    expect(authors[0].colorIndex).not.toBe(authors[1].colorIndex)
    expect(timeline.commits.map((commit) => commit.authorId)).toEqual([
      'login:ada|email:ada@one.example',
      'login:ada|email:ada@two.example',
      'login:ada|email:ada@one.example',
    ])
  })

  it('keeps different usernames separate when they share an email', () => {
    const builder = new TimelineBuilder(repo)
    builder.addCommits([
      raw({
        sha: 'a',
        timestamp: 1000,
        author: { name: 'Ada', email: 'team@example.com', login: 'ada' },
      }),
      raw({
        sha: 'b',
        timestamp: 2000,
        author: { name: 'Grace', email: 'team@example.com', login: 'grace' },
      }),
    ])

    const timeline = builder.build()
    expect(timeline.authors).toHaveLength(2)
    expect(timeline.authors.map((author) => author.login).sort()).toEqual(['ada', 'grace'])
    expect(new Set(timeline.commits.map((commit) => commit.authorId)).size).toBe(2)
  })

  it('normalizes rename, delete and add changes', () => {
    const builder = new TimelineBuilder(repo)
    builder.addCommits([
      raw({
        sha: 'a',
        timestamp: 1000,
        files: [
          { path: 'src/new.ts', previousPath: 'src/old.ts', kind: 'rename', additions: 1, deletions: 1 },
          { path: 'docs/gone.md', kind: 'delete', additions: 0, deletions: 20 },
          { path: 'src/fresh.ts', kind: 'add', additions: 30, deletions: 0 },
          { path: 'src/same.ts', previousPath: 'src/same.ts', kind: 'rename', additions: 0, deletions: 0 },
        ],
      }),
    ])
    const timeline = builder.build()
    const changes = timeline.commits[0].changes
    expect(changes[0]).toMatchObject({ path: 'src/new.ts', from: 'src/old.ts', kind: 'rename' })
    expect(changes[1]).toMatchObject({ path: 'docs/gone.md', kind: 'delete' })
    expect(changes[2]).toMatchObject({ path: 'src/fresh.ts', kind: 'add' })
    // A rename without a different previous path is a modification.
    expect(changes[3]).toMatchObject({ path: 'src/same.ts', kind: 'modify' })
  })

  it('keeps commits without file data and records the reason', () => {
    const builder = new TimelineBuilder(repo)
    builder.addCommits([
      raw({ sha: 'a', timestamp: 1000, files: null, filesMissing: 'rate-limit' }),
      raw({ sha: 'b', timestamp: 2000, files: null, filesMissing: 'merge-parents', parents: ['a', 'x'], isMerge: true }),
      raw({ sha: 'c', timestamp: 3000 }),
    ])
    const timeline = builder.build()
    expect(timeline.stats.withoutFileData).toBe(2)
    expect(timeline.stats.merges).toBe(1)
    expect(timeline.commits[0].filesKnown).toBe(false)
    expect(timeline.commits[0].filesMissingReason).toBe('rate-limit')
    expect(timeline.commits[1].filesMissingReason).toBe('merge-parents')
    expect(timeline.commits[2].filesKnown).toBe(true)
  })

  it('splits messages into subject and body', () => {
    const builder = new TimelineBuilder(repo)
    builder.addCommits([raw({ sha: 'a', timestamp: 1000, message: 'fix: something\n\nLong body\nsecond line' })])
    const timeline = builder.build()
    expect(timeline.commits[0].subject).toBe('fix: something')
    expect(timeline.commits[0].body).toBe('Long body\nsecond line')
  })

  it('handles commits with an empty message', () => {
    const builder = new TimelineBuilder(repo)
    builder.addCommits([raw({ sha: 'a', timestamp: 1000, message: '' })])
    expect(builder.build().commits[0].subject).toBe('(no commit message)')
  })

  it('collects unique paths and extensions for GPU sizing', () => {
    const builder = new TimelineBuilder(repo)
    builder.addCommits([
      raw({
        sha: 'a',
        timestamp: 1000,
        files: [
          { path: 'src/deep/nested/file.ts', kind: 'add', additions: 1, deletions: 0 },
          { path: 'src/other/file.ts', kind: 'add', additions: 1, deletions: 0 },
          { path: 'README.md', kind: 'add', additions: 1, deletions: 0 },
        ],
      }),
    ])
    const timeline = builder.build()
    expect(timeline.stats.files).toBe(3)
    // src, src/deep, src/deep/nested, src/other
    expect(timeline.stats.uniquePaths.dirs).toBe(4)
    expect(timeline.stats.topExtensions[0].extension).toBe('ts')
  })
})

describe('buildTimeline filters', () => {
  it('filters by author and recomputes stats', () => {
    const commits: RawCommit[] = [
      raw({ sha: 'a', timestamp: 1000, author: { name: 'Ada', email: 'ada@x.com' } }),
      raw({ sha: 'b', timestamp: 2000, author: { name: 'Bob', email: 'bob@x.com' } }),
      raw({ sha: 'c', timestamp: 3000, author: { name: 'Ada', email: 'ada@x.com' } }),
    ]
    const timeline = buildTimeline(repo, commits, {
      filter: (commit) => commit.author.email === 'ada@x.com',
    })
    expect(timeline.commits).toHaveLength(2)
    expect(timeline.stats.authors).toBe(1)
    expect(timeline.stats.start).toBe(1000)
    expect(timeline.stats.end).toBe(3000)
  })

  it('drops ignored folders from the file changes and the counters', () => {
    const commits: RawCommit[] = [
      raw({
        sha: 'a',
        timestamp: 1000,
        stats: { additions: 30, deletions: 4 },
        files: [
          { path: 'src/app.ts', kind: 'modify', additions: 10, deletions: 1 },
          { path: 'third_party/lib/dep.ts', kind: 'modify', additions: 20, deletions: 3 },
        ],
      }),
      raw({
        sha: 'b',
        timestamp: 2000,
        files: [
          { path: 'third_party/lib/other.ts', kind: 'add', additions: 5, deletions: 0 },
          { path: 'vendor/x.ts', kind: 'modify', additions: 2, deletions: 2 },
        ],
      }),
    ]
    const ignore = (path: string): boolean => path.startsWith('third_party/') || path.startsWith('vendor/')
    const timeline = buildTimeline(repo, commits, { fileFilter: ignore })

    // Both commits survive: they still carry history, they just lose files.
    expect(timeline.commits).toHaveLength(2)
    expect(timeline.commits[0].changes.map((change) => change.path)).toEqual(['src/app.ts'])
    expect(timeline.commits[1].changes).toEqual([])
    // Counters are recomputed from the remaining changes, never from the total.
    expect(timeline.commits[0].additions).toBe(10)
    expect(timeline.commits[0].deletions).toBe(1)
    expect(timeline.stats.additions).toBe(10)
    expect(timeline.stats.deletions).toBe(1)
    expect(timeline.stats.files).toBe(1)
    expect(timeline.stats.ignoredFileChanges).toBe(3)
    expect(timeline.stats.ignoredFiles).toBe(3)
  })

  it('keeps a rename that moves a file out of an ignored folder, as an addition', () => {
    const commits: RawCommit[] = [
      raw({
        sha: 'a',
        timestamp: 1000,
        files: [
          {
            path: 'src/app.ts',
            previousPath: 'third_party/app.ts',
            kind: 'rename',
            additions: 0,
            deletions: 0,
          },
        ],
      }),
    ]
    const timeline = buildTimeline(repo, commits, { fileFilter: (path) => path.startsWith('third_party/') })
    const change = timeline.commits[0].changes[0]
    // The new path is visible; it appears as an addition because the old path is
    // hidden, so the rename cannot be followed into the ignored tree.
    expect(change.path).toBe('src/app.ts')
    expect(change.from).toBeUndefined()
    expect(change.kind).toBe('add')
    expect(timeline.stats.ignoredFileChanges ?? 0).toBe(0)
  })

  it('drops a rename whose new path is ignored', () => {
    const commits: RawCommit[] = [
      raw({
        sha: 'a',
        timestamp: 1000,
        files: [
          { path: 'third_party/app.ts', previousPath: 'src/app.ts', kind: 'rename', additions: 0, deletions: 0 },
        ],
      }),
    ]
    const timeline = buildTimeline(repo, commits, { fileFilter: (path) => path.startsWith('third_party/') })
    expect(timeline.commits[0].changes).toEqual([])
    expect(timeline.stats.ignoredFileChanges).toBe(1)
  })

  it('leaves everything untouched when no path filter is given', () => {
    const commits: RawCommit[] = [
      raw({
        sha: 'a',
        timestamp: 1000,
        stats: { additions: 7, deletions: 3 },
        files: [{ path: 'third_party/x.ts', kind: 'modify', additions: 4, deletions: 1 }],
      }),
    ]
    const timeline = buildTimeline(repo, commits)
    expect(timeline.commits[0].additions).toBe(7)
    expect(timeline.stats.ignoredFileChanges).toBeUndefined()
    expect(timeline.stats.ignoredFiles).toBeUndefined()
  })

  it('filters by date range', () => {
    const commits: RawCommit[] = [
      raw({ sha: 'a', timestamp: 1000 }),
      raw({ sha: 'b', timestamp: 2000 }),
      raw({ sha: 'c', timestamp: 3000 }),
    ]
    const timeline = buildTimeline(repo, commits, { filter: (commit) => commit.timestamp >= 2000 })
    expect(timeline.commits.map((commit) => commit.sha)).toEqual(['b', 'c'])
  })
})

describe('multi-project scoping', () => {
  const widgetRepo: RepoInfo = { ...repo }
  const gadgetRepo: RepoInfo = {
    ...repo,
    name: 'gadget',
    fullName: 'acme/gadget',
    htmlUrl: 'https://github.com/acme/gadget',
  }
  const projectInputs = [
    { key: 'acme/widget', repo: widgetRepo },
    { key: 'acme/gadget', repo: gadgetRepo },
  ]
  const ada = { name: 'Ada Lovelace', email: 'ada@example.com', login: 'ada' }
  const bob = { name: 'Bob Stone', email: 'bob@example.com', login: 'bob' }

  it('keeps one author instance per project with shared base identity and colour', () => {
    const commits: RawCommit[] = [
      raw({
        sha: 'w1',
        timestamp: 1000,
        projectKey: 'acme/widget',
        projectName: 'acme/widget',
        author: ada,
        stats: { additions: 10, deletions: 2 },
      }),
      raw({
        sha: 'w2',
        timestamp: 3000,
        projectKey: 'acme/widget',
        projectName: 'acme/widget',
        author: ada,
        stats: { additions: 5, deletions: 1 },
      }),
      raw({
        sha: 'g1',
        timestamp: 2000,
        projectKey: 'acme/gadget',
        projectName: 'acme/gadget',
        author: ada,
        stats: { additions: 7, deletions: 3 },
      }),
    ]

    const timeline = buildTimeline(repo, commits, { projects: projectInputs })
    const widgetAda = timeline.authors.find((author) => author.id === 'acme/widget::login:ada|email:ada@example.com')
    const gadgetAda = timeline.authors.find((author) => author.id === 'acme/gadget::login:ada|email:ada@example.com')

    expect(timeline.authors).toHaveLength(2)
    expect(widgetAda).toMatchObject({
      id: 'acme/widget::login:ada|email:ada@example.com',
      baseId: 'login:ada|email:ada@example.com',
      projectKey: 'acme/widget',
      projectName: 'acme/widget',
      commits: 2,
      additions: 15,
      deletions: 3,
      first: 1000,
      last: 3000,
    })
    expect(gadgetAda).toMatchObject({
      id: 'acme/gadget::login:ada|email:ada@example.com',
      baseId: 'login:ada|email:ada@example.com',
      projectKey: 'acme/gadget',
      projectName: 'acme/gadget',
      commits: 1,
      additions: 7,
      deletions: 3,
      first: 2000,
      last: 2000,
    })
    expect(widgetAda?.id).not.toBe(gadgetAda?.id)
    expect(widgetAda?.colorIndex).toBe(gadgetAda?.colorIndex)
    expect(timeline.commits.find((commit) => commit.sha === 'w1')?.authorId).toBe(
      'acme/widget::login:ada|email:ada@example.com',
    )
    expect(timeline.commits.find((commit) => commit.sha === 'g1')?.authorId).toBe(
      'acme/gadget::login:ada|email:ada@example.com',
    )
  })

  it('namespaces file paths, including rename sources', () => {
    const commits: RawCommit[] = [
      raw({
        sha: 'w-rename',
        timestamp: 1000,
        projectKey: 'acme/widget',
        projectName: 'acme/widget',
        files: [
          { path: 'src/new.ts', previousPath: 'src/old.ts', kind: 'rename', additions: 1, deletions: 1 },
          { path: 'README.md', kind: 'add', additions: 2, deletions: 0 },
        ],
      }),
      raw({
        sha: 'g-add',
        timestamp: 2000,
        projectKey: 'acme/gadget',
        projectName: 'acme/gadget',
        files: [{ path: 'src/new.ts', kind: 'add', additions: 3, deletions: 0 }],
      }),
    ]

    const timeline = buildTimeline(repo, commits, { projects: projectInputs })
    const widgetChanges = timeline.commits[0].changes
    const gadgetChange = timeline.commits[1].changes[0]

    expect(widgetChanges[0]).toMatchObject({
      path: 'acme/widget/src/new.ts',
      from: 'acme/widget/src/old.ts',
      kind: 'rename',
    })
    expect(widgetChanges.map((change) => change.path)).toEqual(['acme/widget/src/new.ts', 'acme/widget/README.md'])
    expect(gadgetChange).toMatchObject({ path: 'acme/gadget/src/new.ts', kind: 'add' })
    expect(gadgetChange.from).toBeUndefined()
    // The same repository-relative path in two projects counts as two files.
    expect(timeline.stats.files).toBe(3)
  })

  it('deduplicates SHAs per project while keeping the same SHA across projects', () => {
    const commits: RawCommit[] = [
      raw({
        sha: 'shared',
        timestamp: 1000,
        projectKey: 'acme/widget',
        projectName: 'acme/widget',
        message: 'widget shared',
      }),
      raw({
        sha: 'only-widget',
        timestamp: 1500,
        projectKey: 'acme/widget',
        projectName: 'acme/widget',
        message: 'first copy',
      }),
      raw({
        sha: 'shared',
        timestamp: 2000,
        projectKey: 'acme/gadget',
        projectName: 'acme/gadget',
        message: 'gadget shared',
      }),
      raw({
        sha: 'only-widget',
        timestamp: 2500,
        projectKey: 'acme/widget',
        projectName: 'acme/widget',
        message: 'duplicate copy',
      }),
      raw({
        sha: 'shared',
        timestamp: 3000,
        projectKey: 'acme/widget',
        projectName: 'acme/widget',
        message: 'widget shared duplicate',
      }),
    ]

    const timeline = buildTimeline(repo, commits, { projects: projectInputs })

    expect(timeline.commits.map((commit) => [commit.sha, commit.projectKey])).toEqual([
      ['shared', 'acme/widget'],
      ['only-widget', 'acme/widget'],
      ['shared', 'acme/gadget'],
    ])
    expect(timeline.commits[1].subject).toBe('first copy')
    expect(timeline.commits[0].subject).toBe('widget shared')
    expect(timeline.commits[2].subject).toBe('gadget shared')
    expect(timeline.projects.find((project) => project.key === 'acme/widget')).toMatchObject({
      commits: 2,
      authors: 1,
    })
    expect(timeline.projects.find((project) => project.key === 'acme/gadget')).toMatchObject({
      commits: 1,
      authors: 1,
    })
  })

  it('derives per-project counts and recomputes them after filtering', () => {
    const commits: RawCommit[] = [
      raw({
        sha: 'w1',
        timestamp: 1000,
        projectKey: 'acme/widget',
        projectName: 'acme/widget',
        author: ada,
      }),
      raw({
        sha: 'w2',
        timestamp: 2000,
        projectKey: 'acme/widget',
        projectName: 'acme/widget',
        author: ada,
      }),
      raw({
        sha: 'w3',
        timestamp: 3000,
        projectKey: 'acme/widget',
        projectName: 'acme/widget',
        author: bob,
      }),
      raw({
        sha: 'g1',
        timestamp: 4000,
        projectKey: 'acme/gadget',
        projectName: 'acme/gadget',
        author: ada,
      }),
    ]
    const projects = [
      {
        key: 'acme/widget',
        repo: widgetRepo,
        truncated: true,
        warnings: ['history truncated'],
        sizeSource: 'git-tree',
      },
      { key: 'acme/gadget', repo: gadgetRepo },
    ]

    const timeline = buildTimeline(repo, commits, { projects })
    const widget = timeline.projects.find((project) => project.key === 'acme/widget')
    const gadget = timeline.projects.find((project) => project.key === 'acme/gadget')

    expect(timeline.projects.map((project) => project.key)).toEqual(['acme/widget', 'acme/gadget'])
    expect(widget).toMatchObject({
      repo: widgetRepo,
      commits: 3,
      authors: 2,
      truncated: true,
      warnings: ['history truncated'],
      sizeSource: 'git-tree',
    })
    expect(gadget).toMatchObject({
      repo: gadgetRepo,
      commits: 1,
      authors: 1,
      truncated: false,
      warnings: [],
      sizeSource: 'unavailable',
    })
    // Project author counts are author instances, not unique base identities.
    expect(timeline.stats.commits).toBe(4)
    expect(timeline.stats.authors).toBe(3)

    const filtered = buildTimeline(repo, commits, {
      projects,
      filter: (commit) => commit.projectKey === 'acme/widget' && commit.author.login === 'ada',
    })
    expect(filtered.commits.map((commit) => commit.sha)).toEqual(['w1', 'w2'])
    expect(filtered.stats.commits).toBe(2)
    expect(filtered.stats.authors).toBe(1)
    expect(filtered.projects.find((project) => project.key === 'acme/widget')).toMatchObject({
      commits: 2,
      authors: 1,
    })
    expect(filtered.projects.find((project) => project.key === 'acme/gadget')).toMatchObject({
      commits: 0,
      authors: 0,
    })
  })

  it('keeps legacy single-project output unscoped when no projects are supplied', () => {
    const commits: RawCommit[] = [
      raw({
        sha: 'a',
        timestamp: 1000,
        author: ada,
        files: [
          { path: 'src/new.ts', previousPath: 'src/old.ts', kind: 'rename', additions: 1, deletions: 1 },
        ],
      }),
    ]

    const timeline = buildTimeline(repo, commits)
    const commit = timeline.commits[0]
    const author = timeline.authors[0]

    expect(timeline.projects).toEqual([])
    expect(commit.projectKey).toBeUndefined()
    expect(commit.projectName).toBeUndefined()
    expect(commit.authorId).toBe('login:ada|email:ada@example.com')
    expect(commit.changes[0]).toMatchObject({ path: 'src/new.ts', from: 'src/old.ts', kind: 'rename' })
    expect(author).toMatchObject({
      id: 'login:ada|email:ada@example.com',
      baseId: 'login:ada|email:ada@example.com',
      colorIndex: 0,
    })
    expect(author.projectKey).toBeUndefined()
    expect(author.projectName).toBeUndefined()
    expect(timeline.authorById.get('login:ada|email:ada@example.com')).toBe(author)
  })

  it('shares one colour per person without merging project author rows', () => {
    const commits: RawCommit[] = [
      raw({
        sha: 'w1',
        timestamp: 1000,
        projectKey: 'acme/widget',
        projectName: 'acme/widget',
        author: ada,
      }),
      raw({
        sha: 'g1',
        timestamp: 2000,
        projectKey: 'acme/gadget',
        projectName: 'acme/gadget',
        author: ada,
      }),
      raw({
        sha: 'g2',
        timestamp: 3000,
        projectKey: 'acme/gadget',
        projectName: 'acme/gadget',
        author: bob,
      }),
    ]

    const timeline = buildTimeline(repo, commits, { projects: projectInputs })
    const widgetAda = timeline.authors.find((author) => author.id === 'acme/widget::login:ada|email:ada@example.com')
    const gadgetAda = timeline.authors.find((author) => author.id === 'acme/gadget::login:ada|email:ada@example.com')
    const gadgetBob = timeline.authors.find((author) => author.id === 'acme/gadget::login:bob|email:bob@example.com')

    expect(timeline.authors).toHaveLength(3)
    expect(new Set(timeline.authors.map((author) => author.id)).size).toBe(3)
    expect(widgetAda?.baseId).toBe('login:ada|email:ada@example.com')
    expect(gadgetAda?.baseId).toBe('login:ada|email:ada@example.com')
    expect(widgetAda?.id).not.toBe(gadgetAda?.id)
    expect(widgetAda?.projectKey).toBe('acme/widget')
    expect(gadgetAda?.projectKey).toBe('acme/gadget')
    expect(widgetAda?.colorIndex).toBe(gadgetAda?.colorIndex)
    expect(gadgetBob?.baseId).toBe('login:bob|email:bob@example.com')
    expect(gadgetBob?.id).toBe('acme/gadget::login:bob|email:bob@example.com')
    expect(gadgetBob?.projectKey).toBe('acme/gadget')
    expect(gadgetBob?.colorIndex).not.toBe(widgetAda?.colorIndex)
    expect(timeline.authorById.get('acme/widget::login:ada|email:ada@example.com')).toBe(widgetAda)
    expect(timeline.authorById.get('acme/gadget::login:ada|email:ada@example.com')).toBe(gadgetAda)
    expect(widgetAda).not.toBe(gadgetAda)
  })
})

describe('extensionOf', () => {
  it('extracts extensions', () => {
    expect(extensionOf('src/file.ts')).toBe('ts')
    expect(extensionOf('Dockerfile')).toBe('')
    expect(extensionOf('archive.tar.gz')).toBe('gz')
    expect(extensionOf('src/.hidden')).toBe('')
  })
})
