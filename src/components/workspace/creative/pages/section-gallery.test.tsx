// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
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
      />,
    )
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
    expect(headings).toEqual(["Главные1", "Второстепенные1", "Без категории1"])
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

  it("offers the whole base only when asked to, with the words it is given", () => {
    const onOpenAsBase = vi.fn()
    const { rerender } = render(<SectionGallery section={section} rows={[]} onOpenNote={vi.fn()} />)
    expect(screen.queryByRole("button", { name: "Открыть как базу" })).toBeNull()
    expect(screen.getByText("Пока пусто.")).toBeTruthy()
    rerender(
      <SectionGallery
        section={section}
        rows={[]}
        onOpenNote={vi.fn()}
        onOpenAsBase={onOpenAsBase}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Открыть как базу" }))
    expect(onOpenAsBase).toHaveBeenCalledTimes(1)
  })
})
