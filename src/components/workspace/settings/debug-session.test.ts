import { describe, expect, it } from "vitest"
import type { LogEntry } from "@/lib/logger"
import {
  DEBUG_RECORDING_DURATION_MS,
  DEBUG_RECORDING_LIMIT,
  addRecordingMarker,
  appendRecordingEvent,
  durationStats,
  filterDebugEvents,
  groupRepeatedErrors,
  reserveRecordingEventId,
  startDebugRecording,
} from "./debug-session"

const event = (patch: Partial<LogEntry> = {}): LogEntry => ({
  id: "a",
  timestamp: "2026-09-27T10:00:00.000Z",
  level: "error",
  event: "storage.read",
  source: "frontend",
  subsystem: "storage",
  operationId: "op-1",
  windowId: "main",
  durationMs: 4,
  ...patch,
})

describe("debug session helpers", () => {
  it("bounds recordings by event count and stops them at five minutes", () => {
    let state = startDebugRecording(10_000, "recording")
    for (let index = 0; index < DEBUG_RECORDING_LIMIT + 1; index += 1) {
      state = appendRecordingEvent(state, event({ id: String(index) }), 10_001 + index)
    }
    expect(state.events).toHaveLength(DEBUG_RECORDING_LIMIT)
    expect(state.recording?.dropped).toBe(1)
    const ended = appendRecordingEvent(
      state,
      event({ id: "late" }),
      10_000 + DEBUG_RECORDING_DURATION_MS,
    )
    expect(ended.recording?.endedAt).toBe(
      new Date(10_000 + DEBUG_RECORDING_DURATION_MS).toISOString(),
    )
    expect(ended.events).toHaveLength(DEBUG_RECORDING_LIMIT)
  })

  it("stores timestamped controlled markers and caps their count", () => {
    let state = startDebugRecording(0, "recording")
    for (let index = 0; index < 105; index += 1) {
      state = addRecordingMarker(state, "issue_observed", 100 + index)
    }
    expect(state.recording?.markers).toHaveLength(100)
    expect(state.recording?.markers[0]).toBe("1970-01-01T00:00:00.100Z issue_observed")
    expect(addRecordingMarker(state, "freeform-label", 300)).toBe(state)
  })

  it("bounds recording deduplication IDs to the event retention limit", () => {
    const ids = new Set<string>()
    for (let index = 0; index < DEBUG_RECORDING_LIMIT + 200; index += 1) {
      expect(reserveRecordingEventId(ids, `record-${index}`, index)).toBe(true)
    }
    expect(ids.size).toBe(DEBUG_RECORDING_LIMIT)
    expect(reserveRecordingEventId(ids, "record-0", DEBUG_RECORDING_LIMIT)).toBe(false)
  })

  it("filters by subsystem, operation, window, time and safe searchable fields", () => {
    const events = [event(), event({ id: "b", event: "autosave.done", subsystem: "autosave" })]
    expect(
      filterDebugEvents(events, {
        query: "storage",
        level: "error",
        source: "frontend",
        subsystem: "storage",
        operationId: "op-1",
        windowId: "main",
        since: "2026-09-27T09:59:00.000Z",
        until: "2026-09-27T10:01:00.000Z",
      }),
    ).toEqual([events[0]])
  })

  it("computes duration percentiles and groups repeated failures", () => {
    const events = [
      event({ durationMs: 5 }),
      event({ id: "b", durationMs: 10 }),
      event({ id: "c", durationMs: 30 }),
    ]
    expect(durationStats(events)).toEqual({ count: 3, average: 15, p50: 10, p95: 30, max: 30 })
    expect(groupRepeatedErrors(events)[0]).toMatchObject({ count: 3, event: events[0] })
  })
})
