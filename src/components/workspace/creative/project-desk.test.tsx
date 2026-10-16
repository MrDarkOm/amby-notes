// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import {
  storySummary,
  workshopSection as section,
  workshopSummary,
} from "./project-fixtures.test-support"
import { ProjectDesk } from "./project-desk"

const queryDatabase = vi.fn()
const createWorkshopEntity = vi.fn()
const listTextStats = vi.fn()
const readNote = vi.fn()
const exportTextFile = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>()
  return {
    ...original,
    queryDatabase: (...args: unknown[]) => queryDatabase(...args),
    listTextStats: (...args: unknown[]) => listTextStats(...args),
    readNote: (...args: unknown[]) => readNote(...args),
    exportTextFile: (...args: unknown[]) => exportTextFile(...args),
    createWorkshopEntity: (...args: unknown[]) => createWorkshopEntity(...args),
  }
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
    rowRevision: `rev-${noteId}`,
  }
}

const story = storySummary("hills", {
  name: "MoleHills",
  workshopId: "w_hills",
  databaseId: "db_text",
  text: {
    databaseId: "db_text",
    properties: {
      level: "lvl",
      parent: "par",
      order: "ord",
      format: null,
      status: null,
      anchors: null,
      arcs: null,
    },
    levels: [
      { id: "book", icon: null, name: "Книга", color: null, state: "ok" as const },
      { id: "chapter", icon: null, name: "Глава", color: null, state: "ok" as const },
    ],
    formats: [],
    statusOptions: [],
  },
})

const workshop = workshopSummary("w_hills", {
  name: "MoleHills Workshop",
  stories: [story],
  sections: [section("text", { role: "text", databaseId: "db_text", databaseName: "Текст" })],
})

const ROWS = [
  row("b1", "Книга первая", {
    lvl: { type: "select", optionId: "book" },
    ord: { type: "text", value: "a0" },
  }),
  row("c1", "Глава первая", {
    lvl: { type: "select", optionId: "chapter" },
    par: { type: "relation", targetNoteIds: ["b1"] },
    ord: { type: "text", value: "a0" },
  }),
  row("c2", "Глава вторая", {
    lvl: { type: "select", optionId: "chapter" },
    par: { type: "relation", targetNoteIds: ["b1"] },
    ord: { type: "text", value: "a1" },
  }),
  row("b2", "Книга вторая", {
    lvl: { type: "select", optionId: "book" },
    ord: { type: "text", value: "a1" },
  }),
]

const NOW = Math.floor(Date.now() / 1000)
const STATS = [
  { noteId: "c1", wordCount: 1200, modified: NOW - 60 * 60 * 5, created: 1 },
  { noteId: "c2", wordCount: 300, modified: NOW - 60 * 5, created: 2 },
  { noteId: "b1", wordCount: 0, modified: NOW - 60 * 60 * 24 * 3, created: 0 },
  { noteId: "b2", wordCount: 80, modified: NOW - 60 * 60 * 24 * 9, created: 3 },
]

const NOTES: Record<string, string> = {
  b1: "---\ntitle: Книга\n---\n",
  c1: "---\nstatus: draft\n---\nНачало пути.",
  c2: "Дорога дальше.",
  b2: "Эпилог.",
}

function renderDesk(onOpenNote = vi.fn(), vaultPath: string | null = "/vault") {
  render(
    <ProjectDesk story={story} workshop={workshop} vaultPath={vaultPath} onOpenNote={onOpenNote} />,
  )
  return onOpenNote
}

describe("ProjectDesk", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    queryDatabase.mockReset().mockResolvedValue({
      rows: ROWS,
      nextCursor: null,
      totalCount: ROWS.length,
      diagnostics: [],
    })
    listTextStats.mockReset().mockResolvedValue(STATS)
    readNote.mockReset().mockImplementation(async (_vault: string, noteId: string) => ({
      content: NOTES[noteId] ?? "",
      revision: "r",
      source: "disk",
    }))
    exportTextFile.mockReset().mockResolvedValue("/home/me/MoleHills.md")
    useDatabaseStore.setState({ vaultGeneration: 1, invalidationSeq: 0 })
  })
  afterEach(cleanup)

  it("offers the pages changed last to continue with, newest first, and opens one", async () => {
    const onOpenNote = renderDesk()
    const section = await screen.findByRole("region", { name: "Продолжить с…" })
    await within(section).findByText("Глава вторая")
    // The newest heads the card and has the button; the two before it follow, newest first.
    expect(within(section).getByRole("heading", { name: "Глава вторая" })).toBeTruthy()
    const earlier = within(section)
      .getAllByRole("button")
      .map((button) => button.textContent ?? "")
      .filter((text) => !text.includes("рукопись") && !text.includes("Открыть"))
    expect(earlier).toHaveLength(2)
    expect(earlier[0]).toContain("Глава первая")
    expect(earlier[1]).toContain("Книга первая")
    fireEvent.click(within(section).getByRole("button", { name: /Глава вторая/ }))
    expect(onOpenNote).toHaveBeenCalledWith("c2")
  })

  it("counts the pages and words of each top-level page; the whole work's numbers are the page header's", async () => {
    renderDesk()
    const progress = await screen.findByRole("region", { name: "Текст" })
    await within(progress).findByRole("button", { name: /Книга первая/ })
    // The totals stand in the header of the page above the desk, not in tiles that repeat them.
    expect(screen.queryByText("Слов")).toBeNull()
    expect(screen.queryByText("Страниц")).toBeNull()
    expect(within(progress).getByRole("button", { name: /Книга первая/ }).textContent).toContain(
      "3 стр. · 1500 сл.",
    )
    expect(within(progress).getByRole("button", { name: /Книга вторая/ }).textContent).toContain(
      "1 стр. · 80 сл.",
    )
  })

  it("offers to make the first page in a list the story has none in, linked to the story", async () => {
    const withCharacters = workshopSummary("w_hills", {
      name: "MoleHills Workshop",
      stories: [story],
      sections: [
        section("text", { role: "text", databaseId: "db_text", databaseName: "Текст" }),
        section("chars", {
          role: "characters",
          databaseId: "db_chars",
          databaseName: "Персонажи",
          storiesPropertyId: "stp",
        }),
      ],
    })
    queryDatabase.mockImplementation(async ({ databaseId }: { databaseId: string }) => {
      const rows = databaseId === "db_text" ? ROWS : []
      return { rows, nextCursor: null, totalCount: rows.length, diagnostics: [] }
    })
    createWorkshopEntity.mockReset().mockResolvedValue({ noteId: "new" })
    render(
      <ProjectDesk
        story={story}
        workshop={withCharacters}
        vaultPath="/vault"
        onOpenNote={vi.fn()}
      />,
    )
    const card = await screen.findByRole("region", { name: "Персонажи" })
    expect(await within(card).findByText("Пока пусто.")).toBeTruthy()
    fireEvent.click(within(card).getByRole("button", { name: "Добавить: Персонажи" }))
    const field = within(card).getByLabelText("Название — Персонажи")
    fireEvent.change(field, { target: { value: "Анна" } })
    fireEvent.submit(field.closest("form") as HTMLFormElement)
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(createWorkshopEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "w_hills",
        sectionId: "chars",
        title: "Анна",
        storyId: "hills",
      }),
    )
  })

  it("takes the numbers the page above already read instead of reading them again", async () => {
    const stats = Object.fromEntries(STATS.map((entry) => [entry.noteId, entry]))
    render(
      <ProjectDesk
        story={story}
        workshop={workshop}
        vaultPath="/vault"
        onOpenNote={vi.fn()}
        stats={stats}
      />,
    )
    const progress = await screen.findByRole("region", { name: "Текст" })
    await waitFor(() =>
      expect(within(progress).getByRole("button", { name: /Книга первая/ }).textContent).toContain(
        "3 стр. · 1500 сл.",
      ),
    )
    expect(listTextStats).not.toHaveBeenCalled()
  })

  it("compiles the text in the order of the tree and saves it as a new file", async () => {
    renderDesk()
    fireEvent.click(await screen.findByRole("button", { name: "Собрать рукопись" }))
    await waitFor(() => expect(exportTextFile).toHaveBeenCalledTimes(1))
    const [markdown, name] = exportTextFile.mock.calls[0] as [string, string]
    expect(name).toBe("MoleHills.md")
    expect(markdown).toBe(
      [
        "# MoleHills",
        "## Книга первая",
        "### Глава первая",
        "Начало пути.",
        "### Глава вторая",
        "Дорога дальше.",
        "## Книга вторая",
        "Эпилог.",
      ].join("\n\n") + "\n",
    )
    // Reading only: every page was read once, in the order of the tree.
    expect(readNote.mock.calls.map((call) => call[1])).toEqual(["b1", "c1", "c2", "b2"])
    expect(await screen.findByRole("status")).toBeTruthy()
    expect(screen.getByRole("status").textContent).toContain("/home/me/MoleHills.md")
  })

  it("stops and names the page it could not read, saving nothing", async () => {
    readNote.mockImplementation(async (_vault: string, noteId: string) => {
      if (noteId === "c2") throw new Error("disk")
      return { content: NOTES[noteId] ?? "", revision: "r", source: "disk" }
    })
    renderDesk()
    fireEvent.click(await screen.findByRole("button", { name: "Собрать рукопись" }))
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Глава вторая")
    expect(exportTextFile).not.toHaveBeenCalled()
  })

  it("says nothing when the save dialog was closed", async () => {
    exportTextFile.mockResolvedValue(null)
    renderDesk()
    fireEvent.click(await screen.findByRole("button", { name: "Собрать рукопись" }))
    await waitFor(() => expect(exportTextFile).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("offers no manuscript without a vault to read from", async () => {
    renderDesk(vi.fn(), null)
    await screen.findByRole("region", { name: "Текст" })
    expect(screen.queryByRole("button", { name: "Собрать рукопись" })).toBeNull()
  })

  it("shows the done page count tile when page status is configured", async () => {
    const storyWithStatus = storySummary("hills", {
      ...story,
      text: {
        ...story.text!,
        properties: { ...story.text!.properties, status: "stat" },
        statusOptions: [
          { id: "st_draft", name: "Черновик", color: "gray", group: "notStarted" },
          { id: "st_wip", name: "В работе", color: "amber", group: "inProgress" },
          { id: "st_done", name: "Готово", color: "green", group: "done" },
        ],
      },
    })
    const workshopWithStatus = workshopSummary("w_hills", {
      ...workshop,
      stories: [storyWithStatus],
    })
    queryDatabase.mockResolvedValue({
      rows: [
        row("b1", "Книга первая", {
          lvl: { type: "select", optionId: "book" },
          ord: { type: "text", value: "a0" },
          stat: { type: "status", optionId: "st_done" },
        }),
        row("c1", "Глава первая", {
          lvl: { type: "select", optionId: "chapter" },
          par: { type: "relation", targetNoteIds: ["b1"] },
          ord: { type: "text", value: "a0" },
          stat: { type: "status", optionId: "st_done" },
        }),
        row("c2", "Глава вторая", {
          lvl: { type: "select", optionId: "chapter" },
          par: { type: "relation", targetNoteIds: ["b1"] },
          ord: { type: "text", value: "a1" },
          stat: { type: "status", optionId: "st_wip" },
        }),
      ],
      nextCursor: null,
      totalCount: 3,
      diagnostics: [],
    })
    render(
      <ProjectDesk
        story={storyWithStatus}
        workshop={workshopWithStatus}
        vaultPath="/vault"
        onOpenNote={vi.fn()}
      />,
    )
    await screen.findByRole("region", { name: "Текст" })
    await waitFor(() => expect(screen.getByText("Готово: 2 из 3")).toBeTruthy())
  })

  describe("the world beside the text", () => {
    const withWorld = workshopSummary("w_hills", {
      name: "MoleHills Workshop",
      stories: [story],
      sections: [
        section("text", { role: "text", databaseId: "db_text", databaseName: "Текст" }),
        section("chars", {
          role: "characters",
          name: "Персонажи",
          databaseId: "db_chars",
          databaseName: "Персонажи",
          storiesPropertyId: "stp",
        }),
      ],
    })
    const rel = (...ids: string[]) => ({ type: "relation", targetNoteIds: ids })
    const CHARS = [
      row("anna", "Анна", { stp: rel("note_hills") }),
      row("boris", "Борис", { stp: rel("note_other") }),
      // Named by a page of this story's text.
      row("zoya", "Зоя"),
      row("eva", "Ева"),
    ]
    const TEXT_WITH_CAST = ROWS.map((entry) =>
      entry.noteId === "c1"
        ? row("c1", "Глава первая", {
            lvl: { type: "select", optionId: "chapter" },
            par: { type: "relation", targetNoteIds: ["b1"] },
            cast: rel("zoya"),
            ord: { type: "text", value: "a0" },
          })
        : entry,
    )

    it("lists the pages of this story only: those that name it and those its text names", async () => {
      queryDatabase.mockImplementation(async ({ databaseId }: { databaseId: string }) => {
        const rows = databaseId === "db_chars" ? CHARS : TEXT_WITH_CAST
        return { rows, nextCursor: null, totalCount: rows.length, diagnostics: [] }
      })
      render(
        <ProjectDesk story={story} workshop={withWorld} vaultPath="/vault" onOpenNote={vi.fn()} />,
      )
      const card = await screen.findByRole("region", { name: "Персонажи" })
      await within(card).findByText("Анна")
      expect(within(card).getByText("Зоя")).toBeTruthy()
      expect(within(card).queryByText("Борис")).toBeNull()
      expect(within(card).queryByText("Ева")).toBeNull()
      // The tile counts what the card lists.
      const tile = screen.getByText("Персонажи", { selector: "dt" }).parentElement
      expect(tile?.textContent).toContain("2")
    })
  })
})
