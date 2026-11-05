// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import * as storage from "@/lib/storage"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { usePropertyActions } from "./use-property-actions"

// docs/sync-plan.md, З60: in a vault of the new format the panel calls the commands of the new
// format by the name of the property, never `upsertCustomProperty`. The backend is a map from
// name to icon that refuses a name it does not have, as the real one does.
vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  upsertCustomProperty: vi.fn(),
  setPropertyAppearance: vi.fn(),
  renameProperty: vi.fn(),
  getNoteProperties: vi.fn(),
  readNote: vi.fn(),
}))

const backend = new Map<string, string>()
const calls: string[] = []
const tree = new Map<string, storage.TreeItem>()
const links = { edges: [] }
let generation = 300

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function propertiesOfBackend() {
  return [...backend.entries()].map(([name, icon]) => ({
    id: "",
    name,
    icon,
    propertyType: "text",
    value: "x",
    settings: "",
  }))
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
const visible = () => useDocStore.getState().openDocs.note.noteProperties!.customProperties

beforeEach(() => {
  vi.resetAllMocks()
  backend.clear()
  calls.length = 0
  backend.set("Choice", "◆")
  useDocStore.getState().clearDocs()
  useVaultStore.setState({ vault: "/vault", generation: ++generation, switching: false })
  useDocStore.getState().setDoc("note", {
    id: "note",
    noteId: "note",
    path: "/vault/Note.md",
    title: "Note",
    content: "body",
    source: "body",
    revision: "r0",
    created: "",
    modified: "",
    wordCount: 1,
    noteProperties: {
      hasFrontmatter: true,
      properties: [{ key: "Choice", value: "x", valueKind: "text" }],
      customProperties: propertiesOfBackend(),
    },
  })
  vi.mocked(storage.getNoteProperties).mockImplementation(async () => ({
    hasFrontmatter: true,
    customProperties: propertiesOfBackend(),
    properties: propertiesOfBackend().map((item) => ({
      key: item.name,
      value: item.value,
      valueKind: "text",
    })),
  }))
  vi.mocked(storage.readNote).mockResolvedValue({ content: "body", source: "body", revision: "r1" })
  vi.mocked(storage.setPropertyAppearance).mockImplementation(async (_v, _n, name, icon) => {
    calls.push(`icon:${name}:${icon}`)
    if (!backend.has(name)) throw new Error(`no property named ${name}`)
    backend.set(name, icon)
  })
  vi.mocked(storage.renameProperty).mockImplementation(async (_v, _n, name, newName) => {
    calls.push(`rename:${name}:${newName}`)
    const icon = backend.get(name)
    if (icon === undefined) throw new Error(`no property named ${name}`)
    backend.delete(name)
    backend.set(newName, icon)
  })
})
afterEach(cleanup)

describe("properties by name (З60)", () => {
  it("changes an icon through the command of the new format, not through upsert", async () => {
    const hook = open()
    await act(async () => {
      await hook.result.current.handleSetPropertyAppearance("Choice", "🌿", "")
    })
    expect(storage.setPropertyAppearance).toHaveBeenCalledWith("/vault", "note", "Choice", "🌿", "")
    expect(storage.upsertCustomProperty).not.toHaveBeenCalled()
    expect(visible().find((item) => item.name === "Choice")?.icon).toBe("🌿")
  })

  it("icon, rename, icon: the third command carries the new name and the last icon", async () => {
    const first = deferred<void>()
    vi.mocked(storage.setPropertyAppearance).mockImplementationOnce(async (_v, _n, name, icon) => {
      calls.push(`icon:${name}:${icon}`)
      await first.promise
      backend.set(name, icon)
    })
    const hook = open()
    let a!: Promise<void>, b!: Promise<void>, c!: Promise<void>
    act(() => {
      a = hook.result.current.handleSetPropertyAppearance("Choice", "🌿", "")
    })
    act(() => {
      b = hook.result.current.handleRenameProperty("Choice", "Pick")
    })
    // the user sees «Pick» at once and changes its icon while the first save is still going
    act(() => {
      c = hook.result.current.handleSetPropertyAppearance("Pick", "⭐", "")
    })
    expect(visible().map((item) => [item.name, item.icon])).toEqual([["Pick", "⭐"]])
    await waitFor(() => expect(calls).toEqual(["icon:Choice:🌿"]))
    await act(async () => {
      first.resolve()
      await Promise.all([a, b, c])
    })
    expect(calls).toEqual(["icon:Choice:🌿", "rename:Choice:Pick", "icon:Pick:⭐"])
    expect([...backend.entries()]).toEqual([["Pick", "⭐"]])
    expect(hook.result.current.propertyError).toBeNull()
    expect(visible().map((item) => [item.name, item.icon])).toEqual([["Pick", "⭐"]])
    expect(storage.upsertCustomProperty).not.toHaveBeenCalled()
  })

  it("keeps every one of quick successive edits of one property, in order", async () => {
    const hook = open()
    await act(async () => {
      await Promise.all(
        ["1", "2", "3", "4", "5"].map((icon) =>
          hook.result.current.handleSetPropertyAppearance("Choice", icon, ""),
        ),
      )
    })
    expect(calls).toEqual(["1", "2", "3", "4", "5"].map((icon) => `icon:Choice:${icon}`))
    expect(backend.get("Choice")).toBe("5")
    expect(visible()[0].icon).toBe("5")
  })

  it("shows the real state again when a command fails", async () => {
    vi.mocked(storage.renameProperty).mockRejectedValueOnce(new Error("refused"))
    const hook = open()
    await act(async () => {
      await hook.result.current.handleRenameProperty("Choice", "Pick").catch(() => undefined)
    })
    expect(visible().map((item) => item.name)).toEqual(["Choice"])
    expect(hook.result.current.propertyError).not.toBeNull()
  })
})
