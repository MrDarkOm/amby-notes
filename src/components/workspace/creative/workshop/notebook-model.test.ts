import { describe, expect, it } from "vitest"
import type { Notebook } from "@/lib/storage"
import {
  buildNotebookTree,
  moveCollision,
  notebookNameProblem,
  notebookTargets,
  planNotebookDelete,
  siblingNames,
  subtreeIsEmpty,
  type NoteItem,
} from "./notebook-model"

function note(
  noteId: string,
  title: string,
  categoryPath: string[] = [],
  file = `${title}.md`,
): NoteItem {
  return {
    noteId,
    title,
    databaseId: "db_notes",
    workshopId: "w",
    valuesJson: "{}",
    categoryPath,
    relativePath: [...categoryPath, file].join("/"),
  }
}
function notebook(segments: string[], itemCount = 0): Notebook {
  return { segments, path: `/v/Заметки/${segments.join("/")}`, itemCount }
}

const LISTING: Notebook[] = [
  notebook(["Идеи"], 1),
  notebook(["Идеи", "Сюжеты"], 1),
  notebook(["Пустой"], 0),
  notebook(["архив"], 0),
]

describe("buildNotebookTree", () => {
  const items = [
    note("a", "Зарисовка", ["Идеи"]),
    note("b", "Поворот", ["Идеи", "Сюжеты"]),
    note("c", "Корневая"),
    note("d", "Аква"),
  ]

  it("nests the notebooks, lists the empty ones and puts the notes of no notebook last", () => {
    const tree = buildNotebookTree(LISTING, items, { showEmpty: true })
    // By name, whatever the case; the empty ones are there.
    expect(tree.nodes.map((node) => node.name)).toEqual(["архив", "Идеи", "Пустой"])
    const ideas = tree.nodes[1]
    expect(ideas.children.map((node) => node.name)).toEqual(["Сюжеты"])
    expect(ideas.notes.map((entry) => entry.title)).toEqual(["Зарисовка"])
    expect(ideas.children[0].notes.map((entry) => entry.title)).toEqual(["Поворот"])
    // "No notebook": the notes of the root, by title.
    expect(tree.rootNotes.map((entry) => entry.title)).toEqual(["Аква", "Корневая"])
  })

  it("counts the notes of a notebook with those below it, under the notes it is given", () => {
    const tree = buildNotebookTree(LISTING, items, { showEmpty: true })
    expect(tree.nodes.map((node) => [node.name, node.count])).toEqual([
      ["архив", 0],
      ["Идеи", 2],
      ["Пустой", 0],
    ])
    expect(tree.nodes[1].children[0].count).toBe(1)
    expect(tree.count).toBe(4)

    // The same listing under a filter that lets one note through: every notebook stays, the
    // ones with nothing are dimmed by their zero.
    const filtered = buildNotebookTree(LISTING, [items[1]], { showEmpty: true })
    expect(filtered.nodes.map((node) => [node.name, node.count])).toEqual([
      ["архив", 0],
      ["Идеи", 1],
      ["Пустой", 0],
    ])
    expect(filtered.nodes[1].notes).toEqual([])
    expect(filtered.rootNotes).toEqual([])
    expect(filtered.count).toBe(1)
  })

  it("keeps a notebook the listing does not know when a note lies in it", () => {
    const tree = buildNotebookTree([], [note("x", "Одинокая", ["Новый", "Глубже"])], {
      showEmpty: true,
    })
    expect(tree.nodes.map((node) => node.name)).toEqual(["Новый"])
    expect(tree.nodes[0].path).toBeNull()
    expect(tree.nodes[0].children[0].notes.map((entry) => entry.title)).toEqual(["Одинокая"])
  })

  it("leaves out the notebooks with nothing in them, and the ones above only a notebook that has", () => {
    const tree = buildNotebookTree(LISTING, [items[1]], { showEmpty: false })
    expect(tree.nodes.map((node) => node.name)).toEqual(["Идеи"])
    expect(tree.nodes[0].children.map((node) => node.name)).toEqual(["Сюжеты"])
    expect(tree.nodes[0].notes).toEqual([])
  })

  it("lists every notebook as a place to move a note to, parents first", () => {
    const tree = buildNotebookTree(LISTING, [], { showEmpty: true })
    expect(notebookTargets(tree).map((target) => [target.label, target.depth])).toEqual([
      ["архив", 0],
      ["Идеи", 0],
      ["Идеи / Сюжеты", 1],
      ["Пустой", 0],
    ])
  })
})

describe("notebookNameProblem", () => {
  it("applies the rules of a folder name, whatever the case of a sibling", () => {
    const siblings = ["Идеи", "Архив"]
    expect(notebookNameProblem("Черновики", siblings)).toBeNull()
    expect(notebookNameProblem("  ", siblings)).toBe("empty")
    expect(notebookNameProblem("x".repeat(101), siblings)).toBe("tooLong")
    expect(notebookNameProblem(".скрытый", siblings)).toBe("hidden")
    expect(notebookNameProblem("точка.", siblings)).toBe("trailingDot")
    for (const bad of [
      "a/b",
      "a\\b",
      "a:b",
      "a*b",
      "a?b",
      'a"b',
      "a<b",
      "a>b",
      "a|b",
      "a\u0007b",
    ]) {
      expect(notebookNameProblem(bad, siblings)).toBe("forbiddenCharacter")
    }
    expect(notebookNameProblem("..", siblings)).toBe("hidden")
    expect(notebookNameProblem("CON", siblings)).toBe("reservedName")
    expect(notebookNameProblem("com1.txt", siblings)).toBe("reservedName")
    expect(notebookNameProblem("amby-workshop.json", siblings)).toBe("reservedName")
    expect(notebookNameProblem("идеи", siblings)).toBe("duplicate")
    expect(notebookNameProblem("АРХИВ", siblings)).toBe("duplicate")
  })

  it("lets a notebook keep its own name or change its case when renamed", () => {
    expect(notebookNameProblem("Идеи", ["Идеи", "Архив"], "Идеи")).toBeNull()
    expect(notebookNameProblem("ИДЕИ", ["Идеи", "Архив"], "Идеи")).toBeNull()
    expect(notebookNameProblem("архив", ["Идеи", "Архив"], "Идеи")).toBe("duplicate")
  })

  it("reads the siblings of a folder from the listing", () => {
    expect(siblingNames(LISTING, [])).toEqual(["Идеи", "Пустой", "архив"])
    expect(siblingNames(LISTING, ["Идеи"])).toEqual(["Сюжеты"])
  })
})

describe("planNotebookDelete", () => {
  const rows = [
    note("a", "Зарисовка", ["Идеи"]),
    note("b", "Поворот", ["Идеи", "Сюжеты"]),
    note("c", "Корневая"),
  ]
  const plan = (
    segments: string[],
    options: { rows?: NoteItem[]; listing?: Notebook[]; rowsComplete?: boolean } = {},
  ) =>
    planNotebookDelete(
      segments,
      options.listing ?? LISTING,
      options.rows ?? rows,
      options.rowsComplete ?? true,
      true,
    )

  it("moves the notes of the notebook and of those below it into its parent", () => {
    const result = plan(["Идеи"])
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") return
    expect(result.moves.map((move) => move.noteId).sort()).toEqual(["a", "b"])
    expect(result.parent).toEqual([])
    expect(result.subtree).toEqual([["Идеи"], ["Идеи", "Сюжеты"]])
    const inner = plan(["Идеи", "Сюжеты"])
    expect(inner.kind === "ready" && inner.parent).toEqual(["Идеи"])
    expect(inner.kind === "ready" && inner.moves.map((move) => move.noteId)).toEqual(["b"])
  })

  it("plans an empty notebook with nothing to move", () => {
    const result = plan(["Пустой"])
    expect(result).toMatchObject({ kind: "ready", moves: [] })
  })

  it("refuses, naming the notes, when a moved note would meet one of the same name in the parent", () => {
    const clashing = [...rows, note("d", "Зарисовка", [])]
    expect(plan(["Идеи"], { rows: clashing })).toEqual({
      kind: "collisions",
      titles: ["Зарисовка"],
    })
    // Two notebooks below it that hold a note of one name clash with each other.
    const twins = [note("e", "Близнец", ["Идеи"]), note("f", "Близнец", ["Идеи", "Сюжеты"])]
    const listing = [notebook(["Идеи"], 1), notebook(["Идеи", "Сюжеты"], 1)]
    expect(plan(["Идеи"], { rows: twins, listing })).toEqual({
      kind: "collisions",
      titles: ["Близнец"],
    })
    // The case of a file name does not matter.
    const cased = [...rows, note("g", "зарисовка", [], "ЗАРИСОВКА.MD")]
    expect(plan(["Идеи"], { rows: cased }).kind).toBe("collisions")
  })

  it("sees a note's own folder, and a notebook of the parent, as names a moved note can clash with", () => {
    const bundle = note("h", "С вложением", ["Идеи"], "Вложение/Вложение.md")
    bundle.relativePath = "Идеи/Вложение/Вложение.md"
    const listingWithBundle = [notebook(["Идеи"], 1), notebook(["Вложение"], 0)]
    expect(plan(["Идеи"], { rows: [bundle], listing: listingWithBundle }).kind).toBe("collisions")
    // Without a notebook of that name it moves.
    expect(plan(["Идеи"], { rows: [bundle], listing: [notebook(["Идеи"], 1)] }).kind).toBe("ready")
  })

  it("refuses when the notebook holds anything but notes, or when the lists are not all known", () => {
    // Two items on disk, one note: an attachment or another file.
    const foreign = [notebook(["Идеи"], 2), ...LISTING.slice(1)]
    expect(plan(["Идеи"], { listing: foreign })).toEqual({ kind: "unsafe", reason: "foreign" })
    expect(plan(["Идеи"], { rowsComplete: false })).toEqual({
      kind: "unsafe",
      reason: "incomplete",
    })
    expect(planNotebookDelete(["Идеи"], LISTING, rows, true, false)).toEqual({
      kind: "unsafe",
      reason: "incomplete",
    })
    expect(plan(["Нет такого"])).toEqual({ kind: "unsafe", reason: "unknown" })
  })
})

describe("moveCollision", () => {
  const rows = [
    note("a", "Идея", ["Идеи"]),
    note("b", "Идея", ["Сюжеты"]),
    note("c", "Другая", ["Сюжеты"]),
  ]
  it("names what a moved note would run into, and nothing when the way is free", () => {
    expect(moveCollision(rows[0], ["Сюжеты"], LISTING, rows)).toBe("Идея")
    expect(moveCollision(rows[2], ["Идеи"], LISTING, rows)).toBeNull()
    expect(moveCollision(rows[2], [], LISTING, rows)).toBeNull()
  })
})

describe("subtreeIsEmpty", () => {
  it("is true only when the notebook and every notebook below it hold nothing", () => {
    const after = [notebook(["Идеи"], 0), notebook(["Идеи", "Сюжеты"], 0), notebook(["Другой"], 3)]
    expect(subtreeIsEmpty(after, ["Идеи"])).toBe(true)
    expect(subtreeIsEmpty([notebook(["Идеи"], 0), notebook(["Идеи", "Сюжеты"], 1)], ["Идеи"])).toBe(
      false,
    )
    // Not listed at all is not "empty": nothing is known about it.
    expect(subtreeIsEmpty(after, ["Нет"])).toBe(false)
  })
})
