import { getLogEntries } from "./logger"
import { sanitizeError } from "./debug/privacy"
import { createDebugReport } from "./debug/report"

/**
 * Produces a report that is safe to share: it intentionally excludes error
 * messages, stack traces, vault paths, note contents, and configuration.
 */
export function startupDiagnosticReport(error: unknown, reportedAt = new Date()): string {
  return createDebugReport({
    events: [
      ...getLogEntries(),
      {
        id: crypto.randomUUID(),
        timestamp: reportedAt.toISOString(),
        level: "error",
        event: "startup.failure",
        source: "frontend",
        subsystem: "startup",
        metadata: { errorType: sanitizeError(error) },
      },
    ],
    health: null,
    now: reportedAt,
  })
}
