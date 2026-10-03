import { describe, expect, it } from "vitest"
import { localeResources } from "./resources"

const LAYOUTS = ["table", "board", "list", "gallery", "chart"]

describe("database layout names", () => {
  it("every view layout has a name in every language, so no raw key is ever shown", () => {
    for (const language of ["ru", "en"] as const) {
      const names = (
        localeResources[language].translation as unknown as {
          databaseLayouts: Record<string, string>
        }
      ).databaseLayouts
      for (const layout of LAYOUTS) {
        expect(names[layout], `${language}.databaseLayouts.${layout}`).toBeTruthy()
      }
    }
  })
})
