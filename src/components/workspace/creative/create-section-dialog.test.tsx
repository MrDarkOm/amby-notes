// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { chooseOption } from "@/lib/test-utils/amby-select"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { ProjectOperationError, type CreatedSection } from "@/lib/storage"
import { CreateSectionDialog } from "./create-section-dialog"
import { project } from "./project-fixtures.test-support"

const createProjectSection = vi.hoisted(() => vi.fn())
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  createProjectSection,
}))

const created: CreatedSection = {
  operationId: "op",
  projectId: "p",
  section: {
    sectionId: "sec_1",
    role: null,
    groupId: null,
    name: "Организации",
    databaseId: "db",
    path: "Организации",
    containerPath: "p/Организации",
    manifestRevision: "m",
  },
  projectRevision: "n".repeat(64),
  replayed: false,
  warnings: [],
}

describe("CreateSectionDialog", () => {
  beforeEach(async () => {
    createProjectSection.mockReset()
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  const mount = (target = project("p", { name: "Saga", fileRevision: "f".repeat(64) })) => {
    const onCreated = vi.fn()
    render(
      <CreateSectionDialog
        open
        onClose={vi.fn()}
        vaultGeneration={2}
        project={target}
        onCreated={onCreated}
      />,
    )
    return onCreated
  }

  it("adds a section by the revision of the project file the caller saw", async () => {
    createProjectSection.mockResolvedValue(created)
    const onCreated = mount()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Организации" } })
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created))
    expect(createProjectSection).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 2,
        projectId: "p",
        expectedProjectRevision: "f".repeat(64),
        name: "Организации",
        role: null,
        preset: null,
        groupId: null,
      }),
    )
  })

  it("starts a section from a preset, in the names of the active language", async () => {
    createProjectSection.mockResolvedValue(created)
    mount()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Герои" } })
    await chooseOption("Заготовка", /Персонажи/u)
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }))
    await waitFor(() => expect(createProjectSection).toHaveBeenCalled())
    expect(createProjectSection.mock.calls[0][0]).toMatchObject({
      role: "characters",
      preset: "characters",
      labels: expect.objectContaining({
        "preset:importance": "Значимость",
        "heading:biography": "Биография",
        "template:dossier": "Досье",
      }),
    })
  })

  it("offers a preset without a role for the sections the author names himself", async () => {
    createProjectSection.mockResolvedValue(created)
    mount()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ордены" } })
    await chooseOption("Заготовка", /Организации/u)
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }))
    await waitFor(() => expect(createProjectSection).toHaveBeenCalled())
    expect(createProjectSection.mock.calls[0][0]).toMatchObject({
      role: null,
      preset: "organizations",
    })
  })

  it("offers the project's groups only when it has some", () => {
    mount()
    expect(screen.queryByLabelText("Группа")).toBeNull()
    cleanup()
    mount(project("p", { groups: [{ id: "world", name: "Мир" }] }))
    expect(screen.getByLabelText("Группа")).toBeTruthy()
  })

  it("asks to retry when the project file changed under the dialog", async () => {
    createProjectSection.mockRejectedValue(
      new ProjectOperationError("revisionConflict", "x", {
        kind: "revisionConflict",
        actualRevision: "z",
      }),
    )
    const onCreated = mount()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Организации" } })
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }))
    expect((await screen.findByRole("alert")).textContent).toContain("Файл проекта изменился")
    expect(onCreated).not.toHaveBeenCalled()
  })

  it("opens with the name and the anchors role of a section asked for from the works tab", async () => {
    createProjectSection.mockResolvedValue(created)
    const onCreated = vi.fn()
    render(
      <CreateSectionDialog
        open
        onClose={vi.fn()}
        vaultGeneration={2}
        project={project("p", {
          name: "Saga",
          fileRevision: "f".repeat(64),
          groups: [{ id: "work", name: "Произведение" }],
        })}
        initial={{ name: "Якоря", choice: "anchors" }}
        onCreated={onCreated}
      />,
    )
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Якоря")
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }))
    await waitFor(() => expect(createProjectSection).toHaveBeenCalledTimes(1))
    expect(createProjectSection.mock.calls[0][0]).toMatchObject({
      name: "Якоря",
      role: "anchors",
      preset: null,
      groupId: "work",
    })
  })
})
