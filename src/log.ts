export interface Logger {
  info(message: string): void
  warn(message: string): void
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
}

export function redact(value: string): string {
  return value
    .replace(/anu_[A-Za-z0-9._~+/-]+=*/g, 'anu_[redacted]')
    .replace(/anr_[A-Za-z0-9._~+/-]+=*/g, 'anr_[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt redacted]')
}

export function redactingLogger(logger: Logger): Logger {
  return {
    info(message) {
      logger.info(redact(message))
    },
    warn(message) {
      logger.warn(redact(message))
    },
  }
}
