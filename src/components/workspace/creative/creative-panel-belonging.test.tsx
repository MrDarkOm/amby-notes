// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow, DatabaseSummary, ProjectCatalog } from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"
import { useDatabaseStore } from "../database/database-store"
import { selectedText } from "@/lib/test-utils/amby-select"
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
const createWorkshopEntity = vi.fn()
const addStoryLinks = vi.fn()
const listTextStats = vi.fn()
const resolveDatabaseAssetPaths = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>()
  return {
    ...original,
    queryDatabase: (...args: unknown[]) => queryDatabase(...args),
    createWorkshopEntity: (...args: unknown[]) => createWorkshopEntity(...args),
    addStoryLinks: (...args: unknown[]) => addStoryLinks(...args),
    listTextStats: (...args: unknown[]) => listTextStats(...args),
    resolveDatabaseAssetPaths: (...args: unknown[]) => resolveDatabaseAssetPaths(...args),
  }
})
vi.mock("./create-project-dialog", () => ({ CreateProjectDialog: () => null }))
vi.mock("./create-section-dialog", () => ({ CreateSectionDialog: () => null }))

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

/** Three stories: two in the universe "Мир", one on its own; characters and a location. */
function world(options: { linked?: boolean; universeLink?: boolean } = {}): ProjectCatalog {
  const { linked = true, universeLink = true } = options
  const workshop = workshopSummary("verse", {
    name: "Verse",
    path: "Verse",
    fileRevision: "rev-verse",
    sections: [
      section("stories", {
        role: "stories",
        name: "Истории",
        databaseId: "db_stories",
        universePropertyId: universeLink ? "up" : null,
      }),
      section("universes", { role: "universes", name: "Вселенные", databaseId: "db_univ" }),
      section("chars", {
        role: "characters",
        name: "Персонажи",
        databaseId: "db_chars",
        storiesPropertyId: linked ? "stp" : null,
      }),
      section("locs", {
        role: "locations",
        name: "Локации",
        databaseId: "db_locs",
        storiesPropertyId: linked ? "stp2" : null,
      }),
    ],
    stories: [
      storySummary("hills", { workshopId: "verse", name: "MoleHills", databaseId: "db_t_hills" }),
      storySummary("river", { workshopId: "verse", name: "River", databaseId: "db_t_river" }),
      storySummary("lone", { workshopId: "verse", name: "Lone", databaseId: "db_t_lone" }),
    ],
  })
  return catalog([workshop])
}

const ROWS: Record<string, DatabaseRow[]> = {
  db_stories: [
    row("note_hills", "MoleHills", { up: relation("u1") }),
    row("note_river", "River", { up: relation("u1") }),
    row("note_lone", "Lone"),
  ],
  db_univ: [row("u1", "Мир")],
  db_chars: [
    row("anna", "Анна", { stp: relation("note_hills") }),
    row("boris", "Борис", { stp: relation("note_hills", "note_river") }),
    row("vera", "Вера", { stp: relation("note_river") }),
    row("gleb", "Глеб", { stp: relation("note_lone") }),
    // Named in the text of River, in no story's relation.
    row("zoya", "Зоя"),
    // Named nowhere.
    row("eva", "Ева"),
  ],
  db_locs: [row("lake", "Озеро", { stp2: relation("note_river", "note_hills", "note_lone") })],
  db_t_hills: [row("h1", "Глава Холмов")],
  db_t_river: [row("r1", "Глава Реки", { cast: relation("zoya") })],
  db_t_lone: [row("l1", "Глава Одиночки")],
}

const DATABASES: DatabaseSummary[] = []

const props = (extra: Partial<PanelRenderProps> = {}) =>
  ({ databaseRuntimeEnabled: true, ...extra }) as PanelRenderProps

/** Chooses an item of the list at the top of the panel: a story, a universe or the whole workshop. */
async function choose(name: RegExp) {
  fireEvent.click(screen.getByRole("combobox", { name: "История" }))
  fireEvent.click(await screen.findByRole("option", { name }))
}

const has = (name: RegExp) => screen.queryByRole("button", { name }) !== null

describe("CreativePanel: belonging to stories and universes", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    localStorage.clear()
    queryDatabase
      .mockReset()
      .mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
        rows: ROWS[databaseId] ?? [],
        nextCursor: null,
        totalCount: (ROWS[databaseId] ?? []).length,
        diagnostics: [],
      }))
    createWorkshopEntity.mockReset().mockResolvedValue({ noteId: "new-note", linkedStoryId: null })
    addStoryLinks.mockReset().mockResolvedValue({ propertyId: "stp", link: "stories" })
    listTextStats.mockReset().mockResolvedValue([])
    resolveDatabaseAssetPaths.mockReset().mockResolvedValue({ paths: [] })
    useProjectStore.getState().reset()
    useDatabaseStore.setState({ vaultGeneration: 1, databases: DATABASES, invalidationSeq: 0 })
    useCreativeNavStore.setState({
      sectionByProject: {},
      collapsed: {},
      scope: "verse",
      worksOpen: { text: true, anchors: false, notes: false },
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

  it("shows a story's own pages and those its text names, and no other story's", async () => {
    render(<CreativePanel {...props()} />)
    await screen.findByRole("button", { name: /Анна/ })
    expect(has(/Борис/)).toBe(true)
    expect(has(/Озеро/)).toBe(true)
    for (const other of [/Вера/, /Глеб/, /Зоя/, /Ева/]) expect(has(other)).toBe(false)

    await choose(/River/)
    await screen.findByRole("button", { name: /Вера/ })
    // River names Zoya in its text, so she is in it without a word in her own note.
    expect(has(/Зоя/)).toBe(true)
    expect(has(/Борис/)).toBe(true)
    expect(has(/Анна/)).toBe(false)
    expect(has(/Ева/)).toBe(false)
  })

  it("does not label a row while one story is shown", async () => {
    render(<CreativePanel {...props()} />)
    const boris = await screen.findByRole("button", { name: /Борис/ })
    // The round face is in the text too; what must be missing is the story names.
    expect(boris.textContent).toContain("Борис")
    expect(boris.textContent).not.toMatch(/MoleHills|River|\+/)
  })

  it("shows the whole workshop, each page with up to two story names and '+N', and a group of its own for pages in no story", async () => {
    render(<CreativePanel {...props()} />)
    await screen.findByRole("button", { name: /Анна/ })
    await choose(/Вся мастерская/)
    // The header says so, and it did not fall back on the first story.
    await waitFor(() => expect(selectedText("История")).toContain("Вся мастерская"))
    const boris = await screen.findByRole("button", { name: /Борис/ })
    expect(boris.textContent).toContain("MoleHills, River")
    expect((await screen.findByRole("button", { name: /Озеро/ })).textContent).toContain(
      "MoleHills, River +1",
    )
    expect(screen.getByRole("button", { name: /Анна/ }).textContent).toContain("MoleHills")
    expect(screen.getByRole("button", { name: /Зоя/ }).textContent).toContain("River")

    // Eva is named nowhere: she is listed last, under "Без истории", and nobody else is.
    const group = screen.getByTestId("without-story:characters")
    expect(within(group).getByText("Без истории")).toBeTruthy()
    const members = within(group).getAllByRole("button")
    expect(members).toHaveLength(1)
    expect(members[0].textContent).toContain("Ева")
    expect(members[0].textContent).not.toMatch(/MoleHills|River/)
    expect(group.previousElementSibling).not.toBeNull()
    expect(screen.queryByTestId("without-story:locations")).toBeNull()
    // The whole workshop has no story's parts.
    expect(screen.queryByRole("button", { name: /Текст/ })).toBeNull()
  })

  it("shows a universe through its stories", async () => {
    render(<CreativePanel {...props()} />)
    await screen.findByRole("button", { name: /Анна/ })
    await choose(/Мир/)
    await screen.findByRole("button", { name: /Вера/ })
    for (const inside of [/Анна/, /Борис/, /Вера/, /Зоя/, /Озеро/]) expect(has(inside)).toBe(true)
    // Lone is in no universe; Eva is in no story.
    for (const outside of [/Глеб/, /Ева/]) expect(has(outside)).toBe(false)
    expect(screen.queryByTestId("without-story:characters")).toBeNull()
    expect(selectedText("История")).toContain("Мир")
  })

  it("remembers the whole workshop for the next time", async () => {
    render(<CreativePanel {...props({ vault: "/vaults/one" })} />)
    await screen.findByRole("button", { name: /Анна/ })
    await choose(/Вся мастерская/)
    expect(JSON.parse(localStorage.getItem("amby:creative-workshop") ?? "{}")).toEqual({
      "/vaults/one": { story: "all" },
    })
    cleanup()
    act(() => useCreativeNavStore.setState({ storyFilter: null }))
    render(<CreativePanel {...props({ vault: "/vaults/one" })} />)
    await waitFor(() => expect(selectedText("История")).toContain("Вся мастерская"))
  })

  it("creates a page in the shown story linked to it, and in a universe or the whole workshop with no link", async () => {
    const make = async (title: string) => {
      fireEvent.click(await screen.findByRole("button", { name: "Добавить: Персонажи" }))
      const field = await screen.findByRole("textbox", { name: "Название — Персонажи" })
      fireEvent.change(field, { target: { value: title } })
      fireEvent.keyDown(field, { key: "Enter" })
      await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
      const request = createWorkshopEntity.mock.calls[0][0]
      createWorkshopEntity.mockClear()
      return request
    }
    render(<CreativePanel {...props()} />)
    await screen.findByRole("button", { name: /Анна/ })
    expect(await make("Новая")).toMatchObject({
      workshopId: "verse",
      sectionId: "chars",
      title: "Новая",
      storyId: "hills",
    })

    await choose(/River/)
    await screen.findByRole("button", { name: /Вера/ })
    expect(await make("Другая")).toMatchObject({ storyId: "river" })

    await choose(/Мир/)
    await screen.findByRole("button", { name: /Вера/ })
    expect((await make("Общая")).storyId).toBeNull()

    await choose(/Вся мастерская/)
    await screen.findByRole("button", { name: /Анна/ })
    expect((await make("Ничья")).storyId).toBeNull()
  })

  it("makes no link for a section of an older workshop and offers to link it", async () => {
    act(() => useProjectStore.getState().setCatalog(world({ linked: false, universeLink: false })))
    render(<CreativePanel {...props()} />)
    await screen.findByRole("button", { name: /Зоя|Анна|Озеро|Борис/ }).catch(() => null)
    // Without the property a page is in a story only through its text.
    const links = await screen.findAllByRole("button", { name: "Связать с историями" })
    expect(links).toHaveLength(2)

    // A page made here carries no link: there is nowhere to write one.
    fireEvent.click(await screen.findByRole("button", { name: "Добавить: Персонажи" }))
    const field = await screen.findByRole("textbox", { name: "Название — Персонажи" })
    fireEvent.change(field, { target: { value: "Лев" } })
    fireEvent.keyDown(field, { key: "Enter" })
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(createWorkshopEntity.mock.calls[0][0].storyId).toBeNull()

    fireEvent.click(links[0])
    await waitFor(() => expect(addStoryLinks).toHaveBeenCalledTimes(1))
    expect(addStoryLinks.mock.calls[0][0]).toMatchObject({
      workshopId: "verse",
      expectedWorkshopRevision: "rev-verse",
      sectionId: "chars",
      labels: { "property:stories": "Истории", "property:universe": "Вселенная" },
    })
    expect(typeof addStoryLinks.mock.calls[0][0].operationId).toBe("string")
  })

  it("offers to link the stories to the universes that exist, once", async () => {
    act(() => useProjectStore.getState().setCatalog(world({ universeLink: false })))
    render(<CreativePanel {...props()} />)
    await screen.findByRole("button", { name: /Анна/ })
    fireEvent.click(screen.getByRole("button", { name: "Связать истории со вселенными" }))
    await waitFor(() => expect(addStoryLinks).toHaveBeenCalledTimes(1))
    expect(addStoryLinks.mock.calls[0][0]).toMatchObject({ sectionId: "stories" })

    // With the link in place the offer is gone.
    act(() => useProjectStore.getState().setCatalog(world()))
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Связать истории со вселенными" })).toBeNull(),
    )
    expect(screen.queryByRole("button", { name: "Связать с историями" })).toBeNull()
  })

  it("says why a link failed on the world, in the user's words", async () => {
    act(() => useProjectStore.getState().setCatalog(world({ linked: false })))
    const { ProjectOperationError } = await import("@/lib/storage")
    addStoryLinks.mockRejectedValue(
      new ProjectOperationError("revisionConflict", "stale", {
        kind: "revisionConflict",
        actualRevision: "x",
      }),
    )
    render(<CreativePanel {...props()} />)
    const links = await screen.findAllByRole("button", { name: "Связать с историями" })
    fireEvent.click(links[0])
    expect((await screen.findByRole("alert")).textContent).toContain("Не удалось связать")
  })
})
