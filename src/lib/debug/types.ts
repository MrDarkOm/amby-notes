export type LogLevel = "debug" | "info" | "warn" | "error"
type DebugSource = "frontend" | "backend"

export interface DebugConfig {
  enabled: boolean
  logLevel: LogLevel
  logToFile: boolean
}

export type LogMetadata = Record<string, unknown>

export interface DebugEvent {
  id: string
  timestamp: string
  level: LogLevel
  event: string
  source: DebugSource
  metadata?: LogMetadata
  sessionId?: string
  windowId?: string
  operationId?: string
  subsystem?: string
  durationMs?: number
  sequence?: number
}

export type LogEntry = DebugEvent

export interface DebugBackendStatus {
  config: DebugConfig
  sessionId: string
  buffered: number
  dropped: number
  pending: number
  fileBytes: number
  fileError: string | null
  watcherRunning: boolean
  indexReady: boolean
  vaultOpen: boolean
}

export interface DebugOperationContext {
  operationId?: string
  durationMs?: number
  subsystem?: string
}
