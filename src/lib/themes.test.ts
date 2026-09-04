import { describe, expect, it } from "vitest"
import {
  BUILTIN_THEME_FAMILIES,
  BUILTIN_THEMES,
  migrateThemeId,
  parseThemeDefinition,
  themeById,
  withUniqueThemeId,
} from "./themes"

const validTheme = {
  format: "amby-theme",
  version: 1,
  id: "forest-night",
  name: "Forest Night",
  author: "Example author",
  mode: "dark",
  tokens: {
    "--background": "150 20% 8%",
    "--note-surface": "#102018",
  },
}

describe("portable themes", () => {
  it("accepts only the portable schema and known visual tokens", () => {
    const theme = parseThemeDefinition({
      ...validTheme,
      tokens: { ...validTheme.tokens, "--made-up": "red" },
    })

    expect(theme).toEqual({ ...validTheme, tokens: validTheme.tokens })
  })

  it("rejects CSS values that could load or inject external content", () => {
    expect(
      parseThemeDefinition({
        ...validTheme,
        tokens: { "--background": "url(https://example.com/pixel)" },
      }),
    ).toBeNull()
  })

  it("does not let an import replace a bundled or installed theme", () => {
    const reserved = parseThemeDefinition({ ...validTheme, id: BUILTIN_THEMES[0].id })!
    const first = withUniqueThemeId(reserved, [])
    const second = withUniqueThemeId(reserved, [first])

    expect(first.id).toBe("dark-2")
    expect(second.id).toBe("dark-3")
  })

  it("migrates the retired built-in theme ids", () => {
    expect(migrateThemeId("midnight")).toBe("catppuccin")
    expect(migrateThemeId("paper")).toBe("gruvbox")
    expect(migrateThemeId("custom-theme")).toBe("custom-theme")
  })

  it("provides light and dark variants for the themed palettes", () => {
    expect(BUILTIN_THEME_FAMILIES).toEqual(
      expect.arrayContaining([
        { id: "catppuccin", variants: { light: "catppuccin-light", dark: "catppuccin" } },
        { id: "gruvbox", variants: { light: "gruvbox-light", dark: "gruvbox" } },
      ]),
    )
    expect(themeById("catppuccin-light", [])).toMatchObject({ name: "Catppuccin", mode: "light" })
    expect(themeById("gruvbox-light", [])).toMatchObject({
      name: "Material Gruvbox",
      mode: "light",
    })
  })
})
