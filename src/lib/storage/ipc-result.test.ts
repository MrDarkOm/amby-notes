import { describe, expect, it } from "vitest"
import { unwrapCommandResult } from "./ipc-result"

describe("unwrapCommandResult", () => {
  it("returns successful generated command data", () => {
    expect(unwrapCommandResult({ status: "ok", data: "note" })).toBe("note")
  })

  it("turns generated command errors into rejected caller errors", () => {
    expect(() => unwrapCommandResult({ status: "error", error: "No vault open" })).toThrow(
      "No vault open",
    )
  })
})
