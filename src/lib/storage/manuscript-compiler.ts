/**
 * Manuscript compiler: the text of a story, read in the order of its tree, as one Markdown
 * document (`docs/creative-format.md` §5). It only reads: the notes are never changed, and the
 * result is given back as a string for the caller to save as a new file.
 *
 * The tree is the story's own, whatever its levels are called: a page's heading depth is its
 * depth in the tree, so a one-level story and a four-level one compile the same way.
 */

/** What the compiler needs of a page; the workshop's `TextNode` fits it as it is. */
export interface ManuscriptPage {
  noteId: string
  title: string
  children: ManuscriptPage[]
}

export interface CompileManuscriptOptions {
  /** The top-level pages, already in the author's order (children likewise). */
  roots: ManuscriptPage[]
  /** The Markdown of one note, frontmatter included. */
  readNoteContent: (noteId: string) => Promise<string>
  /** The document's own heading; the pages then start one level below it. */
  title?: string
}

export interface CompiledManuscript {
  markdown: string
  /** How many pages went in. */
  pages: number
}

/** A page could not be read: the compile stops instead of leaving a hole in the manuscript. */
export class ManuscriptReadError extends Error {
  readonly noteId: string
  readonly pageTitle: string
  /** What the read failed with. */
  readonly reason: unknown

  constructor(noteId: string, pageTitle: string, reason: unknown) {
    super(`Could not read "${pageTitle}" for the manuscript`)
    this.name = "ManuscriptReadError"
    this.noteId = noteId
    this.pageTitle = pageTitle
    this.reason = reason
  }
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/

/** The body of a note: the YAML frontmatter block, a BOM and the outer blank lines dropped. */
export function stripYamlFrontmatter(markdown: string): string {
  if (!markdown) return ""
  const match = FRONTMATTER.exec(markdown)
  const body = match ? markdown.slice(match[0].length) : markdown.replace(/^\uFEFF/, "")
  return body.trim()
}

const MAX_HEADING = 6

function heading(depth: number, title: string): string {
  const level = Math.min(Math.max(depth, 1), MAX_HEADING)
  return `${"#".repeat(level)} ${title.trim() || "—"}`
}

/** Compiles a story's text tree into one Markdown document. */
export async function compileManuscript(
  options: CompileManuscriptOptions,
): Promise<CompiledManuscript> {
  const { roots, readNoteContent, title } = options
  const blocks: string[] = []
  const offset = title?.trim() ? 1 : 0
  if (title?.trim()) blocks.push(heading(1, title))
  let pages = 0

  const visit = async (page: ManuscriptPage, depth: number): Promise<void> => {
    blocks.push(heading(depth + 1 + offset, page.title))
    let content: string
    try {
      content = await readNoteContent(page.noteId)
    } catch (error) {
      throw new ManuscriptReadError(page.noteId, page.title, error)
    }
    const body = stripYamlFrontmatter(content)
    if (body) blocks.push(body)
    pages += 1
    for (const child of page.children) await visit(child, depth + 1)
  }

  for (const root of roots) await visit(root, 0)
  return { markdown: blocks.length ? `${blocks.join("\n\n")}\n` : "", pages }
}
