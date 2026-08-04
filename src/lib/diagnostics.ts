import { isTauri } from "./storage"

function errorType(error: unknown): string {
  if (error instanceof Error && error.name) return error.name
  return "UnknownError"
}

/**
 * Produces a report that is safe to share: it intentionally excludes error
 * messages, stack traces, vault paths, note contents, and configuration.
 */
export function startupDiagnosticReport(error: unknown, reportedAt = new Date()): string {
  return [
    "Amby diagnostic report",
    `reported_at: ${reportedAt.toISOString()}`,
    `runtime: ${isTauri() ? "tauri" : "browser"}`,
    `build_mode: ${import.meta.env.MODE}`,
    `error_type: ${errorType(error)}`,
    "included_data: application runtime metadata only",
    "excluded_data: note content, vault paths, credentials, settings, and stack traces",
  ].join("\n")
}
