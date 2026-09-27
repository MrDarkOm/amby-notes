import type { DebugEvent, LogLevel, LogMetadata } from "./types"
import { isKnownDebugEvent, isKnownDebugSubsystem } from "./event-codes"

const LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"])
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,47}$/
const STRING_VALUES = new Set([
  "desktop",
  "browser",
  "frontend",
  "backend",
  "debug",
  "info",
  "warn",
  "error",
  "success",
  "failed",
  "started",
  "completed",
  "cancelled",
  "timeout",
  "unknown",
  "source",
  "live-preview",
  "conflict",
  "clean",
  "dirty",
  "idle",
  "running",
  "paused",
  "enabled",
  "disabled",
  "safe",
  "unsafe",
  "ready",
  "unavailable",
  "true",
  "false",
  "error",
  "typeerror",
  "rangeerror",
  "syntaxerror",
  "referenceerror",
  "urierror",
  "evalerror",
])
const COUNTER_KEYS = new Set([
  "count",
  "items",
  "bytes",
  "durationms",
  "elapsedms",
  "status",
  "attempt",
  "attempts",
  "retries",
  "updatescount",
  "participants",
  "scheduled",
  "inflight",
  "paused",
  "dirty",
  "errors",
  "open",
  "conflicts",
  "source",
  "livepreview",
  "enabled",
  "dropped",
  "pending",
  "buffered",
  "filebytes",
  "sequence",
  "size",
  "total",
  "successes",
  "failures",
  "rows",
  "columns",
  "documents",
  "files",
  "modules",
  "percent",
  "depth",
  "queue",
  "capacity",
])
const IDENTITY_NAMES = new Set([
  "id",
  "identity",
  "documentid",
  "fileid",
  "noteid",
  "databaseid",
  "propertyid",
  "operationid",
  "entityid",
  "snapshotid",
])
const SECRET_KEY =
  /title|name|path|query|value|body|content|prompt|credential|token|apikey|message|raw|line|stack|secret|password|note/i
const ENUM_KEYS = new Set([
  "runtime",
  "state",
  "status",
  "reason",
  "mode",
  "outcome",
  "kind",
  "direction",
  "action",
  "phase",
  "source",
  "level",
  "eventtype",
  "errortype",
  "code",
  "subsystem",
  "operation",
  "result",
  "reasoncode",
])
const ERROR_CODES = new Set([
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
])
const GENERIC_CODES = new Set([
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
])
function randomUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16)
    return (char === "x" ? random : (random & 0x3) | 0x8).toString(16)
  })
}

function newEventId(): string {
  return `evt_${randomUuid()}`
}

const PSEUDONYM_SALT = `session:${randomUuid()}`

function pseudonymize(value: string): string {
  if (/^id_[0-9a-f]{16}$/.test(value)) return value
  const mask = 0xffff_ffff_ffff_ffffn
  let hash = 0xcbf29ce484222325n
  const salted = `${PSEUDONYM_SALT}:${value}`
  for (let index = 0; index < salted.length; index += 1) {
    hash ^= BigInt(salted.charCodeAt(index))
    hash = (hash * 0x100000001b3n) & mask
  }
  return `id_${hash.toString(16).padStart(16, "0")}`
}

function safeString(key: string, value: string): string | undefined {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (value.length > 256) return normalizedKey === "errorcode" ? "UnknownError" : undefined
  if (IDENTITY_NAMES.has(normalizedKey)) return pseudonymize(value)
  if (!ENUM_KEYS.has(normalizedKey)) return undefined
  if (SECRET_KEY.test(normalizedKey)) return undefined
  if (
    normalizedKey === "errortype" &&
    [
      "Error",
      "TypeError",
      "RangeError",
      "SyntaxError",
      "ReferenceError",
      "URIError",
      "EvalError",
      "IoError",
      "UnknownError",
    ].includes(value)
  )
    return value
  if (normalizedKey === "errorcode") return ERROR_CODES.has(value) ? value : "UnknownError"
  if ((normalizedKey === "code" || normalizedKey.endsWith("code")) && SAFE_CODE.test(value)) {
    return GENERIC_CODES.has(value) ? value : undefined
  }
  if (STRING_VALUES.has(value.toLowerCase())) return value.toLowerCase()
  return undefined
}

function safeScalar(key: string, value: unknown): string | number | boolean | undefined {
  if (typeof value === "boolean") {
    return COUNTER_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")) ? value : undefined
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) return undefined
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "")
    return COUNTER_KEYS.has(normalizedKey) ? value : undefined
  }
  if (typeof value === "string") return safeString(key, value)
  return undefined
}

/** Copies only allowlisted scalar diagnostics. Never serializes the input object. */
export function sanitizeLogMetadata(metadata: unknown): LogMetadata | undefined {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
  const clean: LogMetadata = Object.create(null) as LogMetadata
  let count = 0
  try {
    for (const key of Object.keys(metadata as object).slice(0, 48)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(key)) continue
      const value = safeScalar(key, (metadata as Record<string, unknown>)[key])
      if (value === undefined) continue
      clean[key] = value
      count += 1
      if (count >= 32) break
    }
  } catch {
    return undefined
  }
  return count ? clean : undefined
}

export function sanitizeError(error: unknown): string {
  try {
    if (error instanceof Error) {
      const builtIn = new Set([
        "Error",
        "TypeError",
        "RangeError",
        "SyntaxError",
        "ReferenceError",
        "URIError",
        "EvalError",
      ])
      return builtIn.has(error.name) ? error.name : "Error"
    }
    if (typeof error === "object" && error !== null && "name" in error) {
      const name = (error as { name?: unknown }).name
      if (
        typeof name === "string" &&
        ["TypeError", "RangeError", "SyntaxError", "ReferenceError"].includes(name)
      )
        return name
    }
  } catch {
    /* treat hostile accessor objects as unknown */
  }
  return "UnknownError"
}

export function sanitizeDebugEvent(input: unknown): DebugEvent {
  try {
    const event = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
    const timestamp =
      typeof event.timestamp === "string" &&
      event.timestamp.length <= 64 &&
      !Number.isNaN(Date.parse(event.timestamp))
        ? new Date(event.timestamp).toISOString()
        : new Date(0).toISOString()
    const level = LEVELS.has(event.level as LogLevel) ? (event.level as LogLevel) : "info"
    const rawEvent = typeof event.event === "string" ? event.event : ""
    const safeEvent =
      rawEvent.length <= 96 && isKnownDebugEvent(rawEvent) ? rawEvent : "diagnostic.invalid_event"
    const source = event.source === "backend" ? "backend" : "frontend"
    const id =
      typeof event.id === "string" &&
      (isOpaqueId(event.id) || /^\d{10,13}-[a-z0-9]{6}$/.test(event.id))
        ? event.id
        : newEventId()
    const output: DebugEvent = { id, timestamp, level, event: safeEvent, source }
    const metadata = sanitizeLogMetadata(event.metadata)
    if (metadata) output.metadata = metadata
    const sessionId =
      typeof event.sessionId === "string" && isOpaqueId(event.sessionId)
        ? event.sessionId
        : undefined
    if (sessionId) output.sessionId = sessionId
    const windowId =
      typeof event.windowId === "string" &&
      (["main", "settings", "splash"].includes(event.windowId) ||
        (isOpaqueId(event.windowId) && event.windowId.startsWith("win_")))
        ? event.windowId
        : undefined
    if (windowId) output.windowId = windowId
    const operationId =
      typeof event.operationId === "string" && isOpaqueId(event.operationId)
        ? event.operationId
        : undefined
    if (operationId) output.operationId = operationId
    const subsystem =
      typeof event.subsystem === "string" && isKnownDebugSubsystem(event.subsystem)
        ? event.subsystem
        : undefined
    if (subsystem) output.subsystem = subsystem
    if (
      typeof event.durationMs === "number" &&
      Number.isFinite(event.durationMs) &&
      event.durationMs >= 0 &&
      event.durationMs <= 86_400_000
    )
      output.durationMs = event.durationMs
    if (
      typeof event.sequence === "number" &&
      Number.isSafeInteger(event.sequence) &&
      event.sequence >= 0
    )
      output.sequence = event.sequence
    return output
  } catch {
    return {
      id: newEventId(),
      timestamp: new Date(0).toISOString(),
      level: "info",
      event: "diagnostic.invalid_event",
      source: "frontend",
    }
  }
}

function isOpaqueId(value: string): boolean {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
  return (
    new RegExp(`^(?:(?:evt|op|fe|win)_)?${uuid}$`, "i").test(value) ||
    /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(value)
  )
}
