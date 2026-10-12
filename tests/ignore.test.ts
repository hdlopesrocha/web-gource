import { describe, expect, it } from 'vitest'
import {
  COMMON_IGNORED_FOLDERS,
  HIDDEN_FOLDER_EXAMPLES,
  hasHiddenFolder,
  addIgnoredFolder,
  compileIgnoredFolders,
  directorySegments,
  normaliseIgnoreEntry,
  normaliseIgnoredFolders,
  removeIgnoredFolder,
} from '../src/timeline/ignore'

/**
 * Folder ignore list: entries match a *folder* at any depth, case-insensitively,
 * and never a file name. Globs and path prefixes are supported.
 */

describe('normaliseIgnoreEntry', () => {
  it('trims, strips separators and accepts backslashes', () => {
    expect(normaliseIgnoreEntry('  third_party  ')).toBe('third_party')
    expect(normaliseIgnoreEntry('./vendor/')).toBe('vendor')
    expect(normaliseIgnoreEntry('/node_modules')).toBe('node_modules')
    expect(normaliseIgnoreEntry('src\\third_party\\')).toBe('src/third_party')
    expect(normaliseIgnoreEntry('a//b')).toBe('a/b')
    expect(normaliseIgnoreEntry('   ')).toBe('')
  })

  it('deduplicates case-insensitively and keeps the first spelling', () => {
    expect(normaliseIgnoredFolders(['Vendor', 'vendor', ' vendor ', 'third_party'])).toEqual(['Vendor', 'third_party'])
    expect(normaliseIgnoredFolders(['', '   '])).toEqual([])
  })
})

describe('directorySegments', () => {
  it('lists only the folders of a path', () => {
    expect(directorySegments('src/third_party/lib/x.ts')).toEqual(['src', 'third_party', 'lib'])
    expect(directorySegments('src/third_party')).toEqual(['src'])
    expect(directorySegments('file.ts')).toEqual([])
    expect(directorySegments('')).toEqual([])
  })
})

describe('compileIgnoredFolders', () => {
  it('is inactive for an empty list', () => {
    const matcher = compileIgnoredFolders([])
    expect(matcher.active).toBe(false)
    expect(matcher.matches('third_party/lib/x.ts')).toBe(false)
  })

  it('matches a folder name at any depth, ignoring case', () => {
    const matcher = compileIgnoredFolders(['third_party'])
    expect(matcher.matches('third_party/lib/x.ts')).toBe(true)
    expect(matcher.matches('libs/Third_Party/x.ts')).toBe(true)
    expect(matcher.matches('a/b/third_party')).toBe(false) // a *file* with that name
    expect(matcher.matches('src/third_party_src/x.ts')).toBe(false)
    expect(matcher.matches('src/other/x.ts')).toBe(false)
  })

  it('never matches a file with the same name', () => {
    const matcher = compileIgnoredFolders(['vendor'])
    // `vendor` here is a file, so nothing is hidden.
    expect(matcher.matches('src/vendor')).toBe(false)
    expect(matcher.matches('src/vendor.ts')).toBe(false)
  })

  it('supports globs and path prefixes', () => {
    const glob = compileIgnoredFolders(['third*'])
    expect(glob.matches('third_party/x.ts')).toBe(true)
    expect(glob.matches('vendor/third-party/x.ts')).toBe(true)
    expect(glob.matches('vendor/x.ts')).toBe(false)

    const prefix = compileIgnoredFolders(['src/generated'])
    expect(prefix.matches('src/generated/api.ts')).toBe(true)
    expect(prefix.matches('other/src/generated/api.ts')).toBe(false)
    expect(prefix.matches('src/generated-extra/api.ts')).toBe(false)
  })

  it('handles several entries at once', () => {
    const matcher = compileIgnoredFolders(['node_modules', 'vendor', 'third_party', '*.min.js'])
    expect(matcher.entries).toHaveLength(4)
    expect(matcher.matches('node_modules/a/b.js')).toBe(true)
    expect(matcher.matches('packages/app/vendor/lib.js')).toBe(true)
    // The last segment is the file itself, so the folder entry does not match.
    expect(matcher.matches('src/lang/third_party.rs')).toBe(false)
    expect(matcher.matches('src/lang/third_party/x.rs')).toBe(true)
    // A glob entry only matches folder names, never file names.
    expect(matcher.matches('src/theme.min.js')).toBe(false)
    expect(matcher.matches('src/app.js')).toBe(false)
  })

  it('is a pure function of the path', () => {
    const matcher = compileIgnoredFolders(['build'])
    const paths = ['build/x.ts', 'src/build/y.ts', 'src/builder/z.ts']
    const first = paths.map((path) => matcher.matches(path))
    const second = paths.map((path) => matcher.matches(path))
    expect(second).toEqual(first)
  })
})

describe('hidden folders', () => {
  it('detects dot-prefixed folders at any depth, but not dot-prefixed files', () => {
    expect(hasHiddenFolder('.github/workflows/ci.yml')).toBe(true)
    expect(hasHiddenFolder('packages/app/.cache/bundle.js')).toBe(true)
    expect(hasHiddenFolder('.vscode')).toBe(false) // a *file* with that name
    expect(hasHiddenFolder('.gitignore')).toBe(false)
    expect(hasHiddenFolder('src/app.ts')).toBe(false)
  })

  it('hides hidden folders when asked, and nothing else', () => {
    const matcher = compileIgnoredFolders([], { hiddenFolders: true })
    expect(matcher.active).toBe(true)
    expect(matcher.hiddenFolders).toBe(true)
    expect(matcher.matches('.github/workflows/ci.yml')).toBe(true)
    expect(matcher.matches('src/.cache/tmp.bin')).toBe(true)
    expect(matcher.matches('src/app.ts')).toBe(false)
    // A hidden *file* at the repository root stays visible.
    expect(matcher.matches('.gitignore')).toBe(false)
    expect(matcher.matches('docs/.eslintrc.json')).toBe(false)
  })

  it('leaves everything visible when the option is off', () => {
    const matcher = compileIgnoredFolders([])
    expect(matcher.active).toBe(false)
    expect(matcher.hiddenFolders).toBe(false)
    expect(matcher.matches('.github/workflows/ci.yml')).toBe(false)
  })

  it('combines with the ignore list', () => {
    const matcher = compileIgnoredFolders(['vendor'], { hiddenFolders: true })
    expect(matcher.matches('vendor/lib.js')).toBe(true)
    expect(matcher.matches('.github/workflows/ci.yml')).toBe(true)
    expect(matcher.matches('src/app.ts')).toBe(false)
  })

  it('lists the hidden folders used in hints', () => {
    expect(HIDDEN_FOLDER_EXAMPLES).toContain('.github')
    expect(HIDDEN_FOLDER_EXAMPLES.every((entry) => entry.startsWith('.'))).toBe(true)
  })
})

describe('addIgnoredFolder / removeIgnoredFolder', () => {
  it('adds once and removes case-insensitively', () => {
    let list = addIgnoredFolder([], 'third_party')
    expect(list).toEqual(['third_party'])
    list = addIgnoredFolder(list, ' third_party ')
    expect(list).toEqual(['third_party'])
    list = addIgnoredFolder(list, 'vendor')
    expect(list).toEqual(['third_party', 'vendor'])
    list = removeIgnoredFolder(list, 'THIRD_PARTY')
    expect(list).toEqual(['vendor'])
  })

  it('suggests common vendored folders', () => {
    expect(COMMON_IGNORED_FOLDERS).toContain('node_modules')
    expect(COMMON_IGNORED_FOLDERS).toContain('third_party')
  })
})
