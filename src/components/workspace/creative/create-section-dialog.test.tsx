// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { chooseOption } from "@/lib/test-utils/amby-select"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { ProjectOperationError, type CreatedWorkshopSectionResult } from "@/lib/storage"
import { CreateSectionDialog } from "./create-section-dialog"
import { workshopSummary } from "./project-fixtures.test-support"

const createWorkshopSection = vi.hoisted(() => vi.fn())
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  createWorkshopSection,
}))

const created: CreatedWorkshopSectionResult = {
  operationId: "op",
  workshopId: "p",
  workshopRevision: "n".repeat(64),
  replayed: false,
  warnings: [],
  section: {
    sectionId: "sec_1",
    databaseId: "db",
    role: "custom",
    name: "Custom",
    path: "p/Sections/custom.database.json",
    containerPath: "p/Sections",
    manifestRevision: "m".repeat(64),
  },
}

describe("CreateSectionDialog", () => {
  beforeEach(async () => {
    createWorkshopSection.mockReset()
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  const mount = (target = workshopSummary("p", { name: "Saga", fileRevision: "f".repeat(64) })) => {
    const onCreated = vi.fn()
    render(
      <CreateSectionDialog
        open
        onClose={vi.fn()}
        vaultGeneration={2}
        workshop={target}
        onCreated={onCreated}
      />,
    )
    return onCreated
  }

  it("adds a section by the revision of the workshop file the caller saw", async () => {
    createWorkshopSection.mockResolvedValue(created)
    const onCreated = mount()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Организации" } })
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created))
    expect(createWorkshopSection).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 2,
        workshopId: "p",
        expectedWorkshopRevision: "f".repeat(64),
        name: "Организации",
      }),
    )
  })

  it("starts a section from a role choice", async () => {
    createWorkshopSection.mockResolvedValue(created)
    mount()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Герои" } })
    await chooseOption("Заготовка", /Персонажи/u)
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }))
    await waitFor(() => expect(createWorkshopSection).toHaveBeenCalled())
    expect(createWorkshopSection.mock.calls[0][0]).toMatchObject({
      name: "Герои",
      role: "characters",
    })
  })

  it("asks to retry when the workshop file changed under the dialog", async () => {
    createWorkshopSection.mockRejectedValue(
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

  it("renders first without a workshop and then with one, and back, without failing", () => {
    const onCreated = vi.fn()
    const dialog = (target?: ReturnType<typeof workshopSummary>) => (
      <CreateSectionDialog
        open
        onClose={vi.fn()}
        vaultGeneration={2}
        workshop={target}
        onCreated={onCreated}
      />
    )
    const { rerender } = render(dialog())
    expect(screen.queryByRole("textbox")).toBeNull()

    rerender(dialog(workshopSummary("p", { name: "Saga" })))
    expect(screen.getByRole("textbox")).toBeTruthy()
    expect(screen.getByText(/Saga/u)).toBeTruthy()

    rerender(dialog())
    expect(screen.queryByRole("textbox")).toBeNull()
    rerender(dialog(workshopSummary("p", { name: "Saga" })))
    expect(screen.getByRole("textbox")).toBeTruthy()
  })

  it("takes the workshop from the legacy project prop when no workshop is given", () => {
    render(
      <CreateSectionDialog
        open
        onClose={vi.fn()}
        vaultGeneration={2}
        project={workshopSummary("p", { name: "Saga" })}
        onCreated={vi.fn()}
      />,
    )
    expect(screen.getByRole("textbox")).toBeTruthy()
  })

  it("sends a custom role when the author takes no ready-made choice", async () => {
    createWorkshopSection.mockResolvedValue(created)
    mount()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Бестиарий" } })
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }))
    await waitFor(() => expect(createWorkshopSection).toHaveBeenCalled())
    expect(createWorkshopSection.mock.calls[0][0]).toMatchObject({
      name: "Бестиарий",
      role: "custom",
    })
  })

  it("opens with the name and the role of a section asked for from outside", async () => {
    createWorkshopSection.mockResolvedValue(created)
    const onCreated = vi.fn()
    render(
      <CreateSectionDialog
        open
        onClose={vi.fn()}
        vaultGeneration={2}
        workshop={workshopSummary("p", { name: "Saga" })}
        initial={{ name: "Якоря", choice: "anchors" }}
        onCreated={onCreated}
      />,
    )
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Якоря")
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created))
    expect(createWorkshopSection.mock.calls[0][0]).toMatchObject({
      name: "Якоря",
      role: "anchors",
    })
  })

  it("explains a name that cannot be a folder and keeps the dialog open", async () => {
    createWorkshopSection.mockRejectedValue(
      new ProjectOperationError("invalidName", "x", {
        kind: "invalidName",
        field: "name",
        reason: "forbidden character",
      }),
    )
    const onCreated = mount()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "а/б" } })
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }))
    expect((await screen.findByRole("alert")).textContent).toContain("В названии нельзя")
    expect(onCreated).not.toHaveBeenCalled()
    expect(screen.getByRole("textbox")).toBeTruthy()
  })

  it("retries with the same operation ID and takes a new one for another name", async () => {
    createWorkshopSection.mockRejectedValueOnce(
      new ProjectOperationError("pathCollision", "x", { kind: "pathCollision", path: "Орг" }),
    )
    mount()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Орг" } })
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }))
    await screen.findByRole("alert")
    createWorkshopSection.mockResolvedValue(created)
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }))
    await waitFor(() => expect(createWorkshopSection).toHaveBeenCalledTimes(2))
    expect(createWorkshopSection.mock.calls[1][0].operationId).toBe(
      createWorkshopSection.mock.calls[0][0].operationId,
    )
  })
})
