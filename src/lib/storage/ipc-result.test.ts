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
  it("does not read a category out of the user's own folder name (IPC-06)", () => {
    for (const [message, code] of [
      [
        "Failed to write /vault/Collision notes/a.md: Permission denied (os error 13)",
        "permissionDenied",
      ],
      [
        "Path not accessible (/vault/Already exists/x): Permission denied (os error 13)",
        "permissionDenied",
      ],
      ["Failed to read /vault/Not found/a.md: Access is denied. (os error 5)", "permissionDenied"],
      ["Path escapes vault: /vault/Does not exist/../x", "invalidPath"],
      ["Disk error in /vault/Already exists notes/a.md", "operationFailed"],
    ])
      expect(desktopOperationError(message).code, message).toBe(code)
  })

  it("takes the category from the typed code when the command sends one", () => {
    expect(() =>
      unwrapCommandResult({
        status: "error",
        error: { code: "permissionDenied", detail: "Collision already exists" },
      } as never),
    ).toThrowError(expect.objectContaining({ code: "permissionDenied" }))
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
