// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { selectedText } from "@/lib/test-utils/amby-select"
import type { DatabaseRow, DatabaseSummary } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import { parseViewSettings } from "../database/view-config"
import { readWorkshopPrefs } from "./creative-scope-storage"
import { useCreativeNavStore } from "./creative-nav-store"
import {
  catalog,
  storySummary,
  workshopSection as section,
  workshopSummary,
} from "./project-fixtures.test-support"
import { ProjectPage } from "./project-page"
import { useProjectStore } from "./project-store"

const queryDatabase = vi.fn()
const getDatabaseView = vi.fn()
const updateDatabaseViewConfig = vi.fn()
const listTextStats = vi.fn()
const ensurePlotLinks = vi.fn()
const createWorkshopEntity = vi.fn()
const updateDatabaseRelationValue = vi.fn()
const dialog = vi.hoisted(() => ({
  props: null as null | {
    kinds?: string[]
    onCreated: (created: { kind: string; id: string; cardNoteId?: string }) => void
  },
}))

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  queryDatabase: (...args: unknown[]) => queryDatabase(...args),
  ensurePlotLinks: (...args: unknown[]) => ensurePlotLinks(...args),
  createWorkshopEntity: (...args: unknown[]) => createWorkshopEntity(...args),
  updateDatabaseRelationValue: (...args: unknown[]) => updateDatabaseRelationValue(...args),
  getDatabaseView: (...args: unknown[]) => getDatabaseView(...args),
  updateDatabaseViewConfig: (...args: unknown[]) => updateDatabaseViewConfig(...args),
  listTextStats: (...args: unknown[]) => listTextStats(...args),
  resolveDatabaseAssetPaths: async () => ({ paths: [] }),
}))
beforeEach(() => {
  listTextStats.mockReset().mockResolvedValue([])
  getDatabaseView.mockReset().mockResolvedValue({ revision: "view-r1", configJson: "{}" })
  updateDatabaseViewConfig.mockReset().mockResolvedValue({ viewRevision: "view-r2" })
  localStorage.clear()
})
vi.mock("./create-section-dialog", () => ({ CreateSectionDialog: () => null }))
vi.mock("./create-project-dialog", () => ({
  CreateProjectDialog: (props: NonNullable<typeof dialog.props>) => {
    dialog.props = props
    return null
  },
}))

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

const workshop = workshopSummary("verse", {
  name: "Verse",
  sections: [
    section("stories", { role: "stories", databaseId: "db_stories", universePropertyId: "up" }),
    section("universes", { role: "universes", name: "Вселенные", databaseId: "db_univ" }),
    section("chars", {
      role: "characters",
      name: "Персонажи",
      databaseId: "db_chars",
      databaseName: "Персонажи",
      storiesPropertyId: "stp",
    }),
  ],
  stories: [
    storySummary("hills", { workshopId: "verse", name: "MoleHills", databaseId: "db_t_hills" }),
    storySummary("twin", { workshopId: "verse", name: "Близнец", databaseId: "db_t_twin" }),
    storySummary("lone", { workshopId: "verse", name: "Одиночка", databaseId: "db_t_lone" }),
  ],
})

/** The cards of the stories: two stories in the universe u1, one in none. */
const storyCards = (): DatabaseRow[] => [
  row("note_hills", "MoleHills", { up: rel("u1") }),
  row("note_twin", "Близнец", { up: rel("u1") }),
  row("note_lone", "Одиночка"),
]

const ROWS: Record<string, DatabaseRow[]> = {
  db_stories: storyCards(),
  db_univ: [row("u1", "Палуверс")],
  db_chars: [
    row("anna", "Анна", { stp: rel("note_hills") }),
    row("gleb", "Глеб", { stp: rel("note_lone") }),
    row("zoya", "Зоя"),
  ],
  // Zoya is named by one story only; Anna is a page of two stories of the universe.
  db_t_hills: [row("h1", "Глава", { cast: rel("zoya") })],
  db_t_twin: [row("t1", "Глава", { cast: rel("anna") })],
  db_t_lone: [],
}

describe("the page of a universe", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    queryDatabase
      .mockReset()
      .mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
        rows: ROWS[databaseId] ?? [],
        nextCursor: null,
        totalCount: (ROWS[databaseId] ?? []).length,
        diagnostics: [],
      }))
    useProjectStore.getState().reset()
    useDatabaseStore.getState().reset(1)
    useCreativeNavStore.setState({ sectionByProject: {}, collapsed: {}, dataNonce: 0 })
    act(() => useProjectStore.getState().setCatalog(catalog([workshop])))
  })
  afterEach(cleanup)

  it("is named by the universe's card and lists its stories and the pages that belong to it", async () => {
    const onOpenProject = vi.fn()
    const onOpenNote = vi.fn()
    render(
      <ProjectPage
        projectId="universe:u1"
        onOpenDatabase={() => undefined}
        onOpenProject={onOpenProject}
        onOpenNote={onOpenNote}
      />,
    )
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Палуверс"),
    )
    const stories = await screen.findByRole("region", { name: "Истории" })
    await within(stories).findByText("MoleHills")
    expect(within(stories).queryByText("Одиночка")).toBeNull()
    fireEvent.click(within(stories).getByRole("button", { name: /MoleHills/ }))
    expect(onOpenProject).toHaveBeenCalledWith("hills")

    // The world of a universe is what two or more of its stories hold: Anna names one story and
    // is named in the text of the other. Zoya is only in one, so she is on that story's page.
    const characters = await screen.findByRole("region", { name: "Персонажи" })
    await within(characters).findByText("Анна")
    expect(within(characters).queryByText("Зоя")).toBeNull()
    expect(within(characters).queryByText("Глеб")).toBeNull()
    expect(characters.textContent).toContain("Ещё 1 — только в одной истории")
    fireEvent.click(within(characters).getByText("Анна"))
    expect(onOpenNote).toHaveBeenCalledWith("anna")
  })

  it("says so when no story belongs to the universe", async () => {
    ROWS.db_stories = [
      row("note_hills", "MoleHills"),
      row("note_twin", "Близнец"),
      row("note_lone", "Одиночка"),
    ]
    try {
      render(
        <ProjectPage
          projectId="universe:u1"
          onOpenDatabase={() => undefined}
          onOpenProject={vi.fn()}
          onOpenNote={vi.fn()}
        />,
      )
      expect(await screen.findByText(/В этой вселенной пока нет историй/)).toBeTruthy()
    } finally {
      ROWS.db_stories = storyCards()
    }
  })
})

describe("the events of a universe", () => {
  const withAnchors = (universeProperty: string | null) =>
    workshopSummary("verse", {
      name: "Verse",
      fileRevision: "rev-verse",
      sections: [
        ...workshop.sections,
        section("anchors", {
          role: "anchors",
          name: "Якоря",
          databaseId: "db_anch",
          databaseName: "Якоря",
          storiesPropertyId: "ast",
          universePropertyId: universeProperty,
        }),
      ],
      stories: workshop.stories,
    })
  const anchorRows = [
    row("a1", "Потоп", { uni: rel("u1") }),
    row("a2", "Чужое", { uni: rel("u2") }),
    row("a3", "Простой"),
  ]

  function mountDesk(universeProperty: string | null = "uni", rowsOfAnchors = anchorRows) {
    ROWS.db_anch = rowsOfAnchors
    act(() => useProjectStore.getState().setCatalog(catalog([withAnchors(universeProperty)])))
    render(
      <ProjectPage
        projectId="universe:u1"
        onOpenDatabase={() => undefined}
        onOpenProject={vi.fn()}
        onOpenNote={onOpenNote}
      />,
    )
  }
  const onOpenNote = vi.fn()

  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    onOpenNote.mockReset()
    ensurePlotLinks.mockReset().mockResolvedValue({ changed: true })
    createWorkshopEntity.mockReset().mockResolvedValue({ noteId: "new" })
    queryDatabase
      .mockReset()
      .mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
        rows: ROWS[databaseId] ?? [],
        nextCursor: null,
        totalCount: (ROWS[databaseId] ?? []).length,
        diagnostics: [],
      }))
    useProjectStore.getState().reset()
    useDatabaseStore.getState().reset(1)
    useCreativeNavStore.setState({ sectionByProject: {}, collapsed: {}, dataNonce: 0 })
  })
  afterEach(() => {
    cleanup()
    delete ROWS.db_anch
  })

  async function nameEvent(title: string) {
    const region = await screen.findByRole("region", { name: "События вселенной" })
    fireEvent.click(await within(region).findByRole("button", { name: "Новое событие" }))
    const field = within(region).getByLabelText("Название события")
    fireEvent.change(field, { target: { value: title } })
    fireEvent.submit(field.closest("form") as HTMLFormElement)
    return region
  }

  it("lists the anchors that name the universe and opens one", async () => {
    mountDesk()
    const region = await screen.findByRole("region", { name: "События вселенной" })
    await within(region).findByText("Потоп")
    expect(within(region).queryByText("Чужое")).toBeNull()
    expect(within(region).queryByText("Простой")).toBeNull()
    fireEvent.click(within(region).getByText("Потоп"))
    expect(onOpenNote).toHaveBeenCalledWith("a1")
  })

  it("says so when the universe has no event", async () => {
    mountDesk("uni", [row("a3", "Простой")])
    expect(await screen.findByText("У вселенной пока нет событий.")).toBeTruthy()
  })

  it("makes an event in one write that names the universe", async () => {
    mountDesk("uni")
    await nameEvent("Пожар")
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(createWorkshopEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "verse",
        sectionId: "anchors",
        title: "Пожар",
        universeId: "u1",
      }),
    )
    expect(ensurePlotLinks).not.toHaveBeenCalled()
  })

  it("makes the Universe relation of the anchors first when they lack it", async () => {
    mountDesk(null)
    await nameEvent("Пожар")
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(ensurePlotLinks).toHaveBeenCalledTimes(1)
    expect(ensurePlotLinks).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "anchors",
        workshopId: "verse",
        expectedRevision: "rev-verse",
      }),
    )
    expect(ensurePlotLinks.mock.invocationCallOrder[0]).toBeLessThan(
      createWorkshopEntity.mock.invocationCallOrder[0],
    )
  })

  it("shows the failure of that operation and writes no anchor", async () => {
    ensurePlotLinks.mockReset().mockRejectedValue(new Error("диск полон"))
    mountDesk(null)
    const region = await nameEvent("Пожар")
    const alert = await within(region).findByRole("alert")
    expect(alert.textContent).toContain("диск полон")
    expect(createWorkshopEntity).not.toHaveBeenCalled()
  })
})

function mountPage(
  projectId: string,
  extra: Partial<React.ComponentProps<typeof ProjectPage>> = {},
) {
  const handlers = {
    onOpenProject: vi.fn(),
    onOpenNote: vi.fn(),
    onTitle: vi.fn(),
    onOpenDatabase: vi.fn(),
  }
  render(<ProjectPage projectId={projectId} {...handlers} {...extra} />)
  return handlers
}

function resetScopeState() {
  queryDatabase.mockReset().mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
    rows: ROWS[databaseId] ?? [],
    nextCursor: null,
    totalCount: (ROWS[databaseId] ?? []).length,
    diagnostics: [],
  }))
  createWorkshopEntity.mockReset().mockResolvedValue({ noteId: "new" })
  updateDatabaseRelationValue.mockReset().mockResolvedValue(undefined)
  dialog.props = null
  useProjectStore.getState().reset()
  useDatabaseStore.getState().reset(1)
  useCreativeNavStore.setState({ sectionByProject: {}, collapsed: {}, dataNonce: 0 })
  act(() => useProjectStore.getState().setCatalog(catalog([workshop])))
}

describe("the page of the standalone stories", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    ROWS.db_chars = [...ROWS.db_chars, row("eva", "Ева")]
    resetScopeState()
  })
  afterEach(() => {
    cleanup()
    ROWS.db_chars = ROWS.db_chars.filter((entry) => entry.noteId !== "eva")
  })

  it("is named for the standalone stories and lists only the stories no universe holds", async () => {
    const { onOpenProject } = mountPage("standalone:verse")
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Отдельные истории")
    const stories = await screen.findByRole("region", { name: "Истории" })
    await within(stories).findByText("Одиночка")
    expect(within(stories).queryByText("MoleHills")).toBeNull()
    fireEvent.click(within(stories).getByRole("button", { name: /Одиночка/ }))
    expect(onOpenProject).toHaveBeenCalledWith("lone")
  })

  it("shows the world of that scope with the pages of no story as a group of their own", async () => {
    const { onOpenNote } = mountPage("standalone:verse")
    const characters = await screen.findByRole("region", { name: "Персонажи" })
    await within(characters).findByText("Глеб")
    // Anna names a story of the universe and Zoya is named in its text: not here.
    expect(within(characters).queryByText("Анна")).toBeNull()
    expect(within(characters).queryByText("Зоя")).toBeNull()
    const group = screen.getByRole("region", { name: "Без истории" })
    fireEvent.click(within(group).getByText("Ева"))
    expect(onOpenNote).toHaveBeenCalledWith("eva")
  })

  it("has the header of every page: no settings, no new section, the numbers of the stories", async () => {
    mountPage("standalone:verse")
    await screen.findByRole("region", { name: "Истории" })
    const numbers = (await screen.findByText("Написано слов")).closest("dl") as HTMLElement
    await waitFor(() =>
      expect(within(numbers).getByText("Историй").nextSibling?.textContent).toBe("1"),
    )
    expect(within(numbers).queryByText("Персонажей")).toBeNull()
    expect(screen.queryByRole("button", { name: "Настройки" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Раздел" })).toBeNull()
  })

  it("makes a story with no universe: nothing is linked, the story opens", async () => {
    const { onOpenProject } = mountPage("standalone:verse")
    fireEvent.click(await screen.findByRole("button", { name: "Новая история" }))
    expect(dialog.props?.kinds).toEqual(["story"])
    await act(async () => dialog.props?.onCreated({ kind: "story", id: "fresh" }))
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledWith("fresh"))
    expect(updateDatabaseRelationValue).not.toHaveBeenCalled()
  })

  it("says so when there is no standalone story, and offers the first", async () => {
    ROWS.db_stories = [
      row("note_hills", "MoleHills", { up: rel("u1") }),
      row("note_twin", "Близнец", { up: rel("u1") }),
      row("note_lone", "Одиночка", { up: rel("u1") }),
    ]
    try {
      mountPage("standalone:verse")
      expect(await screen.findByText(/Отдельных историй пока нет/)).toBeTruthy()
      expect(screen.getByRole("button", { name: "Новая история" })).toBeTruthy()
    } finally {
      ROWS.db_stories = storyCards()
    }
  })

  it("lists one section as the pages of this scope, with a way to the whole base", async () => {
    const { onOpenProject, onOpenDatabase, onOpenNote } = mountPage("standalone:verse")
    const nav = screen.getByRole("navigation", { name: "Разделы мастерской" })
    fireEvent.click(within(nav).getByRole("button", { name: "Персонажи" }))
    const list = await screen.findByRole("region", { name: "Персонажи" })
    await within(list).findByText("Глеб")
    expect(within(list).queryByText("Анна")).toBeNull()
    expect(onOpenDatabase).not.toHaveBeenCalled()
    fireEvent.click(within(list).getByText("Глеб"))
    expect(onOpenNote).toHaveBeenCalledWith("gleb")
    fireEvent.click(within(list).getByRole("button", { name: "Вся база" }))
    expect(onOpenProject).toHaveBeenCalledWith("verse", "chars")
  })

  it("makes a page of a section with no story, which lands in the group of its own", async () => {
    mountPage("standalone:verse")
    const nav = screen.getByRole("navigation", { name: "Разделы мастерской" })
    fireEvent.click(within(nav).getByRole("button", { name: "Персонажи" }))
    const list = await screen.findByRole("region", { name: "Персонажи" })
    fireEvent.click(await within(list).findByRole("button", { name: "Добавить: Персонажи" }))
    const field = within(list).getByLabelText("Название — Персонажи")
    fireEvent.change(field, { target: { value: "Новый" } })
    fireEvent.submit(field.closest("form") as HTMLFormElement)
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(createWorkshopEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "verse",
        sectionId: "chars",
        title: "Новый",
        storyId: null,
      }),
    )
  })

  it("is not found for a workshop that is not there", () => {
    mountPage("standalone:other")
    expect(screen.getByText("Мастерская не найдена")).toBeTruthy()
  })
})

describe("a story made on the page of a universe", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    ROWS.db_stories = [...ROWS.db_stories, row("note_fresh", "Свежая")]
    resetScopeState()
  })
  afterEach(() => {
    cleanup()
    ROWS.db_stories = ROWS.db_stories.filter((entry) => entry.noteId !== "note_fresh")
  })

  it("is in the universe from the start, by the way the panel does it, and opens", async () => {
    const { onOpenProject } = mountPage("universe:u1")
    fireEvent.click(await screen.findByRole("button", { name: "Новая история" }))
    await act(async () =>
      dialog.props?.onCreated({ kind: "story", id: "fresh", cardNoteId: "note_fresh" }),
    )
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledWith("fresh"))
    expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1)
    expect(updateDatabaseRelationValue).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: "db_stories",
        noteId: "note_fresh",
        propertyId: "up",
        targetNoteIds: ["u1"],
      }),
    )
  })

  it("keeps the story and says why it is not in the universe when the link fails", async () => {
    updateDatabaseRelationValue.mockRejectedValue(new Error("диск полон"))
    const { onOpenProject } = mountPage("universe:u1")
    fireEvent.click(await screen.findByRole("button", { name: "Новая история" }))
    await act(async () =>
      dialog.props?.onCreated({ kind: "story", id: "fresh", cardNoteId: "note_fresh" }),
    )
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("История создана, но не привязана к вселенной")
    expect(alert.textContent).toContain("диск полон")
    expect(onOpenProject).not.toHaveBeenCalled()
  })
})

describe("the header and the tab of each page", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    resetScopeState()
  })
  afterEach(cleanup)

  it("names the tab of a universe by its card and the others by what they are", async () => {
    const universe = mountPage("universe:u1")
    await waitFor(() => expect(universe.onTitle).toHaveBeenLastCalledWith("Палуверс"))
    cleanup()
    const standalone = mountPage("standalone:verse")
    expect(standalone.onTitle).toHaveBeenLastCalledWith("Отдельные истории")
    cleanup()
    const story = mountPage("hills")
    expect(story.onTitle).toHaveBeenLastCalledWith("MoleHills")
  })

  it("renames the tab of the universe once its card is renamed", async () => {
    const { onTitle } = mountPage("universe:u1")
    await waitFor(() => expect(onTitle).toHaveBeenLastCalledWith("Палуверс"))
    ROWS.db_univ = [row("u1", "Новое имя")]
    act(() => useCreativeNavStore.getState().bumpData())
    await waitFor(() => expect(onTitle).toHaveBeenLastCalledWith("Новое имя"))
    ROWS.db_univ = [row("u1", "Палуверс")]
  })

  it("wraps a long name and has no settings on a universe, which has none of its own", async () => {
    const long = "Очень-очень длинное название вселенной, которое не должно ломать вёрстку страницы"
    ROWS.db_univ = [row("u1", long)]
    try {
      mountPage("universe:u1")
      const heading = await screen.findByRole("heading", { level: 1, name: long })
      expect(heading.className).toContain("break-words")
      expect(heading.className).not.toContain("truncate")
      expect(screen.queryByRole("button", { name: "Настройки" })).toBeNull()
      expect(screen.queryByRole("button", { name: "Раздел" })).toBeNull()
    } finally {
      ROWS.db_univ = [row("u1", "Палуверс")]
    }
  })

  it("gives a story its settings, as the workshop has", async () => {
    const settingsInMenu = async () => {
      fireEvent.pointerDown(await screen.findByRole("button", { name: "Другие действия" }), {
        button: 0,
        ctrlKey: false,
      })
      return screen.getByRole("menuitem", { name: "Настройки" })
    }
    mountPage("hills")
    expect(await settingsInMenu()).toBeTruthy()
    cleanup()
    mountPage("verse")
    expect(await screen.findByRole("button", { name: "Раздел" })).toBeTruthy()
    expect(await settingsInMenu()).toBeTruthy()
  })
})

describe("the stories of a universe: order, cards and timeline", () => {
  const storiesSummary: DatabaseSummary = {
    databaseId: "db_stories",
    title: "Истории",
    icon: null,
    attachedNoteId: null,
    manifestRevision: "m",
    locked: false,
    properties: [],
    views: [{ viewId: "v1", title: "Таблица", layout: "table", revision: "vr1", groupField: null }],
    templates: [],
    diagnostics: [],
  }
  const CREATED: Record<string, number> = { note_hills: 100, note_twin: 200 }

  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    listTextStats.mockImplementation(async (databaseId: string) =>
      databaseId === "db_stories"
        ? Object.entries(CREATED).map(([noteId, created]) => ({
            noteId,
            wordCount: 0,
            modified: null,
            created,
          }))
        : [],
    )
    resetScopeState()
    act(() => useDatabaseStore.getState().setCatalog([storiesSummary]))
  })
  afterEach(cleanup)

  const names = () =>
    within(screen.getByRole("region", { name: "Истории" }))
      .getAllByRole("button", { name: /MoleHills|Близнец|Одиночка/ })
      .filter((button) => button.getAttribute("aria-pressed") === null)
      .map((button) => (button.textContent?.includes("MoleHills") ? "MoleHills" : "Близнец"))
  const timeline = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Таймлайн" }))
    return screen.getByRole("region", { name: "Истории" })
  }
  const savedOrder = () =>
    parseViewSettings(updateDatabaseViewConfig.mock.calls[0][0].configJson).manualOrder

  it("lists the stories in the order of the universe by default, unplaced ones by creation", async () => {
    mountPage("universe:u1")
    await within(await screen.findByRole("region", { name: "Истории" })).findByRole("button", {
      name: /Близнец/,
    })
    expect(selectedText("Сортировка")).toBe("По порядку")
    expect(names()).toEqual(["MoleHills", "Близнец"])
  })

  it("puts the stories placed by hand first", async () => {
    getDatabaseView.mockResolvedValue({
      revision: "view-r1",
      configJson: JSON.stringify({ manualOrder: ["note_twin", "note_hills"] }),
    })
    mountPage("universe:u1")
    await waitFor(() => expect(names()).toEqual(["Близнец", "MoleHills"]))
  })

  it("offers 'in order' only on a universe's page", async () => {
    mountPage("universe:u1")
    await within(await screen.findByRole("region", { name: "Истории" })).findByRole("button", {
      name: /Близнец/,
    })
    fireEvent.click(screen.getByRole("combobox", { name: "Сортировка" }))
    expect(await screen.findByRole("option", { name: /По порядку/ })).toBeTruthy()
    cleanup()
    mountPage("standalone:verse")
    await within(await screen.findByRole("region", { name: "Истории" })).findByRole("button", {
      name: /Одиночка/,
    })
    fireEvent.click(screen.getByRole("combobox", { name: "Сортировка" }))
    await screen.findByRole("option", { name: "Название" })
    expect(screen.queryByRole("option", { name: /По порядку/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Таймлайн" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Карточки" })).toBeNull()
  })

  it("shows the timeline in the same order and remembers the view in this vault", async () => {
    mountPage("universe:u1", { vaultPath: "/vault" })
    const region = await timeline()
    const items = await within(region).findAllByRole("listitem")
    expect(items.map((item) => item.textContent).slice(0, 2)).toEqual([
      expect.stringContaining("MoleHills"),
      expect.stringContaining("Близнец"),
    ])
    expect(within(region).getByText(/Что за чем идёт внутри мира/)).toBeTruthy()
    expect(readWorkshopPrefs("/vault").scopes?.universe?.view).toBe("timeline")
    cleanup()
    mountPage("universe:u1", { vaultPath: "/vault" })
    expect(await screen.findByText(/Что за чем идёт внутри мира/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Таймлайн" }).getAttribute("aria-pressed")).toBe(
      "true",
    )
  })

  it("moves a story with the arrows and saves the order in the first view of the stories base", async () => {
    mountPage("universe:u1")
    const region = await timeline()
    await within(region).findByText("MoleHills")
    fireEvent.click(within(region).getByRole("button", { name: "Сдвинуть «MoleHills» позже" }))
    await waitFor(() => expect(updateDatabaseViewConfig).toHaveBeenCalledTimes(1))
    expect(updateDatabaseViewConfig.mock.calls[0][0]).toMatchObject({
      databaseId: "db_stories",
      viewId: "v1",
      expectedViewRevision: "view-r1",
    })
    expect(savedOrder()).toEqual(["note_twin", "note_hills"])
    // The first story cannot step out to the left.
    expect(
      (
        within(region).getByRole("button", {
          name: "Сдвинуть «Близнец» позже",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false)
  })

  it("moves a story by dragging it onto another place", async () => {
    mountPage("universe:u1")
    const region = await timeline()
    const items = await within(region).findAllByRole("listitem")
    fireEvent.dragStart(items[0])
    fireEvent.dragOver(items[1])
    fireEvent.drop(items[1])
    await waitFor(() => expect(updateDatabaseViewConfig).toHaveBeenCalledTimes(1))
    expect(savedOrder()).toEqual(["note_twin", "note_hills"])
  })

  it("keeps the places other universes' stories hold when it saves", async () => {
    getDatabaseView.mockResolvedValue({
      revision: "view-r1",
      configJson: JSON.stringify({ manualOrder: ["note_lone", "note_hills", "note_twin"] }),
    })
    mountPage("universe:u1")
    const region = await timeline()
    await waitFor(() =>
      expect(within(region).getAllByRole("listitem")[0].textContent).toContain("MoleHills"),
    )
    fireEvent.click(within(region).getByRole("button", { name: "Сдвинуть «MoleHills» позже" }))
    await waitFor(() => expect(updateDatabaseViewConfig).toHaveBeenCalledTimes(1))
    expect(savedOrder()).toEqual(["note_lone", "note_twin", "note_hills"])
  })

  it("says why the order was not saved", async () => {
    updateDatabaseViewConfig.mockRejectedValue(new Error("диск полон"))
    mountPage("universe:u1")
    const region = await timeline()
    await within(region).findByText("MoleHills")
    fireEvent.click(within(region).getByRole("button", { name: "Сдвинуть «MoleHills» позже" }))
    const alert = await within(region).findByRole("alert")
    expect(alert.textContent).toContain("Не удалось сохранить порядок")
    expect(alert.textContent).toContain("диск полон")
  })

  it("opens a story from the timeline and starts a new one from its end", async () => {
    const { onOpenProject } = mountPage("universe:u1")
    const region = await timeline()
    fireEvent.click(await within(region).findByRole("button", { name: /^Близнец/ }))
    expect(onOpenProject).toHaveBeenCalledWith("twin")
    fireEvent.click(within(region).getByRole("button", { name: "История" }))
    expect(dialog.props?.kinds).toEqual(["story"])
  })

  it("applies the same two-stories rule on the section tab of the page", async () => {
    mountPage("universe:u1")
    const nav = screen.getByRole("navigation", { name: "Разделы мастерской" })
    fireEvent.click(within(nav).getByRole("button", { name: "Персонажи" }))
    const list = await screen.findByRole("region", { name: "Персонажи" })
    await within(list).findByText("Анна")
    expect(within(list).queryByText("Зоя")).toBeNull()
    expect(list.textContent).toContain("Ещё 1 — только в одной истории")
  })
})
