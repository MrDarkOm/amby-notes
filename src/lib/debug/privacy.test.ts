import { describe, expect, it } from "vitest"
import { sanitizeDebugEvent, sanitizeError, sanitizeLogMetadata } from "./privacy"

describe("debug privacy boundary", () => {
  it("keeps bounded counters and approved enums while pseudonymizing identities", () => {
    const clean = sanitizeLogMetadata({
      durationMs: 12.5,
      runtime: "desktop",
      database_id: "private-database-id",
      title: "A private note title",
      content: "secret note body",
      extra: { nested: "secret" },
    })
    expect(clean).toEqual({
      durationMs: 12.5,
      runtime: "desktop",
      database_id: expect.stringMatching(/^id_/),
    })
    expect(clean?.database_id).not.toContain("private")
    const firstPass = sanitizeLogMetadata({ documentId: "same-private-id", errorType: "TypeError" })
    const secondPass = sanitizeLogMetadata(firstPass)
    expect(firstPass?.documentId).toMatch(/^id_[0-9a-f]{16}$/)
    expect(secondPass).toEqual(firstPass)
    expect(firstPass?.errorType).toBe("TypeError")
  })

  it("does not enumerate or serialize circular objects and survives throwing accessors", () => {
    const circular: Record<string, unknown> = { count: 1 }
    circular.self = circular
    expect(sanitizeLogMetadata(circular)).toEqual({ count: 1 })
    const hostile = Object.defineProperty({}, "count", {
      enumerable: true,
      get: () => {
        throw new Error("private")
      },
    })
    expect(sanitizeLogMetadata(hostile)).toBeUndefined()
  })

  it("normalizes timestamps and rejects unsafe event names and freeform errors", () => {
    const safe = sanitizeDebugEvent({
      id: "event-1",
      timestamp: "2026-09-27T10:11:12+02:00",
      level: "error",
      event: "Failed to save my private note",
      source: "frontend",
      metadata: { error: "file /private/vault/secret.md" },
    })
    expect(safe.timestamp).toBe("2026-09-27T08:11:12.000Z")
    expect(safe.event).toBe("diagnostic.invalid_event")
    expect(safe.metadata).toBeUndefined()
    expect(sanitizeError("server said /private/vault/private.md")).toBe("UnknownError")
    expect(sanitizeError(new TypeError("secret message"))).toBe("TypeError")
    expect(JSON.stringify(safe)).not.toContain("private")
  })

  it("allows only registered event and subsystem codes", () => {
    const unsafe = sanitizeDebugEvent({
      id: "evt_550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-09-27T10:11:12Z",
      level: "warn",
      event: "secret_customer_note",
      subsystem: "private_vault",
      source: "frontend",
    })
    expect(unsafe.event).toBe("diagnostic.invalid_event")
    expect(unsafe.subsystem).toBeUndefined()
    expect(JSON.stringify(unsafe)).not.toContain("secret_customer_note")
    expect(JSON.stringify(unsafe)).not.toContain("private_vault")

    const known = sanitizeDebugEvent({
      event: "autosave.start",
      subsystem: "autosave",
      source: "frontend",
    })
    expect(known.event).toBe("autosave.start")
    expect(known.subsystem).toBe("autosave")
  })
})
