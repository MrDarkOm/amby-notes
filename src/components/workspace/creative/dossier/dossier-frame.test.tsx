// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useContext } from "react"
import i18n from "@/lib/i18n"
import type { DatabaseNoteContext, DatabasePropertySummary, NoteReference } from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { NotePagesDossierContext } from "../../editor/note-pages-context"
import { catalog, section, storySummary, workshopSummary } from "../project-fixtures.test-support"
import { useProjectStore } from "../project-store"
import { CreativeNoteProvider } from "./creative-note-provider"
import { DossierFrame } from "./dossier-frame"

const storage = vi.hoisted(() => ({
  getDatabaseNoteContext: vi.fn(),
  listNoteReferences: vi.fn(),
  updateDatabaseRelationValue: vi.fn(),
  searchNotes: vi.fn(),
  queryDatabase: vi.fn(),
}))
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  ...storage,
}))

const importance = {
  propertyId: "imp",
  name: "Значимость",
  propertyType: "select",
  configJson: "{}",
  options: [{ optionId: "a", name: "Главные", color: "#22c55e" }],
} as unknown as DatabasePropertySummary
const portrait = {
  propertyId: "pic",
  name: "Портрет",
  propertyType: "files",
  configJson: "{}",
  options: [],
} as unknown as DatabasePropertySummary

function context(databaseId: string, title = "Персонажи"): DatabaseNoteContext {
  return {
    vaultGeneration: 1,
    databaseId,
    databaseTitle: title,
    databaseIcon: null,
    manifestRevision: "m",
    locked: false,
    properties: [
      importance,
      portrait,
      { ...importance, propertyId: "role", name: "Роль", propertyType: "text", options: [] },
    ],
    row: {
      noteId: "n1",
      title: "Алиса",
      relativePath: "Алиса.md",
      parentNoteId: null,
      depth: 0,
      categoryPath: [],
      valuesJson: JSON.stringify({
        imp: { type: "select", optionId: "a" },
        role: { type: "text", value: "Разведчик" },
        story: { type: "relation", targetNoteIds: ["note_molehills_story"] },
      }),
      rowRevision: "r",
    },
  }
}

const reference = (over: Partial<NoteReference>): NoteReference => ({
  direction: "in",
  propertyId: "who",
  propertyName: "Участники",
  databaseId: "db_text",
  databaseName: "Текст",
  noteId: "chapter-1",
  title: "Глава первая",
  ...over,
})

const CONTENT = "## Основное\n\n## Характеристика\n\n## Биография\n"

function PageDefault() {
  return <div data-testid="page-default">{String(useContext(NotePagesDossierContext))}</div>
}

function mount(props: { canJump?: boolean; onOpenNote?: (id: string) => void } = {}) {
  const scrollToHeading = vi.fn()
  render(
    <CreativeNoteProvider noteId="n1">
      <PageDefault />
      <DossierFrame
        noteId="n1"
        content={CONTENT}
        canJump={props.canJump ?? true}
        scrollToHeading={scrollToHeading}
        onOpenNote={props.onOpenNote}
      >
        <div data-testid="editor">editor</div>
      </DossierFrame>
    </CreativeNoteProvider>,
  )
  return { scrollToHeading }
}

const story = workshopSummary("molehills", {
  name: "MoleHills",
  sections: [
    section("characters", {
      role: "characters",
      storiesPropertyId: "story",
      databaseName: "Персонажи",
      databaseId: "db_characters",
    }),
    section("notes", { role: "notes", databaseName: "Заметки", databaseId: "db_notes" }),
    section("locations", { role: "locations", databaseId: "db_locations" }),
    section("arcs", { role: "arcs", databaseId: "db_arcs" }),
    section("custom", { role: "custom", databaseId: "db_custom" }),
  ],
  stories: [
    storySummary("molehills_story", {
      databaseId: "db_text",
      text: {
        databaseId: "db_text",
        properties: {
          level: null,
          parent: null,
          order: null,
          format: null,
          status: null,
          anchors: null,
          arcs: null,
          characters: null,
          pov: null,
          places: null,
          storyTime: null,
        },
        levels: [],
        formats: [],
        statusOptions: [],
      },
    }),
  ],
})

describe("DossierFrame", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    storage.getDatabaseNoteContext.mockReset()
    storage.listNoteReferences.mockReset().mockResolvedValue([])
    storage.searchNotes.mockReset().mockResolvedValue([])
    storage.queryDatabase.mockReset().mockResolvedValue({ rows: [], nextCursor: null })
    useProjectStore.getState().reset()
    useDatabaseStore.getState().reset(1)
  })
  afterEach(cleanup)

  const settle = () => act(async () => {})

  it("adds nothing to an ordinary note and asks the backend nothing without projects", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([])))
    mount()
    await settle()
    expect(screen.getByTestId("editor")).toBeTruthy()
    expect(screen.queryByRole("complementary")).toBeNull()
    expect(storage.getDatabaseNoteContext).not.toHaveBeenCalled()
  })

  it("adds nothing to a page of the text, of the notes or of an unknown database", async () => {
    const withoutPlot = { ...story, sections: story.sections.filter(({ role }) => role !== "arcs") }
    act(() => useProjectStore.getState().setCatalog(catalog([withoutPlot])))
    for (const databaseId of ["db_text", "db_notes", "db_somewhere"]) {
      storage.getDatabaseNoteContext.mockResolvedValue(context(databaseId))
      mount()
      await settle()
      expect(screen.queryByRole("complementary")).toBeNull()
      expect(screen.getByTestId("page-default").textContent).toBe("false")
      cleanup()
    }
    expect(storage.listNoteReferences).not.toHaveBeenCalled()
  })

  it.each(["db_characters", "db_locations", "db_arcs", "db_custom"])(
    "uses note pages by default for the %s dossier",
    async (databaseId) => {
      act(() => useProjectStore.getState().setCatalog(catalog([story])))
      storage.getDatabaseNoteContext.mockResolvedValue(context(databaseId))
      mount()
      await settle()
      expect(screen.getByTestId("page-default").textContent).toBe("true")
    },
  )

  it("shows the header and the side blocks for a page of a world section", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
    storage.listNoteReferences.mockResolvedValue([
      reference({}),
      reference({
        direction: "out",
        propertyId: "ally",
        propertyName: "Союзники",
        databaseId: "db_characters",
        databaseName: "Персонажи",
        noteId: "bob",
        title: "Боб",
      }),
    ])
    mount()
    await settle()

    expect(screen.queryByText("MoleHills · Персонажи")).toBeNull()
    expect(screen.getByText("А")).toBeTruthy()
    expect(screen.getByText("Разведчик")).toBeTruthy()
    expect(screen.getByText("molehills_story")).toBeTruthy()
    // Key properties come with their names.
    expect(screen.getByText("Значимость")).toBeTruthy()
    expect(screen.getByText("Главные")).toBeTruthy()
    const aside = screen.getByRole("complementary", { name: "Досье" })
    expect(within(aside).getByText("Разделы")).toBeTruthy()
    expect(within(aside).getByText("Биография")).toBeTruthy()
    expect(within(aside).getByText("Появляется в")).toBeTruthy()
    expect(within(aside).getByText("Глава первая")).toBeTruthy()
    expect(within(aside).getByText("Связи")).toBeTruthy()
    expect(within(aside).getByText("Союзники")).toBeTruthy()
    expect(within(aside).getByText("Боб")).toBeTruthy()
  })

  it("never remounts the editor when the answer arrives", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
    mount()
    const before = screen.getByTestId("editor")
    await settle()
    expect(screen.getByRole("complementary", { name: "Досье" })).toBeTruthy()
    expect(screen.getByTestId("editor")).toBe(before)
  })

  it("jumps to a section and opens a page from the blocks", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
    storage.listNoteReferences.mockResolvedValue([reference({})])
    const onOpenNote = vi.fn()
    const { scrollToHeading } = mount({ onOpenNote })
    await settle()
    const aside = screen.getByRole("complementary", { name: "Досье" })
    fireEvent.click(within(aside).getByRole("button", { name: "Характеристика" }))
    expect(scrollToHeading).toHaveBeenCalledWith(1)
    fireEvent.click(within(aside).getByRole("button", { name: "Глава первая" }))
    expect(onOpenNote).toHaveBeenCalledWith("chapter-1")
  })

  it("says so when the page appears nowhere and has no connections", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
    mount()
    await settle()
    expect(screen.getByText("Пока нигде в тексте не упоминается.")).toBeTruthy()
    expect(screen.getByText("Связей пока нет.")).toBeTruthy()
  })

  it("finds the character by name in the text of a story and writes nothing", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
    storage.listNoteReferences.mockResolvedValue([reference({})])
    const page = (noteId: string, title: string) => ({
      ...context("db_text").row,
      noteId,
      title,
      relativePath: `${title}.md`,
    })
    storage.queryDatabase.mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
      rows:
        databaseId === "db_text"
          ? [page("chapter-1", "Глава первая"), page("ch2", "Глава вторая")]
          : [],
      nextCursor: null,
    }))
    const hit = (id: string, snippet: string) => ({
      note: { id, path: `/v/${id}.md`, title: id, modified: null, wordCount: 1 },
      matchType: "content",
      snippet,
      score: 1,
    })
    storage.searchNotes.mockImplementation(async (query: string) =>
      query === "Алиса"
        ? [
            hit("chapter-1", "Алиса вошла"),
            hit("ch2", "и тогда Алиса ушла"),
            hit("n1", "Алиса"),
            hit("elsewhere", "Алиса в заметке"),
          ]
        : [],
    )
    const onOpenNote = vi.fn()
    mount({ onOpenNote })
    await settle()
    await settle()
    const aside = screen.getByRole("complementary", { name: "Досье" })
    // The linked chapter is listed once; the chapter that only names her comes under its own caption.
    expect(within(aside).getAllByText("Глава первая")).toHaveLength(1)
    expect(within(aside).getByText("Найдено по имени")).toBeTruthy()
    const found = within(aside).getByRole("button", { name: /Глава вторая/ })
    expect(found.getAttribute("title")).toContain("и тогда Алиса ушла")
    expect(within(aside).queryByText("Алиса в заметке")).toBeNull()
    fireEvent.click(found)
    expect(onOpenNote).toHaveBeenCalledWith("ch2")
    expect(storage.updateDatabaseRelationValue).not.toHaveBeenCalled()
  })

  it("does not repeat the stories of the header among the connections", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
    storage.listNoteReferences.mockResolvedValue([
      reference({
        direction: "out",
        propertyId: "story",
        propertyName: "Истории",
        databaseId: "db_stories",
        databaseName: "Истории",
        noteId: "note_molehills_story",
        title: "MoleHills",
      }),
    ])
    mount()
    await settle()
    const aside = screen.getByRole("complementary", { name: "Досье" })
    expect(within(aside).queryByText("Истории")).toBeNull()
    expect(within(aside).getByText("Связей пока нет.")).toBeTruthy()
  })

  it("leaves out the table of contents where headings are not on screen", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
    mount({ canJump: false })
    await settle()
    expect(screen.queryByText("Разделы")).toBeNull()
    expect(screen.getByText("Связи")).toBeTruthy()
  })

  it("falls back to the plain note when the context cannot be read", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockRejectedValue(new Error("offline"))
    mount()
    await settle()
    expect(screen.queryByRole("complementary")).toBeNull()
    expect(screen.getByTestId("editor")).toBeTruthy()
  })

  it("shows the deleted story link and preserves other stories when the author removes it", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    const entry = context("db_characters")
    entry.row.valuesJson = JSON.stringify({
      story: { type: "relation", targetNoteIds: ["note_molehills_story", "deleted"] },
    })
    storage.getDatabaseNoteContext.mockResolvedValue(entry)
    storage.updateDatabaseRelationValue.mockReset().mockResolvedValue({ warnings: [] })
    mount()
    expect(await screen.findByText("История удалена")).toBeTruthy()
    expect(storage.updateDatabaseRelationValue).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Убрать ссылку" }))
    await settle()
    expect(storage.updateDatabaseRelationValue).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: "db_characters",
        noteId: "n1",
        propertyId: "story",
        targetNoteIds: ["note_molehills_story"],
        expectedRevision: "r",
      }),
    )
  })

  it("marks a related page that is no longer in the index", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
    storage.listNoteReferences.mockResolvedValue([reference({ title: null, noteId: "gone" })])
    mount()
    await settle()
    expect(screen.getByText("Страница не найдена")).toBeTruthy()
  })
})
