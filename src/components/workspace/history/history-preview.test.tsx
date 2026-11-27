// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { useHistory } from "./use-history"
import { HistoryPreview } from "./history-preview"

vi.mock("./use-history", () => ({ useHistory: vi.fn() }))
type History = ReturnType<typeof useHistory>
const oldText = "# Сохранённая версия\n\n**Было**\n"
const currentText = "# Текущая заметка\n\n**Стало**\n"
function history(): History {
  const snapshots = [
    {
      id: "old",
      createdAtMs: new Date(2026, 9, 29, 12).getTime(),
      reason: "note-save",
      sizeBytes: 20,
    },
    {
      id: "other",
      createdAtMs: new Date(2026, 9, 28, 12).getTime(),
      reason: "note-save",
      sizeBytes: 20,
    },
  ]
  return {
    snapshots,
    stats: { snapshotCount: 2, noteCount: 1, sizeBytes: 40 },
    loading: false,
    busy: false,
    error: "",
    notice: "",
    selected: snapshots[0],
    preview: { previous: oldText, current: currentText },
    previewLoading: false,
    refresh: vi.fn(),
    select: vi.fn(),
    restore: vi.fn(),
    cleanup: vi.fn(),
    removeSnapshot: vi.fn(),
    clearAll: vi.fn(),
    openLatest: vi.fn(),
  } as unknown as History
}
beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage("ru")
})
afterEach(cleanup)

describe("history Read preview", () => {
  it("renders both versions in Read mode and switches both to exact source without restoring", async () => {
    const state = history()
    vi.mocked(useHistory).mockReturnValue(state)
    const { container } = render(
      <HistoryPreview history={state} name="Заметка" path="/vault/Note.md" treeItems={[]} />,
    )
    expect(await screen.findByRole("heading", { name: "Сохранённая версия" })).toBeTruthy()
    expect(await screen.findByRole("heading", { name: "Текущая заметка" })).toBeTruthy()
    expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Исходный текст" }))
    const sources = [...document.querySelectorAll("pre")].map((element) => element.textContent)
    expect(sources).toContain(oldText)
    expect(sources).toContain(currentText)
    expect(state.restore).not.toHaveBeenCalled()
    expect(state.removeSnapshot).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Просмотр" }))
    expect(await screen.findByRole("heading", { name: "Сохранённая версия" })).toBeTruthy()
  })

  it("shows another selected snapshot without changing the current note pane", async () => {
    const state = history()
    vi.mocked(useHistory).mockReturnValue(state)
    const { rerender } = render(
      <HistoryPreview history={state} name="Заметка" path="/vault/Note.md" treeItems={[]} />,
    )
    await screen.findByRole("heading", { name: "Сохранённая версия" })
    const changed = {
      ...state,
      selected: state.snapshots[1],
      preview: { previous: "# Другой снимок\n", current: currentText },
    }
    vi.mocked(useHistory).mockReturnValue(changed)
    rerender(
      <HistoryPreview history={changed} name="Заметка" path="/vault/Note.md" treeItems={[]} />,
    )
    expect(await screen.findByRole("heading", { name: "Другой снимок" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Сохранённая версия" })).toBeNull()
    expect(screen.getByRole("heading", { name: "Текущая заметка" })).toBeTruthy()
  })
})
