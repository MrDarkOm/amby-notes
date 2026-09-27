import { commands } from "../bindings"
import type { DebugBackendStatus, DebugConfig, DebugEvent } from "../debug/types"

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: string }
type DebugCommands = {
  configureDebug?: (config: DebugConfig) => Promise<Result<DebugBackendStatus>>
  getDebugStatus?: () => Promise<Result<DebugBackendStatus>>
  appendDebugEvents?: (events: DebugEvent[]) => Promise<Result<DebugEvent[]>>
  getDebugEvents?: () => Promise<Result<DebugEvent[]>>
  getDebugHistory?: () => Promise<Result<DebugEvent[]>>
  clearDebugLogs?: () => Promise<Result<null>>
  flushDebugLogs?: () => Promise<Result<null>>
  openLogFolder?: () => Promise<Result<null>>
  toggleDevtools?: () => Promise<Result<null>>
}

export type DebugRepositoryRuntime = {
  isNative: () => boolean
  browserStatus?: () => DebugBackendStatus | null
}

const commandSet = commands as unknown as DebugCommands
let runtime: DebugRepositoryRuntime = { isNative: () => false }
const browserEvents: DebugEvent[] = []
const MAX_BROWSER_EVENTS = 1000

export function configureDebugRepositoryRuntime(next: DebugRepositoryRuntime): void {
  runtime = next
}

function unwrap<T>(result: Result<T>): T {
  if (result.status === "error") throw new Error(result.error || "DEBUG_COMMAND_FAILED")
  return result.data
}

async function call<T>(method: (() => Promise<Result<T>>) | undefined): Promise<T> {
  if (!method) throw new Error("DEBUG_COMMAND_UNAVAILABLE")
  return unwrap(await method())
}

export const configureDebug = (config: DebugConfig): Promise<DebugBackendStatus> =>
  runtime.isNative()
    ? call(() => commandSet.configureDebug!(config))
    : Promise.reject(new Error("DEBUG_NATIVE_HISTORY_UNAVAILABLE"))

export const getDebugStatus = (): Promise<DebugBackendStatus | null> =>
  runtime.isNative()
    ? call(() => commandSet.getDebugStatus!())
    : Promise.resolve(runtime.browserStatus?.() ?? null)

export async function appendDebugEvents(events: DebugEvent[]): Promise<DebugEvent[]> {
  if (runtime.isNative()) return call(() => commandSet.appendDebugEvents!(events))
  for (const event of events) {
    browserEvents.push(event)
    if (browserEvents.length > MAX_BROWSER_EVENTS) browserEvents.shift()
  }
  return events
}

export const getDebugEvents = (): Promise<DebugEvent[]> =>
  runtime.isNative()
    ? call(() => commandSet.getDebugEvents!())
    : Promise.resolve([...browserEvents])

/** Browser mode has no native retained history; callers should surface that explicitly. */
export const getDebugHistory = (): Promise<DebugEvent[]> =>
  runtime.isNative() ? call(() => commandSet.getDebugHistory!()) : Promise.resolve([])

export async function clearDebugLogs(): Promise<void> {
  browserEvents.length = 0
  if (runtime.isNative()) await call(() => commandSet.clearDebugLogs!())
}

export const flushDebugLogs = (): Promise<void> =>
  runtime.isNative()
    ? call(() => commandSet.flushDebugLogs!()).then(() => undefined)
    : Promise.resolve()

export const openDebugLogFolder = (): Promise<void> =>
  runtime.isNative()
    ? call(() => commandSet.openLogFolder!()).then(() => undefined)
    : Promise.reject(new Error("DEBUG_NATIVE_STORAGE_UNAVAILABLE"))

export const toggleDebugDevtools = (): Promise<void> =>
  runtime.isNative()
    ? call(() => commandSet.toggleDevtools!()).then(() => undefined)
    : Promise.reject(new Error("DEBUG_NATIVE_STORAGE_UNAVAILABLE"))
