// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow, ProjectTextSummary } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import { useSettingsStore } from "../use-settings-store"
import { useViewStateStore } from "../use-view-state-store"
import { useCreativeNavStore } from "./creative-nav-store"
import {
  catalog,
  storySummary,
  workshopSection as section,
  workshopSummary,
} from "./project-fixtures.test-support"
import { ProjectPage, type CreativePageHost } from "./project-page"
import { useProjectStore } from "./project-store"

const queryDatabase = vi.fn()
const listTextStats = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  queryDatabase: (...args: unknown[]) => queryDatabase(...args),
  listTextStats: (...args: unknown[]) => listTextStats(...args),
  listNotebooks: async () => ({
    databaseId: "",
    containerPath: "",
    rootItemCount: 0,
    notebooks: [],
  }),
  resolveDatabaseAssetPaths: async () => ({ paths: [] }),
}))
vi.mock("./create-section-dialog", () => ({ CreateSectionDialog: () => null }))
vi.mock("./create-project-dialog", () => ({ CreateProjectDialog: () => null }))

const text = (databaseId: string): ProjectTextSummary => ({
  databaseId,
  properties: {
    level: "lvl",
    parent: "par",
    order: "ord",
    format: null,
    status: null,
    anchors: null,
    arcs: null,
  },
  levels: [{ id: "chapter", icon: null, name: "Глава", color: null, state: "ok" }],
  formats: [],
  statusOptions: [],
})

const workshop = workshopSummary("w", {
  name: "Моя мастерская",
  path: "Мастерская",
  sections: [
    section("stories", { role: "stories", databaseId: "db_stories", universePropertyId: "up" }),
    section("universes", { role: "universes", name: "Вселенные", databaseId: "db_univ" }),
    section("chars", {
      role: "characters",
      name: "Персонажи",
      databaseId: "db_chars",
      databaseName: "Персонажи",
    }),
  ],
  stories: [
    storySummary("hills", {
      name: "MoleHills",
      workshopId: "w",
      databaseId: "db_hills",
      folderPath: "Мастерская/hills",
      cardNoteId: "note_hills",
      text: text("db_hills"),
    }),
    storySummary("lone", {
      name: "Одиночка",
      workshopId: "w",
      databaseId: "db_lone",
      folderPath: "Мастерская/lone",
      cardNoteId: "note_lone",
      text: text("db_lone"),
    }),
  ],
})

function row(noteId: string, title: string, values: Record<string, unknown> = {}): DatabaseRow {
  return {
    noteId,
    title,
    relativePath: `${noteId}.md`,
    parentNoteId: null,
    depth: 0,
    categoryPath: [],
    valuesJson: JSON.stringify(values),
    rowRevision: `rev-${noteId}`,
  }
}
const rel = (...ids: string[]) => ({ type: "relation", targetNoteIds: ids })

const ROWS: Record<string, DatabaseRow[]> = {
  db_stories: [row("note_hills", "MoleHills", { up: rel("u1") }), row("note_lone", "Одиночка")],
  db_univ: [row("u1", "Палуверс")],
  db_hills: [row("p1", "Первая", { lvl: { type: "select", optionId: "chapter" } })],
  db_lone: [],
  db_chars: [],
}

function host(over: Partial<CreativePageHost> = {}): CreativePageHost {
  return {
    onBack: vi.fn(),
    onForward: vi.fn(),
    canGoBack: true,
    canGoForward: false,
    onOpenInNewTab: vi.fn(),
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    onToggleFavorite: vi.fn(),
    onShowInExplorer: vi.fn(),
    ...over,
  }
}

function mount(projectId: string, props: Partial<React.ComponentProps<typeof ProjectPage>> = {}) {
  const handlers = {
    onOpenProject: vi.fn(),
    onOpenNote: vi.fn(),
    onOpenDatabase: vi.fn(),
    onShowSection: vi.fn(),
  }
  const pageHost = host()
  render(
    <ProjectPage
      projectId={projectId}
      vaultPath="/vault"
      host={pageHost}
      {...handlers}
      {...props}
    />,
  )
  return { ...handlers, host: pageHost }
}

const trail = () =>
  Array.from(document.querySelectorAll("[data-breadcrumb-segment]")).map((node) =>
    node.textContent?.trim(),
  )
const MORE = { name: "Другие действия" }
/** The floating bar at the foot of the page. */
const bar = () => within(document.querySelector<HTMLElement>("div.bottom-2.right-4")!)
const openMenu = () =>
  fireEvent.pointerDown(screen.getByRole("button", MORE), { button: 0, ctrlKey: false })
const menuRows = () => screen.getAllByRole("menuitem").map((item) => item.textContent?.trim())

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900)
  localStorage.clear()
  queryDatabase.mockReset().mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
    rows: ROWS[databaseId] ?? [],
    nextCursor: null,
    totalCount: (ROWS[databaseId] ?? []).length,
    diagnostics: [],
  }))
  listTextStats.mockReset().mockResolvedValue([])
  useProjectStore.getState().reset()
  useDatabaseStore.getState().reset(1)
  useCreativeNavStore.setState({ sectionByProject: {}, collapsed: {}, dataNonce: 0 })
  useViewStateStore.setState({ contentWidths: {}, lockedFileIds: new Set(), favorites: new Set() })
  const editor = useSettingsStore.getState().prefs.editor
  useSettingsStore.setState({
    prefs: { ...useSettingsStore.getState().prefs, editor: { ...editor, showAreaControls: true } },
  })
  act(() => useProjectStore.getState().setCatalog(catalog([workshop])))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("the breadcrumb of a workshop page", () => {
  it("is just the workshop on its own page", () => {
    mount("w")
    expect(trail()).toEqual(["Мастерская"])
  })

  it("leads a universe's page from the workshop, named by its card", async () => {
    const { onOpenProject } = mount("universe:u1")
    await waitFor(() => expect(trail()).toEqual(["Мастерская", "Палуверс"]))
    fireEvent.click(screen.getByRole("button", { name: "Мастерская" }))
    expect(onOpenProject).toHaveBeenCalledWith("w")
  })

  it("leads the standalone stories from the workshop", () => {
    const { onOpenProject } = mount("standalone:w")
    expect(trail()).toEqual(["Мастерская", "Отдельные истории"])
    fireEvent.click(screen.getByRole("button", { name: "Мастерская" }))
    expect(onOpenProject).toHaveBeenCalledWith("w")
  })

  it("leads a story through its universe, and every crumb but the story opens a page", async () => {
    const { onOpenProject } = mount("hills")
    await waitFor(() => expect(trail()).toEqual(["Мастерская", "Палуверс", "MoleHills"]))
    fireEvent.click(screen.getByRole("button", { name: "Палуверс" }))
    expect(onOpenProject).toHaveBeenLastCalledWith("universe:u1")
    fireEvent.click(screen.getByRole("button", { name: "Мастерская" }))
    expect(onOpenProject).toHaveBeenLastCalledWith("w")
    expect(screen.queryByRole("button", { name: "MoleHills" })).toBeNull()
  })

  it("leads a story that no universe holds through the standalone stories", async () => {
    const { onOpenProject } = mount("lone")
    expect(trail()).toEqual(["Мастерская", "Отдельные истории", "Одиночка"])
    fireEvent.click(screen.getByRole("button", { name: "Отдельные истории" }))
    expect(onOpenProject).toHaveBeenCalledWith("standalone:w")
  })

  it("adds the section that is open, and then the page itself opens its overview", async () => {
    const { onOpenProject } = mount("lone", { section: "chars" })
    expect(trail()).toEqual(["Мастерская", "Отдельные истории", "Одиночка", "Персонажи"])
    fireEvent.click(screen.getByRole("button", { name: "Одиночка" }))
    expect(onOpenProject).toHaveBeenCalledWith("lone")
  })
})

describe("the section tabs are steps of the tab's history", () => {
  it("asks the shell to step to a tab and shows the section the history names", () => {
    const { onShowSection } = mount("lone", { section: "chars" })
    const nav = screen.getByRole("navigation", { name: "Разделы мастерской" })
    expect(
      within(nav).getByRole("button", { name: "Персонажи" }).getAttribute("aria-current"),
    ).toBe("page")
    fireEvent.click(within(nav).getByRole("button", { name: "Рабочий стол" }))
    expect(onShowSection).toHaveBeenCalledWith("overview")
    // The page does not keep a memory of its own once the history owns the section.
    expect(useCreativeNavStore.getState().sectionByProject.lone).toBeUndefined()
  })

  it("shows the overview of an entry that names no section", () => {
    mount("lone", { section: null })
    const nav = screen.getByRole("navigation", { name: "Разделы мастерской" })
    expect(
      within(nav).getByRole("button", { name: "Рабочий стол" }).getAttribute("aria-current"),
    ).toBe("page")
  })
})

describe("the header menu of a page", () => {
  it("has, on a story's desk, the page's actions and the story's own", async () => {
    mount("hills")
    await screen.findByRole("button", MORE)
    openMenu()
    expect(menuRows()).toEqual([
      "Ширина контента",
      "Скрыть статусную панель",
      "Настроить стол",
      "Собрать рукопись",
      "Добавить в избранное",
      "Открыть в новой вкладке",
      "Разделить вправо",
      "Разделить вниз",
      "Показать в проводнике",
      "Настройки",
    ])
    expect(screen.getAllByRole("separator")).toHaveLength(2)
  })

  it("has the workshop's page without a note to star, and a section tab adds Open as base", () => {
    const { onOpenDatabase } = mount("w")
    openMenu()
    expect(menuRows()).toEqual([
      "Ширина контента",
      "Скрыть статусную панель",
      "Открыть в новой вкладке",
      "Разделить вправо",
      "Разделить вниз",
      "Показать в проводнике",
      "Настройки",
    ])
    cleanup()
    mount("w", { section: "chars", onOpenDatabase })
    openMenu()
    expect(menuRows()).toContain("Открыть как базу")
    fireEvent.click(screen.getByRole("menuitem", { name: "Открыть как базу" }))
    expect(onOpenDatabase).toHaveBeenCalledWith("db_chars", "Персонажи")
  })

  it("stars a universe's note, and a universe has no settings of its own", async () => {
    const { host: pageHost } = mount("universe:u1")
    await waitFor(() => expect(trail()).toEqual(["Мастерская", "Палуверс"]))
    openMenu()
    expect(menuRows()).not.toContain("Настройки")
    fireEvent.click(screen.getByRole("menuitem", { name: "Добавить в избранное" }))
    expect(pageHost.onToggleFavorite).toHaveBeenCalledWith("u1")
  })

  it("has nothing to star on the standalone stories' page", () => {
    mount("standalone:w")
    openMenu()
    expect(menuRows()).not.toContain("Добавить в избранное")
  })

  it("shows a starred note as one that can be unstarred", () => {
    useViewStateStore.setState({ favorites: new Set(["note_hills"]) })
    mount("hills")
    openMenu()
    expect(menuRows()).toContain("Убрать из избранного")
  })

  it("hands the tab, split and file actions to the shell", () => {
    const { host: pageHost } = mount("hills")
    openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Разделить вправо" }))
    expect(pageHost.onSplitRight).toHaveBeenCalledTimes(1)
    openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Разделить вниз" }))
    expect(pageHost.onSplitDown).toHaveBeenCalledTimes(1)
    openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Открыть в новой вкладке" }))
    expect(pageHost.onOpenInNewTab).toHaveBeenCalledTimes(1)
    openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Показать в проводнике" }))
    // A story shows its own folder.
    expect(pageHost.onShowInExplorer).toHaveBeenLastCalledWith("Мастерская/hills")
  })

  it("shows the workshop's folder for the workshop's page", () => {
    const { host: pageHost } = mount("w")
    openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Показать в проводнике" }))
    expect(pageHost.onShowInExplorer).toHaveBeenLastCalledWith("Мастерская")
  })

  it("opens the existing settings dialog", () => {
    mount("w")
    openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Настройки" }))
    expect(screen.getByRole("heading", { name: "Настройки мастерской" })).toBeTruthy()
  })

  it("turns the desk's layout mode on from the menu and compiles from there too", async () => {
    mount("hills")
    await screen.findByRole("region", { name: "Главы" })
    openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Настроить стол" }))
    expect(screen.getByText(/Раскладка одна для всех историй/)).toBeTruthy()
    // The old header button is gone: the action has one place in the menu and one in the bar.
    expect(screen.queryByRole("button", { name: "Настроить стол" })).toBeNull()
    expect(screen.getByRole("button", { name: "Готово" }).getAttribute("aria-pressed")).toBe("true")
  })

  it("hides the bottom bar from the menu and brings it back from there", async () => {
    mount("w")
    expect(bar().getByText(/сл\./)).toBeTruthy()
    openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Скрыть статусную панель" }))
    await waitFor(() =>
      expect(useSettingsStore.getState().prefs.editor.showAreaControls).toBe(false),
    )
    expect(document.querySelector("div.bottom-2.right-4")).toBeNull()
    openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Показать статусную панель" }))
    await waitFor(() =>
      expect(useSettingsStore.getState().prefs.editor.showAreaControls).toBe(true),
    )
    expect(document.querySelector("div.bottom-2.right-4")).not.toBeNull()
  })

  it("keeps the old header's gear away: settings are in the menu only", () => {
    mount("hills")
    expect(screen.queryByRole("button", { name: "Настройки" })).toBeNull()
  })
})

describe("the content width of a page", () => {
  it("is the whole width until chosen, and chosen from the menu like a note's", () => {
    mount("hills")
    const body = () => document.querySelector<HTMLElement>("div.mx-auto.w-full.px-4")!
    expect(body().style.maxWidth).toBe("none")
    openMenu()
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Ширина контента" }), {
      key: "ArrowRight",
    })
    expect(
      within(screen.getByRole("menuitem", { name: /Во всю ширину/ })).getByText("✓"),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("menuitem", { name: "Обычная" }))
    expect(useViewStateStore.getState().contentWidths["creative:hills"]).toBe("normal")
    expect(body().style.maxWidth).toBe("48rem")
  })

  it("is remembered for that page only", () => {
    useViewStateStore.setState({ contentWidths: { "creative:hills": "wide" } })
    mount("hills")
    expect(document.querySelector<HTMLElement>("div.mx-auto.w-full.px-4")!.style.maxWidth).toBe(
      "64rem",
    )
    cleanup()
    mount("lone")
    expect(document.querySelector<HTMLElement>("div.mx-auto.w-full.px-4")!.style.maxWidth).toBe(
      "none",
    )
  })
})

describe("the header buttons of a page", () => {
  it("steps through the tab's history and tells the ends apart", () => {
    const { host: pageHost } = mount("hills")
    fireEvent.click(screen.getByRole("button", { name: "Назад" }))
    expect(pageHost.onBack).toHaveBeenCalledTimes(1)
    expect((screen.getByRole("button", { name: "Вперёд" }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it("enters focus mode from the page", () => {
    const toggle = vi.fn()
    mount("hills", { host: host({ onToggleFocusMode: toggle }) })
    fireEvent.click(screen.getByTitle("Режим фокуса"))
    expect(toggle).toHaveBeenCalledTimes(1)
  })
})

describe("the floating bar of a page", () => {
  it("gives a story its last change, words, read mode and the desk's layout", async () => {
    listTextStats.mockImplementation(async (databaseId: string) =>
      databaseId === "db_hills"
        ? [{ noteId: "p1", wordCount: 1234, modified: Math.floor(Date.now() / 1000) - 7200 }]
        : [],
    )
    mount("hills")
    await waitFor(() => expect(bar().getByText("1234 сл.")).toBeTruthy())
    expect(bar().getByText("Правка 2ч назад")).toBeTruthy()
    expect(screen.getByTitle("Режим просмотра")).toBeTruthy()
    expect(screen.getByTitle("Настроить стол")).toBeTruthy()
    // No real undo for a page of the workshop.
    expect(screen.queryByTitle("Отменить (Ctrl+Z)")).toBeNull()
    expect(screen.queryByTitle("Повторить (Ctrl+Y)")).toBeNull()
  })

  it("gives the workshop's and a universe's page the change and words only", async () => {
    listTextStats.mockImplementation(async (databaseId: string) =>
      databaseId === "db_hills"
        ? [{ noteId: "p1", wordCount: 500, modified: Math.floor(Date.now() / 1000) - 120 }]
        : [],
    )
    mount("w")
    await waitFor(() => expect(bar().getByText("500 сл.")).toBeTruthy())
    expect(bar().getByText("Правка 2 мин назад")).toBeTruthy()
    expect(screen.queryByTitle("Режим просмотра")).toBeNull()
    expect(screen.queryByTitle("Настроить стол")).toBeNull()
    expect(screen.queryByTitle("Отменить (Ctrl+Z)")).toBeNull()
    cleanup()
    mount("universe:u1")
    await waitFor(() => expect(bar().getByText("500 сл.")).toBeTruthy())
    expect(screen.queryByTitle("Режим просмотра")).toBeNull()
  })

  it("is hidden where the author hid the bottom bar", () => {
    const editor = useSettingsStore.getState().prefs.editor
    useSettingsStore.setState({
      prefs: {
        ...useSettingsStore.getState().prefs,
        editor: { ...editor, showAreaControls: false },
      },
    })
    mount("hills")
    expect(screen.queryByTitle("Режим просмотра")).toBeNull()
    expect(screen.queryByText(/сл\./)).toBeNull()
  })

  it("turns the layout mode on from the bar's settings button", async () => {
    mount("hills")
    fireEvent.click(await screen.findByTitle("Настроить стол"))
    expect(screen.getByText(/Раскладка одна для всех историй/)).toBeTruthy()
    fireEvent.click(screen.getByTitle("Готово"))
    expect(screen.queryByText(/Раскладка одна для всех историй/)).toBeNull()
  })

  it("has no layout button on a section tab", () => {
    mount("hills", { section: "chars" })
    expect(screen.queryByTitle("Настроить стол")).toBeNull()
  })
})

describe("read mode of a story's page", () => {
  const chapters = () => screen.findByRole("region", { name: "Главы" })

  it("lets the story be written, then stops every edit while locked and starts again after", async () => {
    mount("hills")
    const region = await chapters()
    expect(within(region).getByRole("button", { name: "Глава" })).toBeTruthy()

    fireEvent.click(screen.getByTitle("Режим просмотра"))
    expect(useViewStateStore.getState().lockedFileIds.has("creative:hills")).toBe(true)
    await waitFor(() => expect(within(region).queryByRole("button", { name: "Глава" })).toBeNull())
    // The layout of the desk cannot be changed either: no button, no menu row.
    expect(screen.queryByTitle("Настроить стол")).toBeNull()
    openMenu()
    expect(menuRows()).not.toContain("Настроить стол")
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    // Reading is still free: the page that was written opens.
    expect(within(region).getByText("Первая")).toBeTruthy()

    fireEvent.click(screen.getByTitle("Режим редактирования"))
    expect(useViewStateStore.getState().lockedFileIds.has("creative:hills")).toBe(false)
    expect(await within(region).findByRole("button", { name: "Глава" })).toBeTruthy()
  })

  it("leaves the layout mode when the page is locked", async () => {
    mount("hills")
    fireEvent.click(await screen.findByTitle("Настроить стол"))
    expect(screen.getByText(/Раскладка одна для всех историй/)).toBeTruthy()
    fireEvent.click(screen.getByTitle("Режим просмотра"))
    expect(screen.queryByText(/Раскладка одна для всех историй/)).toBeNull()
  })

  it("keeps the lock of a story apart from the next one", async () => {
    useViewStateStore.setState({ lockedFileIds: new Set(["creative:hills"]) })
    mount("lone")
    expect(await screen.findByTitle("Режим просмотра")).toBeTruthy()
  })
})
