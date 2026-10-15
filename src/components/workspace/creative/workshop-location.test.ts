import { describe, expect, it } from "vitest"
import { catalog, project } from "./project-fixtures.test-support"
import {
  activeCatalog,
  normalizeWorkshopPath,
  OTHER_WORKSHOP_CODE,
  resolveWorkshopPlace,
} from "./workshop-location"

const at = (id: string, path: string) => project(id, { path })

describe("normalizeWorkshopPath", () => {
  it("keeps a vault-relative folder and tidies its form", () => {
    expect(normalizeWorkshopPath("Мастерская")).toBe("Мастерская")
    expect(normalizeWorkshopPath(" Книги//Серия/ ")).toBe("Книги/Серия")
    expect(normalizeWorkshopPath("./Книги\\Серия")).toBe("Книги/Серия")
  })

  it("refuses what cannot be a folder of the vault", () => {
    for (const bad of [
      "",
      "  ",
      ".",
      "..",
      "../Мастерская",
      "Книги/../Мастерская",
      ".amby",
      "a/.b",
    ]) {
      expect(normalizeWorkshopPath(bad), bad).toBeNull()
    }
    expect(normalizeWorkshopPath(null)).toBeNull()
    expect(normalizeWorkshopPath(undefined)).toBeNull()
  })
})

describe("resolveWorkshopPlace", () => {
  it("takes the workshop whose folder is the setting, and only that one", () => {
    const place = resolveWorkshopPlace([at("a", "Одна"), at("b", "Две")], "две", "Мастерская")
    expect(place.active?.workshopId).toBe("b")
    expect(place.others.map((w) => w.workshopId)).toEqual(["a"])
    expect(place).toMatchObject({ path: "две", configured: true })
  })

  it("has no active workshop when the setting names a folder with none", () => {
    const place = resolveWorkshopPlace([at("a", "Одна")], "Новая", "Мастерская")
    expect(place.active).toBeNull()
    expect(place.path).toBe("Новая")
    expect(place.others).toHaveLength(1)
  })

  it("takes the only workshop found when no folder is set, without making a setting of it", () => {
    const place = resolveWorkshopPlace([at("a", "Где-то")], null, "Мастерская")
    expect(place.active?.workshopId).toBe("a")
    expect(place.configured).toBe(false)
    expect(place.others).toEqual([])
  })

  it("prefers the default folder among several when no folder is set", () => {
    const place = resolveWorkshopPlace([at("a", "Одна"), at("b", "Мастерская")], null, "Мастерская")
    expect(place.active?.workshopId).toBe("b")
    expect(place.path).toBe("Мастерская")
    expect(
      resolveWorkshopPlace([at("a", "Одна"), at("c", "Три")], null, "Workshop").active,
    ).toBeNull()
  })

  it("offers the default folder when there is nothing at all", () => {
    expect(resolveWorkshopPlace([], null, "Workshop")).toMatchObject({
      active: null,
      path: "Workshop",
      configured: false,
    })
  })

  it("ignores a setting that cannot be a path", () => {
    expect(resolveWorkshopPlace([at("a", "Одна")], "../x", "Мастерская").active?.workshopId).toBe(
      "a",
    )
  })
})

describe("activeCatalog", () => {
  it("keeps the active workshop and reports the others as diagnostics, untouched", () => {
    const raw = catalog([at("a", "Одна"), at("b", "Две"), at("c", "Три/Глубже")], {
      diagnostics: [
        {
          code: "legacyProjectFormat",
          severity: "warning",
          path: "Old/amby-project.json",
          workshopId: null,
          storyId: null,
          detail: null,
        },
      ],
    })
    const shown = activeCatalog(raw, "Две", "Мастерская")
    expect(shown.workshops.map((w) => w.workshopId)).toEqual(["b"])
    expect(shown.workshops[0]).toBe(raw.workshops[1])
    expect(shown.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ["legacyProjectFormat", "Old/amby-project.json"],
      [OTHER_WORKSHOP_CODE, "Одна/amby-workshop.json"],
      [OTHER_WORKSHOP_CODE, "Три/Глубже/amby-workshop.json"],
    ])
    expect(raw.workshops).toHaveLength(3)
  })
})
