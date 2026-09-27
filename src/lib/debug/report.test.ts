import { describe, expect, it } from "vitest"
import { createDebugReport } from "./report"

describe("createDebugReport", () => {
  it("re-sanitizes events, health and recording fields and labels voluntary description", () => {
    const report = JSON.parse(
      createDebugReport({
        now: new Date("2026-09-27T08:00:00.000Z"),
        events: [
          {
            id: "evt1",
            timestamp: "2026-09-27T08:00:00Z",
            level: "error",
            event: "settings.save_failed",
            source: "frontend",
            metadata: { durationMs: 23, title: "private note", path: "/vault/secret" },
          },
        ],
        health: {
          runtime: "desktop",
          generatedAt: "2026-09-27T08:00:00Z",
          documents: { open: 2, dirty: 1, title: "secret" },
          backend: {
            buffered: 2,
            fileError: "/private/path",
            vaultOpen: true,
            sessionId: "secret-session",
          },
          editorReasons: { round_trip_mismatch: 1, private_document_name: 7 },
        },
        recording: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          startedAt: "2026-09-27T07:00:00Z",
          markers: ["2026-09-27T07:30:00Z action_performed", "my private note"],
          eventCount: 4,
          dropped: 1,
        },
        userDescription: "I clicked Save and saw an error.",
      }),
    )
    expect(report.schemaVersion).toBe(1)
    expect(report.composition.included).toEqual([
      "environment",
      "health",
      "sanitizedEvents",
      "recording",
      "voluntaryDescription",
    ])
    expect(report.composition.excluded).toEqual([
      "noteContent",
      "noteTitles",
      "rawPaths",
      "credentials",
      "rawErrors",
      "stacks",
    ])
    expect(report.app.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(report.events[0].metadata).toEqual({ durationMs: 23 })
    expect(report.health.documents).toEqual({ open: 2, dirty: 1 })
    expect(report.health.backend.fileError).toBe("UNKNOWN_ERROR")
    expect(report.health.editorReasons).toEqual({ round_trip_mismatch: 1 })
    expect(report.recording.markers).toEqual([
      "2026-09-27T07:30:00.000Z action_performed",
      "marker",
    ])
    expect(report.recording.id).toBe("550e8400-e29b-41d4-a716-446655440000")
    expect(report.userDescription).toBe("I clicked Save and saw an error.")
    expect(JSON.stringify(report)).not.toContain("secret")
  })

  it("bounds history, descriptions and malformed input", () => {
    const events = Array.from({ length: 5100 }, (_, index) => ({
      id: `evt${index}`,
      timestamp: "bad",
      level: "info",
      event: "frontend_started",
      source: "frontend",
    }))
    const report = JSON.parse(
      createDebugReport({ events, health: null, userDescription: "x".repeat(2000) }),
    )
    expect(report.events).toHaveLength(5000)
    expect(report.health.runtime).toBe("unknown")
    expect(report.userDescription).toHaveLength(1200)
    expect(report.composition.included).toContain("voluntaryDescription")
    expect(report.events[0].timestamp).toBe("1970-01-01T00:00:00.000Z")
  })

  it("removes non-opaque recording IDs that could contain private data", () => {
    const report = JSON.parse(
      createDebugReport({
        events: [],
        health: null,
        recording: {
          id: "secret_customer_note_42",
          startedAt: "2026-09-27T07:00:00Z",
          markers: [],
          eventCount: 0,
          dropped: 0,
        },
      }),
    )
    expect(report.recording.id).toBe("recording")
    expect(JSON.stringify(report)).not.toContain("secret_customer_note_42")
  })
})
