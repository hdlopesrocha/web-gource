/**
 * Folder ignore list.
 *
 * A repository often contains trees nobody wants to watch: vendored
 * dependencies, generated output, third-party code. An entry matches a *folder*
 * (never a file name), at any depth, case-insensitively:
 *
 *   `third_party`      any folder called `third_party`
 *   `third_party*`     a glob against a folder name
 *   `src/third_party`  a path prefix
 *
 * Every entry is normalised (trimmed, forward slashes, no leading `./` or
 * slashes, no empty duplicates), so the same list behaves identically on every
 * host and both URL-style separators are accepted.
 */

/** Names that are almost always vendored or generated, offered as suggestions. */
export const COMMON_IGNORED_FOLDERS = [
  'node_modules',
  'vendor',
  'third_party',
  'bower_components',
  'dist',
  'build',
  'target',
  'external',
]

/** Trim and canonicalise one entry. Returns an empty string when unusable. */
export function normaliseIgnoreEntry(entry: string): string {
  let value = entry.trim().replace(/\\/g, '/')
  value = value.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  return value.replace(/\/{2,}/g, '/')
}

/** Normalise an ignore list, dropping blanks and duplicates (case-insensitively). */
export function normaliseIgnoredFolders(entries: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const clean = normaliseIgnoreEntry(entry)
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(clean)
  }
  return result
}

/** Directory segments of a path, lowercased. The file name itself is excluded. */
export function directorySegments(path: string): string[] {
  const slash = path.lastIndexOf('/')
  if (slash <= 0) return []
  return path.slice(0, slash).toLowerCase().split('/').filter(Boolean)
}

/** `*` and `?` are scoped to a single folder name. */
function globToRegExp(pattern: string): RegExp {
  let source = '^'
  for (const char of pattern) {
    if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${source}$`, 'i')
}

export interface FolderIgnoreMatcher {
  /** Normalised entries, in the order they were given. */
  readonly entries: string[]
  /** True when the list hides anything at all. */
  readonly active: boolean
  /** True when the path lives inside an ignored folder. */
  matches(path: string): boolean
}

/**
 * Compile an ignore list into a path predicate.
 *
 * The predicate is a pure function of the path (no state, no ordering), so it
 * can be applied while a timeline is rebuilt and gives the same result for the
 * same history and list.
 */
export function compileIgnoredFolders(entries: readonly string[]): FolderIgnoreMatcher {
  const normalised = normaliseIgnoredFolders(entries)
  const rules: ((path: string, segments: string[]) => boolean)[] = normalised.map((entry) => {
    if (entry.includes('/')) {
      const prefix = `${entry.toLowerCase()}/`
      return (path: string) => path.toLowerCase().startsWith(prefix)
    }
    if (entry.includes('*') || entry.includes('?')) {
      const pattern = globToRegExp(entry)
      return (_path: string, segments: string[]) => segments.some((segment) => pattern.test(segment))
    }
    const name = entry.toLowerCase()
    return (_path: string, segments: string[]) => segments.some((segment) => segment === name)
  })

  return {
    entries: normalised,
    active: rules.length > 0,
    matches(path: string): boolean {
      if (rules.length === 0) return false
      const trimmed = path.trim()
      if (!trimmed) return false
      const segments = directorySegments(trimmed)
      return rules.some((rule) => rule(trimmed, segments))
    },
  }
}

/** Add an entry (if new) and return the new normalised list. */
export function addIgnoredFolder(entries: readonly string[], entry: string): string[] {
  return normaliseIgnoredFolders([...entries, entry])
}

/** Remove an entry (case-insensitively) and return the new normalised list. */
export function removeIgnoredFolder(entries: readonly string[], entry: string): string[] {
  const key = normaliseIgnoreEntry(entry).toLowerCase()
  return normaliseIgnoredFolders(entries).filter((value) => value.toLowerCase() !== key)
}
