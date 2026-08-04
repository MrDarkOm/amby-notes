export type LogLevel = "error" | "warn" | "info" | "debug"

export type LogMetadata = Record<string, boolean | number | string | undefined>

function write(level: LogLevel, event: string, metadata: LogMetadata = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...metadata,
  }
  console[level](entry)
}

/** Structured client-side diagnostics. Never pass note content, paths, or secrets as metadata. */
export const logger = {
  error: (event: string, metadata?: LogMetadata) => write("error", event, metadata),
  warn: (event: string, metadata?: LogMetadata) => write("warn", event, metadata),
  info: (event: string, metadata?: LogMetadata) => write("info", event, metadata),
  debug: (event: string, metadata?: LogMetadata) => write("debug", event, metadata),
}

export function errorType(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UnknownError"
}
