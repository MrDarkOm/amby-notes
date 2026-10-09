import { Extension } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

// A bookmark is not a new kind of block and has no syntax of its own. It is an ordinary
// paragraph that holds nothing but one web link which has a title (the hint in quotes):
//
//   [Page name](https://example.com/page "example.com")
//
// Such a paragraph is drawn as a card. Anywhere else, in Obsidian or in any Markdown
// viewer, it is a working link with a tooltip, and a link without a hint stays a link in
// the editor too. Only the look is decided here: the note text is never rewritten.

export interface Bookmark {
  /** The address the card leads to (always http or https). */
  href: string
  /** The site name shown above the link. */
  host: string
  /** The hint of the link, shown under it. */
  hint: string
}

// Where a bookmark can stand. A list of titled links in a list item or a table cell
// stays a list of links.
const CARD_PARENTS = new Set(["doc", "blockquote", "callout", "column"])

/** The host of a web address, or `null` when it is not an http(s) one. */
export function webHost(address: string): string | null {
  if (/\s/u.test(address)) return null
  try {
    const url = new URL(address)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.hostname.replace(/^www\./u, "") || null
  } catch {
    return null
  }
}

/** Reads what a person typed as a web address; `null` when it is not one. */
export function parseBookmarkAddress(input: string): { href: string; host: string } | null {
  const typed = input.trim()
  if (!typed) return null
  const href = /^[a-z][a-z0-9+.-]*:\/\//iu.test(typed) ? typed : `https://${typed}`
  const host = webHost(href)
  return host ? { href, host } : null
}

/** The paragraph a new bookmark is written as: the site name as text and as the hint. */
export function bookmarkParagraph(href: string, host: string) {
  return {
    type: "paragraph",
    content: [
      { type: "text", text: host, marks: [{ type: "link", attrs: { href, title: host } }] },
    ],
  }
}

/** What the paragraph is a bookmark of, or `null` when it stays an ordinary paragraph. */
export function bookmarkOf(paragraph: PMNode, parent: PMNode | null): Bookmark | null {
  if (paragraph.type.name !== "paragraph" || !paragraph.childCount) return null
  if (!parent || !CARD_PARENTS.has(parent.type.name)) return null
  let href: string | null = null
  let hint: string | null = null
  for (let index = 0; index < paragraph.childCount; index++) {
    const child = paragraph.child(index)
    const link = child.isText ? child.marks.find((mark) => mark.type.name === "link") : undefined
    if (!link) return null
    const address = String(link.attrs.href ?? "")
    const title = String(link.attrs.title ?? "").trim()
    if (!title || (href !== null && (address !== href || title !== hint))) return null
    href = address
    hint = title
  }
  const host = href ? webHost(href) : null
  return href && hint && host ? { href, host, hint } : null
}

function cards(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos, parent) => {
    if (node.type.name !== "paragraph") return node.isTextblock ? false : true
    const bookmark = bookmarkOf(node, parent)
    if (bookmark) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: "amby-bookmark",
          "data-bookmark-host": bookmark.host,
          "data-bookmark-hint": bookmark.hint,
        }),
      )
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

const key = new PluginKey<DecorationSet>("bookmarkCards")

/** Draws a paragraph that is one titled web link as a card. */
export const BookmarkCards = Extension.create({
  name: "bookmarkCards",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (_config, state) => cards(state.doc),
          apply: (tr, previous) => (tr.docChanged ? cards(tr.doc) : previous),
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ]
  },
})
