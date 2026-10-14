// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
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

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  updateWorkshop,
  removeWorkshopSection,
  reorderWorkshopSections,
  updateTextLevels,
  addTextStatus,
  renameDatabase,
}))

vi.mock("./create-section-dialog", () => ({
  CreateSectionDialog: () => <div data-testid="section-dialog" />,
}))

function mount(projectId: string) {
  const onOpenProject = vi.fn()
  const renderDatabase = vi.fn(({ databaseId, title }: { databaseId: string; title: string }) => (
    <div data-testid="database">{`${title}:${databaseId}`}</div>
  ))
  render(
    <ProjectPage
      projectId={projectId}
      renderDatabase={renderDatabase}
      onOpenProject={onOpenProject}
    />,
  )
  return { onOpenProject, renderDatabase }
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
  })
  afterEach(cleanup)

  it("waits for the catalog and then says a missing project is missing", () => {
    useProjectStore.getState().setLoading()
    mount("nope")
    expect(screen.getByText("Загрузка…")).toBeTruthy()
    cleanup()
    act(() => useProjectStore.getState().setCatalog(catalog([])))
    mount("nope")
    expect(screen.getByText("Проект не найден")).toBeTruthy()
  })

  it("starts on the overview, with the sections of a story under their groups", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    const { renderDatabase } = mount("molehills")
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("MoleHills")
    expect(screen.getByText("История")).toBeTruthy()
    expect(renderDatabase).not.toHaveBeenCalled()
    // cards on the overview: one per section
    expect(screen.getAllByRole("button", { name: /Персонажи/u }).length).toBeGreaterThan(0)
  })

  it("shows a section as the ordinary database and remembers it", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    const { renderDatabase } = mount("molehills")
    const nav = screen.getByRole("navigation", { name: "Разделы проекта" })
    fireEvent.click(
      Array.from(nav.querySelectorAll("button")).find((b) => b.textContent === "Персонажи")!,
    )
    expect(renderDatabase).toHaveBeenLastCalledWith({
      databaseId: "db_characters",
      title: "Персонажи",
      readOnly: false,
      toolbarHost: expect.any(HTMLElement),
    })
    expect(screen.getByTestId("database").textContent).toBe("Персонажи:db_characters")
    expect(useCreativeNavStore.getState().sectionByProject.molehills).toBe("characters")
  })

  it("opens the section the sidebar asked for", () => {
    act(() => {
      useProjectStore.getState().setCatalog(universeCatalog())
      useCreativeNavStore.getState().showSection("molehills", "notes")
    })
    mount("molehills")
    expect(screen.getByTestId("database").textContent).toBe("Заметки:db_notes")
  })

  it("falls back to the overview when the remembered section no longer exists", () => {
    act(() => {
      useProjectStore.getState().setCatalog(universeCatalog())
      useCreativeNavStore.getState().showSection("molehills", "gone")
    })
    mount("molehills")
    expect(screen.queryByTestId("database")).toBeNull()
  })

  it("lists the stories of a collection and opens one", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    const { onOpenProject } = mount("palooverse")
    expect(screen.getByRole("heading", { name: "Истории" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "MoleHills" }))
    expect(onOpenProject).toHaveBeenCalledWith("molehills")
  })

  it("explains a section whose database is missing instead of rendering it", () => {
    const broken = project("p", {
      sections: [section("s", { state: "missing", resolvedPath: null, databaseName: "Потеряна" })],
    })
    act(() => {
      useProjectStore.getState().setCatalog(catalog([broken]))
      useCreativeNavStore.getState().showSection("p", "s")
    })
    const { renderDatabase } = mount("p")
    expect(renderDatabase).not.toHaveBeenCalled()
    expect(screen.getByText("Раздел не найден")).toBeTruthy()
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

  it("opens project settings from the header", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    mount("molehills")
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }))
    expect(screen.getByRole("heading", { name: "Настройки проекта" })).toBeTruthy()
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

    const unlinkButtons = screen.getAllByRole("button", { name: "Убрать из проекта" })
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
