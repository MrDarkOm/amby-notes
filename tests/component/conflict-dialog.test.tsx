// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react"
import "@/lib/i18n"
import { ExternalConflictDialog } from "@/components/workspace/external-conflict-dialog"
import { useDocStore } from "@/components/workspace/use-doc-store"
import { useVaultStore } from "@/components/workspace/use-vault-store"
import * as storage from "@/lib/storage"
import { AUTOSAVE_CONFLICT_RESOLVED_EVENT } from "@/components/workspace/autosave/conflict-events"

describe("ExternalConflictDialog component", () => {
  beforeEach(() => {
    cleanup()
    useVaultStore.setState({ vault: null, backendGeneration: null })
    act(() => {
      useDocStore.setState({
        openDocs: {
          "note-1": {
            id: "note-1",
            path: "Note 1.md",
            content: "Local draft content",
            title: "Note",
            created: "",
            modified: "",
            wordCount: 3,
            source: "Local draft content",
            revision: "saved-revision",
          },
        },
        externalConflicts: {},
        activeConflictDialogFileId: null,
        unsavedFileIds: new Set(["note-1"]),
      })
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function showConflict() {
    act(() =>
      useDocStore.getState().setExternalConflict({
        fileId: "note-1",
        path: "Note 1.md",
        localContent: "Local draft content",
        externalContent: "External disk changes",
        externalRevision: "external-revision",
      }),
    )
    render(<ExternalConflictDialog />)
  }

  it("shows two main choices and keeps additional actions collapsed", () => {
    showConflict()
    expect(screen.getByRole("button", { name: "Сохранить текст из Amby" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Загрузить текст с диска" })).toBeTruthy()
    // happy-dom does not model the browser's native <details> visibility.
    expect(screen.getByText("Другие варианты").closest("details")?.open).toBe(false)
  })

  it("closes with the cross, preserves unsaved edits, and can be reopened explicitly", () => {
    showConflict()
    fireEvent.click(screen.getByRole("button", { name: "Закрыть", exact: true }))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(useDocStore.getState().openDocs["note-1"].content).toBe("Local draft content")
    expect(useDocStore.getState().unsavedFileIds.has("note-1")).toBe(true)
    const conflict = useDocStore.getState().externalConflicts["note-1"]
    expect(conflict).toBeDefined()
    act(() =>
      useDocStore
        .getState()
        .setExternalConflict({ ...conflict, externalContent: "Updated disk text" }),
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    act(() => useDocStore.getState().openConflictDialog("note-1"))
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.getByText("Updated disk text")).toBeTruthy()
  })

  it("shows the latest local buffer after the user dismissed the conflict and continued editing", () => {
    showConflict()
    fireEvent.click(screen.getByRole("button", { name: "Закрыть", exact: true }))
    act(() => {
      useDocStore.getState().patchDoc("note-1", { content: "More recent edits" })
      useDocStore.getState().openConflictDialog("note-1")
    })
    expect(screen.getByText("More recent edits")).toBeTruthy()
    expect(screen.queryByText("Local draft content")).toBeNull()
  })

  it("shows a failed save without discarding either version", async () => {
    vi.spyOn(storage, "writeFile").mockRejectedValue(new Error("disk full"))
    showConflict()
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Сохранить текст из Amby" })),
    )
    expect(screen.getByRole("alert").textContent).toContain("Не удалось сохранить текст")
    expect(useDocStore.getState().externalConflicts["note-1"]).toBeDefined()
    expect(useDocStore.getState().openDocs["note-1"].content).toBe("Local draft content")
    expect(useDocStore.getState().unsavedFileIds.has("note-1")).toBe(true)
  })

  it("refreshes the comparison when the disk changes again before the chosen local save", async () => {
    useVaultStore.setState({ vault: "/vault", backendGeneration: 1 })
    vi.spyOn(storage, "writeNote").mockRejectedValue(
      new storage.NoteRevisionConflictError("new-revision"),
    )
    vi.spyOn(storage, "readNote").mockResolvedValue({
      content: "New disk changes",
      revision: "new-revision",
      source: "New disk source",
    })
    showConflict()
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Сохранить текст из Amby" })),
    )
    expect(screen.getByRole("alert").textContent).toContain("Файл снова изменился")
    expect(screen.getByText("New disk changes")).toBeTruthy()
    expect(useDocStore.getState().externalConflicts["note-1"].externalRevision).toBe("new-revision")
    expect(useDocStore.getState().unsavedFileIds.has("note-1")).toBe(true)
  })

  it("preserves edits that arrive while the local version is saving", async () => {
    let finish!: () => void
    vi.spyOn(storage, "writeFile").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const resolved = vi.fn()
    window.addEventListener(AUTOSAVE_CONFLICT_RESOLVED_EVENT, resolved)
    try {
      showConflict()
      fireEvent.click(screen.getByRole("button", { name: "Сохранить текст из Amby" }))
      expect(screen.queryByRole("button", { name: "Закрыть", exact: true })).toBeNull()
      act(() => useDocStore.getState().patchDoc("note-1", { content: "Newer edits during save" }))
      await act(async () => finish())
      expect(useDocStore.getState().unsavedFileIds.has("note-1")).toBe(true)
      expect(useDocStore.getState().openDocs["note-1"].content).toBe("Newer edits during save")
      expect((resolved.mock.calls[0][0] as CustomEvent).detail.resolution).toBe("resume")
    } finally {
      window.removeEventListener(AUTOSAVE_CONFLICT_RESOLVED_EVENT, resolved)
    }
  })

  it("does not render when there are no external conflicts", () => {
    const { container } = render(<ExternalConflictDialog />)
    expect(container.firstChild).toBeNull()
  })

  it("renders conflict dialog and resolves via accept external", async () => {
    act(() => {
      useDocStore.getState().setExternalConflict({
        fileId: "note-1",
        path: "Note 1.md",
        localContent: "Local draft content",
        externalContent: "External disk changes",
        externalRevision: "external-revision",
      })
    })

    render(<ExternalConflictDialog />)

    expect(screen.getByText("Обнаружен внешний конфликт")).toBeTruthy()
    expect(screen.getByText("Local draft content")).toBeTruthy()
    expect(screen.getByText("External disk changes")).toBeTruthy()

    const acceptBtn = screen.getByText("Загрузить текст с диска")
    await act(async () => {
      fireEvent.click(acceptBtn)
    })

    const doc = useDocStore.getState().openDocs["note-1"]
    expect(doc?.content).toBe("External disk changes")
    expect(doc?.revision).toBe("external-revision")
    expect(useDocStore.getState().unsavedFileIds.has("note-1")).toBe(false)
    expect(useDocStore.getState().externalConflicts["note-1"]).toBeUndefined()
  })

  it("resolves via merge with conflict markers", async () => {
    act(() => {
      useDocStore.getState().setExternalConflict({
        fileId: "note-1",
        path: "Note 1.md",
        localContent: "Local draft content",
        externalContent: "External disk changes",
        externalRevision: "external-revision",
      })
    })

    render(<ExternalConflictDialog />)

    const mergeBtn = screen.getByText("Объединить вручную")
    await act(async () => {
      fireEvent.click(mergeBtn)
    })

    const doc = useDocStore.getState().openDocs["note-1"]
    expect(doc?.content).toContain("<<<<<<< Local Amby")
    expect(doc?.content).toContain("Local draft content")
    expect(doc?.content).toContain("=======")
    expect(doc?.content).toContain("External disk changes")
    expect(doc?.content).toContain(">>>>>>> External file")
    expect(doc?.revision).toBe("external-revision")
    expect(useDocStore.getState().unsavedFileIds.has("note-1")).toBe(true)
    expect(useDocStore.getState().externalConflicts["note-1"]).toBeUndefined()
  })

  it("renders external deletion message when externalContent is null", async () => {
    act(() => {
      useDocStore.getState().setExternalConflict({
        fileId: "note-1",
        path: "Note 1.md",
        localContent: "Local draft content",
        externalContent: null,
      })
    })

    render(<ExternalConflictDialog />)

    expect(screen.getByText("Файл был удалён вне Amby")).toBeTruthy()
    expect(screen.getByText("Оставить вкладку открытой")).toBeTruthy()
    expect(screen.getByText("Восстановить локальную")).toBeTruthy()

    const keepBtn = screen.getByText("Оставить вкладку открытой")
    await act(async () => {
      fireEvent.click(keepBtn)
    })

    expect(useDocStore.getState().externalConflicts["note-1"]).toBeUndefined()
  })
})
