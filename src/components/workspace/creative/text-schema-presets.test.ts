import { describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import {
  levelChain,
  levelsProblem,
  MAX_TEXT_LEVELS,
  presetLevelNames,
  TEXT_SCHEMAS,
} from "./text-schema-presets"

describe("text schema presets", () => {
  it("names the levels of each ready schema in the active language", () => {
    const ru = i18n.getFixedT("ru")
    const en = i18n.getFixedT("en")
    expect(presetLevelNames("novel", ru)).toEqual(["Книга", "Глава", "Сцена"])
    expect(presetLevelNames("story", ru)).toEqual(["Страница"])
    expect(presetLevelNames("comic", ru)).toEqual(["Книга", "Том", "Глава", "Страница"])
    expect(presetLevelNames("novel", en)).toEqual(["Book", "Chapter", "Scene"])
  })

  it("keeps every ready schema within what the backend accepts", () => {
    const t = i18n.getFixedT("ru")
    for (const schema of TEXT_SCHEMAS) {
      if (schema === "custom") continue
      expect(levelsProblem(presetLevelNames(schema, t))).toBeNull()
    }
  })

  it("finds what the backend would refuse in a list of names", () => {
    expect(levelsProblem([])).toBe("empty")
    expect(levelsProblem(["Глава", "  "])).toBe("empty")
    expect(levelsProblem(["Глава", "глава"])).toBe("duplicate")
    expect(levelsProblem(Array.from({ length: MAX_TEXT_LEVELS + 1 }, (_, i) => `L${i}`))).toBe(
      "tooMany",
    )
    expect(levelsProblem(Array.from({ length: MAX_TEXT_LEVELS }, (_, i) => `L${i}`))).toBeNull()
  })

  it("writes the levels as one line and leaves blank names out", () => {
    expect(levelChain(["Книга", " ", "Сцена "])).toBe("Книга → Сцена")
    expect(levelChain([])).toBe("")
  })
})
