// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseNoteContext, DatabaseRow, ProjectTextSummary } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import { DocumentHeader, type DocumentHeaderProps } from "../editor/document-header"
import type { TreeItem } from "../sidebar-tree"
import { CreativeNoteTrail } from "./note-trail-header"
import {
  catalog,
  storySummary,
  workshopSection as section,
  workshopSummary,
} from "./project-fixtures.test-support"
import { useProjectStore } from "./project-store"

const getDatabaseNoteContext = vi.fn()
const queryDatabase = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  getDatabaseNoteContext: (...args: unknown[]) => getDatabaseNoteContext(...args),
  queryDatabase: (...args: unknown[]) => queryDatabase(...args),
}))

const text: ProjectTextSummary = {
  databaseId: "db_hills",
  properties: {
    level: "lvl",
    parent: "par",
    order: "ord",
    format: null,
    status: null,
    anchors: null,
    arcs: null,
  },
  levels: [],
  formats: [],
  statusOptions: [],
}

const workshop = workshopSummary("w", {
  sections: [
    section("stories", { role: "stories", databaseId: "db_stories", universePropertyId: "up" }),
    section("universes", { role: "universes", databaseId: "db_univ" }),
    section("chars", { role: "characters", name: "Персонажи", databaseId: "db_chars" }),
  ],
  stories: [
    storySummary("hills", {
      name: "Холмы",
      workshopId: "w",
      databaseId: "db_hills",
      cardNoteId: "card",
      text,
    }),
  ],
})

function row(noteId: string, title: string, values: Record<string, unknown> = {}): DatabaseRow {
  return {
    noteId,
    title,
    relativePath: `${noteId}.md`,
    parentNoteId: null,
    depth: 0,
    categoryPath: [],
    valuesJson: JSON.stringify(values),
    rowRevision: "r",
  }
}
const ROWS: Record<string, DatabaseRow[]> = {
  db_stories: [row("card", "Холмы", { up: { type: "relation", targetNoteIds: ["u1"] } })],
  db_univ: [row("u1", "Палуверс")],
  db_hills: [
    row("ch1", "Глава 1"),
    row("sc1", "Сцена", { par: { type: "relation", targetNoteIds: ["ch1"] } }),
  ],
}
const CONTEXTS: Record<string, { databaseId: string; row: DatabaseRow }> = {
  sc1: { databaseId: "db_hills", row: ROWS.db_hills[1] },
  anna: { databaseId: "db_chars", row: row("anna", "Анна") },
  plain: { databaseId: "db_other", row: row("plain", "Обычная") },
}

const tree: TreeItem[] = [
  {
    id: "f",
    path: "/v/Folder",
    name: "Folder",
    type: "folder",
    children: ["sc1", "anna", "plain"].map((id) => ({
      id,
      path: `/v/Folder/${id}.md`,
      name: id,
      type: "file" as const,
    })),
  },
]

function props(noteId: string, over: Partial<DocumentHeaderProps> = {}): DocumentHeaderProps {
  return {
    hasDocument: true,
    docId: noteId,
    docTitle: noteId,
    docPath: `/v/Folder/${noteId}.md`,
    treeItems: tree,
    viewMode: "live",
    onViewModeChange: vi.fn(),
    contentWidth: "normal",
    onContentWidthChange: vi.fn(),
    nestedNotes: [],
    nestedNotesPlacement: "top",
    onRequestAttachLayer: vi.fn(),
    onRequestMove: vi.fn(),
    onRequestMerge: vi.fn(),
    onCopyPath: vi.fn(),
    onExportPdf: vi.fn(),
    onRequestRename: vi.fn(),
    moreActionsOpen: false,
    onMoreActionsOpenChange: vi.fn(),
    ...over,
  }
}

const trail = () =>
  Array.from(document.querySelectorAll("[data-breadcrumb-segment]")).map((n) =>
    n.textContent?.trim(),
  )

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900)
  getDatabaseNoteContext.mockReset().mockImplementation(async (noteId: string) => {
    const known = CONTEXTS[noteId]
    return known ? ({ ...known, databaseTitle: "" } as unknown as DatabaseNoteContext) : null
  })
  queryDatabase.mockReset().mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
    rows: ROWS[databaseId] ?? [],
    nextCursor: null,
    totalCount: 0,
    diagnostics: [],
  }))
  useProjectStore.getState().reset()
  useDatabaseStore.getState().reset(1)
  act(() => useProjectStore.getState().setCatalog(catalog([workshop])))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("the header of a note of the workshop", () => {
  it("shows the folders first, then the logical path, and opens its steps in place", async () => {
    const onOpenPage = vi.fn()
    const onOpenItem = vi.fn()
    render(
      <DocumentHeader
        {...props("sc1", { onOpenItem })}
        NoteTrail={CreativeNoteTrail}
        onOpenWorkshopPage={onOpenPage}
      />,
    )
    // No flash: the folder path stands until the answer is known.
    expect(trail()).toEqual(["Folder", "sc1"])
    // A long path folds its middle, like the folders do, until the pointer rests on it.
    await waitFor(() => expect(trail()).toEqual(["Мастерская", "Глава 1", "Сцена"]))
    fireEvent.mouseEnter(screen.getByText("…"))
    expect(trail()).toEqual(["Мастерская", "Палуверс", "Холмы", "Глава 1", "Сцена"])
    fireEvent.click(screen.getByRole("button", { name: "Палуверс" }))
    expect(onOpenPage).toHaveBeenLastCalledWith("universe:u1", undefined)
    fireEvent.click(screen.getByRole("button", { name: "Холмы" }))
    expect(onOpenPage).toHaveBeenLastCalledWith("hills", undefined)
    fireEvent.click(screen.getByRole("button", { name: "Глава 1" }))
    expect(onOpenItem).toHaveBeenCalledWith("ch1")
    // The note itself is the current crumb.
    expect(screen.queryByRole("button", { name: "Сцена" })).toBeNull()
  })

  it("opens the section tab for a page of a world section", async () => {
    const onOpenPage = vi.fn()
    render(
      <DocumentHeader
        {...props("anna")}
        NoteTrail={CreativeNoteTrail}
        onOpenWorkshopPage={onOpenPage}
      />,
    )
    await waitFor(() => expect(trail()).toEqual(["Мастерская", "Персонажи", "Анна"]))
    fireEvent.click(screen.getByRole("button", { name: "Персонажи" }))
    expect(onOpenPage).toHaveBeenCalledWith("w", "chars")
  })

  it("keeps the folders for a note that is not in the workshop", async () => {
    render(<DocumentHeader {...props("plain")} NoteTrail={CreativeNoteTrail} />)
    await waitFor(() => expect(getDatabaseNoteContext).toHaveBeenCalled())
    await act(async () => undefined)
    expect(trail()).toEqual(["Folder", "plain"])
  })

  it("keeps the folders when the creative module is off, and asks nothing", async () => {
    render(<DocumentHeader {...props("sc1")} />)
    await act(async () => undefined)
    expect(trail()).toEqual(["Folder", "sc1"])
    expect(getDatabaseNoteContext).not.toHaveBeenCalled()
  })

  it("asks nothing of the backend in a vault with no workshop", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([])))
    render(<DocumentHeader {...props("sc1")} NoteTrail={CreativeNoteTrail} />)
    await act(async () => undefined)
    expect(getDatabaseNoteContext).not.toHaveBeenCalled()
    expect(trail()).toEqual(["Folder", "sc1"])
  })
})
