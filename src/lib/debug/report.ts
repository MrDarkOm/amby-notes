import packageJson from "../../../package.json"
import { sanitizeDebugEvent } from "./privacy"
import type { DebugEvent } from "./types"

const APP_VERSION = typeof packageJson.version === "string" ? packageJson.version : "unknown"
const MAX_EVENTS = 5000
const MAX_DESCRIPTION = 1200
const RECORDING_MARKERS = new Set([
  "reproduction_started",
  "action_performed",
  "issue_observed",
  "reproduction_ended",
])

function sanitizeMarker(value: unknown): string {
  if (typeof value !== "string") return "marker"
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z) ([a-z][a-z0-9_.-]{0,63})$/,
  )
  if (!match || !RECORDING_MARKERS.has(match[2]) || Number.isNaN(Date.parse(match[1])))
    return "marker"
  return `${new Date(match[1]).toISOString()} ${match[2]}`
}
const HEALTH_FIELDS: Record<string, ReadonlySet<string>> = {
  documents: new Set(["open", "dirty", "conflicts", "source", "livePreview"]),
  autosave: new Set(["participants", "scheduled", "inFlight", "paused", "dirty", "errors"]),
  recovery: new Set(["pending", "failed"]),
  modules: new Set(["enabled", "safeMode"]),
}
const SAFE_ERROR_CODES = new Set([
  "UnknownError",
  "FileNotFound",
  "PermissionDenied",
  "AlreadyExists",
  "InvalidData",
  "WriteZero",
  "TimedOut",
  "IoError",
  "QueueFull",
  "WriterUnavailable",
  "FlushTimedOut",
  "LockPoisoned",
  "OperationFailed",
  "SerializeFailed",
  "EventTooLarge",
  "BatchTooLarge",
  "AppDataUnavailable",
  "LogDirectoryUnavailable",
  "OpenFolderFailed",
  "VaultUnavailable",
  "UNKNOWN_ERROR",
  "IO_ERROR",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "INVALID_INPUT",
  "INVALID_PATH",
  "VAULT_NOT_OPEN",
  "CONFLICT",
  "SERIALIZATION_ERROR",
  "DATABASE_ERROR",
  "TIMEOUT",
  "CANCELLED",
  "NETWORK_ERROR",
  "INTERNAL_ERROR",
  "DEBUG_TRANSPORT_FAILED",
  "DEBUG_CONFIG_SYNC_FAILED",
])
const SAFE_EDITOR_REASONS = new Set([
  "unterminated_frontmatter",
  "identity_read_only",
  "inspection_limit",
  "footnotes",
  "reference_links",
  "mixed_line_endings",
  "round_trip_mismatch",
  "source_selected",
  "inspection_failed",
])

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {}
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000
    ? Math.floor(value)
    : undefined
}

function safeTime(value: unknown, fallback: string): string {
  return typeof value === "string" &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : fallback
}

function isSafeRecordingId(value: string): boolean {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
  return (
    new RegExp(`^(?:rec_)?${uuid}$`, "i").test(value) || /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(value)
  )
}

function sanitizeHealth(value: unknown): JsonRecord {
  const input = asRecord(value)
  const result: JsonRecord = {
    runtime:
      input.runtime === "desktop" ? "desktop" : input.runtime === "browser" ? "browser" : "unknown",
    generatedAt: safeTime(input.generatedAt, new Date(0).toISOString()),
  }
  for (const section of [
    "documents",
    "autosave",
    "recovery",
    "modules",
    "editorReasons",
  ] as const) {
    const source = asRecord(input[section])
    const safe: JsonRecord = {}
    for (const [key, entry] of Object.entries(source).slice(0, 48)) {
      if (!/^[a-z][a-zA-Z0-9_]{0,47}$/.test(key)) continue
      if (section === "editorReasons") {
        const count = finiteCount(entry)
        if (count !== undefined && SAFE_EDITOR_REASONS.has(key)) safe[key] = count
      } else if (section === "modules" && key === "safeMode" && typeof entry === "boolean")
        safe[key] = entry
      else {
        if (!HEALTH_FIELDS[section]?.has(key)) continue
        const count = finiteCount(entry)
        if (count !== undefined) safe[key] = count
      }
    }
    result[section] = safe
  }
  const backend = asRecord(input.backend)
  if (Object.keys(backend).length) {
    const backendConfig = asRecord(backend.config)
    result.backend = {
      config: {
        enabled: backendConfig.enabled === true,
        logLevel: ["debug", "info", "warn", "error"].includes(String(backendConfig.logLevel))
          ? backendConfig.logLevel
          : "info",
        logToFile: backendConfig.logToFile === true,
      },
      buffered: finiteCount(backend.buffered) ?? 0,
      dropped: finiteCount(backend.dropped) ?? 0,
      pending: finiteCount(backend.pending) ?? 0,
      fileBytes: finiteCount(backend.fileBytes) ?? 0,
      fileError:
        backend.fileError === null
          ? null
          : typeof backend.fileError === "string" && SAFE_ERROR_CODES.has(backend.fileError)
            ? backend.fileError
            : "UNKNOWN_ERROR",
      watcherRunning: backend.watcherRunning === true,
      indexReady: backend.indexReady === true,
      vaultOpen: backend.vaultOpen === true,
    }
  } else result.backend = null
  return result
}

function sanitizeRecording(value: unknown): JsonRecord | null {
  if (value === null || value === undefined) return null
  const input = asRecord(value)
  const markers = Array.isArray(input.markers)
    ? input.markers.slice(0, 100).map(sanitizeMarker)
    : []
  return {
    id: typeof input.id === "string" && isSafeRecordingId(input.id) ? input.id : "recording",
    startedAt: safeTime(input.startedAt, new Date(0).toISOString()),
    endedAt: input.endedAt === null ? null : safeTime(input.endedAt, new Date(0).toISOString()),
    markers,
    eventCount: finiteCount(input.eventCount) ?? 0,
    dropped: finiteCount(input.dropped) ?? 0,
  }
}

export interface DebugReportOptions {
  events: readonly unknown[]
  health: unknown
  recording?: unknown
  /** Voluntary description supplied by the user, shown verbatim after a clear label. */
  userDescription?: string
  now?: Date
}

export function createDebugReport(options: DebugReportOptions): string {
  const now =
    options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date()
  const events: DebugEvent[] = options.events.slice(-MAX_EVENTS).map(sanitizeDebugEvent)
  const description =
    typeof options.userDescription === "string"
      ? options.userDescription.slice(0, MAX_DESCRIPTION).trim()
      : ""
  const report: JsonRecord = {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    composition: {
      included: [
        "environment",
        "health",
        "sanitizedEvents",
        "recording",
        ...(description ? ["voluntaryDescription"] : []),
      ],
      excluded: ["noteContent", "noteTitles", "rawPaths", "credentials", "rawErrors", "stacks"],
    },
    app: { name: "Amby Notes", version: APP_VERSION },
    environment: {
      runtime:
        typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? "desktop" : "browser",
      buildMode: import.meta.env?.MODE === "production" ? "production" : "development",
    },
    health: sanitizeHealth(options.health),
    recording: sanitizeRecording(options.recording),
    events,
  }
  if (description) report.userDescription = description
  return JSON.stringify(report, null, 2)
}
