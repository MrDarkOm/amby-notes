// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { workshopImport, type ImportSource } from "@/lib/storage"
import { WorkshopImportDialog } from "./workshop-import-dialog"

vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  workshopImport: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it("previews a folder and a database together, commits the chosen mapping, and undoes the batch", async () => {
  const sources: ImportSource[] = [
    { kind: "folder", sourceId: "Source", sectionId: "characters" },
    { kind: "database", sourceId: "entities", sectionId: "characters" },
  ]
  vi.mocked(workshopImport).mockImplementation(async ({ action }) => ({
    entries: [],
    added: action.kind === "apply" ? 2 : 0,
    preview:
      action.kind === "preview"
        ? {
            revision: "preview-1",
            writePath: "Workshop/amby-imports.json",
            sources: sources.map((source, index) => ({
              source,
              candidates: [
                {
                  noteId: `note-${index}`,
                  title: `Candidate ${index}`,
                  path: `Source/${index}.md`,
                  alreadyLinked: false,
                },
              ],
              sourceFields: [
                { key: "occupation", name: "Occupation", valueType: "text", example: "Pilot" },
              ],
              targetFields: [{ key: "role", name: "Role", valueType: "text", example: null }],
              suggested: [],
            })),
          }
        : null,
  }))
  render(
    <WorkshopImportDialog
      workshopId="workshop"
      generation={1}
      sections={[{ id: "characters", name: "Characters" }]}
      databases={[{ id: "entities", name: "Entities" }]}
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  )
  fireEvent.change(screen.getByLabelText("Путь к папке"), { target: { value: "Source" } })
  fireEvent.click(screen.getByRole("button", { name: "Добавить источник" }))
  const second = within(screen.getByRole("group", { name: "Источник 2" }))
  fireEvent.click(second.getByRole("combobox", { name: "Тип источника" }))
  fireEvent.click(await screen.findByRole("option", { name: "База Amby" }))
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
  fireEvent.click(second.getByRole("combobox", { name: "База Amby" }))
  fireEvent.click(await screen.findByRole("option", { name: "Entities" }))
  fireEvent.click(screen.getByRole("button", { name: "Предпросмотр" }))
  expect(await screen.findByText("Candidate 1")).toBeTruthy()
  fireEvent.click(screen.getAllByRole("combobox", { name: "Поле «Role»" })[1])
  fireEvent.click(await screen.findByRole("option", { name: /Occupation/ }))
  fireEvent.click(screen.getByRole("button", { name: "Подключить заметки" }))
  await screen.findByText("Подключено заметок: 2")
  const applied = vi.mocked(workshopImport).mock.calls[1][0].action
  expect(applied).toMatchObject({
    kind: "apply",
    sources,
    expectedPreview: "preview-1",
    selection: [
      { sourceIndex: 0, noteIds: ["note-0"], mappings: [] },
      {
        sourceIndex: 1,
        noteIds: ["note-1"],
        mappings: [{ sourceKey: "occupation", targetId: "role" }],
      },
    ],
  })
  fireEvent.click(screen.getByRole("button", { name: "Отменить импорт" }))
  expect(vi.mocked(workshopImport).mock.calls[2][0].action).toMatchObject({
    kind: "undo",
    operationId: applied.kind === "apply" ? applied.operationId : undefined,
  })
})
