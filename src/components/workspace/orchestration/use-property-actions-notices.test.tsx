// @vitest-environment happy-dom
// The notices follow what the panel does: a rename moves the item of the report of the migration,
// and a command that fails raises the notice «Не удалось сохранить свойство».
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import * as storage from "@/lib/storage"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { usePropertyMigrationStore } from "../note-notices/use-property-migration-store"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { usePropertyActions } from "./use-property-actions"
import { desktopOperationError } from "@/lib/storage/operation-error"

vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  renameProperty: vi.fn(),
  getNoteProperties: vi.fn(),
  readNote: vi.fn(),
}))

const empty = { hasFrontmatter: true, properties: [], customProperties: [] }
function open() {
  return renderHook(() => {
    const currentDoc = useDocStore((state) => state.openDocs.note)
    const vault = useVaultStore((state) => state.vault)
    return usePropertyActions({
      currentDoc,
      vault,
      activeTab: null,
      treeItemById: new Map(),
      linkGraph: { edges: [] },
      t: i18n.t,
    })
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  useNoteNoticesStore.setState(useNoteNoticesStore.getInitialState())
  usePropertyMigrationStore.setState(usePropertyMigrationStore.getInitialState())
  useDocStore.getState().clearDocs()
  useVaultStore.setState({ vault: "/vault", generation: 900, switching: false })
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
    noteProperties: empty,
  })
  vi.mocked(storage.getNoteProperties).mockResolvedValue(empty)
  vi.mocked(storage.readNote).mockResolvedValue({ content: "body", source: "body", revision: "r1" })
})
afterEach(cleanup)

describe("properties and the notices", () => {
  it("a rename moves the item of the report of the migration to the new name", async () => {
    vi.mocked(storage.renameProperty).mockResolvedValue(undefined)
    usePropertyMigrationStore.setState({
      key: "k",
      outcome: {
        state: "migrated",
        reason: null,
        migrationId: "M",
        diverged: [{ noteId: "note", name: "Статус", fileValue: "А", headerValue: "Б" }],
      },
    })
    const hook = open()
    await act(async () => {
      await hook.result.current.handleRenameProperty("Статус", "Статусы")
    })
    expect(usePropertyMigrationStore.getState().renamed["note\u0000Статус"]).toBe("Статусы")
  })

  it("a failed command raises the notice and the next success clears it", async () => {
    vi.mocked(storage.renameProperty).mockRejectedValueOnce(new Error("refused"))
    const hook = open()
    await act(async () => {
      await hook.result.current.handleRenameProperty("А", "Б").catch(() => undefined)
    })
    expect(useNoteNoticesStore.getState().propertyFailed.note).toBe(true)
    vi.mocked(storage.renameProperty).mockResolvedValueOnce(undefined)
    await act(async () => {
      await hook.result.current.handleRenameProperty("А", "Б")
    })
    expect(useNoteNoticesStore.getState().propertyFailed.note).toBeUndefined()
  })

  it("a property another computer changed or removed rereads the panel and says so (З65)", async () => {
    await i18n.changeLanguage("ru")
    const changed = {
      ...empty,
      customProperties: [
        { id: "p", name: "Статус 2", icon: "", propertyType: "text", value: "", settings: "" },
      ],
    }
    vi.mocked(storage.renameProperty).mockRejectedValueOnce(
      desktopOperationError("No such property: Статус"),
    )
    vi.mocked(storage.getNoteProperties).mockResolvedValue(changed)
    const hook = open()
    await act(async () => {
      await hook.result.current.handleRenameProperty("Статус", "Другое").catch(() => undefined)
    })
    expect(useDocStore.getState().openDocs.note.noteProperties).toEqual(changed)
    expect(hook.result.current.propertyError).toBe(
      "Это свойство изменили на другом компьютере. Панель обновлена, повторите правку.",
    )
  })

  it("any other failure still says that the property was not saved", async () => {
    await i18n.changeLanguage("ru")
    vi.mocked(storage.renameProperty).mockRejectedValueOnce(new Error("refused"))
    const hook = open()
    await act(async () => {
      await hook.result.current.handleRenameProperty("А", "Б").catch(() => undefined)
    })
    expect(hook.result.current.propertyError).toBe(
      "Не удалось сохранить свойство. Повторите попытку.",
    )
  })
})
