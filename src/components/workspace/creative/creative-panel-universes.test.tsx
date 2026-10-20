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
const listTextStats = vi.fn()
const resolveDatabaseAssetPaths = vi.fn()
const updateDatabaseRelationValue = vi.fn()
const addStoryLinks = vi.fn()
const dialog = vi.hoisted(() => ({
  props: null as null | {
    open: boolean
    initialKind?: string
    kinds?: string[]
    onCreated: (created: { kind: string; id: string; cardNoteId?: string }) => void
  },
}))

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>()
  return {
    ...original,
    queryDatabase: (...args: unknown[]) => queryDatabase(...args),
    listTextStats: (...args: unknown[]) => listTextStats(...args),
    resolveDatabaseAssetPaths: (...args: unknown[]) => resolveDatabaseAssetPaths(...args),
    updateDatabaseRelationValue: (...args: unknown[]) => updateDatabaseRelationValue(...args),
    addStoryLinks: (...args: unknown[]) => addStoryLinks(...args),
  }
})
vi.mock("./create-project-dialog", () => ({
  CreateProjectDialog: (props: NonNullable<typeof dialog.props>) => {
    dialog.props = props
    return null
  },
}))
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

/** Three stories: two in the universe "Мир", one on its own; "Пустой" holds none. */
function world(
  options: { universes?: boolean; universeProperty?: boolean; extraStory?: boolean } = {},
): ProjectCatalog {
  const { universes = true, universeProperty = true, extraStory = false } = options
  return catalog([
    workshopSummary("verse", {
      name: "Verse",
      path: "Verse",
      fileRevision: "rev-verse",
      sections: [
        section("stories", {
          role: "stories",
          name: "Истории",
          databaseId: "db_stories",
          universePropertyId: universeProperty ? "up" : null,
        }),
        ...(universes
          ? [section("universes", { role: "universes", name: "Вселенные", databaseId: "db_univ" })]
          : []),
        section("chars", {
          role: "characters",
          name: "Персонажи",
          databaseId: "db_chars",
          storiesPropertyId: "stp",
        }),
      ],
      stories: [
        storySummary("hills", { workshopId: "verse", name: "MoleHills", databaseId: "db_t_hills" }),
        storySummary("river", { workshopId: "verse", name: "River", databaseId: "db_t_river" }),
        storySummary("lone", { workshopId: "verse", name: "Lone", databaseId: "db_t_lone" }),
        ...(extraStory
          ? [
              storySummary("fresh", {
                workshopId: "verse",
                name: "Свежая",
                databaseId: "db_t_fresh",
              }),
            ]
          : []),
      ],
    }),
  ])
}

const ROWS: Record<string, DatabaseRow[]> = {}
function resetRows() {
  for (const key of Object.keys(ROWS)) delete ROWS[key]
  Object.assign(ROWS, {
    db_stories: [
      row("note_hills", "MoleHills", { up: relation("u1") }),
      row("note_river", "River", { up: relation("u1") }),
      row("note_lone", "Lone"),
    ],
    db_univ: [row("u1", "Мир"), row("u2", "Пустой")],
    db_chars: [
      row("anna", "Анна", { stp: relation("note_hills") }),
      row("vera", "Вера", { stp: relation("note_river") }),
      row("gleb", "Глеб", { stp: relation("note_lone") }),
      // Named nowhere.
      row("eva", "Ева"),
    ],
    db_t_hills: [row("h1", "Глава Холмов")],
    db_t_river: [row("r1", "Глава Реки")],
    db_t_lone: [row("l1", "Глава Одиночки")],
  })
}

const DATABASES: DatabaseSummary[] = []
const VAULT = "/vaults/one"

const props = (extra: Partial<PanelRenderProps> = {}) =>
  ({ databaseRuntimeEnabled: true, vault: VAULT, ...extra }) as PanelRenderProps

const prefs = () => JSON.parse(localStorage.getItem("amby:creative-workshop") ?? "{}")[VAULT] ?? {}
const has = (name: RegExp) => screen.queryByRole("button", { name }) !== null

/** The bar the drop-down lists sit in: universe › story, and the button that opens the page. */
const cardOf = (name: string) =>
  screen.getByRole("combobox", { name }).closest("[data-scope-bar]") as HTMLElement
const rowOf = cardOf

async function open(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name }))
  return screen.findAllByRole("option")
}
async function pick(name: string, option: RegExp) {
  // A list that was just used may still be closing.
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
  fireEvent.click(screen.getByRole("combobox", { name }))
  fireEvent.click(await screen.findByRole("option", { name: option }))
}
/** The panel has read the stories' cards: with none chosen it shows the first standalone story. */
const settled = () => waitFor(() => expect(selectedText("История")).toContain("Lone"))
/** The card of the stories lists the two stories of "Мир": the scope was read. */
const inUniverse = () => waitFor(() => expect(selectedText("История")).toContain("2 истории"))
const labels = (options: HTMLElement[]) => options.map((option) => option.textContent ?? "")

describe("CreativePanel: the stories above the lists, the universes below them", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    localStorage.clear()
    resetRows()
    dialog.props = null
    queryDatabase
      .mockReset()
      .mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
        rows: ROWS[databaseId] ?? [],
        nextCursor: null,
        totalCount: (ROWS[databaseId] ?? []).length,
        diagnostics: [],
      }))
    listTextStats.mockReset().mockResolvedValue([])
    resolveDatabaseAssetPaths.mockReset().mockResolvedValue({ paths: [] })
    updateDatabaseRelationValue.mockReset().mockResolvedValue({})
    addStoryLinks.mockReset().mockResolvedValue({ propertyId: "up_new", link: "universe" })
    useProjectStore.getState().reset()
    useDatabaseStore.setState({ vaultGeneration: 1, databases: DATABASES, invalidationSeq: 0 })
    useCreativeNavStore.setState({
      sectionByProject: {},
      collapsed: {},
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

  describe("the card of the stories", () => {
    it("names the stories, shows the first story of the scope, and ends its list with 'New story'", async () => {
      render(<CreativePanel {...props()} />)
      // One bar holds the universe and the story, in that order.
      const card = cardOf("История")
      expect(card).toBe(cardOf("Вселенная"))
      const universe = screen.getByRole("combobox", { name: "Вселенная" })
      const story = screen.getByRole("combobox", { name: "История" })
      expect(
        universe.compareDocumentPosition(story) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      // The panel opens on the standalone stories: Lone is the only one.
      await waitFor(() => expect(selectedText("История")).toContain("Lone"))

      const options = await open("История")
      expect(labels(options)).toEqual([
        expect.stringContaining("Lone"),
        "Все истории",
        "Новая история",
      ])
    })

    it("says 'All stories' with their count when none is chosen, and no pages or words", async () => {
      render(<CreativePanel {...props()} />)
      await settled()
      await pick("История", /Все истории/)
      await waitFor(() => expect(selectedText("История")).toContain("Все истории"))
      expect(selectedText("История")).toContain("1 история")
      expect(selectedText("История")).not.toMatch(/стр\.|сл\./)
      // The text of no story is shown for all of them.
      expect(screen.queryByRole("button", { name: /Текст/ })).toBeNull()
    })

    it("lists the stories of the universe chosen below, and no others", async () => {
      render(<CreativePanel {...props()} />)
      await settled()
      await pick("Вселенная", /Мир/)
      await waitFor(() => expect(selectedText("История")).toContain("2 истории"))
      const options = await open("История")
      expect(labels(options)).toEqual([
        expect.stringContaining("Все истории"),
        "MoleHills",
        "River",
        "Новая история",
      ])
    })

    it("asks for a new story from the end of its list", async () => {
      render(<CreativePanel {...props()} />)
      await settled()
      const options = await open("История")
      fireEvent.click(options[options.length - 1])
      await waitFor(() => expect(dialog.props?.open).toBe(true))
      expect(dialog.props?.initialKind).toBe("story")
    })

    it("opens the page of the story, of the universe, or of the workshop, as it stands", async () => {
      const onOpenCreativeProject = vi.fn()
      render(<CreativePanel {...props({ onOpenCreativeProject })} />)
      const top = () => within(rowOf("История"))
      await waitFor(() => expect(selectedText("История")).toContain("Lone"))
      fireEvent.click(top().getByRole("button", { name: "Открыть страницу истории" }))
      expect(onOpenCreativeProject).toHaveBeenLastCalledWith("lone", undefined)

      await pick("Вселенная", /Мир/)
      await waitFor(() => expect(selectedText("История")).toContain("Все истории"))
      fireEvent.click(top().getByRole("button", { name: "Открыть страницу вселенной" }))
      expect(onOpenCreativeProject).toHaveBeenLastCalledWith("universe:u1", undefined)

      await pick("Вселенная", /Отдельные истории/)
      await waitFor(() => expect(selectedText("Вселенная")).toContain("Отдельные истории"))
      fireEvent.click(top().getByRole("button", { name: "Открыть страницу отдельных историй" }))
      expect(onOpenCreativeProject).toHaveBeenLastCalledWith("standalone:verse", undefined)
    })
  })

  describe("the card of the universes", () => {
    it("sits under the search row and says 'Standalone stories' until a universe is chosen", async () => {
      render(<CreativePanel {...props()} />)
      const create = screen.getByRole("button", { name: "Создать" })
      const card = cardOf("Вселенная")
      expect(create.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(selectedText("Вселенная")).toContain("Отдельные истории")
      // The title of the panel is the one place that says "Workshop".
      expect(card.textContent).not.toContain("Мастерская")
    })

    it("lists 'Standalone stories' first, then the universes by the rows of their base, then 'New universe'", async () => {
      render(<CreativePanel {...props()} />)
      await open("Вселенная")
      await waitFor(() => expect(labels(screen.getAllByRole("option"))).toContain("Мир"))
      expect(labels(screen.getAllByRole("option"))).toEqual([
        expect.stringContaining("Отдельные истории"),
        "Мир",
        "Пустой",
        "Новая вселенная",
      ])
    })

    it("chooses a universe: with no story picked yet the lists show it through its stories", async () => {
      render(<CreativePanel {...props()} />)
      await screen.findByRole("button", { name: /Глеб/ })
      await pick("Вселенная", /Мир/)
      await waitFor(() => expect(selectedText("Вселенная")).toContain("Мир"))
      // The first story was only the default: the universe is shown whole.
      await waitFor(() => expect(selectedText("История")).toContain("Все истории"))
      await screen.findByRole("button", { name: /Вера/ })
      expect(has(/Анна/)).toBe(true)
      expect(has(/Глеб/)).toBe(false)
    })

    it("lets a story chosen inside a universe narrow it", async () => {
      render(<CreativePanel {...props()} />)
      await settled()
      await pick("Вселенная", /Мир/)
      await screen.findByRole("button", { name: /Вера/ })
      await pick("История", /River/)
      await waitFor(() => expect(selectedText("История")).toContain("River"))
      expect(selectedText("Вселенная")).toContain("Мир")
      expect(has(/Вера/)).toBe(true)
      expect(has(/Анна/)).toBe(false)
    })

    it("resets a story the new scope does not hold to 'All stories'", async () => {
      render(<CreativePanel {...props()} />)
      await settled()
      await pick("Вселенная", /Мир/)
      await inUniverse()
      await pick("История", /River/)
      await waitFor(() => expect(prefs().story).toBe("river"))
      await pick("Вселенная", /Пустой/)
      await waitFor(() => expect(prefs()).toEqual({ story: "all", universe: "u2" }))
      // The empty universe holds no story: instead of a list with nothing to choose, the card
      // offers making the first one.
      expect(await screen.findByRole("button", { name: /Создать первую историю/ })).toBeTruthy()
      expect(screen.queryByRole("combobox", { name: "История" })).toBeNull()
      expect(screen.queryByText("Все истории")).toBeNull()
    })

    it("offers the first story instead of 'All stories' when the scope holds none, and makes it", async () => {
      render(<CreativePanel {...props()} />)
      await settled()
      await pick("Вселенная", /Пустой/)
      const prompt = await screen.findByRole("button", { name: /Создать первую историю/ })
      fireEvent.click(prompt)
      await waitFor(() => expect(dialog.props?.open).toBe(true))
    })

    it("shows no parts and no world under a universe that holds no story: only the card offering one", async () => {
      render(<CreativePanel {...props()} />)
      await settled()
      await pick("Вселенная", /Пустой/)
      await screen.findByRole("button", { name: /Создать первую историю/ })
      // No "add the first…" rows, no "World" heading, no empty parts of the anchors or notes.
      expect(screen.queryByRole("button", { name: "Добавить: Персонажи" })).toBeNull()
      expect(screen.queryByText("Мир")).toBeNull()
      expect(screen.queryByText("Нет разделов мира")).toBeNull()
      expect(screen.queryByText(/Добавить первый/)).toBeNull()
    })

    it("goes back to the standalone stories, which hold a page of no story as a group of its own", async () => {
      render(<CreativePanel {...props()} />)
      await settled()
      await pick("Вселенная", /Мир/)
      await inUniverse()
      await pick("История", /River/)
      await pick("Вселенная", /Отдельные истории/)
      await waitFor(() => expect(selectedText("Вселенная")).toContain("Отдельные истории"))
      await waitFor(() => expect(selectedText("История")).toContain("Все истории"))
      await screen.findByRole("button", { name: /Глеб/ })
      expect(has(/Анна|Вера/)).toBe(false)
      // Nobody names Eva: she is in the standalone scope, last, under "Без истории".
      const group = screen.getByTestId("without-story:characters")
      expect(group.textContent).toContain("Ева")
    })

    it("is always there: 'Standalone stories' and 'New universe' only, when there are no universes", async () => {
      ROWS.db_univ.splice(0)
      render(<CreativePanel {...props()} />)
      await screen.findByRole("button", { name: /Глеб/ })
      expect(selectedText("Вселенная")).toContain("Отдельные истории")
      const options = await open("Вселенная")
      expect(labels(options)).toEqual([
        expect.stringContaining("Отдельные истории"),
        "Новая вселенная",
      ])
    })

    it("is there for a workshop without the base too, and asks for the universe from its list", async () => {
      act(() => useProjectStore.getState().setCatalog(world({ universes: false })))
      render(<CreativePanel {...props()} />)
      expect(selectedText("Вселенная")).toContain("Отдельные истории")
      const options = await open("Вселенная")
      expect(labels(options)).toEqual([
        expect.stringContaining("Отдельные истории"),
        "Новая вселенная",
      ])
      fireEvent.click(options[options.length - 1])
      await waitFor(() => expect(dialog.props?.open).toBe(true))
      expect(dialog.props?.initialKind).toBe("universe")
      expect(dialog.props?.kinds).toEqual(["universe"])
    })

    it("makes a universe and chooses it, then opens its page", async () => {
      const onOpenCreativeProject = vi.fn()
      render(
        <CreativePanel
          {...props({ onOpenCreativeProject, onCreativeChanged: async () => undefined })}
        />,
      )
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Вселенная" })).toBeTruthy())
      const options = await open("Вселенная")
      fireEvent.click(options[options.length - 1])
      await waitFor(() => expect(dialog.props?.open).toBe(true))
      expect(dialog.props?.initialKind).toBe("universe")

      // The page is written by the operation; the list reads it once the databases change.
      ROWS.db_univ.push(row("u9", "Космос"))
      await act(async () => {
        dialog.props?.onCreated({ kind: "universe", id: "u9" })
      })
      expect(useCreativeNavStore.getState().universeFilter).toBe("u9")
      expect(prefs().universe).toBe("u9")
      await waitFor(() =>
        expect(onOpenCreativeProject).toHaveBeenCalledWith("universe:u9", undefined),
      )
      act(() => useCreativeNavStore.getState().bumpData())
      await waitFor(() => expect(selectedText("Вселенная")).toContain("Космос"))
      // The new universe was not taken for a missing one in the meantime.
      expect(useCreativeNavStore.getState().universeFilter).toBe("u9")
      expect(prefs().universe).toBe("u9")
    })

    it("opens the page of the universe, or of the standalone stories", async () => {
      const onOpenCreativeProject = vi.fn()
      render(<CreativePanel {...props({ onOpenCreativeProject })} />)
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Вселенная" })).toBeTruthy())
      const bottom = () => within(rowOf("Вселенная"))
      fireEvent.click(bottom().getByRole("button", { name: "Открыть страницу отдельных историй" }))
      expect(onOpenCreativeProject).toHaveBeenLastCalledWith("standalone:verse", undefined)

      await pick("Вселенная", /Мир/)
      await waitFor(() => expect(selectedText("Вселенная")).toContain("Мир"))
      fireEvent.click(bottom().getByRole("button", { name: "Открыть страницу вселенной" }))
      expect(onOpenCreativeProject).toHaveBeenLastCalledWith("universe:u1", undefined)
    })
  })

  describe("the header of the panel", () => {
    it("opens the page of the workshop, next to the settings, whatever the scope", async () => {
      const onOpenCreativeProject = vi.fn()
      const onOpenSettings = vi.fn()
      render(<CreativePanel {...props({ onOpenCreativeProject, onOpenSettings })} />)
      const header = screen.getByRole("banner")
      const open = within(header).getByRole("button", { name: "Открыть страницу мастерской" })
      const settings = within(header).getByRole("button", { name: "Настройки мастерской" })
      expect(open.parentElement).toBe(settings.parentElement)
      fireEvent.click(open)
      expect(onOpenCreativeProject).toHaveBeenLastCalledWith("verse", undefined)
      await pick("Вселенная", /Мир/)
      await waitFor(() => expect(selectedText("Вселенная")).toContain("Мир"))
      fireEvent.click(within(header).getByRole("button", { name: "Открыть страницу мастерской" }))
      expect(onOpenCreativeProject).toHaveBeenLastCalledWith("verse", undefined)
    })

    it("is not there before a workshop is", () => {
      act(() => useProjectStore.getState().setCatalog(catalog([])))
      render(<CreativePanel {...props({ onOpenCreativeProject: vi.fn() })} />)
      expect(screen.queryByRole("button", { name: "Открыть страницу мастерской" })).toBeNull()
    })
  })

  describe("a story made while a universe is chosen", () => {
    /** The dialog made the story "fresh" with its card "note_fresh"; the lists read it again. */
    /** `first`: what the story card shows; `null` when the scope holds no story and it offers one. */
    async function makeStory(first: string | null = "MoleHills", onOpenCreativeProject = vi.fn()) {
      ROWS.db_stories.push(row("note_fresh", "Свежая"))
      render(
        <CreativePanel
          {...props({ onOpenCreativeProject, onCreativeChanged: async () => undefined })}
        />,
      )
      if (first === null) {
        await screen.findByRole("button", { name: /Создать первую историю/ })
      } else {
        await waitFor(() => expect(selectedText("История")).toContain(first))
      }
      await act(async () => {
        dialog.props?.onCreated({ kind: "story", id: "fresh", cardNoteId: "note_fresh" })
      })
      return onOpenCreativeProject
    }
    const chooseMir = () =>
      localStorage.setItem(
        "amby:creative-workshop",
        JSON.stringify({ [VAULT]: { universe: "u1" } }),
      )

    it("writes the Universe relation of its card with the card's revision, then shows it in the universe", async () => {
      chooseMir()
      updateDatabaseRelationValue.mockImplementation(async () => {
        // What the write does to the files, and the catalog the refresh reads.
        ROWS.db_stories = ROWS.db_stories.map((entry) =>
          entry.noteId === "note_fresh"
            ? row("note_fresh", "Свежая", { up: relation("u1") })
            : entry,
        )
        act(() => useProjectStore.getState().setCatalog(world({ extraStory: true })))
        return {}
      })
      const onOpen = await makeStory()
      await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1))
      expect(updateDatabaseRelationValue.mock.calls[0][0]).toMatchObject({
        expectedGeneration: 1,
        databaseId: "db_stories",
        noteId: "note_fresh",
        propertyId: "up",
        targetNoteIds: ["u1"],
        expectedRevision: "rev-note_fresh",
      })
      expect(addStoryLinks).not.toHaveBeenCalled()
      await waitFor(() => expect(onOpen).toHaveBeenCalledWith("fresh", undefined))
      // It is chosen and listed, without a manual refresh, and not taken for one outside the scope.
      await waitFor(() => expect(selectedText("История")).toContain("Свежая"))
      expect(useCreativeNavStore.getState().storyFilter).toBe("fresh")
      expect(selectedText("Вселенная")).toContain("Мир")
      await waitFor(() => expect(useCreativeNavStore.getState().freshStoryId).toBeNull())
      expect(screen.queryByRole("alert")).toBeNull()
    })

    it("makes the section's relation first when it has none, then writes with the property it made", async () => {
      act(() => useProjectStore.getState().setCatalog(world({ universeProperty: false })))
      chooseMir()
      // Without the relation the universe holds no story yet: its card offers the first.
      await makeStory(null)
      await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1))
      expect(addStoryLinks).toHaveBeenCalledTimes(1)
      expect(addStoryLinks.mock.calls[0][0]).toMatchObject({
        workshopId: "verse",
        sectionId: "stories",
        expectedWorkshopRevision: "rev-verse",
      })
      expect(addStoryLinks.mock.invocationCallOrder[0]).toBeLessThan(
        updateDatabaseRelationValue.mock.invocationCallOrder[0],
      )
      expect(updateDatabaseRelationValue.mock.calls[0][0]).toMatchObject({
        propertyId: "up_new",
        targetNoteIds: ["u1"],
      })
    })

    it("keeps the story and says why when the relation could not be written", async () => {
      chooseMir()
      updateDatabaseRelationValue.mockRejectedValue(new Error("файл занят"))
      const onOpen = await makeStory()
      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toContain("История создана, но не привязана к вселенной")
      expect(alert.textContent).toContain("файл занят")
      // The story is not lost: its page opens and it is not selected under the universe.
      expect(onOpen).toHaveBeenCalledWith("fresh", undefined)
      expect(useCreativeNavStore.getState().storyFilter).not.toBe("fresh")
    })

    it("writes no link under the standalone stories", async () => {
      const onOpen = await makeStory("Lone")
      await waitFor(() => expect(onOpen).toHaveBeenCalledWith("fresh", undefined))
      expect(updateDatabaseRelationValue).not.toHaveBeenCalled()
      expect(addStoryLinks).not.toHaveBeenCalled()
      expect(screen.queryByRole("alert")).toBeNull()
    })
  })

  describe("the world", () => {
    it("does not list the universes among its sections, only the other ones", async () => {
      render(<CreativePanel {...props()} />)
      await screen.findByRole("button", { name: /Глеб/ })
      expect(screen.getByRole("button", { name: "Добавить: Персонажи" })).toBeTruthy()
      expect(screen.queryByRole("button", { name: /Вселенные/ })).toBeNull()
      expect(screen.queryByRole("button", { name: "Добавить: Вселенные" })).toBeNull()
    })
  })

  describe("what is remembered", () => {
    it("brings back the universe and the story of the last time", async () => {
      render(<CreativePanel {...props()} />)
      await settled()
      await pick("Вселенная", /Мир/)
      await inUniverse()
      await pick("История", /River/)
      await waitFor(() => expect(prefs()).toEqual({ story: "river", universe: "u1" }))
      cleanup()
      act(() => useCreativeNavStore.setState({ storyFilter: null, universeFilter: null }))
      render(<CreativePanel {...props()} />)
      await waitFor(() => expect(selectedText("Вселенная")).toContain("Мир"))
      expect(selectedText("История")).toContain("River")
    })

    it("stores 'standalone' for the stories no universe holds, and reads it back", async () => {
      render(<CreativePanel {...props()} />)
      await settled()
      await pick("Вселенная", /Мир/)
      await pick("Вселенная", /Отдельные истории/)
      await pick("История", /Все истории/)
      await waitFor(() => expect(prefs()).toEqual({ story: "all", universe: "standalone" }))
      cleanup()
      act(() => useCreativeNavStore.setState({ storyFilter: "x", universeFilter: "y" }))
      render(<CreativePanel {...props()} />)
      await waitFor(() => expect(selectedText("История")).toContain("Все истории"))
      expect(selectedText("Вселенная")).toContain("Отдельные истории")
      expect(useCreativeNavStore.getState().universeFilter).toBeNull()
    })

    it("drops a universe and a story that are gone back to the defaults, writing it down", async () => {
      localStorage.setItem(
        "amby:creative-workshop",
        JSON.stringify({ [VAULT]: { story: "deleted-story", universe: "deleted-universe" } }),
      )
      render(<CreativePanel {...props()} />)
      await waitFor(() => expect(selectedText("История")).toContain("Все истории"))
      expect(selectedText("Вселенная")).toContain("Отдельные истории")
      await waitFor(() => expect(prefs()).toEqual({ story: "all", universe: "standalone" }))
      // The panel works: the standalone stories are listed.
      expect(await screen.findByRole("button", { name: /Глеб/ })).toBeTruthy()
    })

    it("keeps working when the universe is deleted while it is chosen", async () => {
      useCreativeNavStore.setState({ universeFilter: "u1", storyFilter: "all" })
      render(<CreativePanel {...props({ vault: undefined })} />)
      await screen.findByRole("button", { name: /Анна/ })
      expect(has(/Глеб/)).toBe(false)
      // The universe is deleted: the next read finds no such row.
      ROWS.db_univ.splice(0)
      act(() => useCreativeNavStore.getState().bumpData())
      await waitFor(() => expect(has(/Глеб/)).toBe(true))
      expect(useCreativeNavStore.getState().universeFilter).toBeNull()
    })
  })
})
