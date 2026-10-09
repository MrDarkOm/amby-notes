import { Extension } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"

import i18n from "@/lib/i18n"
import { isTauri, type PageInfo } from "@/lib/storage"
import { fetchPageInfoOnce, openWebAddressInBrowser } from "./external-open"

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

// What a page tells about itself is somebody else's text. It becomes the text of the link
// and its hint, as plain text on one line, cut short, and nothing else: the backend has
// already done the same, and this does it once more because the note is what is at risk.
const MAX_TITLE_CHARS = 200
const MAX_HINT_CHARS = 300

export function plainLine(raw: string, maxChars: number): string {
  const clean = raw
    // control characters, invisible formatting marks (zero width, bidi controls, soft
    // hyphen), line and paragraph separators, object and replacement characters
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uFFFC\uFFFD]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
  const chars = Array.from(clean)
  return chars.length > maxChars
    ? `${chars
        .slice(0, maxChars - 1)
        .join("")
        .trimEnd()}…`
    : clean
}

/**
 * Brackets and angle brackets of a page's title are replaced by look-alikes: written as
 * they are, `[x](address)` in a title would become a second link, and `<b>` or a comment
 * an HTML tag, because the editor does not escape them in the text of a link.
 */
export function neutralizeMarkup(text: string): string {
  return text.replace(/\[/gu, "(").replace(/\]/gu, ")").replace(/</gu, "‹").replace(/>/gu, "›")
}

/**
 * The bookmark paragraph with the title of the page as the text of its link and, when the
 * page has a description, that as the hint; without one the hint stays as it was.
 */
export function bookmarkWithPageInfo(paragraph: PMNode, info: PageInfo): PMNode | null {
  const first = paragraph.firstChild
  const link = first?.marks.find((mark) => mark.type.name === "link")
  if (!first || !link) return null
  const title = plainLine(neutralizeMarkup(info.title), MAX_TITLE_CHARS)
  if (!title) return null
  const description = info.description ? plainLine(info.description, MAX_HINT_CHARS) : ""
  const mark = link.type.create({ ...link.attrs, title: description || link.attrs.title })
  return paragraph.type.create(
    paragraph.attrs,
    paragraph.type.schema.text(title, [mark]),
    paragraph.marks,
  )
}

/** Finds the paragraph the button was pressed in again, after the document may have moved. */
function findBookmark(
  doc: PMNode,
  wanted: { href: string; text: string; hint: string },
  near: number,
) {
  let best: { pos: number; node: PMNode } | null = null
  doc.descendants((node, pos, parent) => {
    if (node.type.name !== "paragraph") return node.isTextblock ? false : true
    const bookmark = bookmarkOf(node, parent)
    if (
      bookmark &&
      bookmark.href === wanted.href &&
      bookmark.hint === wanted.hint &&
      node.textContent === wanted.text &&
      (!best || Math.abs(pos - near) < Math.abs(best.pos - near))
    ) {
      best = { pos, node }
    }
    return false
  })
  return best as { pos: number; node: PMNode } | null
}

/**
 * The buttons on a card. What a button acts on is read from the paragraph it stands in at
 * the moment of the click, not from anything captured when it was drawn.
 */
function actionsOf(view: EditorView, getPos: () => number | undefined): HTMLElement {
  const bar = document.createElement("span")
  bar.className = "amby-bookmark-actions"
  bar.contentEditable = "false"
  const open = document.createElement("button")
  open.type = "button"
  open.textContent = i18n.t("externalOpen.open")
  open.addEventListener("mousedown", (event) => event.preventDefault())
  open.addEventListener("click", (event) => {
    event.preventDefault()
    event.stopPropagation()
    const pos = getPos()
    if (pos === undefined) return
    const $pos = view.state.doc.resolve(pos)
    const bookmark = bookmarkOf($pos.parent, $pos.node(Math.max(0, $pos.depth - 1)))
    if (bookmark) void openWebAddressInBrowser(bookmark.href)
  })
  bar.append(open)
  if (view.editable && isTauri()) bar.append(fetchButton(view, getPos))
  return bar
}

function fetchButton(view: EditorView, getPos: () => number | undefined): HTMLElement {
  const button = document.createElement("button")
  button.type = "button"
  button.textContent = i18n.t("externalOpen.fetchTitle")
  button.addEventListener("mousedown", (event) => event.preventDefault())
  button.addEventListener("click", async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (button.disabled) return
    const pos = getPos()
    if (pos === undefined) return
    const $pos = view.state.doc.resolve(pos)
    const bookmark = bookmarkOf($pos.parent, $pos.node(Math.max(0, $pos.depth - 1)))
    if (!bookmark) return
    const wanted = { href: bookmark.href, text: $pos.parent.textContent, hint: bookmark.hint }
    const paragraphPos = $pos.before()
    // One request for one press: the button waits for the answer.
    button.disabled = true
    button.textContent = i18n.t("externalOpen.fetching")
    try {
      const info = await fetchPageInfoOnce(bookmark.href)
      if (!info || view.isDestroyed) return
      const found = findBookmark(view.state.doc, wanted, paragraphPos)
      const rewritten = found && bookmarkWithPageInfo(found.node, info)
      if (!found || !rewritten) return
      view.dispatch(
        view.state.tr.replaceWith(found.pos, found.pos + found.node.nodeSize, rewritten),
      )
    } finally {
      button.disabled = false
      button.textContent = i18n.t("externalOpen.fetchTitle")
    }
  })
  return button
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
        Decoration.widget(pos + node.nodeSize - 1, actionsOf, {
          side: 1,
          key: `bookmark-actions-${bookmark.href}`,
          stopEvent: () => true,
          ignoreSelection: true,
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
