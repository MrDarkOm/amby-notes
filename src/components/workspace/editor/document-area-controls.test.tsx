// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { useSettingsStore } from "../use-settings-store"
import { DocumentAreaControls } from "./document-area-controls"

afterEach(() => {
  cleanup()
  const editor = useSettingsStore.getState().prefs.editor
  useSettingsStore.setState({
    prefs: { ...useSettingsStore.getState().prefs, editor: { ...editor, showAreaControls: true } },
  })
})

const base = { wordCount: 12, onUndo: vi.fn(), onRedo: vi.fn() }

describe("the note's floating bar, drawn by the shared bar", () => {
  it("shows when the note changed and its words, then undo, redo, lock and settings", () => {
    render(<DocumentAreaControls {...base} docModified="12:00" onToggleLock={vi.fn()} />)
    expect(screen.getByText("12:00")).toBeTruthy()
    expect(screen.getByText("12 сл.")).toBeTruthy()
    for (const title of [
      "Отменить (Ctrl+Z)",
      "Повторить (Ctrl+Y)",
      "Режим просмотра",
      "Настройки",
    ]) {
      expect(screen.getByTitle(title)).toBeTruthy()
    }
  })

  it("takes undo and redo away while the note is locked and says how to unlock it", () => {
    const toggle = vi.fn()
    render(<DocumentAreaControls {...base} isLocked onToggleLock={toggle} />)
    expect(screen.queryByTitle("Отменить (Ctrl+Z)")).toBeNull()
    fireEvent.click(screen.getByTitle("Режим редактирования"))
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it("has no lock button without a lock to toggle", () => {
    render(<DocumentAreaControls {...base} />)
    expect(screen.queryByTitle("Режим просмотра")).toBeNull()
  })

  it("offers the content width in its settings and hides the bar on request", async () => {
    const onContentWidthChange = vi.fn()
    const { container } = render(
      <DocumentAreaControls {...base} onContentWidthChange={onContentWidthChange} />,
    )
    const settings = screen.getByTitle("Настройки")
    fireEvent.pointerDown(settings, { button: 0, ctrlKey: false })
    fireEvent.click(settings)
    fireEvent.click(screen.getByRole("button", { name: "100%" }))
    expect(onContentWidthChange).toHaveBeenCalledWith("full")
    fireEvent.click(screen.getByRole("button", { name: "Скрыть нижнюю панель" }))
    await waitFor(() =>
      expect(useSettingsStore.getState().prefs.editor.showAreaControls).toBe(false),
    )
    expect(container.firstChild).toBeNull()
  })
})
