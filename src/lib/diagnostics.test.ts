import { describe, expect, it } from "vitest"
import { startupDiagnosticReport } from "./diagnostics"

describe("startupDiagnosticReport", () => {
  it("excludes potentially sensitive error text and stack traces", () => {
    const error = new Error("API key sk-secret-value from /private/vault/Note.md")
    error.stack = "sensitive stack trace"

    const report = startupDiagnosticReport(error, new Date("2026-08-03T12:00:00.000Z"))

    const parsed = JSON.parse(report)
    expect(parsed.createdAt).toBe("2026-08-03T12:00:00.000Z")
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.events.at(-1).event).toBe("startup.failure")
    expect(parsed.events.at(-1).metadata.errorType).toBe("Error")
    expect(report).not.toContain(error.message)
    expect(report).not.toContain("sensitive stack trace")
  })
})
