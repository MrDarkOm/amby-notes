import { describe, expect, it } from "vitest"
import macosConfig from "../../src-tauri/tauri.macos.conf.json"

describe("macOS bundle signing", () => {
  it("seals the complete local app bundle instead of leaving a linker-only signature", () => {
    // Tauri's explicit pseudo-identity signs resources as well as the binary.
    // This does not assert Developer ID trust or Apple notarization.
    expect(macosConfig.bundle.macOS.signingIdentity).toBe("-")
  })
})
