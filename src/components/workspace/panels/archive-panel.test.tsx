// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import {
  listTrash,
  purgeTrash,
  readTrashPreview,
  restoreTrash,
  type TrashEntry,
} from "@/lib/storage"
import { confirm } from "@/lib/confirm"
import { ArchivePanel } from "./archive-panel"
import type { PanelRenderProps } from "../panel-registry"

vi.mock("@/lib/storage", () => ({
  listTrash: vi.fn(),
  readTrashPreview: vi.fn(),
  restoreTrash: vi.fn(),
  purgeTrash: vi.fn(),
}))
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn() }))
const props: PanelRenderProps = {
  treeItems: [],
  selectedId: null,
  vault: "/vault",
  onSelect: vi.fn(),
  onOpenVault: vi.fn(),
}
const entry: TrashEntry = {
  id: "archived-note",
  name: "Черновик.md",
  originalPath: "Мир/Черновик.md",
  deletedAtMs: Date.now(),
}
beforeEach(async () => {
  vi.resetAllMocks()
  await i18n.changeLanguage("ru")
  vi.mocked(listTrash).mockResolvedValue([entry])
  vi.mocked(restoreTrash).mockResolvedValue({
    primaryPath: "/vault/Мир/Черновик.md",
    pathChanges: [],
    deletedPaths: [],
  })
})
afterEach(cleanup)
const openActions = () =>
  fireEvent.pointerDown(screen.getByRole("button", { name: "Действия с «Черновик»" }), {
    button: 0,
    ctrlKey: false,
  })

describe("archive panel", () => {
  it("shows clean names, location, date and catalog count; searches the original path", async () => {
    render(<ArchivePanel {...props} />)
    expect(await screen.findByText("Черновик")).toBeTruthy()
    expect(screen.getByText("Мир")).toBeTruthy()
    expect(screen.getByText("1")).toBeTruthy()
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(entry.deletedAtMs).toISOString(),
    )
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Мир/Черновик.md" } })
    expect(screen.getByText("Черновик")).toBeTruthy()
  })

  it("switches row menus on the first press without blocking the rest of the workspace", async () => {
    vi.mocked(listTrash).mockResolvedValue([entry, { ...entry, id: "second", name: "Другая.md" }])
    render(<ArchivePanel {...props} />)
    await screen.findByText("Черновик")
    openActions()
    expect(document.body.style.pointerEvents).not.toBe("none")
    fireEvent.pointerDown(screen.getByRole("button", { name: "Действия с «Другая»" }), {
      button: 0,
      ctrlKey: false,
    })
    expect(
      screen.getByRole("button", { name: "Действия с «Черновик»" }).getAttribute("aria-expanded"),
    ).toBe("false")
    expect(
      screen.getByRole("button", { name: "Действия с «Другая»" }).getAttribute("aria-expanded"),
    ).toBe("true")
    expect(screen.getAllByRole("menu")).toHaveLength(1)
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    openActions()
    expect(screen.getByRole("menu")).toBeTruthy()
    expect(document.body.style.pointerEvents).not.toBe("none")
  })

  it("opens with Enter and stays open until explicitly dismissed", async () => {
    render(<ArchivePanel {...props} />)
    const trigger = await screen.findByRole("button", { name: "Действия с «Черновик»" })
    act(() => trigger.focus())
    fireEvent.keyDown(trigger, { key: "Enter" })
    fireEvent.keyUp(trigger, { key: "Enter" })
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"))
    expect(screen.getByRole("menuitem", { name: "Вернуть" })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"))
  })

  it("opens a read-only preview by name without restoring the entry", async () => {
    vi.mocked(readTrashPreview).mockResolvedValue({
      path: "",
      directory: false,
      text: "Archived content",
      children: [],
      truncated: false,
    })
    render(<ArchivePanel {...props} />)
    fireEvent.click(await screen.findByRole("button", { name: "Предпросмотр «Черновик»" }))
    expect(await screen.findByText("Archived content")).toBeTruthy()
    expect(readTrashPreview).toHaveBeenCalledExactlyOnceWith(entry.id, "")
    expect(restoreTrash).not.toHaveBeenCalled()
    expect(purgeTrash).not.toHaveBeenCalled()
  })

  it("opens preview from the menu without returning focus to the background trigger", async () => {
    vi.mocked(readTrashPreview).mockResolvedValue({
      path: "",
      directory: false,
      text: "Preview from menu",
      children: [],
      truncated: false,
    })
    render(<ArchivePanel {...props} />)
    await screen.findByText("Черновик")
    openActions()
    fireEvent.click(screen.getByRole("menuitem", { name: "Предпросмотр" }))
    expect(await screen.findByText("Preview from menu")).toBeTruthy()
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("tells the tree which file came back, so it refreshes that file only", async () => {
    vi.mocked(listTrash).mockResolvedValueOnce([entry]).mockResolvedValue([])
    const changed = vi.fn()
    window.addEventListener("amby:archive-changed", changed)
    try {
      render(<ArchivePanel {...props} />)
      fireEvent.click(await screen.findByRole("button", { name: "Восстановить «Черновик»" }))
      await waitFor(() => expect(changed).toHaveBeenCalled())
      const event = changed.mock.calls[0]![0] as CustomEvent<{ paths?: string[] }>
      expect(event.detail.paths).toEqual(["/vault/Мир/Черновик.md"])
    } finally {
      window.removeEventListener("amby:archive-changed", changed)
    }
  })

  it("restores the selected entry once and refreshes the catalog", async () => {
    vi.mocked(listTrash).mockResolvedValueOnce([entry]).mockResolvedValue([])
    render(<ArchivePanel {...props} />)
    fireEvent.click(await screen.findByRole("button", { name: "Восстановить «Черновик»" }))
    await waitFor(() => expect(restoreTrash).toHaveBeenCalledExactlyOnceWith(entry.id))
    expect(await screen.findByText("Архив пуст")).toBeTruthy()
    expect(purgeTrash).not.toHaveBeenCalled()
  })

  it("keeps the entry and shows a failure if restoring fails", async () => {
    vi.mocked(restoreTrash).mockRejectedValue(new Error("conflict"))
    render(<ArchivePanel {...props} />)
    fireEvent.click(await screen.findByRole("button", { name: "Восстановить «Черновик»" }))
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.getByText("Черновик")).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Восстановить «Черновик»" }).disabled,
    ).toBe(false)
  })

  it("requires confirmation before permanent deletion", async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    render(<ArchivePanel {...props} />)
    await screen.findByText("Черновик")
    openActions()
    fireEvent.click(screen.getByRole("menuitem", { name: "Удалить навсегда" }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    // The question names the note without an extension, says it is dangerous and names the verb.
    const question = vi.mocked(confirm).mock.calls[0][0]
    expect(question.title).toContain("Черновик")
    expect(question.title).not.toContain(".md")
    expect(question.destructive).toBe(true)
    expect(question.confirmLabel).toBe("Удалить")
    expect(purgeTrash).not.toHaveBeenCalled()
  })

  it("deletes the exact archive entry after confirmation", async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    vi.mocked(listTrash).mockResolvedValueOnce([entry]).mockResolvedValue([])
    render(<ArchivePanel {...props} />)
    await screen.findByText("Черновик")
    openActions()
    fireEvent.click(screen.getByRole("menuitem", { name: "Удалить навсегда" }))
    expect(await screen.findByText("Архив пуст")).toBeTruthy()
    expect(purgeTrash).toHaveBeenCalledExactlyOnceWith(entry.id)
    expect(restoreTrash).not.toHaveBeenCalled()
  })

  it("reports a failed catalog read and allows retrying", async () => {
    vi.mocked(listTrash).mockRejectedValueOnce(new Error("unavailable"))
    render(<ArchivePanel {...props} />)
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.queryByText("Архив пуст")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }))
    expect(await screen.findByText("Черновик")).toBeTruthy()
  })

  it("discards a stale response after a newer archive refresh", async () => {
    let resolveFirst!: (entries: TrashEntry[]) => void
    vi.mocked(listTrash).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve
      }),
    )
    render(<ArchivePanel {...props} />)
    act(() => {
      window.dispatchEvent(new Event("amby:archive-changed"))
    })
    expect(await screen.findByText("Черновик")).toBeTruthy()
    await act(async () => {
      resolveFirst([])
    })
    expect(screen.getByText("Черновик")).toBeTruthy()
  })
})
