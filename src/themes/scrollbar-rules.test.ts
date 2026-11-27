import { readFileSync, readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"

const dir = new URL("./", import.meta.url)

describe("theme scrollbars", () => {
  // "Browser engines" in docs/ai/agent-guidelines.md: the standard properties make Chromium
  // (WebView2) ignore ::-webkit-scrollbar, so the bar loses the look the themes give it.
  it("use only ::-webkit-scrollbar, never scrollbar-width or scrollbar-color", () => {
    const offenders: string[] = []
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".css"))) {
      const css = readFileSync(new URL(file, dir), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "")
      css.split("\n").forEach((line, index) => {
        if (/\bscrollbar-(width|color)\s*:/u.test(line)) offenders.push(`${file}:${index + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
