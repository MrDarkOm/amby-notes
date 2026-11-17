import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import macosConfig from "../../src-tauri/tauri.macos.conf.json"

describe("macOS bundle signing", () => {
  it("seals the complete local app bundle instead of leaving a linker-only signature", () => {
    // Tauri's explicit pseudo-identity signs resources as well as the binary.
    // This does not assert Developer ID trust or Apple notarization.
    expect(macosConfig.bundle.macOS.signingIdentity).toBe("-")
  })
})

describe("macOS minimum version (UI-06)", () => {
  it("requires macOS 13, the oldest system whose WebKit has every style Amby uses", () => {
    // color-mix() needs Safari 16.2; older systems would install and show broken colours.
    const macOS: { minimumSystemVersion?: string } = macosConfig.bundle.macOS
    expect(macOS.minimumSystemVersion).toBe("13.0")
  })

  it("gives every dvh height a vh fallback on the line before it", () => {
    const css = readFileSync(resolve(__dirname, "../themes/app.css"), "utf8").split("\n")
    const missing = css.flatMap((line, index) => {
      if (!/\d(dvh)\b/.test(line)) return []
      const property = line.trim().split(":")[0]
      const previous = (css[index - 1] ?? "").trim()
      const fallback = previous.startsWith(`${property}:`) && /\dvh\b/.test(previous)
      return fallback ? [] : [`app.css:${index + 1}`]
    })
    expect(missing).toEqual([])
  })
})
