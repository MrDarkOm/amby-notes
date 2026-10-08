import MarkdownIt from "markdown-it"
import { referenceUnlessFootnote } from "./markdown-footnotes"
import type Token from "markdown-it/lib/token.mjs"

// A second, independent reading of Markdown. The editor's own parser decides what a note
// means to the editor, so it cannot notice what it drops while reading (the title of a
// link once was such a thing). This reading uses plain markdown-it and none of the
// editor's rules: when a note and the text the editor would write for it read the same
// here, rewriting a block changes how it is spelled and nothing else.
const reader = new MarkdownIt("default", { html: true, linkify: false, breaks: false })
// The one thing this reading shares with the editor: `[^label]: text` is a footnote, not
// a link definition that vanishes from the note (see markdown-footnotes.ts). It stays
// text here, so a change to it is seen like a change to any other text.
reader.block.ruler.at("reference", referenceUnlessFootnote, { alt: ["paragraph"] })

type Segment = [kind: string, value: string, marks: string]

function attributes(token: Token): string {
  return JSON.stringify([...(token.attrs ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function inlineMeaning(children: Token[]): Segment[] {
  const marks: string[] = []
  const segments: Segment[] = []
  const push = (kind: string, value: string) => {
    // Marks are compared as a set: `***a***` may nest either way.
    const active = [...new Set(marks)].sort().join("\u0000")
    const last = segments[segments.length - 1]
    if (kind === "text" && last?.[0] === "text" && last[2] === active) last[1] += value
    else segments.push([kind, value, active])
  }
  for (const child of children) {
    if (child.type === "text" || child.type === "text_special") {
      if (child.content) push("text", child.content)
    } else if (child.type === "softbreak") push("text", "\n")
    else if (child.type === "hardbreak") push("break", "")
    else if (child.type === "code_inline") push("code", child.content)
    else if (child.type === "html_inline") push("html", child.content)
    else if (child.type === "image") {
      const alt = (child.children ?? []).map((part) => part.content).join("")
      push("image", JSON.stringify([child.attrGet("src"), child.attrGet("title") ?? "", alt]))
    } else if (child.nesting === 1)
      marks.push(`${child.type.replace(/_open$/u, "")}${attributes(child)}`)
    else if (child.nesting === -1) {
      const name = child.type.replace(/_close$/u, "")
      for (let index = marks.length - 1; index >= 0; index--) {
        if (marks[index].startsWith(`${name}[`)) {
          marks.splice(index, 1)
          break
        }
      }
    } else push(child.type, child.content)
  }
  return segments
}

export interface MarkdownMeaning {
  /** Canonical form of everything a reader of the note would see. */
  content: string
  /** Link definitions (`[name]: address`): the parser consumes them without a trace. */
  hasDefinitions: boolean
}

export function markdownMeaning(markdown: string): MarkdownMeaning {
  const env: { references?: Record<string, unknown> } = {}
  const out: unknown[] = []
  const tokens = reader.parse(markdown ?? "", env)
  tokens.forEach((token, index) => {
    if (token.type === "inline") {
      const segments = inlineMeaning(token.children ?? [])
      // The type of a callout is not case-sensitive (`[!tip]` is `[!TIP]`).
      if (tokens[index - 2]?.type === "blockquote_open" && segments[0]?.[0] === "text") {
        segments[0][1] = segments[0][1].replace(/^\[![^\]\n]+\]/u, (type) => type.toUpperCase())
      }
      out.push(segments)
    }
    // An indented block and a fenced one are the same code; the fence characters are spelling.
    else if (token.type === "fence" || token.type === "code_block") {
      // A fence that is not closed ends with the note; closing it adds no code.
      const code = token.content.replace(/\n$/u, "")
      out.push(["code", token.type === "fence" ? token.info.trim() : "", code])
    } else if (token.type === "html_block") out.push(["html", token.content.replace(/\n+$/u, "")])
    // `markup` (which bullet, which rule, `1.` or `1)`) and `hidden` (a tight or a loose
    // list) are spelling as well; the tag keeps the level of a heading.
    else out.push([token.type, token.tag, attributes(token)])
  })
  return {
    content: JSON.stringify(out),
    hasDefinitions: Object.keys(env.references ?? {}).length > 0,
  }
}
