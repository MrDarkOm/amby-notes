import { describe, expect, it, vi } from "vitest"
import {
  compileManuscript,
  ManuscriptReadError,
  stripYamlFrontmatter,
  type ManuscriptPage,
} from "./manuscript-compiler"

const page = (noteId: string, title: string, children: ManuscriptPage[] = []): ManuscriptPage => ({
  noteId,
  title,
  children,
})

describe("stripYamlFrontmatter", () => {
  it("drops a frontmatter block and keeps the body", () => {
    const raw = "---\ntitle: Глава 1\nstatus: draft\n---\nПервая строка.\nВторая строка."
    expect(stripYamlFrontmatter(raw)).toBe("Первая строка.\nВторая строка.")
  })

  it("handles CRLF, a BOM and an empty block", () => {
    expect(stripYamlFrontmatter("\uFEFF---\r\na: 1\r\n---\r\nТекст")).toBe("Текст")
    expect(stripYamlFrontmatter("---\n---\nТекст")).toBe("Текст")
  })

  it("leaves a note without frontmatter as it is, a horizontal rule included", () => {
    expect(stripYamlFrontmatter("Просто текст")).toBe("Просто текст")
    expect(stripYamlFrontmatter("Абзац\n\n---\n\nДальше")).toBe("Абзац\n\n---\n\nДальше")
    expect(stripYamlFrontmatter("")).toBe("")
  })
})

describe("compileManuscript", () => {
  const notes: Record<string, string> = {
    book: "---\ntitle: Книга\n---\n",
    ch1: "---\nstatus: draft\n---\nНачало.",
    sc1: "Сцена в таверне.",
    sc2: "Побег.",
    ch2: "Конец.",
  }
  const read = (noteId: string) => Promise.resolve(notes[noteId] ?? "")

  it("reads the tree in order and makes the heading depth follow the depth in the tree", async () => {
    const roots = [
      page("book", "Книга первая", [
        page("ch1", "Глава 1", [page("sc1", "Таверна"), page("sc2", "Побег")]),
        page("ch2", "Глава 2"),
      ]),
    ]
    const result = await compileManuscript({ roots, readNoteContent: read })
    expect(result.pages).toBe(5)
    expect(result.markdown).toBe(
      [
        "# Книга первая",
        "## Глава 1",
        "Начало.",
        "### Таверна",
        "Сцена в таверне.",
        "### Побег",
        "Побег.",
        "## Глава 2",
        "Конец.",
      ].join("\n\n") + "\n",
    )
  })

  it("puts the story's name on top and moves the pages one level down", async () => {
    const result = await compileManuscript({
      roots: [page("ch1", "Глава 1")],
      readNoteContent: read,
      title: "MoleHills",
    })
    expect(result.markdown).toBe("# MoleHills\n\n## Глава 1\n\nНачало.\n")
  })

  it("caps the heading depth at six and gives an untitled page a dash", async () => {
    let deep = page("ch2", "")
    for (let level = 0; level < 7; level += 1) deep = page("sc1", `Уровень ${level}`, [deep])
    const result = await compileManuscript({ roots: [deep], readNoteContent: read })
    const headings = result.markdown.split("\n").filter((line) => line.startsWith("#"))
    expect(headings).toHaveLength(8)
    expect(headings.every((line) => line.indexOf(" ") <= 6)).toBe(true)
    expect(headings[headings.length - 1]).toBe("###### —")
  })

  it("is an empty document for an empty text", async () => {
    await expect(compileManuscript({ roots: [], readNoteContent: read })).resolves.toEqual({
      markdown: "",
      pages: 0,
    })
  })

  it("stops and names the page it could not read instead of skipping it", async () => {
    const readNoteContent = vi.fn(async (noteId: string) => {
      if (noteId === "sc1") throw new Error("disk")
      return notes[noteId] ?? ""
    })
    const roots = [page("ch1", "Глава 1", [page("sc1", "Таверна"), page("sc2", "Побег")])]
    const failure = await compileManuscript({ roots, readNoteContent }).catch((error) => error)
    expect(failure).toBeInstanceOf(ManuscriptReadError)
    expect(failure).toMatchObject({ noteId: "sc1", pageTitle: "Таверна" })
    expect(readNoteContent).not.toHaveBeenCalledWith("sc2")
  })

  it("never writes: the only call it makes is the read", async () => {
    const readNoteContent = vi.fn(read)
    await compileManuscript({ roots: [page("ch1", "Глава 1")], readNoteContent })
    expect(readNoteContent).toHaveBeenCalledTimes(1)
    expect(readNoteContent).toHaveBeenCalledWith("ch1")
  })
})
