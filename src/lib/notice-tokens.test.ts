// The colours of the five levels of a notice are theme tokens (docs/notices.md, section 11): a
// background, a text colour and a border for each level, in the light theme and in the dark one,
// readable, and open to portable themes. Patterned after themes.test.ts and theme-boundary.test.ts.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { THEME_TOKENS, parseThemeDefinition } from "./themes"

// Vitest turns a `?raw` import of a stylesheet into an empty string, so the file is read from disk.
const css = readFileSync(join(import.meta.dirname, "../themes/app.css"), "utf8")

const LEVELS = ["danger", "decision", "warning", "info", "success"] as const
const PARTS = ["bg", "fg", "border"] as const
const TOKENS = LEVELS.flatMap((level) => PARTS.map((part) => `--notice-${level}-${part}`))

/** The declarations of every rule whose selector is exactly `selector`, joined. */
function declarationsOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const rule = new RegExp(`(?:^|[}\\s,{])${escaped}\\s*\\{([^{}]*)\\}`, "gu")
  return [...css.matchAll(rule)].map((match) => match[1]).join("\n")
}

function valueOf(block: string, token: string): string | null {
  const found = new RegExp(`${token}\\s*:\\s*([^;]+);`, "u").exec(block)
  return found ? found[1].trim() : null
}

function channel(hex: string): number[] {
  const full = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1)
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
}
function luminance(hex: string): number {
  const [r, g, b] = channel(hex).map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe.each([
  ["the light theme", ":root"],
  ["the dark theme", ".dark"],
])("notice tokens in %s", (_name, selector) => {
  const block = declarationsOf(selector)

  it.each(TOKENS)("defines %s", (token) => {
    expect(valueOf(block, token)).not.toBeNull()
  })

  it.each(LEVELS)("keeps the text of %s readable on its background", (level) => {
    const bg = valueOf(block, `--notice-${level}-bg`)
    const fg = valueOf(block, `--notice-${level}-fg`)
    expect(bg).toMatch(/^#[0-9a-f]{6}$/iu)
    expect(fg).toMatch(/^#[0-9a-f]{6}$/iu)
    expect(contrast(bg!, fg!)).toBeGreaterThanOrEqual(4.5)
  })

  it("gives every level its own colour", () => {
    const fgs = LEVELS.map((level) => valueOf(block, `--notice-${level}-fg`))
    expect(new Set(fgs).size).toBe(LEVELS.length)
  })
})

describe("notice tokens in portable themes", () => {
  it("are tokens that a theme may set", () => {
    for (const token of TOKENS) expect(THEME_TOKENS).toContain(token)
  })

  it("are accepted from a theme file with a plain colour", () => {
    const theme = parseThemeDefinition({
      format: "amby-theme",
      version: 1,
      id: "forest-night",
      name: "Forest Night",
      mode: "dark",
      tokens: { "--notice-danger-bg": "#2c1618", "--notice-danger-fg": "#f87171" },
    })
    expect(theme?.tokens).toEqual({
      "--notice-danger-bg": "#2c1618",
      "--notice-danger-fg": "#f87171",
    })
  })
})
