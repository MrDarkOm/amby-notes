import { describe, expect, it } from "vitest"
import { unwrapCommandResult } from "./ipc-result"
import { desktopOperationError } from "./operation-error"

describe("unwrapCommandResult", () => {
  it("exposes stable storage error categories without relying on OS language", () => {
    for (const [message, code] of [
      ["Path not found: Note.md", "notFound"],
      ["Системе не удается найти указанный файл. (os error 2)", "notFound"],
      ["File already exists: Note.md", "alreadyExists"],
      ["Path escapes vault: ../Note.md", "invalidPath"],
      ["Disk unavailable", "operationFailed"],
    ])
      expect(desktopOperationError(message).code).toBe(code)
  })
  it("returns successful generated command data", () => {
    expect(unwrapCommandResult({ status: "ok", data: "note" })).toBe("note")
  })

  it("turns generated command errors into rejected caller errors", () => {
    expect(() => unwrapCommandResult({ status: "error", error: "No vault open" })).toThrow(
      "No vault open",
    )
  })
})
