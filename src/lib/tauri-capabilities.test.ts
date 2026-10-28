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
    // The settings window prints one thing: the recovery code of the sync connect screen (О3).
    expect(settingsWindowCapability.permissions).toContain("core:webview:allow-print")
    expect(settingsWindowCapability.permissions).toContain(
      "core:window:allow-internal-toggle-maximize",
    )
    for (const capability of [defaultCapability, settingsWindowCapability]) {
      expect(capability.permissions).not.toContain("updater:default")
      expect(capability.permissions).not.toContain("updater:allow-check")
      expect(capability.permissions).toContain("updater:allow-download-and-install")
      expect(capability.permissions).toContain("core:resources:allow-close")
    }
    expect(defaultCapability.permissions).toContain("process:allow-restart")
    expect(settingsWindowCapability.permissions).toContain("process:allow-restart")
    expect(defaultCapability.permissions).toContain("core:app:allow-version")
    expect(settingsWindowCapability.permissions).toContain("core:app:allow-version")
    expect(noteWindowCapability.permissions).not.toContain("updater:default")
    expect(noteWindowCapability.permissions).not.toContain("process:allow-restart")

    for (const capability of [defaultCapability, noteWindowCapability, settingsWindowCapability]) {
      expect(capability.permissions).toContain("core:window:allow-close")
      expect(capability.permissions).toContain("core:window:allow-destroy")
    }
  })

  // Opening a note's attachment or a web address is done by Amby's own commands
  // (`open_attachment`, `open_web_address`), which check the file type, the folder and the
  // address themselves. No window may be given a plugin that opens arbitrary paths, runs
  // programs, or reads and writes files or the network on its own.
  it("gives no window a permission to open, run, read or fetch on its own", () => {
    for (const capability of [defaultCapability, noteWindowCapability, settingsWindowCapability]) {
      for (const permission of capability.permissions) {
        expect(permission, permission).not.toMatch(/^(opener|shell|fs|http|os|process:allow-exit)/u)
        expect(permission, permission).not.toMatch(/allow-open-path|allow-open-url|allow-execute/u)
      }
    }
  })
})
