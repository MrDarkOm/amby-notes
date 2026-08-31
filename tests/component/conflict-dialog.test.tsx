// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from "vitest"
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react"
import "@/lib/i18n"
import { ExternalConflictDialog } from "@/components/workspace/external-conflict-dialog"
import { useDocStore } from "@/components/workspace/use-doc-store"

describe("ExternalConflictDialog component", () => {
  beforeEach(() => {
    cleanup()
    act(() => {
      useDocStore.setState({
        openDocs: {
          "note-1": {
            id: "note-1",
            path: "Note 1.md",
            content: "Local draft content",
            isDirty: true,
            viewMode: "live",
          },
        },
        externalConflicts: {},
      })
    })
  })

  it("does not render when there are no external conflicts", () => {
    const { container } = render(<ExternalConflictDialog vault={null} />)
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

    render(<ExternalConflictDialog vault={null} />)

    expect(screen.getByText("Обнаружен внешний конфликт")).toBeTruthy()
    expect(screen.getByText("Local draft content")).toBeTruthy()
    expect(screen.getByText("External disk changes")).toBeTruthy()

    const acceptBtn = screen.getByText("Принять внешнюю")
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

    render(<ExternalConflictDialog vault={null} />)

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
    expect(doc?.isDirty).toBe(true)
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

    render(<ExternalConflictDialog vault={null} />)

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
