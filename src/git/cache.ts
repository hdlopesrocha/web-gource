/**
 * Two-level cache (memory + IndexedDB) for API payloads.
 *
 * Commit objects are immutable for a given SHA, so caching them is safe and
 * makes reloading the same repository dramatically cheaper — this matters a lot
 * for unauthenticated GitHub usage where the quota is only 60 requests/hour.
 *
 * The cache degrades to a no-op when IndexedDB is unavailable (private
 * browsing, restricted contexts) and never throws into the caller.
 */

interface CacheRecord<T> {
  key: string
  value: T
  /** Epoch ms after which the entry is stale, or `undefined` for immutable. */
  expiresAt?: number
}

const DB_NAME = 'web-gource'
const DB_VERSION = 1
const STORE = 'api-cache'

export class ApiCache {
  private memory = new Map<string, CacheRecord<unknown>>()
  private db: IDBDatabase | null = null
  private dbPromise: Promise<IDBDatabase | null> | null = null
  private available = true

  /** Statistics for the loading UI. */
  hits = 0
  misses = 0

  private openDb(): Promise<IDBDatabase | null> {
    if (this.db) return Promise.resolve(this.db)
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') {
          this.available = false
          resolve(null)
          return
        }
        let request: IDBOpenDBRequest
        try {
          request = indexedDB.open(DB_NAME, DB_VERSION)
        } catch {
          this.available = false
          resolve(null)
          return
        }
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
        }
        request.onsuccess = () => {
          this.db = request.result
          resolve(request.result)
        }
        request.onerror = () => {
          this.available = false
          resolve(null)
        }
        request.onblocked = () => resolve(null)
      })
    }
    return this.dbPromise
  }

  async get<T>(key: string): Promise<T | undefined> {
    const mem = this.memory.get(key)
    if (mem && !isExpired(mem)) {
      this.hits += 1
      return mem.value as T
    }
    const db = await this.openDb()
    if (!db) {
      this.misses += 1
      return undefined
    }
    const record = await new Promise<CacheRecord<T> | undefined>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readonly')
        const request = tx.objectStore(STORE).get(key)
        request.onsuccess = () => resolve(request.result as CacheRecord<T> | undefined)
        request.onerror = () => resolve(undefined)
      } catch {
        resolve(undefined)
      }
    })
    if (record && !isExpired(record)) {
      this.memory.set(key, record)
      this.hits += 1
      return record.value
    }
    this.misses += 1
    return undefined
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const record: CacheRecord<T> = { key, value }
    if (ttlMs !== undefined) record.expiresAt = Date.now() + ttlMs
    this.memory.set(key, record)
    const db = await this.openDb()
    if (!db) return
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(record)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.memory.keys()]) {
      if (key.startsWith(prefix)) this.memory.delete(key)
    }
    const db = await this.openDb()
    if (!db) return
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        const request = store.openCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          if (String(cursor.key).startsWith(prefix)) cursor.delete()
          cursor.continue()
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
      } catch {
        resolve()
      }
    })
  }

  get isPersistent(): boolean {
    return this.available
  }
}

function isExpired(record: CacheRecord<unknown>): boolean {
  return record.expiresAt !== undefined && record.expiresAt < Date.now()
}

/** Shared cache instance for the whole app. */
export const apiCache = new ApiCache()
