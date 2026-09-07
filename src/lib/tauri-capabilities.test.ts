import { describe, expect, it } from "vitest"
import defaultCapability from "../../src-tauri/capabilities/default.json"
import noteWindowCapability from "../../src-tauri/capabilities/note-window.json"
import settingsWindowCapability from "../../src-tauri/capabilities/settings-window.json"

describe("Tauri window capabilities", () => {
  it("allows the autosave-aware close lifecycle only for application windows", () => {
    expect(defaultCapability.windows).toEqual(["main"])
    expect(noteWindowCapability.windows).toEqual(["note-*"])
    expect(settingsWindowCapability.windows).toEqual(["settings"])
    expect(defaultCapability.permissions).toContain("core:window:allow-show")
    expect(defaultCapability.permissions).toContain("core:window:allow-set-focus")
    expect(defaultCapability.permissions).toContain("core:window:allow-unminimize")
    expect(defaultCapability.permissions).toContain("core:webview:allow-print")
    expect(noteWindowCapability.permissions).toContain("core:webview:allow-print")
    expect(settingsWindowCapability.permissions).not.toContain("core:webview:allow-print")
    expect(settingsWindowCapability.permissions).toContain(
      "core:window:allow-internal-toggle-maximize",
    )

    for (const capability of [defaultCapability, noteWindowCapability, settingsWindowCapability]) {
      expect(capability.permissions).toContain("core:window:allow-close")
      expect(capability.permissions).toContain("core:window:allow-destroy")
    }
  })
})
