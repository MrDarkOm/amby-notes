import { describe, expect, it } from "vitest"
import defaultCapability from "../../src-tauri/capabilities/default.json"
import noteWindowCapability from "../../src-tauri/capabilities/note-window.json"

describe("Tauri window capabilities", () => {
  it("allows the autosave-aware close lifecycle only for application windows", () => {
    expect(defaultCapability.windows).toEqual(["main"])
    expect(noteWindowCapability.windows).toEqual(["note-*"])

    for (const capability of [defaultCapability, noteWindowCapability]) {
      expect(capability.permissions).toContain("core:window:allow-close")
      expect(capability.permissions).toContain("core:window:allow-destroy")
    }
  })
})
