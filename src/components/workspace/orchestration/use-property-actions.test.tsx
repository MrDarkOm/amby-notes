// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import * as storage from "@/lib/storage"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { usePropertyActions } from "./use-property-actions"

vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  upsertCustomProperty: vi.fn(),
  getNoteProperties: vi.fn(),
  readNote: vi.fn(),
}))
const records = new Map<string, storage.CustomProperty>()
const empty = { hasFrontmatter: false, properties: [], customProperties: [] }
const tree = new Map<string, storage.TreeItem>()
const links = { edges: [] }
let generation = 100
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function property(name: string): storage.CustomProperty {
  return { id: "", name, icon: "", propertyType: "text", value: "value", settings: "" }
}
function open() {
  return renderHook(() => {
    const currentDoc = useDocStore((state) => state.openDocs.note)
    const vault = useVaultStore((state) => state.vault)
    return usePropertyActions({
      currentDoc,
      vault,
      activeTab: null,
      treeItemById: tree,
      linkGraph: links,
      t: i18n.t,
    })
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  records.clear()
  useDocStore.getState().clearDocs()
  useVaultStore.setState({ vault: "/vault", generation: ++generation, switching: false })
  useDocStore.getState().setDoc("note", {
    id: "note",
    noteId: "note",
    path: "/vault/Note.md",
    title: "Note",
    content: "local body",
    source: "disk body",
    revision: "r0",
    created: "",
    modified: "",
    wordCount: 2,
    noteProperties: empty,
  })
  vi.mocked(storage.getNoteProperties).mockImplementation(async () => ({
    hasFrontmatter: true,
    customProperties: [...records.values()],
    properties: [...records.values()].map((item) => ({
      key: item.name,
      value: item.value,
      valueKind: "text",
    })),
  }))
  vi.mocked(storage.readNote).mockResolvedValue({
    content: "disk body",
    source: "disk source",
    revision: "r1",
  })
  vi.mocked(storage.upsertCustomProperty).mockImplementation(async (_vault, _id, item) => {
    records.set(item.id, item)
    return item
  })
})
afterEach(cleanup)

describe("property edits", () => {
  it("keeps later optimistic properties while an older save reloads and serializes writes", async () => {
    const first = deferred<void>(),
      second = deferred<void>()
    vi.mocked(storage.upsertCustomProperty).mockImplementation(async (_vault, _id, item) => {
      await (item.name === "First" ? first.promise : second.promise)
      records.set(item.id, item)
      return item
    })
    const hook = open()
    let a!: Promise<storage.CustomProperty>, b!: Promise<storage.CustomProperty>
    act(() => {
      a = hook.result.current.handleUpsertCustomProperty(property("First"))
    })
    act(() => {
      b = hook.result.current.handleUpsertCustomProperty(property("Second"))
    })
    const visible = () => useDocStore.getState().openDocs.note.noteProperties!
    expect(visible().properties.map((item) => item.key)).toEqual(["First", "Second"])
    expect(visible().customProperties.every((item) => Boolean(item.id))).toBe(true)
    await waitFor(() => expect(storage.upsertCustomProperty).toHaveBeenCalledTimes(1))
    await act(async () => {
      first.resolve()
      await a
    })
    await waitFor(() => expect(storage.upsertCustomProperty).toHaveBeenCalledTimes(2))
    expect(visible().properties.map((item) => item.key)).toEqual(["First", "Second"])
    await act(async () => {
      second.resolve()
      await b
    })
    expect(visible().customProperties).toHaveLength(2)
    expect(useDocStore.getState().openDocs.note.content).toBe("local body")
    expect(useDocStore.getState().openDocs.note.revision).toBe("r0")
  })

  it("keeps the latest icon while an earlier icon save is still finishing", async () => {
    const base = { ...property("Choice"), id: "choice-id", icon: "◆" }
    records.set(base.id, base)
    useDocStore.getState().patchDoc("note", {
      noteProperties: {
        hasFrontmatter: true,
        properties: [{ key: base.name, value: base.value, valueKind: "text" }],
        customProperties: [base],
      },
    })
    const first = deferred<void>(),
      second = deferred<void>()
    vi.mocked(storage.upsertCustomProperty).mockImplementation(async (_vault, _id, item) => {
      await (item.icon === "🌿" ? first.promise : second.promise)
      records.set(item.id, item)
      return item
    })
    const hook = open()
    let a!: Promise<storage.CustomProperty>, b!: Promise<storage.CustomProperty>
    act(() => {
      a = hook.result.current.handleUpsertCustomProperty({ ...base, icon: "🌿" })
    })
    act(() => {
      b = hook.result.current.handleUpsertCustomProperty({ ...base, icon: "⭐" })
    })
    const icon = () => useDocStore.getState().openDocs.note.noteProperties?.customProperties[0].icon
    expect(icon()).toBe("⭐")
    await waitFor(() => expect(storage.upsertCustomProperty).toHaveBeenCalledTimes(1))
    await act(async () => {
      first.resolve()
      await a
    })
    await waitFor(() => expect(storage.upsertCustomProperty).toHaveBeenCalledTimes(2))
    expect(icon()).toBe("⭐")
    await act(async () => {
      second.resolve()
      await b
    })
    expect(icon()).toBe("⭐")
  })

  it("refuses a new property write during a vault switch", async () => {
    const hook = open()
    act(() => useVaultStore.setState({ switching: true }))
    await act(async () => {
      await expect(
        hook.result.current.handleUpsertCustomProperty(property("Blocked")),
      ).rejects.toThrow("Vault switch in progress")
    })
    expect(storage.upsertCustomProperty).not.toHaveBeenCalled()
    expect(useDocStore.getState().openDocs.note.noteProperties).toEqual(empty)
    expect(hook.result.current.propertyError).toContain("Не удалось сохранить")
    act(() => useVaultStore.setState({ switching: false }))
  })

  it("does not apply an old note's result after switching vaults", async () => {
    const pending = deferred<void>()
    vi.mocked(storage.upsertCustomProperty).mockImplementation(async (_vault, _id, item) => {
      await pending.promise
      return item
    })
    const hook = open()
    let writing!: Promise<storage.CustomProperty>
    act(() => {
      writing = hook.result.current.handleUpsertCustomProperty(property("Old"))
    })
    await waitFor(() => expect(storage.upsertCustomProperty).toHaveBeenCalledTimes(1))
    act(() => {
      useVaultStore.setState({ vault: "/other", generation: ++generation })
      useDocStore.getState().setDoc("note", {
        ...useDocStore.getState().openDocs.note,
        path: "/other/Note.md",
        noteProperties: empty,
        revision: "other",
      })
    })
    await act(async () => {
      pending.resolve()
      await writing
    })
    expect(useDocStore.getState().openDocs.note.noteProperties).toEqual(empty)
    expect(useDocStore.getState().openDocs.note.revision).toBe("other")
    expect(storage.readNote).not.toHaveBeenCalled()
  })

  it("rolls a failed write back to durable properties and exposes the failure", async () => {
    vi.mocked(storage.upsertCustomProperty).mockRejectedValue(new Error("disk unavailable"))
    const hook = open()
    await act(async () => {
      await expect(
        hook.result.current.handleUpsertCustomProperty(property("Failed")),
      ).rejects.toThrow("disk unavailable")
    })
    expect(useDocStore.getState().openDocs.note.noteProperties?.customProperties).toEqual([])
    expect(hook.result.current.propertyError).toContain("Не удалось сохранить")
  })
})
