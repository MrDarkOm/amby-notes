// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow, DatabaseSummary } from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { workshopSection } from "../project-fixtures.test-support"
import { SectionGallery } from "./section-gallery"

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  resolveDatabaseAssetPaths: async () => ({ paths: [] }),
}))

const row = (noteId: string, title: string, optionId?: string): DatabaseRow => ({
  noteId,
  title,
  relativePath: `${noteId}.md`,
  parentNoteId: null,
  depth: 0,
  categoryPath: [],
  valuesJson: JSON.stringify(optionId ? { imp: { type: "select", optionId } } : {}),
  rowRevision: "r",
})

const summary: DatabaseSummary = {
  databaseId: "db_chars",
  title: "Персонажи",
  icon: null,
  attachedNoteId: null,
  manifestRevision: "m",
  locked: false,
  properties: [
    {
      propertyId: "imp",
      name: "Значимость",
      propertyType: "select",
      configJson: "{}",
      options: [
        { optionId: "main", name: "Главные", color: "#d00000" },
        { optionId: "side", name: "Второстепенные", color: "#00d000" },
      ],
    },
  ],
  views: [
    {
      viewId: "v",
      title: "Таблица",
      layout: "table",
      revision: "r",
      groupField: { kind: "property", propertyId: "imp" },
    },
  ],
  templates: [],
  diagnostics: [],
}

const section = workshopSection("chars", {
  role: "characters",
  name: "Персонажи",
  databaseName: "Персонажи",
  databaseId: "db_chars",
})

describe("SectionGallery", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    useDatabaseStore.getState().reset(1)
  })
  afterEach(cleanup)

  it("shows the categories as headings in the option order, the rest last", () => {
    act(() => useDatabaseStore.getState().setCatalog([summary]))
    const onOpenNote = vi.fn()
    render(
      <SectionGallery
        section={section}
        rows={[row("a", "Зоя", "side"), row("b", "Анна", "main"), row("c", "Глеб")]}
        onOpenNote={onOpenNote}
        createFor={vi.fn()}
      />,
    )
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
    expect(headings).toEqual(["Главные1", "Второстепенные1", "Без категории1"])
    const lists = screen.getAllByRole("list")
    const lastGroup = within(lists[lists.length - 1])
    expect(lastGroup.getAllByRole("button")).toEqual([
      lastGroup.getByRole("button", { name: "Глеб" }),
      lastGroup.getByRole("button", { name: "Персонаж" }),
    ])
    fireEvent.click(screen.getByRole("button", { name: /Анна/ }))
    expect(onOpenNote).toHaveBeenCalledWith("b")
  })

  it("has no heading when the section is one group", () => {
    act(() => useDatabaseStore.getState().setCatalog([summary]))
    render(
      <SectionGallery section={section} rows={[row("a", "Анна", "main")]} onOpenNote={vi.fn()} />,
    )
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0)
  })

  it("names two stories on a card and counts the rest", () => {
    render(
      <SectionGallery
        section={section}
        rows={[row("a", "Анна")]}
        storyLabelsOf={() => ({ names: ["Первая", "Вторая"], more: 3 })}
        onOpenNote={vi.fn()}
      />,
    )
    const card = screen.getByRole("button", { name: /Анна/ })
    expect(within(card).getByText("Первая")).toBeTruthy()
    expect(within(card).getByText("Вторая")).toBeTruthy()
    expect(within(card).getByText("+3")).toBeTruthy()
  })

  it("keeps creation after the cards when the gallery grows", async () => {
    const onCreate = vi.fn(async () => undefined)
    const { rerender } = render(
      <SectionGallery
        section={section}
        rows={[row("a", "Анна")]}
        onOpenNote={vi.fn()}
        createFor={onCreate}
      />,
    )
    expect(screen.getByText("Здесь живут персонажи ваших историй.")).toBeTruthy()
    const cards = within(screen.getByRole("list")).getAllByRole("button")
    expect(cards).toEqual([
      screen.getByRole("button", { name: "Анна" }),
      screen.getByRole("button", { name: "Персонаж" }),
    ])
    fireEvent.click(cards[1])
    const input = screen.getByRole("textbox", { name: "Название — Персонажи" })
    expect(input.closest("li")).toBe(cards[0].closest("li")?.nextElementSibling)
    fireEvent.change(input, { target: { value: "Боб" } })
    fireEvent.submit(input.closest("form")!)
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull())
    expect(onCreate).toHaveBeenCalledWith("Боб")
    rerender(
      <SectionGallery
        section={section}
        rows={[row("a", "Анна"), row("b", "Боб"), row("c", "Вера")]}
        onOpenNote={vi.fn()}
        createFor={onCreate}
      />,
    )
    expect(screen.queryByText("Здесь живут персонажи ваших историй.")).toBeNull()
    expect(within(screen.getByRole("list")).getAllByRole("button")).toEqual(
      ["Анна", "Боб", "Вера", "Персонаж"].map((name) => screen.getByRole("button", { name })),
    )
  })

  it("starts an empty location gallery with its creation card", () => {
    const locations = workshopSection("locations", {
      role: "locations",
      databaseName: "Локации",
    })
    render(
      <SectionGallery section={locations} rows={[]} onOpenNote={vi.fn()} createFor={vi.fn()} />,
    )
    expect(within(screen.getByRole("list")).getByRole("button", { name: "Локация" })).toBeTruthy()
  })

  it("offers the whole base only when asked to, with the words it is given", () => {
    const onOpenAsBase = vi.fn()
    const { rerender } = render(<SectionGallery section={section} rows={[]} onOpenNote={vi.fn()} />)
    expect(screen.queryByRole("button", { name: "Открыть таблицей" })).toBeNull()
    expect(screen.getByText("Пока пусто.")).toBeTruthy()
    rerender(
      <SectionGallery
        section={section}
        rows={[]}
        onOpenNote={vi.fn()}
        onOpenAsBase={onOpenAsBase}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Открыть таблицей" }))
    expect(onOpenAsBase).toHaveBeenCalledTimes(1)
  })
})
