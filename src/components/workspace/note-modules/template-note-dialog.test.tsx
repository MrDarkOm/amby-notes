// @vitest-environment happy-dom
// The dialog for a note from a template offers to make the first template, and a new one at any
// time; a template is made by name and the note dialog keeps its own path.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { listNoteTemplates } from "@/lib/storage"
import { TemplateNoteDialog } from "./template-note-dialog"
import { useNoteModulesStore } from "./note-modules-store"

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  listNoteTemplates: vi.fn(),
}))

const list = vi.mocked(listNoteTemplates)

beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage("ru")
  useNoteModulesStore.setState({ open: true, parentPath: "/v/Projects" })
})
afterEach(cleanup)

describe("the template dialog", () => {
  it("offers to make the first template when there is none, by name", async () => {
    list.mockResolvedValue([])
    const onCreate = vi.fn(async () => {})
    const onCreateTemplate = vi.fn(async () => {})
    render(<TemplateNoteDialog onCreate={onCreate} onCreateTemplate={onCreateTemplate} />)
    fireEvent.click(await screen.findByRole("button", { name: "Создать шаблон" }))
    expect(screen.getByText("Новый шаблон")).toBeTruthy()
    expect(screen.getByText(/Вместо \{\{title\}\}, \{\{date\}\} и \{\{time\}\}/u)).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Название шаблона"), { target: { value: " Встреча " } })
    fireEvent.click(screen.getByRole("button", { name: "Создать шаблон" }))
    await waitFor(() => expect(onCreateTemplate).toHaveBeenCalledWith("Встреча"))
    expect(onCreate).not.toHaveBeenCalled()
    expect(useNoteModulesStore.getState().open).toBe(false)
  })

  it("makes a note from the chosen template and offers a new template beside the list", async () => {
    list.mockResolvedValue([
      { name: "Встреча", path: "Templates/Встреча.md" },
      { name: "День", path: "Templates/День.md" },
    ])
    const onCreate = vi.fn(async () => {})
    render(<TemplateNoteDialog onCreate={onCreate} onCreateTemplate={vi.fn()} />)
    fireEvent.click(await screen.findByRole("radio", { name: "День" }))
    expect(screen.getByRole("button", { name: "Новый шаблон" })).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Планёрка" } })
    fireEvent.click(screen.getByRole("button", { name: "Создать" }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("/v/Projects", "Планёрка", "День"))
  })
})
