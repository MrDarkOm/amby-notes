// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import i18n from "@/lib/i18n"
import {
  ProjectOperationError,
  type CreatedStory,
  type CreatedWorkshopSectionResult,
  type WorkshopSummary,
} from "@/lib/storage"
import { CreateProjectDialog } from "./create-project-dialog"
import { workshopSummary } from "./project-fixtures.test-support"

const createStory = vi.hoisted(() => vi.fn())
const createWorkshopSection = vi.hoisted(() => vi.fn())
const createWorkshopEntity = vi.hoisted(() => vi.fn())

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  createStory,
  createWorkshopSection,
  createWorkshopEntity,
}))

const sampleWorkshop: WorkshopSummary = workshopSummary("w1", { name: "Palooverse" })

const createdStoryRes: CreatedStory = {
  operationId: "op",
  workshopId: "w1",
  storyId: "s1",
  title: "Palooverse",
  folderPath: "Palooverse/Stories/s1",
  cardPath: "Palooverse/Stories/s1/card.md",
  cardNoteId: "note_s1",
  databaseId: "db_s1",
  storyFileRevision: "r".repeat(64),
  replayed: false,
  warnings: [],
}

const createdSectionRes: CreatedWorkshopSectionResult = {
  operationId: "op",
  workshopId: "w1",
  workshopRevision: "n".repeat(64),
  replayed: false,
  warnings: [],
  section: {
    sectionId: "sec_u",
    databaseId: "db_u",
    role: "universes",
    name: "Вселенные",
    path: "Вселенные",
    containerPath: "Palooverse/Вселенные",
    manifestRevision: "m".repeat(64),
  },
}

function mount(props: Partial<React.ComponentProps<typeof CreateProjectDialog>> = {}) {
  const onCreated = vi.fn()
  const onClose = vi.fn()
  render(
    <CreateProjectDialog
      open
      onClose={onClose}
      vaultGeneration={4}
      workshop={sampleWorkshop}
      onCreated={onCreated}
      {...props}
    />,
  )
  return { onCreated, onClose }
}

const type = (value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: /^Название$|^Name$/u }), {
    target: { value },
  })
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Создать" }))

describe("CreateProjectDialog", () => {
  beforeEach(async () => {
    createStory.mockReset()
    createWorkshopSection.mockReset()
    createWorkshopEntity.mockReset()
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

  it("creates a story with the chosen text levels", async () => {
    createStory.mockResolvedValue(createdStoryRes)
    const { onCreated, onClose } = mount()
    type("  Saga ")
    submit()
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({
        kind: "story",
        id: "s1",
        cardNoteId: "note_s1",
      }),
    )
    expect(onClose).toHaveBeenCalled()
    expect(createStory).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 4,
        workshopId: "w1",
        title: "Saga",
        textLevels: ["Книга", "Глава", "Сцена"],
      }),
    )
  })

  it("creates a universe as a page of the universes section, the way a world page is made", async () => {
    createWorkshopEntity.mockResolvedValue({ noteId: "note_univ_1" })
    const univWorkshop = workshopSummary("w1", {
      sections: [
        {
          id: "sec_u",
          role: "universes",
          name: "Вселенные",
          databaseId: "db_universes",
          pathHint: "universes",
          storiesPropertyId: null,
          universePropertyId: null,
          arcsPropertyId: null,
          charactersPropertyId: null,
          state: "ok",
          resolvedPath: "universes",
          databaseName: "Вселенные",
        },
      ],
    })
    const { onCreated } = mount({ initialKind: "universe", workshop: univWorkshop })
    type("Cosmos")
    submit()
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ kind: "universe", id: "note_univ_1" }),
    )
    expect(createWorkshopEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "w1",
        sectionId: "sec_u",
        title: "Cosmos",
        storyId: null,
      }),
    )
  })

  it("makes the universes section first when the workshop has none", async () => {
    createWorkshopSection.mockResolvedValue({
      ...createdSectionRes,
      section: { ...createdSectionRes.section, sectionId: "sec_u", databaseId: "db_new_universes" },
    })
    createWorkshopEntity.mockResolvedValue({ noteId: "note_univ_2" })
    const { onCreated } = mount({ initialKind: "universe" })
    type("Cosmos")
    submit()
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ kind: "universe", id: "note_univ_2" }),
    )
    expect(createWorkshopSection).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "w1",
        role: "universes",
        expectedWorkshopRevision: sampleWorkshop.fileRevision,
      }),
    )
    expect(createWorkshopEntity).toHaveBeenCalledWith(
      expect.objectContaining({ workshopId: "w1", sectionId: "sec_u", title: "Cosmos" }),
    )
  })

  it("explains a collision and keeps the dialog open", async () => {
    createStory.mockRejectedValue(
      new ProjectOperationError("pathCollision", "x", { kind: "pathCollision", path: "Saga" }),
    )
    const { onClose } = mount()
    type("Saga")
    submit()
    expect((await screen.findByRole("alert")).textContent).toContain("«Saga» уже существует")
    expect(onClose).not.toHaveBeenCalled()
  })

  it("retries with the same operation ID and takes a new one for another name", async () => {
    createStory.mockRejectedValue(
      new ProjectOperationError("pathCollision", "x", { kind: "pathCollision", path: "Saga" }),
    )
    const { onClose, onCreated } = mount()
    type("Saga")
    submit()
    await screen.findByRole("alert")
    expect(onClose).not.toHaveBeenCalled()
    submit()
    await waitFor(() => expect(createStory).toHaveBeenCalledTimes(2))
    expect(createStory.mock.calls[1][0].operationId).toBe(createStory.mock.calls[0][0].operationId)

    // Another name is another request, so it gets its own operation ID.
    type("Saga 2")
    createStory.mockResolvedValue(createdStoryRes)
    submit()
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(createStory.mock.calls[2][0].operationId).not.toBe(
      createStory.mock.calls[0][0].operationId,
    )
  })

  it("explains a name that cannot be a folder and keeps the dialog open", async () => {
    createStory.mockRejectedValue(
      new ProjectOperationError("invalidName", "x", {
        kind: "invalidName",
        field: "title",
        reason: "forbidden character",
      }),
    )
    const { onClose, onCreated } = mount()
    type('Дом "Лис"')
    submit()
    expect((await screen.findByRole("alert")).textContent).toContain("В названии нельзя")
    expect(onClose).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it("shows what was left behind when the cleanup was incomplete", async () => {
    createStory.mockRejectedValue(
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

  it("sends the names of the base sections in the language that is active", async () => {
    await i18n.changeLanguage("en")
    createStory.mockResolvedValue(createdStoryRes)
    mount()
    type("Saga")
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(createStory).toHaveBeenCalled())
    expect(createStory.mock.calls[0][0].labels).toMatchObject({
      "section:stories": "Stories",
      "section:characters": "Characters",
      "section:locations": "Locations",
      "section:arcs": "Arcs",
      "section:anchors": "Anchors",
    })
  })

  it("no longer makes workshops: the dialog offers a story and a universe only", () => {
    mount()
    const kinds = within(screen.getByRole("radiogroup", { name: "Что создать" }))
    expect(kinds.getAllByRole("radio")).toHaveLength(2)
    expect(screen.getByRole("radio", { name: /^История/u })).toBeTruthy()
    expect(screen.getByRole("radio", { name: /^Вселенная/u })).toBeTruthy()
  })

  it("is not asked for a text schema when it makes a universe", () => {
    mount({ initialKind: "universe", workshop: sampleWorkshop })
    expect(screen.queryByRole("radio", { name: "Роман" })).toBeNull()
  })

  describe("the schema of the text", () => {
    const levelsSent = (call = 0) => createStory.mock.calls[call][0].textLevels as string[]
    const chain = () => screen.getByText(/^Уровни:/u).textContent

    it("starts from a novel and shows what the levels will be", async () => {
      createStory.mockResolvedValue(createdStoryRes)
      mount()
      expect(screen.getByRole("radio", { name: "Роман" }).getAttribute("aria-checked")).toBe("true")
      expect(chain()).toBe("Уровни: Книга → Глава → Сцена")
      type("Saga")
      submit()
      await waitFor(() => expect(createStory).toHaveBeenCalled())
      expect(levelsSent()).toEqual(["Книга", "Глава", "Сцена"])
    })

    it("offers a short story with one level and a comic with four", async () => {
      createStory.mockResolvedValue(createdStoryRes)
      mount()
      fireEvent.click(screen.getByRole("radio", { name: "Рассказ" }))
      expect(chain()).toBe("Уровни: Страница")
      type("Tale")
      submit()
      await waitFor(() => expect(createStory).toHaveBeenCalledTimes(1))
      expect(levelsSent(0)).toEqual(["Страница"])

      cleanup()
      mount()
      fireEvent.click(screen.getByRole("radio", { name: "Комикс" }))
      expect(chain()).toBe("Уровни: Книга → Том → Глава → Страница")
      type("Tale")
      submit()
      await waitFor(() => expect(createStory).toHaveBeenCalledTimes(2))
      expect(levelsSent(1)).toEqual(["Книга", "Том", "Глава", "Страница"])
    })

    it("keeps the operation ID for a retry and takes a new one when the schema changes", async () => {
      createStory.mockRejectedValue(
        new ProjectOperationError("pathCollision", "x", { kind: "pathCollision", path: "Saga" }),
      )
      mount()
      type("Saga")
      submit()
      await screen.findByRole("alert")
      submit()
      await waitFor(() => expect(createStory).toHaveBeenCalledTimes(2))
      const id = createStory.mock.calls[0][0].operationId
      expect(createStory.mock.calls[1][0].operationId).toBe(id)

      // The same name with other levels is another request; Rust would refuse to reuse the ID.
      fireEvent.click(screen.getByRole("radio", { name: "Рассказ" }))
      submit()
      await waitFor(() => expect(createStory).toHaveBeenCalledTimes(3))
      expect(createStory.mock.calls[2][0].operationId).not.toBe(id)
      expect(levelsSent(2)).toEqual(["Страница"])
    })

    it("follows the language: the levels of a novel in English", async () => {
      await i18n.changeLanguage("en")
      createStory.mockResolvedValue(createdStoryRes)
      mount()
      expect(screen.getByText("Levels: Book → Chapter → Scene")).toBeTruthy()
      type("Saga")
      fireEvent.click(screen.getByRole("button", { name: "Create" }))
      await waitFor(() => expect(createStory).toHaveBeenCalled())
      expect(levelsSent()).toEqual(["Book", "Chapter", "Scene"])
    })

    it("keeps at least one level and refuses blank or repeated names", async () => {
      createStory.mockResolvedValue(createdStoryRes)
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
      expect(createStory).not.toHaveBeenCalled()
    })

    it("edits its own list: rename, add and remove, one to six levels", async () => {
      createStory.mockResolvedValue(createdStoryRes)
      mount()
      fireEvent.click(screen.getByRole("radio", { name: "Своя" }))
      expect(chain()).toBe("Уровни: Книга → Глава → Сцена")
      fireEvent.change(screen.getByRole("textbox", { name: "Название уровня 1" }), {
        target: { value: "Том" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Убрать уровень 2" }))
      expect(chain()).toBe("Уровни: Том → Сцена")

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
      await waitFor(() => expect(createStory).toHaveBeenCalled())
      expect(levelsSent()).toEqual(["Том", "Сцена", "Часть 3", "Часть 4", "Часть 5", "Часть 6"])
    })
  })
})
