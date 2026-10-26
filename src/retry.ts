import { RegistryError } from "./errors.ts"
import type { Logger } from "./log.ts"

export type Sleep = (ms: number) => Promise<void>

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504])

function isTransient(cause: unknown): boolean {
  if (cause instanceof RegistryError) return TRANSIENT_STATUS.has(cause.status)

  if (cause instanceof Error) {
    if (cause.name === "TimeoutError" || cause.name === "AbortError") return true

    return /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(cause.message)
  }

  return false
}

function backoffMs(attempt: number, retryAfterMs?: number): number {
  const exponential = Math.min(15_000, 500 * 2 ** (attempt - 1))
  const jitter = Math.floor(Math.random() * 250)
  const computed = exponential + jitter

  if (retryAfterMs !== undefined && retryAfterMs > computed) return retryAfterMs

  return computed
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  log: Logger,
  sleepFn: Sleep = sleep,
  maxAttempts = 5,
): Promise<T> {
  let last: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      last = error

      if (!isTransient(error) || attempt === maxAttempts) throw error
      const retryAfter = error instanceof RegistryError ? error.retryAfterMs : undefined
      const delay = backoffMs(attempt, retryAfter)
      const message = error instanceof Error ? error.message : String(error)
      log.info(
        `Retrying ${label} after a transient error (attempt ${attempt} of ${maxAttempts - 1} retries, waiting ${delay}ms): ${message}`,
      )
      await sleepFn(delay)
    }
  }

  throw last
}
