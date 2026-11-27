// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { TextNode } from "../workshop/text-tree-model"
import { StoryBoard } from "./story-board"

function node(
  noteId: string,
  title: string,
  levelId: string,
  orderKey: string,
  children: TextNode[] = [],
): TextNode {
  return {
    noteId,
    title,
    levelId,
    parentId: null,
    orderKey,
    statusOptionId: null,
    revision: "r",
    children: children.map((child) => ({ ...child, parentId: noteId })),
  }
}

const levels = [
  { id: "book", icon: null, name: "Книга", color: null, state: "ok" as const },
  { id: "chapter", icon: null, name: "Глава", color: null, state: "ok" as const },
]
const roots = [
  node("b1", "Книга первая", "book", "a0", [
    node("c1", "Пробуждение", "chapter", "a0"),
    node("c2", "Дорога", "chapter", "a1"),
  ]),
  node("b2", "Книга вторая", "book", "a1", [node("c3", "Город", "chapter", "a0")]),
]

function transfer() {
  const data = new Map<string, string>()
  return {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    get types() {
      return [...data.keys()]
    },
    effectAllowed: "",
    dropEffect: "",
  }
}

describe("StoryBoard", () => {
  const onOpenNote = vi.fn()
  const onMovePage = vi.fn()
  const loadSynopsis = vi.fn(async (noteId: string) =>
    noteId === "c1" ? "Кей проснулся до рассвета." : "",
  )

  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    onOpenNote.mockReset()
    onMovePage.mockReset()
    loadSynopsis.mockClear()
  })
  afterEach(cleanup)

  function mount(canWrite = true) {
    render(
      <StoryBoard
        roots={roots}
        levels={levels}
        statusOptions={[]}
        stats={{}}
        hintsOf={(noteId) => (noteId === "c2" ? ["Боб", "Ночь"] : [])}
        loadSynopsis={loadSynopsis}
        canWrite={canWrite}
        onOpenNote={onOpenNote}
        onMovePage={onMovePage}
      />,
    )
  }

  it("shows a column per part with its pages as cards, their synopsis and scene", async () => {
    mount()
    await act(async () => {})
    const first = screen.getByRole("group", { name: "Книга первая" })
    expect(
      within(first)
        .getAllByRole("button")
        .map((card) => card.getAttribute("data-board-card")),
    ).toEqual(["c1", "c2"])
    expect(within(first).getByText("Кей проснулся до рассвета.")).toBeTruthy()
    expect(within(first).getByText("Боб")).toBeTruthy()
    expect(within(first).getByText("Ночь")).toBeTruthy()
    expect(screen.getByRole("group", { name: "Книга вторая" })).toBeTruthy()
    fireEvent.click(within(first).getByText("Дорога"))
    expect(onOpenNote).toHaveBeenCalledWith("c2")
  })

  it("moves a card before the card it is dropped on, and to the end of a column", async () => {
    mount()
    await act(async () => {})
    const data = transfer()
    const card = (id: string) => document.querySelector(`[data-board-card="${id}"]`) as HTMLElement
    fireEvent.dragStart(card("c2"), { dataTransfer: data })
    fireEvent.dragOver(card("c1"), { dataTransfer: data })
    fireEvent.drop(card("c1"), { dataTransfer: data })
    expect(onMovePage).toHaveBeenLastCalledWith("c2", {
      newParentId: "b1",
      orderKey: expect.any(String),
    })
    fireEvent.dragStart(card("c1"), { dataTransfer: data })
    fireEvent.drop(screen.getByRole("group", { name: "Книга вторая" }), { dataTransfer: data })
    expect(onMovePage).toHaveBeenLastCalledWith("c1", {
      newParentId: "b2",
      orderKey: expect.any(String),
    })
  })

  it("says why a drop is refused and moves nothing", async () => {
    mount()
    await act(async () => {})
    const data = transfer()
    const card = document.querySelector('[data-board-card="c1"]') as HTMLElement
    fireEvent.dragStart(card, { dataTransfer: data })
    fireEvent.drop(card, { dataTransfer: data })
    expect(onMovePage).not.toHaveBeenCalled()
    expect(screen.getByRole("status").textContent).toBe("Сюда перетаскивается сама страница.")
  })

  it("only opens pages when the story cannot be changed", async () => {
    mount(false)
    await act(async () => {})
    const card = document.querySelector('[data-board-card="c1"]') as HTMLElement
    expect(card.getAttribute("draggable")).not.toBe("true")
  })
})
