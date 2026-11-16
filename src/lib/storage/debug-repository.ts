import { commands, type DebugEvent as WireDebugEvent } from "../bindings"
import type { DebugBackendStatus, DebugConfig, DebugEvent } from "../debug/types"

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: string }

export type DebugRepositoryRuntime = {
  isNative: () => boolean
  browserStatus?: () => DebugBackendStatus | null
}

let runtime: DebugRepositoryRuntime = { isNative: () => false }
const browserEvents: DebugEvent[] = []
const MAX_BROWSER_EVENTS = 1000

export function configureDebugRepositoryRuntime(next: DebugRepositoryRuntime): void {
  runtime = next
}

/** The backend wire type uses `null` for absent optionals; the frontend type uses `undefined`. */
function fromWire(event: WireDebugEvent): DebugEvent {
  const { metadata, sessionId, windowId, operationId, subsystem, durationMs, sequence, ...rest } =
    event
  return {
    ...rest,
    ...(metadata != null && { metadata }),
    ...(sessionId != null && { sessionId }),
    ...(windowId != null && { windowId }),
    ...(operationId != null && { operationId }),
    ...(subsystem != null && { subsystem }),
    ...(durationMs != null && { durationMs }),
    ...(sequence != null && { sequence }),
  }
}

/** Event metadata is sanitized to JSON values by `debug/privacy` before it reaches storage. */
const toWire = (event: DebugEvent): WireDebugEvent => event as WireDebugEvent

function unwrap<T>(result: Result<T>): T {
  if (result.status === "error") throw new Error(result.error || "DEBUG_COMMAND_FAILED")
  return result.data
}

async function call<T>(method: () => Promise<Result<T>>): Promise<T> {
  return unwrap(await method())
}

export const configureDebug = (config: DebugConfig): Promise<DebugBackendStatus> =>
  runtime.isNative()
    ? call(() => commands.configureDebug(config))
    : Promise.reject(new Error("DEBUG_NATIVE_HISTORY_UNAVAILABLE"))

export const getDebugStatus = (): Promise<DebugBackendStatus | null> =>
  runtime.isNative()
    ? call(() => commands.getDebugStatus())
    : Promise.resolve(runtime.browserStatus?.() ?? null)

export async function appendDebugEvents(events: DebugEvent[]): Promise<DebugEvent[]> {
  if (runtime.isNative())
    return call(() => commands.appendDebugEvents(events.map(toWire))).then((r) => r.map(fromWire))
  for (const event of events) {
    browserEvents.push(event)
    if (browserEvents.length > MAX_BROWSER_EVENTS) browserEvents.shift()
  }
  return events
}

export const getDebugEvents = (): Promise<DebugEvent[]> =>
  runtime.isNative()
    ? call(() => commands.getDebugEvents()).then((r) => r.map(fromWire))
    : Promise.resolve([...browserEvents])

/** Browser mode has no native retained history; callers should surface that explicitly. */
export const getDebugHistory = (): Promise<DebugEvent[]> =>
  runtime.isNative()
    ? call(() => commands.getDebugHistory()).then((r) => r.map(fromWire))
    : Promise.resolve([])

export async function clearDebugLogs(): Promise<void> {
  browserEvents.length = 0
  if (runtime.isNative()) await call(() => commands.clearDebugLogs())
}

export const flushDebugLogs = (): Promise<void> =>
  runtime.isNative()
    ? call(() => commands.flushDebugLogs()).then(() => undefined)
    : Promise.resolve()

export const openDebugLogFolder = (): Promise<void> =>
  runtime.isNative()
    ? call(() => commands.openLogFolder()).then(() => undefined)
    : Promise.reject(new Error("DEBUG_NATIVE_STORAGE_UNAVAILABLE"))

export const toggleDebugDevtools = (): Promise<void> =>
  runtime.isNative()
    ? call(() => commands.toggleDevtools()).then(() => undefined)
    : Promise.reject(new Error("DEBUG_NATIVE_STORAGE_UNAVAILABLE"))
