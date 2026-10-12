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

// The name of the project; with a custom schema there are more text fields than this one.
const type = (value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: /^Название$|^Name$/u }), {
    target: { value },
  })
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
      "group:work": "Story",
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
    // No choice of kind: only a story fits here. Its text schema is still chosen.
    expect(screen.queryByRole("radio", { name: /Вселенная|Сборник/u })).toBeNull()
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

  describe("the schema of the text", () => {
    const levelsSent = (call = 0) => createProject.mock.calls[call][0].textLevels as string[]
    const chain = () => screen.getByText(/^Уровни:/u).textContent

    it("starts from a novel and shows what the levels will be", async () => {
      createProject.mockResolvedValue(created)
      mount()
      expect(screen.getByRole("radio", { name: "Роман" }).getAttribute("aria-checked")).toBe("true")
      expect(chain()).toBe("Уровни: Книга → Глава → Сцена")
      type("Saga")
      submit()
      await waitFor(() => expect(createProject).toHaveBeenCalled())
      expect(levelsSent()).toEqual(["Книга", "Глава", "Сцена"])
    })

    it("offers a short story with one level and a comic with four", async () => {
      createProject.mockResolvedValue(created)
      mount()
      fireEvent.click(screen.getByRole("radio", { name: "Рассказ" }))
      expect(chain()).toBe("Уровни: Страница")
      type("Tale")
      submit()
      await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1))
      expect(levelsSent(0)).toEqual(["Страница"])

      cleanup()
      mount()
      fireEvent.click(screen.getByRole("radio", { name: "Комикс" }))
      expect(chain()).toBe("Уровни: Книга → Арка → Глава → Страница")
      type("Tale")
      submit()
      await waitFor(() => expect(createProject).toHaveBeenCalledTimes(2))
      expect(levelsSent(1)).toEqual(["Книга", "Арка", "Глава", "Страница"])
    })

    it("keeps the operation ID for a retry and takes a new one when the schema changes", async () => {
      createProject.mockRejectedValue(
        new ProjectOperationError("pathCollision", "x", { kind: "pathCollision", path: "Saga" }),
      )
      mount()
      type("Saga")
      submit()
      await screen.findByRole("alert")
      submit()
      await waitFor(() => expect(createProject).toHaveBeenCalledTimes(2))
      const id = createProject.mock.calls[0][0].operationId
      expect(createProject.mock.calls[1][0].operationId).toBe(id)

      // The same name with other levels is another request; Rust would refuse to reuse the ID.
      fireEvent.click(screen.getByRole("radio", { name: "Рассказ" }))
      submit()
      await waitFor(() => expect(createProject).toHaveBeenCalledTimes(3))
      expect(createProject.mock.calls[2][0].operationId).not.toBe(id)
      expect(levelsSent(2)).toEqual(["Страница"])
    })

    it("follows the language: the levels of a novel in English", async () => {
      await i18n.changeLanguage("en")
      createProject.mockResolvedValue(created)
      mount()
      expect(screen.getByText("Levels: Book → Chapter → Scene")).toBeTruthy()
      type("Saga")
      fireEvent.click(screen.getByRole("button", { name: "Create" }))
      await waitFor(() => expect(createProject).toHaveBeenCalled())
      expect(levelsSent()).toEqual(["Book", "Chapter", "Scene"])
    })

    it("edits its own list: rename, add and remove, one to six levels", async () => {
      createProject.mockResolvedValue(created)
      mount()
      fireEvent.click(screen.getByRole("radio", { name: "Своя" }))
      // The list starts from the schema that was chosen before it.
      expect(chain()).toBe("Уровни: Книга → Глава → Сцена")
      fireEvent.change(screen.getByRole("textbox", { name: "Название уровня 1" }), {
        target: { value: "Том" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Убрать уровень 2" }))
      expect(chain()).toBe("Уровни: Том → Сцена")

      // Up to six levels; then nothing more is added.
      for (let count = 2; count < 6; count++) {
        fireEvent.click(screen.getByRole("button", { name: "Добавить уровень" }))
        fireEvent.change(screen.getByRole("textbox", { name: `Название уровня ${count + 1}` }), {
          target: { value: `Часть ${count + 1}` },
        })
      }
      expect(
        (screen.getByRole("button", { name: "Добавить уровень" }) as HTMLButtonElement).disabled,
      ).toBe(true)

      type("Epic")
      submit()
      await waitFor(() => expect(createProject).toHaveBeenCalled())
      expect(levelsSent()).toEqual(["Том", "Сцена", "Часть 3", "Часть 4", "Часть 5", "Часть 6"])
    })

    it("keeps at least one level and refuses blank or repeated names", async () => {
      createProject.mockResolvedValue(created)
      mount()
      fireEvent.click(screen.getByRole("radio", { name: "Рассказ" }))
      fireEvent.click(screen.getByRole("radio", { name: "Своя" }))
      // The only level cannot be removed.
      expect(
        (screen.getByRole("button", { name: "Убрать уровень 1" }) as HTMLButtonElement).disabled,
      ).toBe(true)

      type("Tale")
      const create = () => screen.getByRole("button", { name: "Создать" }) as HTMLButtonElement
      expect(create().disabled).toBe(false)
      fireEvent.change(screen.getByRole("textbox", { name: "Название уровня 1" }), {
        target: { value: "   " },
      })
      expect(create().disabled).toBe(true)
      expect(screen.getByText("Назовите каждый уровень.")).toBeTruthy()

      fireEvent.change(screen.getByRole("textbox", { name: "Название уровня 1" }), {
        target: { value: "Глава" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Добавить уровень" }))
      fireEvent.change(screen.getByRole("textbox", { name: "Название уровня 2" }), {
        target: { value: "ГЛАВА" },
      })
      expect(create().disabled).toBe(true)
      expect(screen.getByText("Названия уровней не должны повторяться.")).toBeTruthy()
      submit()
      expect(createProject).not.toHaveBeenCalled()
    })

    it("is not asked for a universe or a plain collection, which have no text", async () => {
      createProject.mockResolvedValue({ ...created, kind: "collection" })
      mount()
      fireEvent.click(screen.getByRole("radio", { name: /Вселенная/u }))
      expect(screen.queryByRole("radio", { name: "Роман" })).toBeNull()
      type("Palooverse")
      submit()
      await waitFor(() => expect(createProject).toHaveBeenCalled())
      expect(createProject.mock.calls[0][0]).not.toHaveProperty("textLevels")
    })
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
