// Formulas and diagrams are drawn from the text the note holds; the file keeps that
// text and nothing else. Both libraries are large and most notes need neither, so they
// are loaded the first time something has to be drawn.

type Katex = typeof import("katex").default

let katexLoading: Promise<Katex> | null = null

export function loadKatex(): Promise<Katex> {
  katexLoading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(
    ([module]) => module.default,
  )
  return katexLoading
}

/** The TeX between the `$$` lines of a display-math block. */
export function displayMathSource(block: string): string {
  return block.replace(/^\s*\$\$[ \t]*\r?\n?/u, "").replace(/\r?\n?[ \t]*\$\$\s*$/u, "")
}

/**
 * Draws a formula into an element. Returns false when it could not be drawn at all (the
 * library failed to load); a formula with a mistake is drawn with the mistake marked.
 */
export async function renderMath(
  tex: string,
  into: HTMLElement,
  displayMode: boolean,
): Promise<boolean> {
  try {
    const katex = await loadKatex()
    katex.render(tex, into, { displayMode, throwOnError: false, strict: "ignore" })
    return true
  } catch {
    return false
  }
}

type Mermaid = typeof import("mermaid").default

let mermaidLoading: Promise<Mermaid> | null = null
let mermaidTheme: string | null = null
let diagramCount = 0

const isDark = () =>
  typeof document !== "undefined" && document.documentElement.classList.contains("dark")

export type DiagramResult = { svg: string } | { error: string }

/** The SVG of a Mermaid diagram, or why it could not be drawn. Never throws. */
export async function renderMermaid(source: string): Promise<DiagramResult> {
  if (!source.trim()) return { error: "" }
  try {
    mermaidLoading ??= import("mermaid").then((module) => module.default)
    const mermaid = await mermaidLoading
    const theme = isDark() ? "dark" : "default"
    if (mermaidTheme !== theme) {
      // Strict: the diagram is sanitized and carries no scripts or click handlers.
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme })
      mermaidTheme = theme
    }
    if ((await mermaid.parse(source, { suppressErrors: true })) === false) {
      return { error: "syntax" }
    }
    const id = `amby-mermaid-${++diagramCount}`
    try {
      const { svg } = await mermaid.render(id, source)
      return { svg }
    } finally {
      // A failed render leaves its scratch element in the page.
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
    }
  } catch (reason) {
    return { error: reason instanceof Error ? reason.message : String(reason) }
  }
}
