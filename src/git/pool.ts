/**
 * Run `worker` over `items` with a bounded number of concurrent invocations.
 *
 * Used for per-commit detail requests: GitHub needs one request per commit, so
 * a small pool keeps loading fast without hammering the API (and without
 * triggering secondary rate limits).
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: { signal?: AbortSignal } = {},
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const size = Math.max(1, Math.min(limit, items.length))
  let next = 0

  async function run(): Promise<void> {
    for (;;) {
      if (options.signal?.aborted) return
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: size }, run))
  return results
}
