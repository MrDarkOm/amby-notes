// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { readArchivePreview, type ArchiveEntry, type TrashPreview } from "@/lib/storage"
import { ArchivePreview } from "./archive-preview"

vi.mock("@/lib/storage", () => ({ readArchivePreview: vi.fn() }))
const entry: ArchiveEntry = {
  id: "archive",
  name: "Note.md",
  originalPath: "Folder/Note.md",
  archivedAtMs: 1,
}
const text = (value: string, path = ""): TrashPreview => ({
  path,
  directory: false,
  text: value,
  children: [],
  truncated: false,
})
const folder: TrashPreview = {
  path: "",
  directory: true,
  text: null,
  truncated: false,
  children: [
    { name: "A.md", path: "A.md", directory: false },
    { name: "B.md", path: "B.md", directory: false },
  ],
}
function mount() {
  const onRestore = vi.fn()
  const onClose = vi.fn()
  render(
    <ArchivePreview
      entry={entry}
      busy={false}
      actionError={null}
      onClose={onClose}
      onRestore={onRestore}
    />,
  )
  return { onRestore, onClose }
}
beforeEach(async () => {
  vi.resetAllMocks()
  await i18n.changeLanguage("ru")
})
afterEach(cleanup)

describe("archive preview", () => {
  it("renders archived text literally without executing HTML or loading images", async () => {
    const content = '<script>alert(1)</script><img src="https://example.invalid/private">'
    vi.mocked(readArchivePreview).mockResolvedValue(text(content))
    const { onRestore } = mount()
    expect(await screen.findByText(content)).toBeTruthy()
    expect(document.querySelector("img, script")).toBeNull()
    expect(onRestore).not.toHaveBeenCalled()
  })

  it("navigates archived directories and ignores a cancelled file response", async () => {
    let resolveA!: (preview: TrashPreview) => void
    vi.mocked(readArchivePreview).mockImplementation(async (_, path) => {
      if (path === "") return folder
      if (path === "A.md")
        return new Promise((resolve) => {
          resolveA = resolve
        })
      return text("Content B", "B.md")
    })
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "A.md" }))
    fireEvent.click(await screen.findByRole("button", { name: "Назад к содержимому папки" }))
    fireEvent.click(await screen.findByRole("button", { name: "B.md" }))
    expect(await screen.findByText("Content B")).toBeTruthy()
    await act(async () => {
      resolveA(text("Stale A", "A.md"))
    })
    expect(screen.queryByText("Stale A")).toBeNull()
    expect(screen.getByText("Content B")).toBeTruthy()
  })

  it("reports a missing entry and retries without restoring it", async () => {
    vi.mocked(readArchivePreview)
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValue(text("Recovered read"))
    const { onRestore } = mount()
    expect(await screen.findByRole("alert")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }))
    expect(await screen.findByText("Recovered read")).toBeTruthy()
    expect(onRestore).not.toHaveBeenCalled()
  })

  it("makes restoration an explicit separate action", async () => {
    vi.mocked(readArchivePreview).mockResolvedValue(text("Archived"))
    const { onRestore } = mount()
    await screen.findByText("Archived")
    fireEvent.click(screen.getByRole("button", { name: "Восстановить" }))
    expect(onRestore).toHaveBeenCalledTimes(1)
  })
})
