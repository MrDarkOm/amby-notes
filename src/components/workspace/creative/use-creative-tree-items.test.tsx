// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TreeItem } from "../tree/tree-types"
import { useCreativeSettingsStore } from "./creative-settings-store"
import { catalog, project } from "./project-fixtures.test-support"
import { useProjectStore } from "./project-store"
import { useCreativeTreeItems } from "./use-creative-tree-items"

vi.mock("../app-config", () => ({
  loadWorkspaceConfig: vi.fn(),
  saveWorkspaceConfigPatch: vi.fn(),
}))

const VAULT = "/vault"
const tree: TreeItem[] = [
  {
    id: "folder:/vault/Verse",
    path: "/vault/Verse",
    name: "Verse",
    type: "folder",
    icon: "folder",
    children: [],
  },
  { id: "b", path: "/vault/b.md", name: "b", type: "file", icon: "file" },
]

describe("useCreativeTreeItems", () => {
  beforeEach(() => {
    useProjectStore.getState().reset()
    useCreativeSettingsStore.setState({ showInTree: true })
    act(() => useProjectStore.getState().setCatalog(catalog([project("verse", { path: "Verse" })])))
  })
  afterEach(() => vi.restoreAllMocks())

  it("marks the project folder while the module is on", () => {
    const { result } = renderHook(() => useCreativeTreeItems(tree, VAULT, true))
    expect(result.current[0].icon).toContain("amby-icon:feather:")
  })

  it("hands the vault's own tree back untouched while the module is off", () => {
    const { result } = renderHook(() => useCreativeTreeItems(tree, VAULT, false))
    expect(result.current).toBe(tree)
    // The hidden-folders setting does not reach a module that is off either.
    act(() => useCreativeSettingsStore.setState({ showInTree: false }))
    expect(result.current).toBe(tree)
  })

  it("follows the module being switched on and off", () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useCreativeTreeItems(tree, VAULT, enabled),
      { initialProps: { enabled: true } },
    )
    act(() => useCreativeSettingsStore.setState({ showInTree: false }))
    expect(result.current.map((item) => item.id)).toEqual(["b"])
    rerender({ enabled: false })
    expect(result.current).toBe(tree)
    rerender({ enabled: true })
    expect(result.current.map((item) => item.id)).toEqual(["b"])
  })
})
