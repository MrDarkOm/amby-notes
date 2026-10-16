// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
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
  listTextStats: async () => [],
  resolveDatabaseAssetPaths: async () => ({ paths: [] }),
}))
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
    storySummary("lone", { workshopId: "verse", name: "Одиночка", databaseId: "db_t_lone" }),
  ],
})

const ROWS: Record<string, DatabaseRow[]> = {
  db_stories: [row("note_hills", "MoleHills", { up: rel("u1") }), row("note_lone", "Одиночка")],
  db_univ: [row("u1", "Палуверс")],
  db_chars: [
    row("anna", "Анна", { stp: rel("note_hills") }),
    row("gleb", "Глеб", { stp: rel("note_lone") }),
    row("zoya", "Зоя"),
  ],
  db_t_hills: [row("h1", "Глава", { cast: rel("zoya") })],
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
        renderDatabase={() => null}
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

    // The pages of the universe: Anna names a story of it, Zoya is named in that story's text.
    const characters = await screen.findByRole("region", { name: "Персонажи" })
    await within(characters).findByText("Анна")
    expect(within(characters).getByText("Зоя")).toBeTruthy()
    expect(within(characters).queryByText("Глеб")).toBeNull()
    fireEvent.click(within(characters).getByText("Зоя"))
    expect(onOpenNote).toHaveBeenCalledWith("zoya")
  })

  it("says so when no story belongs to the universe", async () => {
    ROWS.db_stories = [row("note_hills", "MoleHills"), row("note_lone", "Одиночка")]
    try {
      render(
        <ProjectPage
          projectId="universe:u1"
          renderDatabase={() => null}
          onOpenProject={vi.fn()}
          onOpenNote={vi.fn()}
        />,
      )
      expect(await screen.findByText(/В этой вселенной пока нет историй/)).toBeTruthy()
    } finally {
      ROWS.db_stories = [
        row("note_hills", "MoleHills", { up: rel("u1") }),
        row("note_lone", "Одиночка"),
      ]
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
        renderDatabase={() => null}
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
    renderDatabase: vi.fn(() => null),
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
    const group = screen.getByRole("region", { name: "Персонажи: без истории" })
    fireEvent.click(within(group).getByText("Ева"))
    expect(onOpenNote).toHaveBeenCalledWith("eva")
  })

  it("has the header of every page: no settings, no new section, the numbers of the stories", async () => {
    mountPage("standalone:verse")
    await screen.findByRole("region", { name: "Истории" })
    await waitFor(() => expect(screen.getByText(/1 история/)).toBeTruthy())
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
      row("note_lone", "Одиночка", { up: rel("u1") }),
    ]
    try {
      mountPage("standalone:verse")
      expect(await screen.findByText(/Отдельных историй пока нет/)).toBeTruthy()
      expect(screen.getByRole("button", { name: "Новая история" })).toBeTruthy()
    } finally {
      ROWS.db_stories = [
        row("note_hills", "MoleHills", { up: rel("u1") }),
        row("note_lone", "Одиночка"),
      ]
    }
  })

  it("lists one section as the pages of this scope, with a way to the whole base", async () => {
    const { onOpenProject, renderDatabase, onOpenNote } = mountPage("standalone:verse")
    const nav = screen.getByRole("navigation", { name: "Разделы мастерской" })
    fireEvent.click(within(nav).getByRole("button", { name: "Персонажи" }))
    const list = await screen.findByRole("region", { name: "Персонажи" })
    await within(list).findByText("Глеб")
    expect(within(list).queryByText("Анна")).toBeNull()
    expect(renderDatabase).not.toHaveBeenCalled()
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
    mountPage("hills")
    expect(await screen.findByRole("button", { name: "Настройки" })).toBeTruthy()
    cleanup()
    mountPage("verse")
    expect(await screen.findByRole("button", { name: "Настройки" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Раздел" })).toBeTruthy()
  })
})
