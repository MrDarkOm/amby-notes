// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabasePropertySummary } from "@/lib/storage"
import { DossierTemplateDialog } from "./dossier-template-dialog"

const storage = vi.hoisted(() => ({
  getDossierTemplate: vi.fn(),
  updateDossierTemplate: vi.fn(),
  createDatabaseProperty: vi.fn(),
}))
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  ...storage,
}))

const property = (propertyId: string, name: string, propertyType = "text") =>
  ({
    propertyId,
    name,
    propertyType,
    configJson: "{}",
    options: [],
  }) as unknown as DatabasePropertySummary

const PROPERTIES = [property("role", "Роль"), property("imp", "Значимость", "select")]

function template(over: Record<string, unknown> = {}) {
  return {
    databaseId: "db_chars",
    templateId: "tpl",
    name: "Досье",
    body: "## Основное\n\n## Внешность\n\n",
    dossier: null,
    manifestRevision: "rev-1",
    ...over,
  }
}

const settle = () => act(async () => {})

describe("DossierTemplateDialog", () => {
  const onClose = vi.fn()
  const onSaved = vi.fn()

  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    storage.getDossierTemplate.mockReset().mockResolvedValue(template())
    storage.updateDossierTemplate.mockReset().mockImplementation(async (request) => ({
      template: template({ dossier: request.dossier, manifestRevision: "rev-2" }),
      warnings: [],
    }))
    storage.createDatabaseProperty.mockReset()
    onClose.mockReset()
    onSaved.mockReset()
  })
  afterEach(cleanup)

  function mount() {
    render(
      <DossierTemplateDialog
        open
        databaseId="db_chars"
        expectedGeneration={1}
        properties={PROPERTIES}
        knownHints={new Map([["Основное", "Возраст, занятие"]])}
        onClose={onClose}
        onSaved={onSaved}
      />,
    )
  }

  const titles = () =>
    screen.getAllByLabelText("Название раздела").map((field) => (field as HTMLInputElement).value)

  it("opens a template without a layout as its headings, with the known hints", async () => {
    mount()
    await settle()
    expect(storage.getDossierTemplate).toHaveBeenCalledWith("db_chars")
    expect(titles()).toEqual(["Основное", "Внешность"])
    expect(
      screen.getAllByLabelText("Подсказка").map((field) => (field as HTMLInputElement).value),
    ).toEqual(["Возраст, занятие", ""])
  })

  it("renames, adds and moves sections, adds a field, and saves the layout over the revision", async () => {
    mount()
    await settle()
    const [, look] = screen.getAllByLabelText("Название раздела")
    fireEvent.change(look, { target: { value: "Облик" } })
    fireEvent.click(screen.getByRole("button", { name: "Добавить раздел" }))
    const added = screen.getAllByLabelText("Название раздела")[2]
    fireEvent.change(added, { target: { value: "Голос" } })
    fireEvent.click(screen.getAllByRole("button", { name: "Выше" })[2])
    expect(titles()).toEqual(["Основное", "Голос", "Облик"])

    const basic = screen.getAllByRole("group", { name: /^Раздел/ })[0]
    fireEvent.keyDown(within(basic).getByRole("button", { name: "Добавить поле" }), {
      key: "Enter",
    })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Роль" }))

    fireEvent.click(screen.getByRole("button", { name: "Сохранить шаблон" }))
    await settle()
    const request = storage.updateDossierTemplate.mock.calls[0][0]
    expect(request).toMatchObject({
      expectedGeneration: 1,
      databaseId: "db_chars",
      templateId: "tpl",
      expectedManifestRevision: "rev-1",
    })
    expect(
      request.dossier.sections.map((section: { title: string; fields: string[] }) => [
        section.title,
        section.fields,
      ]),
    ).toEqual([
      ["Основное", ["role"]],
      ["Голос", []],
      ["Облик", []],
    ])
    expect(onSaved).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it("creates a new text field in a section and saves over the new revision", async () => {
    storage.createDatabaseProperty.mockResolvedValue({
      databaseId: "db_chars",
      propertyId: "height",
      name: "Рост",
      propertyType: "text",
      manifestRevision: "rev-after-field",
      operationId: null,
      inversePropertyId: null,
      manifestRevisions: [],
      warnings: [],
    })
    mount()
    await settle()
    const look = screen.getAllByRole("group", { name: /^Раздел/ })[1]
    fireEvent.change(within(look).getByLabelText("Новое поле"), { target: { value: "Рост" } })
    fireEvent.keyDown(within(look).getByLabelText("Новое поле"), { key: "Enter" })
    await settle()
    expect(storage.createDatabaseProperty).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: "db_chars",
        expectedManifestRevision: "rev-1",
        name: "Рост",
        propertyType: "text",
      }),
    )
    expect(within(look).getByText("Рост")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Сохранить шаблон" }))
    await settle()
    const request = storage.updateDossierTemplate.mock.calls[0][0]
    expect(request.expectedManifestRevision).toBe("rev-after-field")
    expect(request.dossier.sections[1].fields).toEqual(["height"])
  })

  it("does not save a layout the backend would refuse, and says why", async () => {
    mount()
    await settle()
    const [, look] = screen.getAllByLabelText("Название раздела")
    fireEvent.change(look, { target: { value: "основное" } })
    expect(
      (screen.getByRole("button", { name: "Сохранить шаблон" }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByText("Два раздела называются одинаково.")).toBeTruthy()
  })

  it("keeps the dialog open and shows the failure when saving fails", async () => {
    storage.updateDossierTemplate.mockRejectedValue(new Error("conflict"))
    mount()
    await settle()
    fireEvent.click(screen.getByRole("button", { name: "Сохранить шаблон" }))
    await settle()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole("status")).toBeTruthy()
  })
})
