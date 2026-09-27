import type { LogEntry } from "@/lib/logger"

export const DEBUG_RECORDING_LIMIT = 5_000
export const DEBUG_RECORDING_DURATION_MS = 5 * 60 * 1_000
export const DEBUG_RECORDING_MARKER_LIMIT = 100
const ALLOWED_MARKERS = new Set([
  "reproduction_started",
  "action_performed",
  "issue_observed",
  "reproduction_ended",
])

/** Deduplicates accepted events while keeping the ID set bounded by the recording cap. */
export function reserveRecordingEventId(
  ids: Set<string>,
  id: string,
  acceptedCount: number,
): boolean {
  if (ids.has(id)) return false
  if (acceptedCount < DEBUG_RECORDING_LIMIT) ids.add(id)
  return true
}

export interface DebugRecording {
  id: string
  startedAt: string
  endedAt: string | null
  markers: string[]
  eventCount: number
  dropped: number
}

export interface DebugRecordingState {
  recording: DebugRecording | null
  events: LogEntry[]
}

export interface DebugEventFilters {
  query: string
  level: "all" | LogEntry["level"]
  source: "all" | LogEntry["source"]
  subsystem: string
  operationId: string
  windowId: string
  since: string
  until: string
}

export interface DurationStats {
  count: number
  average: number
  p50: number
  p95: number
  max: number
}

export function startDebugRecording(
  now = Date.now(),
  id: string = crypto.randomUUID(),
): DebugRecordingState {
  const startedAt = new Date(now).toISOString()
  return {
    recording: { id, startedAt, endedAt: null, markers: [], eventCount: 0, dropped: 0 },
    events: [],
  }
}

export function appendRecordingEvent(
  state: DebugRecordingState,
  event: LogEntry,
  now = Date.now(),
): DebugRecordingState {
  const recording = state.recording
  if (!recording || recording.endedAt) return state

  if (now - Date.parse(recording.startedAt) >= DEBUG_RECORDING_DURATION_MS) {
    return stopDebugRecording(state, now)
  }
  if (state.events.length >= DEBUG_RECORDING_LIMIT) {
    return {
      ...state,
      recording: { ...recording, eventCount: state.events.length, dropped: recording.dropped + 1 },
    }
  }
  const events = [...state.events, event]
  return { ...state, events, recording: { ...recording, eventCount: events.length } }
}

export function stopDebugRecording(
  state: DebugRecordingState,
  now = Date.now(),
): DebugRecordingState {
  if (!state.recording || state.recording.endedAt) return state
  return {
    ...state,
    recording: { ...state.recording, endedAt: new Date(now).toISOString() },
  }
}

export function addRecordingMarker(
  state: DebugRecordingState,
  label: string,
  now = Date.now(),
): DebugRecordingState {
  if (!state.recording || state.recording.endedAt) return state
  if (!ALLOWED_MARKERS.has(label) || state.recording.markers.length >= DEBUG_RECORDING_MARKER_LIMIT)
    return state
  if (now - Date.parse(state.recording.startedAt) >= DEBUG_RECORDING_DURATION_MS) {
    return stopDebugRecording(state, now)
  }
  return {
    ...state,
    recording: {
      ...state.recording,
      markers: [...state.recording.markers, `${new Date(now).toISOString()} ${label}`],
    },
  }
}

function metadataText(entry: LogEntry): string {
  try {
    return JSON.stringify(entry.metadata ?? {}).toLocaleLowerCase()
  } catch {
    return ""
  }
}

function errorGroupKey(entry: LogEntry): string {
  return [
    entry.event,
    entry.subsystem ?? "",
    entry.windowId ?? "",
    entry.operationId ?? "",
    metadataText(entry),
  ].join("\u0000")
}

export function filterDebugEvents(events: LogEntry[], filters: DebugEventFilters): LogEntry[] {
  const query = filters.query.trim().toLocaleLowerCase()
  const since = filters.since ? Date.parse(filters.since) : Number.NEGATIVE_INFINITY
  const until = filters.until ? Date.parse(filters.until) : Number.POSITIVE_INFINITY
  return events.filter((entry) => {
    const timestamp = Date.parse(entry.timestamp)
    if (filters.level !== "all" && entry.level !== filters.level) return false
    if (filters.source !== "all" && entry.source !== filters.source) return false
    if (filters.subsystem && entry.subsystem !== filters.subsystem) return false
    if (filters.operationId && entry.operationId !== filters.operationId) return false
    if (filters.windowId && entry.windowId !== filters.windowId) return false
    if (Number.isFinite(timestamp) && (timestamp < since || timestamp > until)) return false
    return (
      !query ||
      entry.event.toLocaleLowerCase().includes(query) ||
      metadataText(entry).includes(query) ||
      (entry.subsystem ?? "").toLocaleLowerCase().includes(query) ||
      (entry.operationId ?? "").toLocaleLowerCase().includes(query)
    )
  })
}

export function durationStats(events: LogEntry[]): DurationStats {
  const values = events
    .map((event) => event.durationMs)
    .filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
    )
    .sort((a, b) => a - b)
  if (!values.length) return { count: 0, average: 0, p50: 0, p95: 0, max: 0 }
  const percentile = (p: number) => values[Math.max(0, Math.ceil(values.length * p) - 1)]
  return {
    count: values.length,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: values[values.length - 1],
  }
}

export function groupRepeatedErrors(events: LogEntry[]): Array<{ event: LogEntry; count: number }> {
  const groups = new Map<string, { event: LogEntry; count: number }>()
  for (const event of events) {
    const key = errorGroupKey(event)
    const existing = groups.get(key)
    if (existing) existing.count += 1
    else groups.set(key, { event, count: 1 })
  }
  return [...groups.values()].sort(
    (a, b) => Date.parse(b.event.timestamp) - Date.parse(a.event.timestamp),
  )
}
