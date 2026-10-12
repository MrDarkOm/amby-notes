// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TreeItem } from "../tree/tree-types"
import { useCreativeNavStore } from "./creative-nav-store"
import { catalog, project } from "./project-fixtures.test-support"
import { useCollectionFolderSelect } from "./use-collection-folder-select"

const VAULT = "/vault"
const universe: TreeItem = {
  id: "folder:/vault/Verse",
  path: "/vault/Verse",
  name: "Verse",
  type: "folder",
  icon: "folder",
}
const ordinary: TreeItem = {
  id: "folder:/vault/Plain",
  path: "/vault/Plain",
  name: "Plain",
  type: "folder",
  icon: "folder",
}
const items = new Map([universe, ordinary].map((item) => [item.id, item]))
const cat = catalog([project("verse", { kind: "collection", path: "Verse" })])

function setup(enabled: boolean) {
  const fallback = vi.fn()
  const showPanel = vi.fn()
  const openProject = vi.fn()
  const { result } = renderHook(() =>
    useCollectionFolderSelect({
      enabled,
      vault: VAULT,
      catalog: cat,
      itemById: (id) => items.get(id),
      fallback,
      showPanel,
      openProject,
    }),
  )
  return { select: result.current, fallback, showPanel, openProject }
}

describe("useCollectionFolderSelect", () => {
  beforeEach(() => {
    localStorage.clear()
    useCreativeNavStore.setState({ scope: undefined })
  })

  it("opens the workshop on the universe whose folder was selected", () => {
    const { select, fallback, showPanel, openProject } = setup(true)
    select(universe.id)
    expect(useCreativeNavStore.getState().scope).toBe("verse")
    expect(JSON.parse(localStorage.getItem("amby:creative-scope") ?? "{}")).toEqual({
      [VAULT]: "verse",
    })
    expect(showPanel).toHaveBeenCalled()
    expect(openProject).toHaveBeenCalledWith("verse")
    expect(fallback).not.toHaveBeenCalled()
  })

  it("selects any other folder as usual", () => {
    const { select, fallback, showPanel, openProject } = setup(true)
    select(ordinary.id)
    expect(fallback).toHaveBeenCalledWith(ordinary.id)
    expect(showPanel).not.toHaveBeenCalled()
    expect(openProject).not.toHaveBeenCalled()
    expect(useCreativeNavStore.getState().scope).toBeUndefined()
  })

  it("treats the universe's folder as an ordinary folder while the module is off", () => {
    const { select, fallback, showPanel, openProject } = setup(false)
    select(universe.id)
    expect(fallback).toHaveBeenCalledWith(universe.id)
    expect(showPanel).not.toHaveBeenCalled()
    expect(openProject).not.toHaveBeenCalled()
  })
})
