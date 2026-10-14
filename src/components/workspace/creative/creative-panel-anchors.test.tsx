// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow, ProjectCatalog } from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"
import { useDatabaseStore } from "../database/database-store"
import { CreativePanel } from "./creative-panel"
import { useCreativeNavStore } from "./creative-nav-store"
import {
  catalog,
  workshopSection as section,
  storySummary,
  workshopSummary,
} from "./project-fixtures.test-support"
import { useProjectStore } from "./project-store"

const queryDatabase = vi.fn()
const ensurePlotLinks = vi.fn()
const createWorkshopEntity = vi.fn()
const listTextStats = vi.fn()
const resolveDatabaseAssetPaths = vi.fn()
const dialogs = vi.hoisted(() => ({
  project: { current: null as null | ((created: { kind: string; id: string }) => void) },
  section: {
    current: null as null | ((created: { section: { sectionId: string } }) => void),
  },
}))

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>()
  return {
    ...original,
    queryDatabase: (...args: unknown[]) => queryDatabase(...args),
    ensurePlotLinks: (...args: unknown[]) => ensurePlotLinks(...args),
    createWorkshopEntity: (...args: unknown[]) => createWorkshopEntity(...args),
    listTextStats: (...args: unknown[]) => listTextStats(...args),
    resolveDatabaseAssetPaths: (...args: unknown[]) => resolveDatabaseAssetPaths(...args),
  }
})
vi.mock("./create-project-dialog", () => ({
  CreateProjectDialog: (props: { onCreated: (created: { kind: string; id: string }) => void }) => {
    dialogs.project.current = props.onCreated
    return null
  },
}))
vi.mock("./create-section-dialog", () => ({
  CreateSectionDialog: (props: {
    onCreated: (created: { section: { sectionId: string } }) => void
  }) => {
    dialogs.section.current = props.onCreated
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
const relation = (...ids: string[]) => ({ type: "relation", targetNoteIds: ids })

function world(options: { universeProperty?: boolean } = {}): ProjectCatalog {
  const { universeProperty = true } = options
  return catalog([
    workshopSummary("verse", {
      name: "Verse",
      fileRevision: "rev-verse",
      sections: [
        section("stories", {
          role: "stories",
          name: "Истории",
          databaseId: "db_stories",
          universePropertyId: "up",
        }),
        section("universes", { role: "universes", name: "Вселенные", databaseId: "db_univ" }),
        section("anchors", {
          role: "anchors",
          name: "Якоря",
          databaseId: "db_anch",
          databaseName: "Якоря",
          storiesPropertyId: "ast",
          universePropertyId: universeProperty ? "au" : null,
        }),
      ],
      stories: [
        storySummary("hills", { workshopId: "verse", name: "MoleHills", databaseId: "db_t_hills" }),
        storySummary("lone", { workshopId: "verse", name: "Lone", databaseId: "db_t_lone" }),
      ],
    }),
  ])
}

const ROWS: Record<string, DatabaseRow[]> = {
  db_stories: [row("note_hills", "MoleHills", { up: relation("u1") }), row("note_lone", "Lone")],
  db_univ: [row("u1", "Мир")],
  db_anch: [
    row("a1", "Встреча", { ast: relation("note_hills") }),
    row("a2", "Потоп", { au: relation("u1") }),
    row("a3", "Одинокий", { ast: relation("note_lone") }),
    row("a4", "Ничей"),
  ],
  db_t_hills: [],
  db_t_lone: [],
}

const props = (extra: Partial<PanelRenderProps> = {}) =>
  ({ databaseRuntimeEnabled: true, ...extra }) as PanelRenderProps

async function choose(name: RegExp) {
  fireEvent.click(screen.getByRole("combobox", { name: "История" }))
  fireEvent.click(await screen.findByRole("option", { name }))
}

describe("CreativePanel: the anchors when no single story is shown", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    localStorage.clear()
    dialogs.project.current = null
    queryDatabase
      .mockReset()
      .mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
        rows: ROWS[databaseId] ?? [],
        nextCursor: null,
        totalCount: (ROWS[databaseId] ?? []).length,
        diagnostics: [],
      }))
    ensurePlotLinks.mockReset().mockResolvedValue({ changed: true })
    createWorkshopEntity.mockReset().mockResolvedValue({ noteId: "new-note", linkedStoryId: null })
    listTextStats.mockReset().mockResolvedValue([])
    resolveDatabaseAssetPaths.mockReset().mockResolvedValue({ paths: [] })
    useProjectStore.getState().reset()
    useDatabaseStore.setState({ vaultGeneration: 1, databases: [], invalidationSeq: 0 })
    useCreativeNavStore.setState({
      sectionByProject: {},
      collapsed: {},
      scope: "verse",
      worksOpen: { text: true, anchors: true, notes: false },
      storyFilter: null,
      universeFilter: null,
      dataNonce: 0,
      search: "",
      pageRequest: null,
      entityRequest: null,
      createRequest: null,
    })
    act(() => useProjectStore.getState().setCatalog(world()))
  })
  afterEach(cleanup)

  const titles = (container: HTMLElement) =>
    within(container)
      .getAllByRole("button")
      .map((button) => button.textContent ?? "")
      .filter((text) => /Встреча|Потоп|Одинокий|Ничей/.test(text))

  it("lists all the anchors of the whole workshop in the author's order, those of no story last", async () => {
    render(<CreativePanel {...props()} />)
    await choose(/Вся мастерская/)
    await screen.findByRole("button", { name: /Встреча/ })
    const names = titles(document.body)
    expect(names.map((text) => text.replace(/MoleHills|Lone/, "").trim())).toEqual([
      "Встреча",
      "Одинокий",
      "Потоп",
      "Ничей",
    ])
    // The story names show on the rows, and "No story" holds only what belongs nowhere: the event
    // of a universe is not one of them.
    expect(screen.getByRole("button", { name: /Встреча/ }).textContent).toContain("MoleHills")
    const heading = screen.getByRole("heading", { name: /Без истории/ })
    expect(heading.textContent).toContain("1")
    expect(heading.nextElementSibling?.textContent).toContain("Ничей")
    expect(screen.queryByText("События вселенной")).toBeNull()
  })

  it("shows the events of a universe first, then the anchors of its stories", async () => {
    render(<CreativePanel {...props()} />)
    await choose(/Мир/)
    await screen.findByRole("button", { name: /Потоп/ })
    expect(titles(document.body).map((text) => text.replace(/MoleHills/, "").trim())).toEqual([
      "Потоп",
      "Встреча",
    ])
    const events = screen.getByRole("heading", { name: /События вселенной/ })
    expect(events.nextElementSibling?.textContent).toContain("Потоп")
    expect(screen.getByRole("heading", { name: /Якоря историй/ })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Одинокий/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Ничей/ })).toBeNull()
  })

  async function addIn(filter: RegExp, title: string) {
    render(<CreativePanel {...props()} />)
    await choose(filter)
    await screen.findAllByRole("button", { name: /Потоп|Встреча/ })
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }))
    const field = await screen.findByPlaceholderText("Название якоря — Enter, чтобы создать")
    fireEvent.change(field, { target: { value: title } })
    fireEvent.keyDown(field, { key: "Enter" })
  }

  it("makes an anchor shown in a universe an event of it, with the relation made first when missing", async () => {
    act(() => useProjectStore.getState().setCatalog(world({ universeProperty: false })))
    await addIn(/Мир/, "Пожар")
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(ensurePlotLinks).toHaveBeenCalledWith(
      expect.objectContaining({ target: "anchors", workshopId: "verse" }),
    )
    expect(ensurePlotLinks.mock.invocationCallOrder[0]).toBeLessThan(
      createWorkshopEntity.mock.invocationCallOrder[0],
    )
    expect(createWorkshopEntity).toHaveBeenCalledWith(
      expect.objectContaining({ sectionId: "anchors", title: "Пожар", universeId: "u1" }),
    )
  })

  it("does not ask for the relation again when the anchors have it", async () => {
    await addIn(/Мир/, "Пожар")
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(ensurePlotLinks).not.toHaveBeenCalled()
  })

  it("links nothing to a universe or a story when the whole workshop is shown", async () => {
    await addIn(/Вся мастерская/, "Свободный")
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(createWorkshopEntity).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Свободный", storyId: null, universeId: null }),
    )
    expect(ensurePlotLinks).not.toHaveBeenCalled()
  })

  it("shows the failure of the relation and writes no anchor", async () => {
    act(() => useProjectStore.getState().setCatalog(world({ universeProperty: false })))
    ensurePlotLinks.mockReset().mockRejectedValue(new Error("файл занят"))
    await addIn(/Мир/, "Пожар")
    expect(await screen.findByText(/файл занят/)).toBeTruthy()
    expect(createWorkshopEntity).not.toHaveBeenCalled()
  })
})

describe("CreativePanel: the anchors' relations after a base was made", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    localStorage.clear()
    dialogs.project.current = null
    queryDatabase.mockReset().mockResolvedValue({
      rows: [],
      nextCursor: null,
      totalCount: 0,
      diagnostics: [],
    })
    ensurePlotLinks.mockReset().mockResolvedValue({ changed: true })
    listTextStats.mockReset().mockResolvedValue([])
    resolveDatabaseAssetPaths.mockReset().mockResolvedValue({ paths: [] })
    useProjectStore.getState().reset()
    useDatabaseStore.setState({ vaultGeneration: 1, databases: [], invalidationSeq: 0 })
    useCreativeNavStore.setState({ scope: "verse", storyFilter: null, universeFilter: null })
  })
  afterEach(cleanup)

  async function createUniverse(missing: boolean) {
    act(() => useProjectStore.getState().setCatalog(world({ universeProperty: !missing })))
    render(
      <CreativePanel
        {...props({ onCreativeChanged: async () => undefined, onOpenCreativeProject: vi.fn() })}
      />,
    )
    await waitFor(() => expect(dialogs.project.current).not.toBeNull())
    await act(async () => {
      dialogs.project.current?.({ kind: "universe", id: "u9" })
    })
  }

  it("makes the Universe relation of the anchors right after a universe was made", async () => {
    await createUniverse(true)
    await waitFor(() => expect(ensurePlotLinks).toHaveBeenCalledTimes(1))
    expect(ensurePlotLinks).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "anchors",
        workshopId: "verse",
        expectedRevision: "rev-verse",
      }),
    )
  })

  it("asks for nothing when the anchors already have it", async () => {
    await createUniverse(false)
    await act(async () => {})
    expect(ensurePlotLinks).not.toHaveBeenCalled()
  })

  it("shows the failure instead of swallowing it", async () => {
    ensurePlotLinks.mockReset().mockRejectedValue(new Error("файл занят"))
    await createUniverse(true)
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("файл занят")
    expect(alert.textContent).toContain("Не удалось подготовить связи якорей")
  })
})

describe("CreativePanel: the anchors' relations after a section was made", () => {
  /** A workshop with a story and a universe but no anchors yet; or, after the section was made. */
  function workshopWith(options: { anchors: boolean; arcs?: boolean; universes?: boolean }) {
    const { anchors, arcs = false, universes = true } = options
    const sections = [
      section("stories", { role: "stories", name: "Истории", databaseId: "db_stories" }),
      ...(universes
        ? [section("universes", { role: "universes", name: "Вселенные", databaseId: "db_univ" })]
        : []),
      ...(arcs ? [section("arcs", { role: "arcs", name: "Арки", databaseId: "db_arcs" })] : []),
      ...(anchors
        ? [
            section("anchors", {
              role: "anchors",
              name: "Якоря",
              databaseId: "db_anch",
              storiesPropertyId: "ast",
            }),
          ]
        : []),
    ]
    return catalog([
      workshopSummary("verse", {
        name: "Verse",
        fileRevision: "rev-verse",
        sections,
        stories: [
          storySummary("hills", {
            workshopId: "verse",
            name: "MoleHills",
            databaseId: "db_t_hills",
          }),
        ],
      }),
    ])
  }

  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    localStorage.clear()
    dialogs.section.current = null
    queryDatabase.mockReset().mockResolvedValue({
      rows: [],
      nextCursor: null,
      totalCount: 0,
      diagnostics: [],
    })
    ensurePlotLinks.mockReset().mockResolvedValue({ changed: true })
    listTextStats.mockReset().mockResolvedValue([])
    resolveDatabaseAssetPaths.mockReset().mockResolvedValue({ paths: [] })
    useProjectStore.getState().reset()
    useDatabaseStore.setState({ vaultGeneration: 1, databases: [], invalidationSeq: 0 })
    useCreativeNavStore.setState({
      sectionByProject: {},
      collapsed: {},
      scope: "verse",
      worksOpen: { text: true, anchors: true, notes: false },
      storyFilter: null,
      universeFilter: null,
      dataNonce: 0,
      search: "",
      pageRequest: null,
      entityRequest: null,
      createRequest: null,
    })
  })
  afterEach(cleanup)

  /**
   * "Create anchors" in the story's anchors part opens the section dialog; the dialog finishes
   * and the catalog, read again, holds the new base (the test sets it where the store would).
   */
  async function makeAnchors(after: ProjectCatalog) {
    act(() => useProjectStore.getState().setCatalog(workshopWith({ anchors: false })))
    render(
      <CreativePanel
        {...props({ onCreativeChanged: async () => undefined, onOpenCreativeProject: vi.fn() })}
      />,
    )
    fireEvent.click(await screen.findByRole("button", { name: "Создать раздел «Якоря»" }))
    await waitFor(() => expect(dialogs.section.current).not.toBeNull())
    act(() => useProjectStore.getState().setCatalog(after))
    await act(async () => {
      dialogs.section.current?.({ section: { sectionId: "anchors" } })
    })
  }

  it("makes the Universe relation of anchors born after the universes", async () => {
    await makeAnchors(workshopWith({ anchors: true }))
    await waitFor(() => expect(ensurePlotLinks).toHaveBeenCalledTimes(1))
    expect(ensurePlotLinks).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "anchors",
        workshopId: "verse",
        expectedRevision: "rev-verse",
      }),
    )
  })

  it("makes the Arcs relation too when the arcs exist, in the one call", async () => {
    act(() => useProjectStore.getState().setCatalog(workshopWith({ anchors: false, arcs: true })))
    await makeAnchors(workshopWith({ anchors: true, arcs: true }))
    await waitFor(() => expect(ensurePlotLinks).toHaveBeenCalledTimes(1))
    expect(ensurePlotLinks.mock.calls[0][0]).toMatchObject({ target: "anchors" })
  })

  it("asks for nothing when there is nothing to relate the new anchors to", async () => {
    // No universes and no arcs in the workshop: the anchors need no relation of their own.
    act(() => useProjectStore.getState().setCatalog(workshopWith({ anchors: false })))
    render(
      <CreativePanel
        {...props({ onCreativeChanged: async () => undefined, onOpenCreativeProject: vi.fn() })}
      />,
    )
    fireEvent.click(await screen.findByRole("button", { name: "Создать раздел «Якоря»" }))
    await waitFor(() => expect(dialogs.section.current).not.toBeNull())
    act(() =>
      useProjectStore
        .getState()
        .setCatalog(workshopWith({ anchors: true, universes: false, arcs: false })),
    )
    await act(async () => {
      dialogs.section.current?.({ section: { sectionId: "anchors" } })
    })
    await act(async () => {})
    expect(ensurePlotLinks).not.toHaveBeenCalled()
  })

  it("shows the failure instead of swallowing it, and still opens the new section", async () => {
    ensurePlotLinks.mockReset().mockRejectedValue(new Error("файл занят"))
    const onOpenCreativeProject = vi.fn()
    act(() => useProjectStore.getState().setCatalog(workshopWith({ anchors: false })))
    render(
      <CreativePanel
        {...props({ onCreativeChanged: async () => undefined, onOpenCreativeProject })}
      />,
    )
    fireEvent.click(await screen.findByRole("button", { name: "Создать раздел «Якоря»" }))
    await waitFor(() => expect(dialogs.section.current).not.toBeNull())
    act(() => useProjectStore.getState().setCatalog(workshopWith({ anchors: true })))
    await act(async () => {
      dialogs.section.current?.({ section: { sectionId: "anchors" } })
    })
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("файл занят")
    expect(alert.textContent).toContain("Не удалось подготовить связи якорей")
    expect(onOpenCreativeProject).toHaveBeenCalledWith("verse", "anchors")
  })
})
