import { beforeEach, describe, expect, it } from "vitest"
import { catalog, project } from "./project-fixtures.test-support"
import { useProjectStore } from "./project-store"

const raw = () =>
  catalog([project("a", { path: "Одна" }), project("b", { path: "Мастерская" })], {
    diagnostics: [],
  })

describe("project store: which marker is the workshop", () => {
  beforeEach(() => {
    useProjectStore.getState().reset()
    useProjectStore.getState().setPlace(null, "Мастерская")
  })

  it("shows only the workshop in the default folder, and the others as diagnostics", () => {
    useProjectStore.getState().setCatalog(raw())
    const state = useProjectStore.getState()
    expect(state.catalog?.workshops.map((w) => w.workshopId)).toEqual(["b"])
    expect(state.rawCatalog?.workshops).toHaveLength(2)
    expect(state.catalog?.diagnostics.map((d) => d.code)).toEqual(["otherWorkshop"])
  })

  it("follows a change of the setting without reading anything again", () => {
    useProjectStore.getState().setCatalog(raw())
    useProjectStore.getState().setPlace("Одна", "Мастерская")
    expect(useProjectStore.getState().catalog?.workshops.map((w) => w.workshopId)).toEqual(["a"])
    useProjectStore.getState().setPlace("Нет такой", "Мастерская")
    expect(useProjectStore.getState().catalog?.workshops).toEqual([])
    expect(useProjectStore.getState().catalog?.diagnostics).toHaveLength(2)
  })

  it("follows the language when the default folder is the one named", () => {
    useProjectStore.getState().setCatalog(raw())
    useProjectStore.getState().setPlace(null, "Workshop")
    expect(useProjectStore.getState().catalog?.workshops).toEqual([])
    useProjectStore.getState().setPlace(null, "Мастерская")
    expect(useProjectStore.getState().catalog?.workshops).toHaveLength(1)
  })

  it("is empty after a reset and when the module is off", () => {
    useProjectStore.getState().setCatalog(raw())
    useProjectStore.getState().reset()
    expect(useProjectStore.getState().rawCatalog).toBeNull()
    useProjectStore.getState().setCatalog(raw())
    useProjectStore.getState().setDisabled()
    expect(useProjectStore.getState().catalog).toBeNull()
    expect(useProjectStore.getState().rawCatalog).toBeNull()
  })
})
