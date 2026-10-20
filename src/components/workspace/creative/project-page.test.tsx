// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import { useCreativeNavStore } from "./creative-nav-store"
import {
  catalog,
  project,
  section,
  storySummary,
  universeCatalog,
  workshopSummary,
} from "./project-fixtures.test-support"
import { ProjectPage } from "./project-page"
import { ProjectSettingsDialog } from "./project-settings-dialog"
import { useProjectStore } from "./project-store"

const updateWorkshop = vi.hoisted(() => vi.fn())
const removeWorkshopSection = vi.hoisted(() => vi.fn())
const reorderWorkshopSections = vi.hoisted(() => vi.fn())
const updateTextLevels = vi.hoisted(() => vi.fn())
const addTextStatus = vi.hoisted(() => vi.fn())
const renameDatabase = vi.hoisted(() => vi.fn())
const queryDatabase = vi.hoisted(() => vi.fn())

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  updateWorkshop,
  removeWorkshopSection,
  reorderWorkshopSections,
  updateTextLevels,
  addTextStatus,
  renameDatabase,
  queryDatabase: (...args: unknown[]) => queryDatabase(...args),
  listTextStats: async () => [],
  listNotebooks: async () => ({
    databaseId: "",
    containerPath: "",
    rootItemCount: 0,
    notebooks: [],
  }),
  resolveDatabaseAssetPaths: async () => ({ paths: [] }),
}))

vi.mock("./create-section-dialog", () => ({
  CreateSectionDialog: () => <div data-testid="section-dialog" />,
}))

function mount(projectId: string) {
  const onOpenProject = vi.fn()
  const onOpenDatabase = vi.fn()
  const onOpenNote = vi.fn()
  render(
    <ProjectPage
      projectId={projectId}
      onOpenDatabase={onOpenDatabase}
      onOpenProject={onOpenProject}
      onOpenNote={onOpenNote}
    />,
  )
  return { onOpenProject, onOpenDatabase, onOpenNote }
}

const openPageMenu = () =>
  fireEvent.pointerDown(screen.getByRole("button", { name: "Другие действия" }), {
    button: 0,
    ctrlKey: false,
  })

function row(noteId: string, title: string): DatabaseRow {
  return {
    noteId,
    title,
    relativePath: `${noteId}.md`,
    parentNoteId: null,
    depth: 0,
    categoryPath: [],
    valuesJson: "{}",
    rowRevision: `rev-${noteId}`,
  }
}

function serveRows(rows: Record<string, DatabaseRow[]>) {
  queryDatabase.mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
    rows: rows[databaseId] ?? [],
    nextCursor: null,
    totalCount: (rows[databaseId] ?? []).length,
    diagnostics: [],
  }))
}

describe("ProjectPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    useProjectStore.getState().reset()
    useDatabaseStore.getState().reset(1)
    useCreativeNavStore.setState({ sectionByProject: {}, collapsed: {} })
    updateWorkshop.mockReset()
    removeWorkshopSection.mockReset()
    reorderWorkshopSections.mockReset()
    updateTextLevels.mockReset()
    addTextStatus.mockReset()
    renameDatabase.mockReset()
    queryDatabase.mockReset()
    serveRows({})
  })
  afterEach(cleanup)

  it("waits for the catalog and then says a missing project is missing", () => {
    useProjectStore.getState().setLoading()
    mount("nope")
    expect(screen.getByText("Загрузка…")).toBeTruthy()
    cleanup()
    act(() => useProjectStore.getState().setCatalog(catalog([])))
    mount("nope")
    expect(screen.getByText("Мастерская не найдена")).toBeTruthy()
  })

  it("opens a story on its desk and lists only the lists that can hold its pages", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    mount("molehills")
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("MoleHills")
    expect(screen.getByText("История")).toBeTruthy()
    const nav = screen.getByRole("navigation", { name: "Разделы мастерской" })
    const tabs = Array.from(nav.querySelectorAll("button")).map((b) => b.textContent)
    // The desk, then the world's lists, the anchors and the notes: no list of stories, no text,
    // no universes, which are not about this story.
    expect(tabs).toEqual(["Рабочий стол", "Персонажи", "Локации", "Прочее", "Якоря", "Заметки"])
    // A story without text has no desk to show.
    expect(screen.getByText("У истории нет раздела с текстом.")).toBeTruthy()
    // None of the cards of the old nested model.
    expect(screen.queryByText("Произведение")).toBeNull()
  })

  it("shows a section of a story as the pages that belong to it, not as the shared database", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    const { onOpenDatabase } = mount("molehills")
    const nav = screen.getByRole("navigation", { name: "Разделы мастерской" })
    fireEvent.click(
      Array.from(nav.querySelectorAll("button")).find((b) => b.textContent === "Персонажи")!,
    )
    expect(onOpenDatabase).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Вся база" })).toBeTruthy()
    expect(useCreativeNavStore.getState().sectionByProject.molehills).toBe("characters")
  })

  it("shows a section of the workshop as a gallery, remembers it and opens the base on request", async () => {
    serveRows({ db_characters: [row("anna", "Анна"), row("gleb", "Глеб")] })
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    const { onOpenDatabase, onOpenNote } = mount("palooverse")
    const nav = screen.getByRole("navigation", { name: "Разделы мастерской" })
    fireEvent.click(
      Array.from(nav.querySelectorAll("button")).find((b) => b.textContent === "Персонажи")!,
    )
    // The gallery is named by the database (the fixture's is its ID), the tab by the section.
    const gallery = await screen.findByRole("region", { name: "characters" })
    await within(gallery).findByText("Анна")
    fireEvent.click(within(gallery).getByText("Глеб"))
    expect(onOpenNote).toHaveBeenCalledWith("gleb")
    expect(useCreativeNavStore.getState().sectionByProject.palooverse).toBe("characters")
    // The ordinary database is one row away, in the page's "⋯" menu: no button in the tabs row.
    expect(within(nav).queryByRole("button", { name: "Открыть как базу" })).toBeNull()
    openPageMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Открыть как базу" }))
    expect(onOpenDatabase).toHaveBeenCalledWith("db_characters", "Персонажи")
  })

  it("opens the section the sidebar asked for", async () => {
    act(() => {
      useProjectStore.getState().setCatalog(universeCatalog())
      useCreativeNavStore.getState().showSection("palooverse", "notes")
    })
    mount("palooverse")
    expect(await screen.findByRole("region", { name: "notes" })).toBeTruthy()
  })

  it("falls back to the overview when the remembered section no longer exists", () => {
    act(() => {
      useProjectStore.getState().setCatalog(universeCatalog())
      useCreativeNavStore.getState().showSection("palooverse", "gone")
    })
    mount("palooverse")
    expect(screen.getByRole("region", { name: "Истории" })).toBeTruthy()
    openPageMenu()
    expect(screen.queryByRole("menuitem", { name: "Открыть как базу" })).toBeNull()
  })

  it("lists the stories of the workshop as cards and opens one", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    const { onOpenProject } = mount("palooverse")
    expect(screen.getByRole("heading", { name: "Истории" })).toBeTruthy()
    // No tiles of the sections any more: the tabs above are the way to them.
    expect(screen.queryByRole("heading", { name: "Мир" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /MoleHills/ }))
    expect(onOpenProject).toHaveBeenCalledWith("molehills")
  })

  it("shows the numbers of the workshop under its name: worlds, stories, words", async () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    mount("palooverse")
    const numbers = screen.getByText("Историй").closest("dl") as HTMLElement
    expect(within(numbers).getByText("Миров")).toBeTruthy()
    expect(within(numbers).getByText("Написано слов")).toBeTruthy()
    expect(within(numbers).getByText("Историй").nextSibling?.textContent).toBe("2")
  })

  it("explains a section whose database is missing instead of rendering it", () => {
    const broken = project("p", {
      sections: [section("s", { state: "missing", resolvedPath: null, databaseName: "Потеряна" })],
    })
    act(() => {
      useProjectStore.getState().setCatalog(catalog([broken]))
      useCreativeNavStore.getState().showSection("p", "s")
    })
    mount("p")
    expect(screen.getByText("Раздел не найден")).toBeTruthy()
    openPageMenu()
    expect(screen.queryByRole("menuitem", { name: "Открыть как базу" })).toBeNull()
  })

  it("is read-only for a project of an unknown format", () => {
    act(() =>
      useProjectStore
        .getState()
        .setCatalog(catalog([project("p", { readOnly: true, formatVersion: 4 })])),
    )
    mount("p")
    expect(screen.getByText(/версия 4/u)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Раздел" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Настройки" })).toBeNull()
  })

  it("adds a section from the header", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    mount("palooverse")
    fireEvent.click(screen.getByRole("button", { name: "Раздел" }))
    expect(screen.getByTestId("section-dialog")).toBeTruthy()
  })

  it("opens project settings from the page's menu", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    mount("molehills")
    fireEvent.pointerDown(screen.getByRole("button", { name: "Другие действия" }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.click(screen.getByRole("menuitem", { name: "Настройки" }))
    expect(screen.getByRole("heading", { name: "Настройки мастерской" })).toBeTruthy()
  })
})

describe("ProjectSettingsDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    useProjectStore.getState().reset()
    useDatabaseStore.getState().reset(1)
    updateWorkshop.mockReset()
    removeWorkshopSection.mockReset()
    reorderWorkshopSections.mockReset()
    updateTextLevels.mockReset()
    addTextStatus.mockReset()
    renameDatabase.mockReset()
  })
  afterEach(cleanup)

  it("saves project name and comma-separated tags", async () => {
    updateWorkshop.mockResolvedValue({
      operationId: "op",
      workshopId: "molehills",
      name: "MoleHills II",
      path: "molehills",
      filePath: "molehills/.workshop.json",
      fileRevision: "r2",
      sections: [],
      replayed: false,
      warnings: [],
    })
    const target = project("molehills", {
      name: "MoleHills",
      tags: ["фэнтези"],
      fileRevision: "f".repeat(64),
    })
    const onClose = vi.fn()
    render(<ProjectSettingsDialog open onClose={onClose} vaultGeneration={2} workshop={target} />)

    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "MoleHills II" } })
    fireEvent.change(screen.getByLabelText(/Теги/u), {
      target: { value: "фэнтези, приключения" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }))

    await waitFor(() => expect(updateWorkshop).toHaveBeenCalledTimes(1))
    expect(updateWorkshop.mock.calls[0][0]).toMatchObject({
      expectedGeneration: 2,
      workshopId: "molehills",
      expectedWorkshopRevision: "f".repeat(64),
      name: "MoleHills II",
      icon: null,
      tags: ["фэнтези", "приключения"],
    })
    expect(onClose).toHaveBeenCalled()
  })

  it("reorders and unlinks non-text sections while protecting the text section", async () => {
    reorderWorkshopSections.mockResolvedValue({
      operationId: "op",
      workshopId: "molehills",
      sectionIds: ["notes", "text"],
      workshopRevision: "r2",
      replayed: false,
      warnings: [],
    })
    removeWorkshopSection.mockResolvedValue({
      operationId: "op2",
      workshopId: "molehills",
      sectionId: "notes",
      workshopRevision: "r3",
      replayed: false,
      warnings: [],
    })
    const target = project("molehills", {
      fileRevision: "f".repeat(64),
      sections: [
        section("text", { role: "text", databaseName: "Текст" }),
        section("notes", { role: "notes", databaseName: "Заметки" }),
      ],
    })
    render(<ProjectSettingsDialog open onClose={vi.fn()} vaultGeneration={2} workshop={target} />)

    fireEvent.click(screen.getByRole("tab", { name: "Разделы" }))

    const unlinkButtons = screen.getAllByRole("button", { name: "Убрать из мастерской" })
    expect((unlinkButtons[0] as HTMLButtonElement).disabled).toBe(true)
    expect((unlinkButtons[1] as HTMLButtonElement).disabled).toBe(false)

    const moveDownButtons = screen.getAllByRole("button", { name: "Ниже" })
    fireEvent.click(moveDownButtons[0])
    await waitFor(() => expect(reorderWorkshopSections).toHaveBeenCalledTimes(1))
    expect(reorderWorkshopSections.mock.calls[0][0]).toMatchObject({
      workshopId: "molehills",
      sectionIds: ["notes", "text"],
    })

    fireEvent.click(unlinkButtons[1])
    fireEvent.click(screen.getByRole("button", { name: "Убрать" }))
    await waitFor(() => expect(removeWorkshopSection).toHaveBeenCalledTimes(1))
    expect(removeWorkshopSection.mock.calls[0][0]).toMatchObject({
      workshopId: "molehills",
      sectionId: "notes",
    })
  })

  it("updates text levels and adds page status on a story", async () => {
    updateTextLevels.mockResolvedValue({
      operationId: "op1",
      projectId: "molehills",
      projectRevision: "r2",
      manifestRevision: "m2",
      levels: [],
      replayed: false,
      warnings: [],
    })
    addTextStatus.mockResolvedValue({
      operationId: "op2",
      projectId: "molehills",
      projectRevision: "r3",
      manifestRevision: "m3",
      statusPropertyId: "prop_status",
      replayed: false,
      warnings: [],
    })
    const targetStory = storySummary("molehills", {
      name: "MoleHills",
      fileRevision: "f".repeat(64),
      text: {
        databaseId: "db_text",
        properties: {
          level: "prop_level",
          parent: "prop_parent",
          order: "prop_order",
          format: "prop_format",
          status: null,
          anchors: null,
          arcs: null,
        },
        levels: [
          { id: "opt_ch", name: "Глава", icon: null, color: "gray", state: "ok" },
          { id: "opt_sc", name: "Сцена", icon: null, color: "gray", state: "ok" },
        ],
        formats: [
          { id: "opt_ms", kind: "manuscript", name: "Рукопись", color: "gray", state: "ok" },
        ],
        statusOptions: [],
      },
    })
    const targetWorkshop = workshopSummary("molehills_ws", {
      fileRevision: "f".repeat(64),
      stories: [targetStory],
    })
    render(
      <ProjectSettingsDialog
        open
        onClose={vi.fn()}
        vaultGeneration={2}
        workshop={targetWorkshop}
        story={targetStory}
      />,
    )

    fireEvent.click(screen.getByRole("tab", { name: "Уровни текста" }))

    fireEvent.click(screen.getByRole("button", { name: "Добавить уровень" }))
    fireEvent.change(screen.getByLabelText("Название уровня 3"), {
      target: { value: "Эпизод" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Сохранить уровни" }))

    await waitFor(() => expect(updateTextLevels).toHaveBeenCalledTimes(1))
    expect(updateTextLevels.mock.calls[0][0]).toMatchObject({
      storyId: "molehills",
      levels: [
        { id: "opt_ch", name: "Глава", icon: null },
        { id: "opt_sc", name: "Сцена", icon: null },
        { id: null, name: "Эпизод", icon: null },
      ],
    })

    fireEvent.click(screen.getByRole("button", { name: "Добавить статус страниц" }))
    await waitFor(() => expect(addTextStatus).toHaveBeenCalledTimes(1))
    expect(addTextStatus.mock.calls[0][0]).toMatchObject({
      storyId: "molehills",
      labels: {
        "property:status": "Статус",
        "status:draft": "Черновик",
        "status:inProgress": "В работе",
        "status:done": "Готово",
      },
    })
  })
})
