import { describe, expect, it } from "vitest"
import type { TextNode } from "../workshop/text-tree-model"
import { boardColumns, boardDropPlan, synopsisOf } from "./board-model"

function node(
  noteId: string,
  levelId: string,
  orderKey: string,
  children: TextNode[] = [],
  parentId: string | null = null,
): TextNode {
  return {
    noteId,
    title: noteId,
    levelId,
    parentId,
    orderKey,
    statusOptionId: null,
    revision: "r",
    children: children.map((child) => ({ ...child, parentId: noteId })),
  }
}

const levels = [{ id: "book" }, { id: "chapter" }, { id: "scene" }]

describe("boardColumns", () => {
  it("makes a column of each page with pages inside and its cards of them", () => {
    const roots = [
      node("b1", "book", "a0", [node("c1", "chapter", "a0"), node("c2", "chapter", "a1")]),
      node("b2", "book", "a1", [node("c3", "chapter", "a0")]),
    ]
    expect(
      boardColumns(roots).map((column) => [column.id, column.cards.map((card) => card.noteId)]),
    ).toEqual([
      ["b1", ["c1", "c2"]],
      ["b2", ["c3"]],
    ])
  })

  it("puts top pages with nothing inside into one column of their own, in place", () => {
    const roots = [
      node("p1", "chapter", "a0"),
      node("b1", "book", "a1", [node("c1", "chapter", "a0")]),
      node("p2", "chapter", "a2"),
    ]
    expect(
      boardColumns(roots).map((column) => [column.id, column.cards.map((card) => card.noteId)]),
    ).toEqual([
      [null, ["p1", "p2"]],
      ["b1", ["c1"]],
    ])
  })

  it("has no columns for an empty text", () => {
    expect(boardColumns([])).toEqual([])
  })
})

describe("boardDropPlan", () => {
  const roots = [
    node("b1", "book", "a0", [node("c1", "chapter", "a0"), node("c2", "chapter", "a1")]),
    node("b2", "book", "a1", [node("c3", "chapter", "a0")]),
  ]

  it("puts a card before the card it is dropped on, in that card's column", () => {
    expect(boardDropPlan(roots, levels, "c2", { card: "c1" })).toEqual({
      plan: { newParentId: "b1", orderKey: expect.any(String) },
    })
    const plan = boardDropPlan(roots, levels, "c2", { card: "c1" })
    expect("plan" in plan && plan.plan.orderKey < "a0").toBe(true)
  })

  it("puts a card at the end of a column dropped on the column", () => {
    const result = boardDropPlan(roots, levels, "c1", { column: "b2" })
    expect(result).toEqual({ plan: { newParentId: "b2", orderKey: expect.any(String) } })
    expect("plan" in result && result.plan.orderKey > "a0").toBe(true)
  })

  it("refuses what the levels refuse, saying why", () => {
    expect(boardDropPlan(roots, levels, "b2", { column: "b1" })).toEqual({ reason: "parentLevel" })
    expect(boardDropPlan(roots, levels, "c1", { card: "c1" })).toEqual({ reason: "samePage" })
  })
})

describe("synopsisOf", () => {
  it("takes the first paragraph of the text, past the frontmatter and headings", () => {
    const markdown = [
      "---",
      "amby-id: x",
      "---",
      "# Глава 1",
      "",
      "Кей проснулся до рассвета.",
      "Дом молчал.",
      "",
      "Второй абзац.",
    ].join("\n")
    expect(synopsisOf(markdown)).toBe("Кей проснулся до рассвета. Дом молчал.")
  })

  it("drops Markdown marks, shortens a long paragraph and is empty for an empty page", () => {
    expect(synopsisOf("**Кей** вошёл в [[Дом у реки|дом]] и _замер_.")).toBe(
      "Кей вошёл в дом и замер.",
    )
    const long = "слово ".repeat(80)
    const short = synopsisOf(long)
    expect(short.length).toBeLessThanOrEqual(161)
    expect(short.endsWith("…")).toBe(true)
    expect(synopsisOf("---\na: b\n---\n")).toBe("")
  })
})
