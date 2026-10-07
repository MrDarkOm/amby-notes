/**
 * Manuscript tree builder and Markdown compiler for Amby Creative Studio.
 * Complies with docs/creative-format.md (CR-12, CR-13, CR-19).
 */

export interface ManuscriptNode {
  noteId: string
  title: string
  type: string // "book" | "chapter" | "scene"
  order: string
  chapterMode?: "body" | "scenes"
  synopsis?: string
  status?: string
  children: ManuscriptNode[]
}

export interface CompileManuscriptOptions {
  vaultPath: string
  rootNodes: ManuscriptNode[]
  readNoteContent: (vaultPath: string, noteId: string) => Promise<string>
  includeSceneHeaders?: boolean
  sceneSeparator?: string
}

/**
 * Strips YAML frontmatter block from markdown text.
 */
export function stripYamlFrontmatter(markdown: string): string {
  if (!markdown) return ""
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (match) {
    return markdown.slice(match[0].length).trim()
  }
  return markdown.trim()
}

/**
 * Compiles a manuscript tree into a single clean Markdown document.
 */
export async function compileManuscript(options: CompileManuscriptOptions): Promise<string> {
  const {
    vaultPath,
    rootNodes,
    readNoteContent,
    includeSceneHeaders = true,
    sceneSeparator = "\n\n* * *\n\n",
  } = options

  const parts: string[] = []

  const sortedRoots = [...rootNodes].sort((a, b) => (a.order || "").localeCompare(b.order || ""))

  for (const root of sortedRoots) {
    if (root.type === "book") {
      parts.push(`# ${root.title}\n\n`)

      const sortedChapters = [...root.children].sort((a, b) =>
        (a.order || "").localeCompare(b.order || ""),
      )

      for (const chapter of sortedChapters) {
        await compileChapter(chapter, parts)
      }
    } else if (root.type === "chapter") {
      await compileChapter(root, parts)
    } else if (root.type === "scene") {
      await compileScene(root, parts, false)
    }
  }

  return parts.join("").trim() + "\n"

  async function compileChapter(chapter: ManuscriptNode, output: string[]) {
    output.push(`## ${chapter.title}\n\n`)

    if (chapter.chapterMode === "body") {
      try {
        const rawContent = await readNoteContent(vaultPath, chapter.noteId)
        const cleanContent = stripYamlFrontmatter(rawContent)
        if (cleanContent) {
          output.push(`${cleanContent}\n\n`)
        }
      } catch (err) {
        console.warn(`Failed to read chapter note ${chapter.noteId}:`, err)
      }
    } else {
      // "scenes" mode: compile child scenes in order
      const sortedScenes = [...chapter.children].sort((a, b) =>
        (a.order || "").localeCompare(b.order || ""),
      )

      for (let i = 0; i < sortedScenes.length; i++) {
        const scene = sortedScenes[i]
        if (i > 0 && !includeSceneHeaders) {
          output.push(sceneSeparator)
        }
        await compileScene(scene, output, includeSceneHeaders)
      }
    }
  }

  async function compileScene(scene: ManuscriptNode, output: string[], withHeader: boolean) {
    if (withHeader) {
      output.push(`### ${scene.title}\n\n`)
    }

    try {
      const rawContent = await readNoteContent(vaultPath, scene.noteId)
      const cleanContent = stripYamlFrontmatter(rawContent)
      if (cleanContent) {
        output.push(`${cleanContent}\n\n`)
      }
    } catch (err) {
      console.warn(`Failed to read scene note ${scene.noteId}:`, err)
    }
  }
}
