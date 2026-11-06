// @vitest-environment happy-dom
// After another computer changed the properties (docs/sync-plan.md, З65) the open notes read them
// again, but never over a local edit that is still going.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as storage from "@/lib/storage"
import { beginPropertyMutation } from "../note-mutation-queue"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { rereadOpenNoteProperties, touchesNoteProperties } from "./reread-note-properties"

vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  getNoteProperties: vi.fn(),
}))

const before = { hasFrontmatter: true, properties: [], customProperties: [] }
const fresh = {
  hasFrontmatter: true,
  properties: [],
  customProperties: [
    { id: "p", name: "Статус", icon: "star", propertyType: "text", value: "", settings: "" },
  ],
}
let generation = 700

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function put(id: string, withProperties = true) {
  useDocStore.getState().setDoc(id, {
    id,
    noteId: id,
    path: `/vault/${id}.md`,
    title: id,
    content: "body",
    source: "body",
    revision: "r0",
    created: "",
    modified: "",
    wordCount: 1,
    ...(withProperties ? { noteProperties: before } : {}),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  useDocStore.getState().clearDocs()
  useVaultStore.setState({ vault: "/vault", generation: ++generation, switching: false })
  vi.mocked(storage.getNoteProperties).mockResolvedValue(fresh)
})
afterEach(() => useDocStore.getState().clearDocs())

describe("which written paths concern the properties", () => {
  it("the groups, the marks, the layout and the old file do", () => {
    expect(touchesNoteProperties([".amby/properties/prop_a.jsonl"])).toBe(true)
    expect(touchesNoteProperties([".amby/properties/legacy_3.jsonl"])).toBe(true)
    expect(touchesNoteProperties([".amby/properties/layout.json"])).toBe(true)
    expect(touchesNoteProperties([".amby/properties.json"])).toBe(true)
    expect(touchesNoteProperties([".amby/blocks/n.json", ".amby/properties/prop_0.jsonl"])).toBe(
      true,
    )
  })

  it("other files of .amby/ and similar names do not", () => {
    expect(touchesNoteProperties([])).toBe(false)
    expect(touchesNoteProperties([".amby/blocks/n.json"])).toBe(false)
    expect(touchesNoteProperties([".amby/property-backups/a.json"])).toBe(false)
    expect(touchesNoteProperties([".amby/properties-old/x"])).toBe(false)
    expect(touchesNoteProperties(["Notes/.amby/properties/prop_a.jsonl"])).toBe(false)
  })
})

describe("rereading the open notes", () => {
  it("reads the properties of every open note that has them and patches the panel", async () => {
    put("a")
    put("b")
    put("c", false)
    await rereadOpenNoteProperties("/vault", generation)
    expect(storage.getNoteProperties).toHaveBeenCalledTimes(2)
    expect(useDocStore.getState().openDocs.a.noteProperties).toEqual(fresh)
    expect(useDocStore.getState().openDocs.b.noteProperties).toEqual(fresh)
    expect(useDocStore.getState().openDocs.c.noteProperties).toBeUndefined()
  })

  it("leaves the body and its revision alone", async () => {
    put("a")
    await rereadOpenNoteProperties("/vault", generation)
    const doc = useDocStore.getState().openDocs.a
    expect([doc.content, doc.source, doc.revision]).toEqual(["body", "body", "r0"])
  })

  it("skips a note whose local edit is still going", async () => {
    put("a")
    put("b")
    const edit = beginPropertyMutation(generation, "a")
    await rereadOpenNoteProperties("/vault", generation)
    expect(useDocStore.getState().openDocs.a.noteProperties).toEqual(before)
    expect(useDocStore.getState().openDocs.b.noteProperties).toEqual(fresh)
    edit.finish()
  })

  it("drops the answer when a local edit began while it was being read", async () => {
    put("a")
    const late = deferred<typeof fresh>()
    vi.mocked(storage.getNoteProperties).mockReturnValue(late.promise)
    const done = rereadOpenNoteProperties("/vault", generation)
    const edit = beginPropertyMutation(generation, "a")
    late.resolve(fresh)
    await done
    expect(useDocStore.getState().openDocs.a.noteProperties).toEqual(before)
    edit.finish()
  })

  it("does nothing for another vault or a later opening of the vault", async () => {
    put("a")
    await rereadOpenNoteProperties("/other", generation)
    await rereadOpenNoteProperties("/vault", generation - 1)
    expect(storage.getNoteProperties).not.toHaveBeenCalled()
    const late = deferred<typeof fresh>()
    vi.mocked(storage.getNoteProperties).mockReturnValue(late.promise)
    const done = rereadOpenNoteProperties("/vault", generation)
    useVaultStore.setState({ generation: generation + 1 })
    late.resolve(fresh)
    await done
    expect(useDocStore.getState().openDocs.a.noteProperties).toEqual(before)
  })

  it("a note that cannot be read keeps what it had and the others go on", async () => {
    put("a")
    put("b")
    vi.mocked(storage.getNoteProperties).mockImplementation(async (_vault, id) => {
      if (id === "a") throw new Error("gone")
      return fresh
    })
    await rereadOpenNoteProperties("/vault", generation)
    expect(useDocStore.getState().openDocs.a.noteProperties).toEqual(before)
    expect(useDocStore.getState().openDocs.b.noteProperties).toEqual(fresh)
  })
})
