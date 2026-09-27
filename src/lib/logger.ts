import {
  appendDebugEvents,
  clearDebugLogs,
  configureDebug as configureBackendDebug,
  flushDebugLogs,
  getDebugEvents,
  getDebugHistory,
  getDebugStatus,
  isTauri,
} from "./storage"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { sanitizeDebugEvent, sanitizeError, sanitizeLogMetadata } from "./debug/privacy"
import type {
  DebugBackendStatus,
  DebugConfig,
  DebugEvent,
  DebugOperationContext,
  LogEntry,
  LogLevel,
  LogMetadata,
} from "./debug/types"

export type {
  DebugBackendStatus,
  DebugConfig,
  DebugEvent,
  DebugOperationContext,
  LogEntry,
  LogLevel,
  LogMetadata,
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const MAX_LOG_BUFFER_SIZE = 1000
const MAX_TRANSPORT_QUEUE = 2000
const BATCH_SIZE = 100
const MAX_RETRIES = 3

const randomId = (prefix: string): string => {
  const cryptoApi = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto : null
  const value = cryptoApi
    ? cryptoApi.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
        const random = Math.floor(Math.random() * 16)
        return (char === "x" ? random : (random & 0x3) | 0x8).toString(16)
      })
  return `${prefix}_${value}`
}

const logBuffer: LogEntry[] = []
const entryListeners = new Set<(entry: LogEntry) => void>()
const changeListeners = new Set<() => void>()
const seenIds = new Set<string>()
let dropped = 0
let clearRevision = 0
let pendingEvents: DebugEvent[] = []
let deliveryActive = false
let transportError: string | null = null
let backendStatus: DebugBackendStatus | null = null
let clearGeneration = 0
let configSyncPending = 0
let config: DebugConfig = { enabled: false, logLevel: "info", logToFile: false }
let configSyncChain: Promise<void> = Promise.resolve()
const frontendContext: { sessionId: string; windowId?: string } = {
  sessionId: randomId("fe"),
  windowId: randomId("win"),
}

let nativeWindowLabelResolved = false
function getFrontendContext(): { sessionId: string; windowId?: string } {
  if (isTauri() && !nativeWindowLabelResolved) {
    nativeWindowLabelResolved = true
    try {
      const label = getCurrentWindow().label
      if (["main", "settings", "splash"].includes(label)) frontendContext.windowId = label
    } catch {
      // Use the per-window opaque ID if Tauri does not expose a controlled label.
    }
  }
  return frontendContext
}

function threshold(): number {
  const selected = LEVEL_WEIGHT[config.logLevel]
  return config.enabled ? selected : Math.max(LEVEL_WEIGHT.info, selected)
}

function shouldCapture(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= threshold()
}

function notifyChanged(): void {
  for (const listener of changeListeners) {
    try {
      listener()
    } catch {
      /* observer errors do not affect logging */
    }
  }
}

function notifyEntry(entry: DebugEvent): void {
  for (const listener of entryListeners) {
    try {
      listener(entry)
    } catch {
      /* observer errors do not affect logging */
    }
  }
  notifyChanged()
}

function addEntry(entry: DebugEvent, enrichExisting = false): DebugEvent | null {
  if (seenIds.has(entry.id)) {
    if (enrichExisting) {
      const existing = logBuffer.find((candidate) => candidate.id === entry.id)
      if (existing && entry.sequence !== undefined && existing.sequence !== entry.sequence) {
        existing.sequence = entry.sequence
        notifyChanged()
      }
    }
    return null
  }
  seenIds.add(entry.id)
  if (seenIds.size > MAX_LOG_BUFFER_SIZE * 4) {
    const oldest = seenIds.values().next().value as string | undefined
    if (oldest) seenIds.delete(oldest)
  }
  logBuffer.push(entry)
  if (logBuffer.length > MAX_LOG_BUFFER_SIZE) {
    logBuffer.shift()
    dropped += 1
  }
  notifyEntry(entry)
  return entry
}

function scheduleDelivery(): void {
  if (deliveryActive || configSyncPending > 0 || pendingEvents.length === 0 || !isTauri()) return
  deliveryActive = true
  void deliver()
}

async function deliver(): Promise<void> {
  try {
    while (pendingEvents.length) {
      const batch = pendingEvents.slice(0, BATCH_SIZE)
      const generationAtSend = clearGeneration
      let delivered = false
      for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
        try {
          const accepted = await appendDebugEvents(batch)
          if (generationAtSend === clearGeneration) {
            for (const event of accepted) {
              const clean = sanitizeDebugEvent(event)
              addEntry(clean, true)
            }
          }
          removeQueuedBatch(batch)
          // Backend acknowledges accepted IDs; it may filter records by its active threshold.
          delivered = true
          transportError = null
          break
        } catch {
          transportError = "DEBUG_TRANSPORT_FAILED"
          if (attempt < MAX_RETRIES - 1)
            await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)))
        }
      }
      if (!delivered) {
        if (generationAtSend === clearGeneration) dropped += batch.length
        removeQueuedBatch(batch)
        notifyChanged()
      }
    }
  } finally {
    deliveryActive = false
    notifyChanged()
    if (pendingEvents.length) scheduleDelivery()
  }
}

function enqueue(entry: DebugEvent): void {
  if (!isTauri()) return
  if (pendingEvents.length >= MAX_TRANSPORT_QUEUE) {
    pendingEvents.shift()
    dropped += 1
  }
  pendingEvents.push(entry)
  notifyChanged()
  scheduleDelivery()
}

function removeQueuedBatch(batch: readonly DebugEvent[]): void {
  const ids = new Set(batch.map((entry) => entry.id))
  pendingEvents = pendingEvents.filter((entry) => !ids.has(entry.id))
}

function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  errorCode: string,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout?.()
      reject(new Error(errorCode))
    }, timeoutMs)
  })
  return Promise.race([operation, timedOut]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

function consoleWrite(entry: DebugEvent): void {
  if (LEVEL_WEIGHT[entry.level] < threshold()) return
  const formatted = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.event}`
  const method = console[entry.level]
  method.call(console, formatted, ...(entry.metadata ? [entry.metadata] : []))
}

function write(
  level: LogLevel,
  event: string,
  metadata: LogMetadata = {},
  source: "frontend" | "backend" = "frontend",
  context: DebugOperationContext = {},
): DebugEvent | null {
  if (!shouldCapture(level)) return null
  const meta = sanitizeLogMetadata(metadata)
  const base: DebugEvent = {
    id: randomId("evt"),
    timestamp: new Date().toISOString(),
    level,
    event,
    source,
    ...(meta ? { metadata: meta } : {}),
    ...(context.operationId ? { operationId: context.operationId } : {}),
    ...(context.durationMs !== undefined ? { durationMs: context.durationMs } : {}),
    ...(context.subsystem ? { subsystem: context.subsystem } : {}),
  }
  const clean = sanitizeDebugEvent({ ...base, ...getFrontendContext() })
  consoleWrite(clean)
  addEntry(clean)
  enqueue(clean)
  return clean
}

/** Structured diagnostics. Metadata is filtered before it is copied or serialized. */
export const logger = {
  error: (event: string, metadata?: LogMetadata, context?: DebugOperationContext) =>
    write("error", event, metadata, "frontend", context),
  warn: (event: string, metadata?: LogMetadata, context?: DebugOperationContext) =>
    write("warn", event, metadata, "frontend", context),
  info: (event: string, metadata?: LogMetadata, context?: DebugOperationContext) =>
    write("info", event, metadata, "frontend", context),
  debug: (event: string, metadata?: LogMetadata, context?: DebugOperationContext) =>
    write("debug", event, metadata, "frontend", context),
  record: (
    entry: Omit<LogEntry, "id" | "timestamp"> & { id?: string; timestamp?: string },
    context?: DebugOperationContext,
  ) => {
    const clean = sanitizeDebugEvent({
      ...entry,
      id: entry.id ?? randomId("evt"),
      timestamp: entry.timestamp ?? new Date().toISOString(),
      ...context,
    })
    if (!shouldCapture(clean.level)) return null
    if (seenIds.has(clean.id)) return null
    consoleWrite(clean)
    addEntry(clean)
    enqueue(clean)
    return clean
  },
}

export function configureLogger(newConfig: Partial<DebugConfig>): void {
  const next: DebugConfig = {
    enabled: typeof newConfig.enabled === "boolean" ? newConfig.enabled : config.enabled,
    logLevel:
      newConfig.logLevel && LEVEL_WEIGHT[newConfig.logLevel] !== undefined
        ? newConfig.logLevel
        : config.logLevel,
    logToFile: typeof newConfig.logToFile === "boolean" ? newConfig.logToFile : config.logToFile,
  }
  config = next
  notifyChanged()
  if (isTauri()) {
    configSyncPending += 1
    configSyncChain = configSyncChain.then(async () => {
      try {
        const status = await configureBackendDebug(next)
        backendStatus = status
        transportError = null
        scheduleDelivery()
      } catch {
        transportError = "DEBUG_CONFIG_SYNC_FAILED"
      } finally {
        configSyncPending = Math.max(0, configSyncPending - 1)
        scheduleDelivery()
      }
      notifyChanged()
    })
  } else {
    backendStatus = null
  }
}

export function getLoggerConfig(): Readonly<DebugConfig> {
  return config
}
export function getLogEntries(): LogEntry[] {
  return [...logBuffer]
}

export function clearLogEntries(): void {
  clearRevision += 1
  logBuffer.length = 0
  seenIds.clear()
  dropped = 0
  notifyChanged()
}

export function subscribeToLogs(listener: (entry: LogEntry) => void): () => void {
  entryListeners.add(listener)
  return () => {
    entryListeners.delete(listener)
  }
}

export function subscribeToLogChanges(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

export function getLoggerStatus(): {
  buffered: number
  dropped: number
  clearRevision: number
  pending: number
  transportError: string | null
  backend: DebugBackendStatus | null
} {
  return {
    buffered: logBuffer.length,
    dropped,
    clearRevision,
    pending: pendingEvents.length,
    transportError,
    backend: backendStatus,
  }
}

export function formatLogsForExport(entries: readonly LogEntry[] = logBuffer): string {
  return entries.map((entry) => JSON.stringify(sanitizeDebugEvent(entry))).join("\n")
}

const ANSI_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g")
function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "")
}

/** Compatibility parser for imported legacy log lines. Parsed fields are privacy-filtered. */
export function parseLogLine(raw: string): LogEntry | null {
  if (typeof raw !== "string" || raw.length > 16_384) return null
  const line = stripAnsi(raw).trim()
  if (!line) return null
  const custom = line.match(
    /^\[([^\]]+)\]\s+\[(DEBUG|INFO|WARN|ERROR)\]\s+\[(frontend|backend)\]\s+([^\s{]+)(?:\s+(.*))?$/i,
  )
  if (custom) {
    let metadata: unknown
    if (custom[5]) {
      try {
        metadata = JSON.parse(custom[5])
      } catch {
        metadata = undefined
      }
    }
    return sanitizeDebugEvent({
      id: randomId("legacy"),
      timestamp: custom[1],
      level: custom[2].toLowerCase(),
      source: custom[3].toLowerCase(),
      event: custom[4],
      metadata,
    })
  }
  const tracing = line.match(/^([0-9T:.-]+Z?)\s+(DEBUG|INFO|WARN|ERROR)\s+([^:]+):\s*(.*)$/i)
  if (tracing) {
    const [, timestamp, level, , rest] = tracing
    const eventMatch = rest.match(/event="?([a-z][a-z0-9_.-]*)"?/i)
    const event = eventMatch?.[1] ?? "diagnostic.legacy_event"
    const metadata: Record<string, unknown> = {}
    const fields = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^\s]+))/g
    let match: RegExpExecArray | null
    while ((match = fields.exec(rest)) !== null)
      if (match[1] !== "event") {
        const rawValue = match[2] ?? match[3]
        const normalizedKey = match[1].toLowerCase().replace(/[^a-z0-9]/g, "")
        metadata[match[1]] =
          /^(?:count|items|bytes|durationms|elapsedms|status|attempt|attempts|retries|updatescount|participants|scheduled|inflight|paused|dirty|errors|open|conflicts|livepreview|enabled|dropped|pending|buffered|filebytes|sequence|size|total|successes|failures|rows|columns|documents|files|modules|percent|depth|queue|capacity)$/.test(
            normalizedKey,
          ) && /^-?\d+(?:\.\d+)?$/.test(rawValue)
            ? Number(rawValue)
            : rawValue
      }
    return sanitizeDebugEvent({
      id: randomId("legacy"),
      timestamp,
      level: level.toLowerCase(),
      event,
      source: "backend",
      metadata,
    })
  }
  return sanitizeDebugEvent({
    id: randomId("legacy"),
    timestamp: new Date().toISOString(),
    level: "info",
    event: "diagnostic.legacy_line",
    source: "backend",
  })
}

export function ingestLogLine(raw: string): LogEntry | null {
  if (typeof raw !== "string" || raw.length > 64_000) return null
  const clean = stripAnsi(raw).trim()
  if (!clean) return null
  let last: LogEntry | null = null
  for (const line of clean.split("\n")) {
    const entry = parseLogLine(line)
    if (
      entry &&
      logBuffer.some(
        (existing) =>
          existing.timestamp === entry.timestamp &&
          existing.event === entry.event &&
          existing.source === entry.source,
      )
    )
      continue
    if (entry && addEntry(entry)) last = entry
  }
  return last
}

let backendListenerInitialized = false
let backendListenerGeneration = 0
export async function initBackendLogListener(): Promise<() => void> {
  if (backendListenerInitialized || !isTauri()) return () => {}
  backendListenerInitialized = true
  const generation = ++backendListenerGeneration
  const unlisteners: Array<() => void> = []
  try {
    const { listen } = await import("@tauri-apps/api/event")
    unlisteners.push(
      await listen<DebugEvent>("amby:debug-event", ({ payload }) => {
        const entry = sanitizeDebugEvent(payload)
        if (!shouldCapture(entry.level)) return
        addEntry(entry, true)
      }),
    )
    unlisteners.push(
      await listen("amby:debug-cleared", () => {
        clearGeneration += 1
        pendingEvents = []
        clearLogEntries()
        backendStatus = null
      }),
    )
    return () => {
      for (const stop of unlisteners.splice(0)) stop()
      if (backendListenerGeneration === generation) {
        backendListenerGeneration += 1
        backendListenerInitialized = false
      }
    }
  } catch {
    for (const stop of unlisteners.splice(0)) stop()
    if (backendListenerGeneration === generation) backendListenerInitialized = false
    transportError = "DEBUG_LISTENER_UNAVAILABLE"
    notifyChanged()
    return () => {}
  }
}

/** Compatibility name retained; synchronizes the typed event collector. */
export async function syncBackendLogs(): Promise<void> {
  if (!isTauri()) return
  try {
    const events = await getDebugEvents()
    for (const event of events) {
      const clean = sanitizeDebugEvent(event)
      if (shouldCapture(clean.level)) addEntry(clean, true)
    }
    backendStatus = await getDebugStatus()
    transportError = null
  } catch {
    transportError = "DEBUG_SYNC_FAILED"
  }
  notifyChanged()
}

export async function loadLogHistory(): Promise<LogEntry[]> {
  if (!isTauri()) return []
  try {
    const history = await getDebugHistory()
    for (const event of history) {
      const clean = sanitizeDebugEvent(event)
      if (shouldCapture(clean.level)) addEntry(clean, true)
    }
    backendStatus = await getDebugStatus()
    transportError = null
    notifyChanged()
    return history.map(sanitizeDebugEvent)
  } catch {
    transportError = "DEBUG_HISTORY_UNAVAILABLE"
    notifyChanged()
    return []
  }
}

export async function clearPersistedLogs(): Promise<void> {
  clearGeneration += 1
  pendingEvents = []
  clearLogEntries()
  let timedOut = false
  try {
    await withDeadline(
      (async () => {
        await configSyncChain
        while (deliveryActive) await new Promise((resolve) => setTimeout(resolve, 20))
        await clearDebugLogs()
        backendStatus = await getDebugStatus()
      })(),
      5000,
      "DEBUG_CLEAR_TIMEOUT",
      () => {
        timedOut = true
      },
    )
    transportError = null
    notifyChanged()
  } catch {
    transportError = timedOut ? "DEBUG_CLEAR_TIMEOUT" : "DEBUG_CLEAR_FAILED"
    notifyChanged()
    throw new Error(transportError)
  }
}

export async function flushLogs(): Promise<void> {
  let timedOut = false
  try {
    await withDeadline(
      (async () => {
        await configSyncChain
        scheduleDelivery()
        while (deliveryActive || pendingEvents.length)
          await new Promise((resolve) => setTimeout(resolve, 20))
        await flushDebugLogs()
      })(),
      5000,
      "DEBUG_FLUSH_TIMEOUT",
      () => {
        timedOut = true
      },
    )
    transportError = null
    notifyChanged()
  } catch {
    transportError = timedOut ? "DEBUG_FLUSH_TIMEOUT" : "DEBUG_FLUSH_FAILED"
    notifyChanged()
    throw new Error(transportError)
  }
}

export interface OperationHandle {
  id: string
  succeed(metadata?: LogMetadata): void
  fail(error: unknown): void
}

export interface OperationOptions {
  operationId?: string
  subsystem?: string
}

export function beginOperation(
  event: string,
  metadata: LogMetadata = {},
  context: OperationOptions = {},
): OperationHandle {
  const id = context.operationId ?? randomId("op")
  const started = performance.now()
  write("debug", `${event}.started`, metadata, "frontend", {
    operationId: id,
    subsystem: context.subsystem,
  })
  let settled = false
  return {
    id,
    succeed: (resultMetadata = {}) => {
      if (settled) return
      settled = true
      write("debug", `${event}.completed`, resultMetadata, "frontend", {
        operationId: id,
        subsystem: context.subsystem,
        durationMs: Math.max(0, performance.now() - started),
      })
    },
    fail: (error) => {
      if (settled) return
      settled = true
      write("error", `${event}.failed`, { errorType: sanitizeError(error) }, "frontend", {
        operationId: id,
        subsystem: context.subsystem,
        durationMs: Math.max(0, performance.now() - started),
      })
    },
  }
}

export async function traceOperation<T>(
  event: string,
  metadata: LogMetadata,
  work: (operationId: string) => Promise<T>,
  context: OperationOptions = {},
): Promise<T> {
  const operation = beginOperation(event, metadata, context)
  try {
    const result = await work(operation.id)
    operation.succeed()
    return result
  } catch (error) {
    operation.fail(error)
    throw error
  }
}

export const errorType = sanitizeError
