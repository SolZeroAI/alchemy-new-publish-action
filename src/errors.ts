/** Node syscall failures carry a string `code`. Other throws do not. */
export function nodeErrorCode(cause: unknown): string {
  if (!hasNodeErrorCode(cause)) return ""

  return String(cause.code)
}

function hasNodeErrorCode(cause: unknown): cause is { code: unknown } {
  return typeof cause === "object" && cause !== null && "code" in cause
}

/** Failures a publisher can act on. Unexpected bugs stay plain Error instances. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ActionError"
  }
}

export class RegistryError extends ActionError {
  readonly status: number
  readonly code: string | undefined
  readonly retryAfterMs: number | undefined

  constructor(message: string, status: number, code?: string, retryAfterMs?: number) {
    super(message)
    this.name = "RegistryError"
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}
