// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useContext, type ReactNode } from "react"
import i18n from "@/lib/i18n"
import type { DatabaseNoteContext, DatabasePropertySummary, NoteReference } from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { HeadingHintsContext } from "../../editor/heading-hints-context"
import { NotePageAboveContext, NotePagesDossierContext } from "../../editor/note-pages-context"
import { catalog, section, storySummary, workshopSummary } from "../project-fixtures.test-support"
import { useProjectStore } from "../project-store"
import { CreativeNoteProvider } from "./creative-note-provider"
import { DossierFrame } from "./dossier-frame"
import { EntityNamesContext } from "../../editor/entity-names-context"
import type { EntityNames } from "../../tiptap/entity-names"

const storage = vi.hoisted(() => ({
  getDatabaseNoteContext: vi.fn(),
  listNoteReferences: vi.fn(),
  updateDatabaseRelationValue: vi.fn(),
  searchNotes: vi.fn(),
  queryDatabase: vi.fn(),
  ensurePlotLinks: vi.fn(),
  pickAssetFile: vi.fn(),
  importDatabaseAsset: vi.fn(),
  applyDatabaseValueBatch: vi.fn(),
  resolveDatabaseAssetPaths: vi.fn(),
  getDossierTemplate: vi.fn(),
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
    storage.resolveDatabaseAssetPaths.mockReset().mockResolvedValue({ paths: [] })
    // By default a section's template cannot be read: the dossier works as it did before.
    storage.getDossierTemplate.mockReset().mockRejectedValue(new Error("no template"))
    storage.pickAssetFile.mockReset()
    storage.importDatabaseAsset.mockReset()
    storage.applyDatabaseValueBatch.mockReset().mockResolvedValue({ revisions: [], warnings: [] })
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
    // The page can be edited, so the role is in its field (owner, 2026-11-26: edited in place).
    expect(screen.getByDisplayValue("Разведчик")).toBeTruthy()
    // The story is named by the breadcrumb, not again under the name (owner, 2026-11-26).
    expect(screen.queryByText("molehills_story")).toBeNull()
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

  it("shows how much of the dossier is filled and asks for the key fields left empty", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    const entry = context("db_characters")
    entry.row.valuesJson = JSON.stringify({
      story: { type: "relation", targetNoteIds: ["note_molehills_story"] },
    })
    storage.getDatabaseNoteContext.mockResolvedValue(entry)
    render(
      <CreativeNoteProvider noteId="n1">
        <DossierFrame
          noteId="n1"
          content={"## Основное\n\nПилот.\n\n## Характеристика\n\n## Биография\n"}
          canJump
          scrollToHeading={vi.fn()}
        >
          <div />
        </DossierFrame>
      </CreativeNoteProvider>,
    )
    await settle()
    const header = screen.getByRole("banner")
    expect(within(header).getByText("Заполнено 1 из 3 разделов")).toBeTruthy()
    // The role and the importance are empty: they are still there, ready to be filled in.
    expect(within(header).getByRole("group", { name: "Роль" })).toBeTruthy()
    expect(within(header).getByRole("group", { name: "Значимость" })).toBeTruthy()
  })

  it("sets a portrait from the header: the picture is copied next to the note and linked", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
    storage.pickAssetFile.mockResolvedValue("/Users/me/Pictures/face.png")
    storage.importDatabaseAsset.mockResolvedValue({
      databaseId: "db_characters",
      noteId: "n1",
      assetId: "asset-1",
      name: "face.png",
      relativePath: "Персонажи/assets/face.png",
      mimeType: "image/png",
      sizeBytes: 42,
    })
    mount()
    await settle()
    fireEvent.click(screen.getByRole("button", { name: "Добавить портрет" }))
    await settle()
    expect(storage.pickAssetFile).toHaveBeenCalledWith(true)
    expect(storage.importDatabaseAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: "db_characters",
        noteId: "n1",
        sourcePath: "/Users/me/Pictures/face.png",
      }),
    )
    expect(storage.applyDatabaseValueBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: "db_characters",
        cells: [
          {
            noteId: "n1",
            propertyId: "pic",
            expectedRevision: "r",
            valueJson: JSON.stringify({
              type: "files",
              items: [
                {
                  assetId: "asset-1",
                  kind: "asset",
                  relativePath: "Персонажи/assets/face.png",
                  name: "face.png",
                  mimeType: "image/png",
                  sizeBytes: 42,
                },
              ],
            }),
          },
        ],
      }),
    )
  })

  it("writes nothing when the picture dialog is closed", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
    storage.pickAssetFile.mockResolvedValue(null)
    mount()
    await settle()
    fireEvent.click(screen.getByRole("button", { name: "Добавить портрет" }))
    await settle()
    expect(storage.importDatabaseAsset).not.toHaveBeenCalled()
    expect(storage.applyDatabaseValueBatch).not.toHaveBeenCalled()
  })

  it("changes or removes a portrait from its menu; removing keeps the picture file", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    const entry = context("db_characters")
    entry.row.valuesJson = JSON.stringify({
      pic: {
        type: "files",
        items: [
          {
            assetId: "old",
            kind: "asset",
            relativePath: "Персонажи/assets/old.png",
            name: "old.png",
            mimeType: "image/png",
            sizeBytes: 1,
          },
        ],
      },
    })
    storage.getDatabaseNoteContext.mockResolvedValue(entry)
    mount()
    await settle()
    fireEvent.keyDown(screen.getByRole("button", { name: "Портрет" }), { key: "Enter" })
    expect(await screen.findByRole("menuitem", { name: "Сменить портрет" })).toBeTruthy()
    fireEvent.click(screen.getByRole("menuitem", { name: "Убрать портрет" }))
    await settle()
    expect(storage.applyDatabaseValueBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        cells: [{ noteId: "n1", propertyId: "pic", expectedRevision: "r" }],
      }),
    )
  })

  it("offers no portrait change on a page that cannot be edited", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockResolvedValue({ ...context("db_characters"), locked: true })
    mount()
    await settle()
    expect(screen.queryByRole("button", { name: "Добавить портрет" })).toBeNull()
  })

  it("edits a key field in the header in place, with the row's revision", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
    mount()
    await settle()
    const role = within(screen.getByRole("banner")).getByRole("group", { name: "Роль" })
    const field = within(role).getByRole("textbox")
    expect((field as HTMLInputElement).value).toBe("Разведчик")
    fireEvent.change(field, { target: { value: "Пилот" } })
    fireEvent.blur(field)
    await settle()
    expect(storage.applyDatabaseValueBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: "db_characters",
        cells: [
          expect.objectContaining({
            noteId: "n1",
            propertyId: "role",
            expectedRevision: "r",
            valueJson: JSON.stringify({ type: "text", value: "Пилот" }),
          }),
        ],
      }),
    )
  })

  it("shows the header read only on a page that cannot be edited", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    const entry = { ...context("db_characters"), locked: true }
    entry.row = { ...entry.row, valuesJson: JSON.stringify({}) }
    storage.getDatabaseNoteContext.mockResolvedValue(entry)
    mount()
    await settle()
    const header = screen.getByRole("banner")
    expect(within(header).queryByRole("textbox")).toBeNull()
    expect(within(header).getAllByText("не указано")).toHaveLength(2)
  })

  describe("with a dossier template", () => {
    const layoutTemplate = {
      databaseId: "db_characters",
      templateId: "tpl",
      name: "Досье",
      body: "## Основное\n\n## Биография\n\n",
      dossier: {
        version: 1,
        sections: [
          { id: "basic", title: "Основное", hint: "Кто он, чем живёт", fields: ["role"] },
          { id: "bio", title: "Биография", hint: "", fields: [] },
        ],
      },
      manifestRevision: "m",
    }

    function mountWithProbe(probe: () => ReactNode) {
      function Probe() {
        return <>{probe()}</>
      }
      render(
        <CreativeNoteProvider noteId="n1">
          <DossierFrame noteId="n1" content={CONTENT} canJump scrollToHeading={vi.fn()}>
            <Probe />
          </DossierFrame>
        </CreativeNoteProvider>,
      )
    }

    it("shows the open tab's fields under the tabs and keeps them out of the header", async () => {
      act(() => useProjectStore.getState().setCatalog(catalog([story])))
      storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
      storage.getDossierTemplate.mockResolvedValue(layoutTemplate)
      let above: ((title: string | null) => ReactNode) | null = null
      function Grab() {
        above = useContext(NotePageAboveContext)
        return null
      }
      mountWithProbe(() => <Grab />)
      await settle()
      await settle()
      expect(storage.getDossierTemplate).toHaveBeenCalledWith("db_characters")
      const header = screen.getByRole("banner")
      expect(within(header).queryByRole("group", { name: "Роль" })).toBeNull()
      expect(within(header).getByRole("group", { name: "Значимость" })).toBeTruthy()

      expect(above).not.toBeNull()
      const render_ = above as unknown as (title: string | null) => ReactNode
      const { container } = render(<>{render_("Основное")}</>)
      const role = within(container).getByRole("group", { name: "Роль" })
      expect(within(role).getByDisplayValue("Разведчик")).toBeTruthy()
      // A tab without fields and the whole note show nothing.
      expect(render(<>{render_("Биография")}</>).container.textContent).toBe("")
      expect(render(<>{render_(null)}</>).container.textContent).toBe("")
    })

    it("takes the hints of the empty sections from the template", async () => {
      act(() => useProjectStore.getState().setCatalog(catalog([story])))
      storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
      storage.getDossierTemplate.mockResolvedValue(layoutTemplate)
      let hints: ReadonlyMap<string, string> | null = null
      function Grab() {
        hints = useContext(HeadingHintsContext)
        return null
      }
      mountWithProbe(() => <Grab />)
      await settle()
      await settle()
      expect((hints as unknown as ReadonlyMap<string, string>).get("Основное")).toBe(
        "Кто он, чем живёт",
      )
    })

    it("opens the template editor from the header of a page that can be edited", async () => {
      act(() => useProjectStore.getState().setCatalog(catalog([story])))
      storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
      storage.getDossierTemplate.mockResolvedValue(layoutTemplate)
      mount()
      await settle()
      await settle()
      fireEvent.click(screen.getByRole("button", { name: "Шаблон раздела" }))
      expect(await screen.findByRole("dialog", { name: "Шаблон досье" })).toBeTruthy()
    })

    it("offers no template editor on a page that cannot be edited", async () => {
      act(() => useProjectStore.getState().setCatalog(catalog([story])))
      storage.getDatabaseNoteContext.mockResolvedValue({
        ...context("db_characters"),
        locked: true,
      })
      storage.getDossierTemplate.mockResolvedValue(layoutTemplate)
      mount()
      await settle()
      expect(screen.queryByRole("button", { name: "Шаблон раздела" })).toBeNull()
    })
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

  it("binds a found chapter to the character, making the text's Characters on first use", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
    const chapter = {
      ...context("db_text").row,
      noteId: "ch2",
      title: "Глава вторая",
      relativePath: "Глава вторая.md",
      valuesJson: JSON.stringify({ who: { type: "relation", targetNoteIds: ["bob"] } }),
      rowRevision: "rev-ch2",
    }
    storage.queryDatabase.mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
      rows: databaseId === "db_text" ? [chapter] : [],
      nextCursor: null,
    }))
    storage.searchNotes.mockImplementation(async (query: string) =>
      query === "Алиса"
        ? [
            {
              note: { id: "ch2", path: "/v/ch2.md", title: "ch2", wordCount: 1 },
              matchType: "content",
              snippet: "и тогда Алиса ушла",
              score: 1,
            },
          ]
        : [],
    )
    storage.ensurePlotLinks.mockReset().mockResolvedValue({
      operationId: "op",
      workshopId: "molehills",
      target: "story",
      storyId: "molehills_story",
      anchorsPropertyId: null,
      arcsPropertyId: null,
      universePropertyId: null,
      charactersPropertyId: "who",
      povPropertyId: null,
      placesPropertyId: null,
      storyTimePropertyId: null,
      revision: "story-rev-2",
      changed: true,
      replayed: false,
      warnings: [],
    })
    storage.updateDatabaseRelationValue.mockReset().mockResolvedValue({ warnings: [] })
    mount()
    await settle()
    await settle()
    const aside = screen.getByRole("complementary", { name: "Досье" })
    fireEvent.click(within(aside).getByRole("button", { name: "Привязать" }))
    await settle()
    // The story's text had no "Characters": it is made first, alone.
    expect(storage.ensurePlotLinks).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "story",
        storyId: "molehills_story",
        parts: ["characters"],
      }),
    )
    // Then the chapter's list gets the character, keeping who was there.
    expect(storage.updateDatabaseRelationValue).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: "db_text",
        noteId: "ch2",
        propertyId: "who",
        targetNoteIds: ["bob", "n1"],
        expectedRevision: "rev-ch2",
      }),
    )
  })

  it("shows the story time and the point of view of the chapters a character is in", async () => {
    const timed = {
      ...story,
      stories: story.stories.map((entry) => ({
        ...entry,
        text: entry.text && {
          ...entry.text,
          properties: {
            ...entry.text.properties,
            characters: "who",
            pov: "eyes",
            storyTime: "when",
          },
        },
      })),
    }
    act(() => useProjectStore.getState().setCatalog(catalog([timed])))
    storage.getDatabaseNoteContext.mockResolvedValue(context("db_characters"))
    storage.listNoteReferences.mockResolvedValue([
      reference({ propertyId: "who", noteId: "chapter-1", title: "Глава первая" }),
      reference({ propertyId: "eyes", noteId: "chapter-2", title: "Глава вторая" }),
      reference({ propertyId: "who", noteId: "chapter-2", title: "Глава вторая" }),
    ])
    const page = (noteId: string, title: string, values: Record<string, unknown>) => ({
      ...context("db_text").row,
      noteId,
      title,
      valuesJson: JSON.stringify(values),
    })
    storage.queryDatabase.mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
      rows:
        databaseId === "db_text"
          ? [
              page("chapter-1", "Глава первая", {
                who: { type: "relation", targetNoteIds: ["n1"] },
                when: { type: "text", value: "День 1" },
              }),
              page("chapter-2", "Глава вторая", {
                who: { type: "relation", targetNoteIds: ["n1"] },
                eyes: { type: "relation", targetNoteIds: ["n1"] },
              }),
            ]
          : [],
      nextCursor: null,
    }))
    mount()
    await settle()
    await settle()
    const aside = screen.getByRole("complementary", { name: "Досье" })
    expect(within(aside).getByText("День 1")).toBeTruthy()
    expect(within(aside).getByText("точка зрения")).toBeTruthy()
    // A chapter linked twice (in it and through its eyes) is listed once.
    expect(within(aside).getAllByText("Глава вторая")).toHaveLength(1)
  })

  it("gives a page of the text the names of the world and shows a card for a pointed name", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([story])))
    storage.getDatabaseNoteContext.mockResolvedValue(context("db_text"))
    storage.queryDatabase.mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
      rows:
        databaseId === "db_characters"
          ? [{ ...context("db_characters").row, noteId: "evan", title: "Evan Key" }]
          : databaseId === "db_locations"
            ? [{ ...context("db_locations").row, noteId: "house", title: "Дом" }]
            : [],
      nextCursor: null,
    }))
    let names: EntityNames | null = null
    function Probe() {
      names = useContext(EntityNamesContext)
      return null
    }
    const onOpenNote = vi.fn()
    render(
      <CreativeNoteProvider noteId="n1">
        <DossierFrame
          noteId="n1"
          content=""
          canJump
          scrollToHeading={vi.fn()}
          onOpenNote={onOpenNote}
        >
          <Probe />
        </DossierFrame>
      </CreativeNoteProvider>,
    )
    await settle()
    await settle()
    expect(names).not.toBeNull()
    const given = names as unknown as EntityNames
    expect(given.entries).toEqual(
      expect.arrayContaining([
        { name: "Evan Key", noteId: "evan" },
        { name: "Evan", noteId: "evan" },
        { name: "Key", noteId: "evan" },
        { name: "Дом", noteId: "house" },
      ]),
    )
    const mark = document.createElement("span")
    document.body.append(mark)
    act(() => given.onHover("evan", mark))
    const card = screen.getByRole("tooltip")
    expect(within(card).getByText("Evan Key")).toBeTruthy()
    expect(within(card).getByText("Персонажи")).toBeTruthy()
    act(() => given.onHover(null, null))
    expect(screen.queryByRole("tooltip")).toBeNull()
    act(() => given.onOpen("house"))
    expect(onOpenNote).toHaveBeenCalledWith("house")
    mark.remove()
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
