import { GitError, isAbortError } from './errors'
import type { ProviderProgress } from './types'

export interface RateLimitSnapshot {
  limit?: number
  remaining?: number
  /** Epoch ms when the window resets. */
  resetAt?: number
  /** `x-ratelimit-resource` (GitHub) — core / search / graphql. */
  resource?: string
  /** Seconds to wait, from `retry-after`. */
  retryAfterSeconds?: number
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  /** Retry attempts for transient failures. Defaults to 3. */
  retries?: number
  /** Milliseconds before the first retry; doubles every attempt. */
  retryDelayMs?: number
  /** Invoked for every response so the caller can track quota consumption. */
  onResponse?: (info: { url: string; status: number; rateLimit: RateLimitSnapshot }) => void
  /** Treat 404 as a normal result for endpoints where absence is expected. */
  allow404?: boolean
}

export interface HttpResponse<T> {
  status: number
  data: T
  url: string
  rateLimit: RateLimitSnapshot
  headers: Headers
}

const RATE_LIMIT_HEADERS = {
  limit: 'x-ratelimit-limit',
  remaining: 'x-ratelimit-remaining',
  reset: 'x-ratelimit-reset',
  resource: 'x-ratelimit-resource',
  retryAfter: 'retry-after',
} as const

export function readRateLimit(headers: Headers): RateLimitSnapshot {
  const num = (v: string | null): number | undefined => {
    if (v === null) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const reset = num(headers.get(RATE_LIMIT_HEADERS.reset))
  const retryAfter = num(headers.get(RATE_LIMIT_HEADERS.retryAfter))
  const snapshot: RateLimitSnapshot = {
    limit: num(headers.get(RATE_LIMIT_HEADERS.limit)),
    remaining: num(headers.get(RATE_LIMIT_HEADERS.remaining)),
    resource: headers.get(RATE_LIMIT_HEADERS.resource) ?? undefined,
  }
  if (reset !== undefined) snapshot.resetAt = reset * 1000
  if (retryAfter !== undefined) {
    snapshot.retryAfterSeconds = retryAfter
    if (snapshot.resetAt === undefined) snapshot.resetAt = Date.now() + retryAfter * 1000
  }
  return snapshot
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GitError('aborted', 'Request aborted', { status: 0 }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new GitError('aborted', 'Request aborted', { status: 0 }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function classifyHttpError(status: number, url: string, rateLimit: RateLimitSnapshot, body: string): GitError {
  const detail = body.slice(0, 300)
  switch (status) {
    case 401:
      return new GitError('auth', 'Authentication failed (401). The token is invalid or expired.', { status })
    case 409:
      // GitHub uses 409 ("Git Repository is empty") for repositories without commits.
      return new GitError(
        'unsupported',
        'This repository is an empty repository: it has no commits to visualize yet.',
        { status },
      )
    case 403:
    case 429: {
      // GitHub uses 403 for both "rate limited" and genuine permission errors.
      const limited = rateLimit.remaining === 0 || status === 429 || /rate limit|abuse/i.test(body)
      if (limited) {
        return new GitError('rate-limit', 'API rate limit exceeded.', {
          status,
          resetAt: rateLimit.resetAt,
          retryable: false,
        })
      }
      return new GitError('private', 'Access forbidden (403). The repository may be private or blocked.', { status })
    }
    case 404:
      return new GitError('not-found', 'Repository or resource not found (404).', { status })
    case 451:
      return new GitError('private', 'Repository unavailable for legal reasons (451).', { status })
    default:
      return new GitError('unknown', `Request failed with status ${status} for ${url}. ${detail}`.trim(), {
        status,
        retryable: status >= 500,
      })
  }
}

/**
 * JSON GET with retries, abort support and rate-limit awareness.
 *
 * Everything the provider layer needs to talk to a REST API goes through here so
 * that retry/backoff/quota logic lives in exactly one place.
 */
export async function requestJson<T>(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
  const retries = options.retries ?? 3
  const baseDelay = options.retryDelayMs ?? 700
  let attempt = 0
  let lastError: unknown

  while (attempt <= retries) {
    let response: Response
    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...options.headers,
        },
        body: options.body,
        signal: options.signal,
      })
    } catch (error) {
      if (isAbortError(error)) throw new GitError('aborted', 'Request aborted', { status: 0, cause: error })
      lastError = error
      attempt += 1
      if (attempt > retries) {
        throw new GitError('network', `Network error while requesting ${url}: ${(error as Error).message}`, {
          retryable: true,
          cause: error,
        })
      }
      await sleep(baseDelay * 2 ** (attempt - 1), options.signal)
      continue
    }

    const rateLimit = readRateLimit(response.headers)
    options.onResponse?.({ url, status: response.status, rateLimit })

    if (options.allow404 && response.status === 404) {
      return { status: 404, data: null as T, url, rateLimit, headers: response.headers }
    }

    if (response.ok) {
      if (response.status === 204) {
        return { status: 204, data: null as T, url, rateLimit, headers: response.headers }
      }
      let data: T
      try {
        data = (await response.json()) as T
      } catch (error) {
        throw new GitError('unknown', `Malformed JSON response from ${url}.`, { status: response.status, cause: error })
      }
      return { status: response.status, data, url, rateLimit, headers: response.headers }
    }

    const body = await response.text().catch(() => '')
    const error = classifyHttpError(response.status, url, rateLimit, body)

    const transient = response.status >= 500 || response.status === 429
    if (!transient || attempt >= retries) throw error

    lastError = error
    attempt += 1
    const wait =
      rateLimit.retryAfterSeconds !== undefined
        ? rateLimit.retryAfterSeconds * 1000
        : baseDelay * 2 ** (attempt - 1)
    await sleep(wait, options.signal)
  }

  throw new GitError('unknown', `Request to ${url} failed: ${String(lastError)}`)
}

/** Helper to build an initial progress object for providers. */
export function emptyProgress(authenticated: boolean): ProviderProgress {
  return { requestCount: 0, authenticated }
}

/** Merge a rate-limit snapshot into a progress object. */
export function mergeRateLimit(progress: ProviderProgress, snapshot: RateLimitSnapshot): ProviderProgress {
  return {
    ...progress,
    rateLimit: snapshot.limit ?? progress.rateLimit,
    rateRemaining: snapshot.remaining ?? progress.rateRemaining,
    rateReset: snapshot.resetAt ?? progress.rateReset,
  }
}
