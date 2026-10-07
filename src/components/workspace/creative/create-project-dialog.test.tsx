// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import i18n from "@/lib/i18n"
import { ProjectOperationError, type CreatedProject } from "@/lib/storage"
import { CreateProjectDialog } from "./create-project-dialog"
import { project } from "./project-fixtures.test-support"

const createProject = vi.hoisted(() => vi.fn())
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  createProject,
}))

const created: CreatedProject = {
  operationId: "op",
  projectId: "p1",
  kind: "story",
  name: "Saga",
  path: "Saga",
  filePath: "Saga/amby-project.json",
  fileRevision: "r".repeat(64),
  sections: [],
  replayed: false,
  warnings: [],
}

function mount(props: Partial<React.ComponentProps<typeof CreateProjectDialog>> = {}) {
  const onCreated = vi.fn()
  const onClose = vi.fn()
  render(
    <CreateProjectDialog
      open
      onClose={onClose}
      vaultGeneration={4}
      onCreated={onCreated}
      {...props}
    />,
  )
  return { onCreated, onClose }
}

const type = (value: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value } })
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Создать" }))

describe("CreateProjectDialog", () => {
  beforeEach(async () => {
    createProject.mockReset()
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  it("does not send an empty name", () => {
    mount()
    expect((screen.getByRole("button", { name: "Создать" }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    type("   ")
    expect((screen.getByRole("button", { name: "Создать" }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it("creates a story with the base sections named in the active language", async () => {
    createProject.mockResolvedValue(created)
    const { onCreated, onClose } = mount()
    type("  Saga ")
    submit()
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created))
    expect(onClose).toHaveBeenCalled()
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 4,
        kind: "story",
        name: "Saga",
        parentPath: null,
        baseSections: true,
        labels: expect.objectContaining({ "section:text": "Текст", "group:world": "Мир" }),
      }),
    )
  })

  it("sends English names when English is active", async () => {
    await i18n.changeLanguage("en")
    createProject.mockResolvedValue(created)
    mount()
    type("Saga")
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(createProject).toHaveBeenCalled())
    expect(createProject.mock.calls[0][0].labels).toMatchObject({
      "section:text": "Text",
      "section:characters": "Characters",
      "group:work": "Work",
    })
  })

  it("offers a universe and a plain collection, and maps them to backend kinds", async () => {
    createProject.mockResolvedValue({ ...created, kind: "collection" })
    mount()
    fireEvent.click(screen.getByRole("radio", { name: /Вселенная/u }))
    type("Palooverse")
    submit()
    await waitFor(() => expect(createProject).toHaveBeenCalled())
    expect(createProject.mock.calls[0][0]).toMatchObject({ kind: "collection", baseSections: true })

    createProject.mockClear()
    cleanup()
    mount()
    fireEvent.click(screen.getByRole("radio", { name: /Сборник/u }))
    type("Singles")
    submit()
    await waitFor(() => expect(createProject).toHaveBeenCalled())
    expect(createProject.mock.calls[0][0]).toMatchObject({
      kind: "collection",
      baseSections: false,
    })
  })

  it("creates only a story inside a collection, in that folder", async () => {
    createProject.mockResolvedValue(created)
    mount({ parent: project("c", { kind: "collection", name: "Palooverse", path: "Palooverse" }) })
    expect(screen.queryByRole("radio")).toBeNull()
    type("First")
    submit()
    await waitFor(() => expect(createProject).toHaveBeenCalled())
    expect(createProject.mock.calls[0][0]).toMatchObject({
      kind: "story",
      parentPath: "Palooverse",
    })
  })

  it("explains a collision, keeps the dialog open, and retries with the same operation ID", async () => {
    createProject.mockRejectedValue(
      new ProjectOperationError("pathCollision", "x", { kind: "pathCollision", path: "Saga" }),
    )
    const { onClose, onCreated } = mount()
    type("Saga")
    submit()
    expect((await screen.findByRole("alert")).textContent).toContain("«Saga» уже существует")
    expect(onClose).not.toHaveBeenCalled()
    submit()
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(2))
    expect(createProject.mock.calls[1][0].operationId).toBe(
      createProject.mock.calls[0][0].operationId,
    )

    // Another name is another request, so it gets its own operation ID.
    type("Saga 2")
    createProject.mockResolvedValue(created)
    submit()
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(createProject.mock.calls[2][0].operationId).not.toBe(
      createProject.mock.calls[0][0].operationId,
    )
  })

  it("shows what was left behind when the cleanup was incomplete", async () => {
    createProject.mockRejectedValue(
      new ProjectOperationError("recoveryRequired", "x", {
        kind: "recoveryRequired",
        operationId: "op",
        message: "Персонажи: not a directory",
      }),
    )
    mount()
    type("Saga")
    submit()
    expect((await screen.findByRole("alert")).textContent).toContain("Персонажи: not a directory")
  })
})
