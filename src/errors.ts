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
