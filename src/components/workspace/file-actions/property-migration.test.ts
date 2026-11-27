// @vitest-environment happy-dom
// Carrying the properties of a note over to the database it was moved into. The settings of a property are
// JSON since the properties redesign (values only in the header, the look in groups); a plain header key
// without a look is a property too; the field is named like the key, so the value lives in the header
// only; the question counts with proper plurals.
import { beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseNoteContext, NoteProperties } from "@/lib/storage"
import {
  migratedOptions,
  migratePropertiesToDatabase,
  propertiesToMigrate,
} from "./property-migration"

const storage = vi.hoisted(() => ({
  applyDatabaseValueBatch: vi.fn(),
  backupCustomProperties: vi.fn(),
  createDatabaseProperty: vi.fn(),
  getDatabaseNoteContext: vi.fn(),
}))
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  ...storage,
}))

const custom = (over: Record<string, unknown>) => ({
  id: "x",
  name: "x",
  icon: "",
  propertyType: "text",
  value: "",
  settings: "",
  ...over,
})

function context(properties: unknown[] = []): DatabaseNoteContext {
  return {
    databaseId: "d1",
    databaseTitle: "Тест",
    vaultGeneration: 1,
    manifestRevision: "m1",
    properties,
    row: { noteId: "n1", rowRevision: "r1" },
  } as unknown as DatabaseNoteContext
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  vi.clearAllMocks()
  storage.getDatabaseNoteContext.mockReset()
  storage.createDatabaseProperty.mockImplementation(async (request: { name: string }) => ({
    propertyId: `p-${request.name}`,
    manifestRevision: "m2",
  }))
  storage.applyDatabaseValueBatch.mockResolvedValue(undefined)
  storage.backupCustomProperties.mockResolvedValue("backup")
})

describe("the options of a select property", () => {
  it("are read from the JSON of its settings, not split by commas", () => {
    const options = migratedOptions(
      custom({
        propertyType: "select",
        value: "draft",
        settings: '{"options":["Idea","In progress","Done"]}',
      }) as never,
    )
    expect(options).toEqual(["Idea", "In progress", "Done", "draft"])
  })

  it("keep a value that is already among them once, and an option with a comma whole", () => {
    expect(
      migratedOptions(
        custom({ value: "Done", settings: '{"options":["Idea","Done, really"]}' }) as never,
      ),
    ).toEqual(["Idea", "Done, really", "Done"])
    expect(
      migratedOptions(custom({ value: "idea", settings: '{"options":["Idea"]}' }) as never),
    ).toEqual(["Idea"])
  })

  it("still read the old comma-separated text of settings", () => {
    expect(migratedOptions(custom({ value: "", settings: "а, б" }) as never)).toEqual(["а", "б"])
  })
})

describe("which properties are carried over", () => {
  const note = (over: Partial<NoteProperties>): NoteProperties =>
    ({
      hasFrontmatter: true,
      properties: [],
      customProperties: [],
      ...over,
    }) as NoteProperties

  it("are the ones with a look and the plain header keys, a number as a number", () => {
    const found = propertiesToMigrate(
      note({
        customProperties: [
          custom({ id: "status", name: "status", propertyType: "select", value: "draft" }),
        ],
        properties: [
          { key: "amby-id", value: "01ABC", valueKind: "text" },
          { key: "rating", value: "5", valueKind: "number" },
          { key: "status", value: "draft", valueKind: "text" },
          { key: "tags", value: "a", valueKind: "list", items: ["a"] },
        ],
      }),
    )
    expect(found.map((p) => [p.name, p.propertyType])).toEqual([
      ["status", "select"],
      ["rating", "number"],
    ])
  })
})

describe("a list (multi-select) property", () => {
  const note = (over: Partial<NoteProperties>): NoteProperties =>
    ({ hasFrontmatter: true, properties: [], customProperties: [], ...over }) as NoteProperties

  it("takes its items from the header, not the joined text of its value", () => {
    const [kinds] = propertiesToMigrate(
      note({
        // The look the panel derives for a list: its value is the items joined, its settings the options.
        customProperties: [
          custom({
            id: "kinds",
            name: "kinds",
            propertyType: "list",
            value: "one, two",
            settings: '{"options":["one","two"]}',
          }),
        ] as never,
        properties: [{ key: "kinds", value: "one, two", valueKind: "list", items: ["one", "two"] }],
      }),
    )
    expect(migratedOptions(kinds)).toEqual(["one", "two"])
  })

  it("never makes the whole joined value an option when the items are not known", () => {
    expect(
      migratedOptions(
        custom({
          propertyType: "list",
          value: "one, two",
          settings: '{"options":["one","two"]}',
        }) as never,
      ),
    ).toEqual(["one", "two"])
  })
})

describe("the field made for a property", () => {
  it("is named like the key of the header: the value stays in the header only", async () => {
    storage.getDatabaseNoteContext.mockResolvedValue(
      context([
        { propertyId: "p-rating", name: "rating", propertyType: "number", options: [] },
        {
          propertyId: "p-status",
          name: "status",
          propertyType: "select",
          options: [{ optionId: "o1", name: "draft" }],
        },
      ]),
    )
    await migratePropertiesToDatabase("/v", context(), [
      custom({ name: "rating", propertyType: "number", value: "5" }),
      custom({
        name: "status",
        propertyType: "select",
        value: "draft",
        settings: '{"options":["Idea"]}',
      }),
    ] as never)
    const names = storage.createDatabaseProperty.mock.calls.map(([r]) => r.name)
    expect(names).toEqual(["rating", "status"])
    expect(storage.createDatabaseProperty.mock.calls[1][0].options).toEqual(["Idea", "draft"])
    expect(storage.applyDatabaseValueBatch).toHaveBeenCalledTimes(1)
  })

  it("is not made again under another name when a field of another kind has the name: the key already belongs to it", async () => {
    await migratePropertiesToDatabase(
      "/v",
      context([
        { propertyId: "p1", name: "rating", propertyType: "text", options: [], configJson: "{}" },
      ]),
      [custom({ name: "rating", propertyType: "number", value: "5" })] as never,
    )
    expect(storage.createDatabaseProperty).not.toHaveBeenCalled()
    expect(storage.applyDatabaseValueBatch).not.toHaveBeenCalled()
    expect(storage.backupCustomProperties).toHaveBeenCalled()
  })

  it("reuses a field of the same name and kind", async () => {
    await migratePropertiesToDatabase(
      "/v",
      context([
        { propertyId: "p1", name: "Rating", propertyType: "number", options: [], configJson: "{}" },
      ]),
      [custom({ name: "rating", propertyType: "number", value: "5" })] as never,
    )
    expect(storage.createDatabaseProperty).not.toHaveBeenCalled()
  })
})

describe("the question about the properties", () => {
  const ask = (count: number) =>
    i18n.t("infoPanel.databasePropertyMoveDescription", { count, database: "Тест" })

  it("counts in proper Russian plurals and stays one line", () => {
    expect(ask(1)).toContain("1 свойство")
    expect(ask(2)).toContain("2 свойства")
    expect(ask(5)).toContain("5 свойств")
    expect(ask(21)).toContain("21 свойство")
    for (const n of [1, 2, 5]) expect(ask(n)).not.toContain("\n")
  })

  it("counts in English plurals", async () => {
    await i18n.changeLanguage("en")
    expect(ask(1)).toContain("1 property")
    expect(ask(3)).toContain("3 properties")
  })
})
