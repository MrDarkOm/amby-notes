// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow, ProjectTextSummary, TextPropertyIds } from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import {
  storySummary,
  workshopSection as section,
  workshopSummary,
} from "../project-fixtures.test-support"
import { SceneBlock } from "./scene-block"

const storage = vi.hoisted(() => ({
  queryDatabase: vi.fn(),
  ensurePlotLinks: vi.fn(),
  updateDatabaseRelationValue: vi.fn(),
  applyDatabaseValueBatch: vi.fn(),
}))
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  ...storage,
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

const NONE: TextPropertyIds = {
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
}

function text(properties: Partial<TextPropertyIds> = {}): ProjectTextSummary {
  return {
    databaseId: "db_text",
    properties: { ...NONE, ...properties },
    levels: [],
    formats: [],
    statusOptions: [],
  }
}

function world(properties: Partial<TextPropertyIds> = {}) {
  return workshopSummary("w", {
    name: "Мир",
    sections: [
      section("characters", { role: "characters", databaseId: "db_chars" }),
      section("locations", { role: "locations", databaseId: "db_places" }),
    ],
    stories: [
      storySummary("s1", {
        workshopId: "w",
        name: "Дом",
        databaseId: "db_text",
        text: text(properties),
      }),
    ],
  })
}

let ROWS: Record<string, DatabaseRow[]> = {}

function mount(properties: Partial<TextPropertyIds> = {}, locked = false) {
  const workshop = world(properties)
  render(<SceneBlock workshop={workshop} story={workshop.stories[0]} noteId="p1" locked={locked} />)
}

const settle = () => act(async () => {})

function ensured(over: Record<string, string>) {
  return {
    operationId: "op",
    workshopId: "w",
    target: "story",
    storyId: "s1",
    anchorsPropertyId: null,
    arcsPropertyId: null,
    universePropertyId: null,
    charactersPropertyId: null,
    povPropertyId: null,
    placesPropertyId: null,
    storyTimePropertyId: null,
    revision: "rev-2",
    changed: true,
    replayed: false,
    warnings: [],
    ...over,
  }
}

describe("SceneBlock", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    useDatabaseStore.getState().reset(1)
    ROWS = {
      db_text: [row("p1", "Глава 1")],
      db_chars: [row("anna", "Анна"), row("bob", "Боб")],
      db_places: [row("house", "Дом у реки")],
    }
    storage.queryDatabase.mockReset().mockImplementation(async ({ databaseId }) => ({
      rows: ROWS[databaseId] ?? [],
      nextCursor: null,
    }))
    storage.ensurePlotLinks.mockReset()
    storage.updateDatabaseRelationValue.mockReset().mockResolvedValue({ warnings: [] })
    storage.applyDatabaseValueBatch.mockReset().mockResolvedValue({ warnings: [], revisions: [] })
  })
  afterEach(cleanup)

  it("shows the scene of the page with names, not IDs", async () => {
    ROWS.db_text = [
      row("p1", "Глава 1", {
        who: rel("anna", "bob"),
        eyes: rel("bob"),
        where: rel("house"),
        when: { type: "text", value: "Утро, день 3" },
      }),
    ]
    mount({ characters: "who", pov: "eyes", places: "where", storyTime: "when" })
    await settle()
    const block = screen.getByRole("region", { name: "Сцена" })
    expect(within(block).getByText("Анна")).toBeTruthy()
    expect(within(block).getAllByText("Боб")).toHaveLength(2)
    expect(within(block).getByText("Дом у реки")).toBeTruthy()
    expect((within(block).getByLabelText("Время действия") as HTMLInputElement).value).toBe(
      "Утро, день 3",
    )
  })

  it("adds a character, making the text's Characters alone on first use", async () => {
    storage.ensurePlotLinks.mockResolvedValue(ensured({ charactersPropertyId: "who" }))
    mount()
    await settle()
    const block = screen.getByRole("region", { name: "Сцена" })
    fireEvent.keyDown(within(block).getByRole("button", { name: "Добавить персонажа" }), {
      key: "Enter",
    })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Анна" }))
    await settle()
    expect(storage.ensurePlotLinks).toHaveBeenCalledWith(
      expect.objectContaining({ storyId: "s1", parts: ["characters"] }),
    )
    expect(storage.updateDatabaseRelationValue).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: "db_text",
        noteId: "p1",
        propertyId: "who",
        targetNoteIds: ["anna"],
        expectedRevision: "rev-p1",
      }),
    )
  })

  it("removes a character and replaces the point of view, keeping the rest", async () => {
    ROWS.db_text = [row("p1", "Глава 1", { who: rel("anna", "bob"), eyes: rel("anna") })]
    mount({ characters: "who", pov: "eyes" })
    await settle()
    const block = screen.getByRole("region", { name: "Сцена" })
    fireEvent.click(within(block).getByRole("button", { name: "Убрать: Боб" }))
    await settle()
    expect(storage.updateDatabaseRelationValue).toHaveBeenLastCalledWith(
      expect.objectContaining({ propertyId: "who", targetNoteIds: ["anna"] }),
    )
    fireEvent.keyDown(within(block).getByRole("button", { name: "Выбрать точку зрения" }), {
      key: "Enter",
    })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Боб" }))
    await settle()
    expect(storage.updateDatabaseRelationValue).toHaveBeenLastCalledWith(
      expect.objectContaining({ propertyId: "eyes", targetNoteIds: ["bob"] }),
    )
    expect(storage.ensurePlotLinks).not.toHaveBeenCalled()
  })

  it("writes the story time when the field is left, and clears it when emptied", async () => {
    storage.ensurePlotLinks.mockResolvedValue(ensured({ storyTimePropertyId: "when" }))
    mount()
    await settle()
    const field = screen.getByLabelText("Время действия")
    fireEvent.change(field, { target: { value: "  Ночь, день 5 " } })
    fireEvent.blur(field)
    await settle()
    expect(storage.ensurePlotLinks).toHaveBeenCalledWith(
      expect.objectContaining({ parts: ["storyTime"] }),
    )
    expect(storage.applyDatabaseValueBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: "db_text",
        cells: [
          expect.objectContaining({
            noteId: "p1",
            propertyId: "when",
            valueJson: JSON.stringify({ type: "text", value: "Ночь, день 5" }),
          }),
        ],
      }),
    )
    // An unchanged field writes nothing.
    storage.applyDatabaseValueBatch.mockClear()
    fireEvent.blur(field)
    await settle()
    expect(storage.applyDatabaseValueBatch).not.toHaveBeenCalled()
  })

  it("only shows the scene of a page that cannot be edited", async () => {
    ROWS.db_text = [row("p1", "Глава 1", { who: rel("anna") })]
    mount({ characters: "who" }, true)
    await settle()
    const block = screen.getByRole("region", { name: "Сцена" })
    expect(within(block).getByText("Анна")).toBeTruthy()
    expect(within(block).queryByRole("button", { name: "Добавить персонажа" })).toBeNull()
    expect(within(block).queryByRole("button", { name: /Убрать/ })).toBeNull()
    expect((within(block).getByLabelText("Время действия") as HTMLInputElement).readOnly).toBe(true)
  })
})
