import type { Editor } from "@tiptap/core"
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history"
import { Fragment, type Node } from "@tiptap/pm/model"
import { Plugin, PluginKey, Selection, TextSelection, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import { isEnterKey } from "@/lib/keyboard"
import { markEditorUserIntent } from "./editor-user-intent"
import { readFind } from "./find-in-note"
import { missingHeadingNodes } from "./missing-headings"
import type { AppendHeadingsResult } from "./constants"
import type { NotePagesPref } from "../app-config"

export interface NotePage {
  from: number
  to: number
  /** Where the visible part starts: after the page's heading, which the tab already shows. A page
   *  with nothing under its heading is empty (`body === to`). */
  body: number
  /** The heading that starts the page; `null` for the introduction. */
  heading: number | null
  title: string | null
}

interface NotePagesState {
  enabled: boolean
  pages: NotePage[]
  active: number | null
}

interface NotePageChange {
  enabled: boolean
  index?: number
}

export const notePagesKey = new PluginKey<NotePagesState>("notePages")

/** Marks an edit the page controls make outside the open page. */
const PAGE_EDIT = "notePagesEdit"

/**
 * Which top-level headings start pages: `h1` takes only first-level headings (ordinary notes);
 * `top` takes the shallowest heading level present (Workshop dossiers).
 */
export type NotePagesLevel = "h1" | "top"

/** The frontmatter property that marks a note for pages when the setting is `flagged`. */
export const NOTE_PAGES_FLAG = "amby-pages"

/** `true` / `false` from the note's `amby-pages` property; `null` when absent or not a boolean. */
export function readNotePagesFlag(
  properties: readonly { key: string; value: string }[] | undefined,
): boolean | null {
  const value = properties
    ?.find((property) => property.key === NOTE_PAGES_FLAG)
    ?.value.trim()
    .toLowerCase()
  return value === "true" ? true : value === "false" ? false : null
}

/**
 * Whether a note offers pages and which headings make them. `off` disables pages everywhere and
 * `amby-pages: false` disables them in one note; dossiers default to pages.
 */
export function notePagesRule(
  mode: NotePagesPref,
  flag: boolean | null,
  dossier: boolean,
): NotePagesLevel | null {
  if (mode === "off" || flag === false) return null
  if (dossier) return "top"
  return mode === "always" || flag === true ? "h1" : null
}

/**
 * The `amby-pages` value that turns pages on or off for one note: the smallest change from the
 * default, so `null` (no property) whenever the note already has the requested default.
 */
export function notePagesFlagFor(
  mode: NotePagesPref,
  enabled: boolean,
  dossier = false,
): boolean | null {
  const byDefault = notePagesRule(mode, null, dossier) !== null
  if (enabled === byDefault) return null
  return enabled
}

function pagesOf(doc: Node, mode: NotePagesLevel): NotePage[] {
  const starts: { from: number; size: number; title: string; level: number }[] = []
  let firstContent: number | undefined
  let level = mode === "h1" ? 1 : Infinity
  doc.forEach((node, from) => {
    if (node.type.name === "heading") {
      const depth = Number(node.attrs.level)
      if (mode === "top") level = Math.min(depth, level)
      starts.push({ from, size: node.nodeSize, title: node.textContent.trim(), level: depth })
    }
    if (firstContent === undefined && (node.type.name !== "paragraph" || node.content.size > 0)) {
      firstContent = from
    }
  })
  const headings = starts.filter((start) => start.level === level)
  const first = headings[0]
  if (!first) return []
  const pages: NotePage[] = headings.map(({ from, size, title }, index) => {
    const start = index === 0 && firstContent === first.from ? 0 : from
    const to = headings[index + 1]?.from ?? doc.content.size
    return { from: start, to, body: from + size, heading: from, title }
  })
  if (firstContent !== undefined && firstContent < first.from) {
    pages.unshift({ from: 0, to: first.from, body: 0, heading: null, title: null })
  }
  return pages
}

function pageAt(pages: NotePage[], position: number): number {
  const index = pages.findIndex((page) => position < page.to)
  return index < 0 ? pages.length - 1 : index
}

export function notePageAtPosition(state: EditorState, position: number): number {
  return pageAt(notePagesKey.getState(state)?.pages ?? [], position)
}

/** Use the title and its occurrence, keeping the introduction distinct from any heading. */
export function notePageIdentity(pages: NotePage[], index: number): string {
  const { title } = pages[index]
  return JSON.stringify([
    title,
    pages.slice(0, index).filter((page) => page.title === title).length,
  ])
}

export function restoreNotePageIndex(pages: NotePage[], identity: string): number {
  return Math.max(
    0,
    pages.findIndex((_, index) => notePageIdentity(pages, index) === identity),
  )
}

function currentPage(state?: NotePagesState): NotePage | undefined {
  return state && state.active !== null ? state.pages[state.active] : undefined
}

export function notePageContains(state: NotePagesState | undefined, offset: number): boolean {
  const page = currentPage(state)
  return !page || (offset >= page.from && offset < page.to)
}

/** The heading at `offset` starts the open page, and that page has nothing under it. */
export function isEmptyOpenPageHeading(state: NotePagesState | undefined, offset: number): boolean {
  const page = currentPage(state)
  return Boolean(page && page.heading === offset && page.body >= page.to)
}

export function setNotePages(editor: Editor, enabled: boolean, index?: number) {
  const state = notePagesKey.getState(editor.state)
  if (!state || (state.enabled === enabled && (index === undefined || state.active === index))) {
    return
  }
  editor.view.dispatch(
    editor.state.tr
      .setMeta(notePagesKey, { enabled, index } satisfies NotePageChange)
      .setMeta("addToHistory", false),
  )
}

/** Move a section to another tab's index, preserving its complete blocks and source metadata. */
export function moveNotePage(
  editor: Editor,
  fromIndex: number,
  toIndex: number,
  introductionTitle: string,
): boolean {
  const state = notePagesKey.getState(editor.state)
  const from = state?.pages[fromIndex]
  const to = state?.pages[toIndex]
  if (!editor.isEditable || !state || !from || !to || fromIndex === toIndex) return false
  const { doc, schema } = editor.state
  const fromStart = from.heading ?? from.from
  let content = doc.slice(fromStart, from.to).content
  if (from.heading === null || to.heading === null) {
    // A preamble only forms a page at the start. Give it a heading when it would
    // otherwise become part of the section that now precedes it.
    const otherHeading = from.heading ?? to.heading
    if (otherHeading === null) return false
    const level = doc.nodeAt(otherHeading)?.attrs.level
    const heading = Fragment.from(
      schema.nodes.heading.create({ level }, schema.text(introductionTitle)),
    )
    content = from.heading === null ? heading.append(content) : content.append(heading)
  }
  const tr = closeHistory(editor.state.tr).delete(fromStart, from.to)
  const target = fromIndex < toIndex ? to.to : (to.heading ?? to.from)
  tr.insert(tr.mapping.map(target), content).setMeta(PAGE_EDIT, true)
  markEditorUserIntent(editor)
  tr.setMeta(notePagesKey, { enabled: state.enabled, index: toIndex } satisfies NotePageChange)
  editor.view.dispatch(tr)
  editor.view.dispatch(closeHistory(editor.state.tr))
  return true
}

/** The command moves whole top-level blocks so it can keep their original Markdown. */
export function notePageExtraction(editor: Editor) {
  const { doc, selection } = editor.state
  const state = notePagesKey.getState(editor.state)
  if (!editor.isEditable || !state || selection.empty) return null
  const blocks: { start: number; end: number }[] = []
  doc.forEach((node, start) => {
    const end = start + node.nodeSize
    if (
      (selection.from <= start && selection.to >= end) ||
      (selection.from < end - 1 && selection.to > start + 1)
    )
      blocks.push({ start, end })
  })
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  if (!first || !last) return null
  if (
    state.pages.some(
      (page) => page.heading !== null && page.heading >= first.start && page.heading < last.end,
    )
  ) {
    return null
  }
  return { doc, from: first.start, to: last.end }
}

export function extractNotePage(
  editor: Editor,
  range: NonNullable<ReturnType<typeof notePageExtraction>>,
  title: string,
): boolean {
  const state = notePagesKey.getState(editor.state)
  const { doc, schema } = editor.state
  const name = title.trim()
  if (!editor.isEditable || !state || range.doc !== doc || !name) return false
  const firstHeading = state.pages.find((page) => page.heading !== null)?.heading
  const level = firstHeading == null ? 1 : Number(doc.nodeAt(firstHeading)?.attrs.level ?? 1)
  const moved = doc.slice(range.from, range.to).content
  const titleNode = schema.nodes.heading.create({ level }, schema.text(name))
  const tr = closeHistory(editor.state.tr).delete(range.from, range.to)
  const at = tr.doc.content.size
  tr.insert(at, titleNode).insert(at + titleNode.nodeSize, moved)
  tr.setSelection(Selection.near(tr.doc.resolve(at + titleNode.nodeSize), 1))
  tr.setMeta(PAGE_EDIT, true)
  tr.setMeta(notePagesKey, {
    enabled: true,
    index: Number.MAX_SAFE_INTEGER,
  } satisfies NotePageChange)
  markEditorUserIntent(editor)
  editor.view.dispatch(tr)
  editor.view.dispatch(closeHistory(editor.state.tr))
  return true
}

/**
 * Appends a page: a heading of the pages' level and an empty line under it, then opens the new
 * page with the cursor on that line. One undo step removes it.
 */
export function addNotePage(editor: Editor, title: string): boolean {
  const state = notePagesKey.getState(editor.state)
  const name = title.trim()
  if (!state || !name || !editor.isEditable) return false
  const { schema, doc } = editor.state
  const heading = state.pages.find((page) => page.heading !== null)?.heading
  const level = heading == null ? 1 : Number(doc.nodeAt(heading)?.attrs.level ?? 1)
  const last = doc.lastChild
  // A trailing empty line belongs to the last page only as the editor's spare line: reuse it.
  const from =
    last && last.type.name === "paragraph" && last.content.size === 0 && doc.childCount > 1
      ? doc.content.size - last.nodeSize
      : doc.content.size
  const tr = editor.state.tr.replaceWith(from, doc.content.size, [
    schema.nodes.heading.create({ level }, schema.text(name)),
    schema.nodes.paragraph.create(),
  ])
  tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1))
  tr.setMeta(PAGE_EDIT, true)
  // The page controls live outside the editor's text, so the save gate must hear about the edit.
  markEditorUserIntent(editor)
  tr.setMeta(notePagesKey, {
    enabled: true,
    index: Number.MAX_SAFE_INTEGER,
  } satisfies NotePageChange)
  editor.view.dispatch(tr.scrollIntoView())
  editor.view.focus()
  return true
}

/** Appends template sections in one undo step, keeping the open page and its selection. */
export function appendMissingHeadings(
  editor: Editor,
  titles: readonly string[],
): AppendHeadingsResult {
  if (editor.isDestroyed || !editor.isEditable) return "blocked"
  const { doc } = editor.state
  const headings = missingHeadingNodes(doc, titles)
  if (headings.length === 0) return "unchanged"
  // The initial empty paragraph is only the editor's placeholder.
  const from =
    doc.childCount === 1 &&
    doc.firstChild?.type.name === "paragraph" &&
    doc.firstChild.content.size === 0
      ? 0
      : doc.content.size
  const tr = closeHistory(editor.state.tr)
    .replaceWith(from, doc.content.size, headings)
    .setMeta(PAGE_EDIT, true)
  markEditorUserIntent(editor)
  editor.view.dispatch(tr)
  editor.view.dispatch(closeHistory(editor.state.tr))
  return "added"
}

/** Renames a page by replacing the text of its heading; the introduction has none. */
export function renameNotePage(editor: Editor, index: number, title: string): boolean {
  const state = notePagesKey.getState(editor.state)
  const page = state?.pages[index]
  const name = title.trim()
  if (!page || page.heading === null || !name || !editor.isEditable) return false
  const node = editor.state.doc.nodeAt(page.heading)
  if (!node || node.textContent === name) return false
  const tr = editor.state.tr.replaceWith(
    page.heading + 1,
    page.heading + node.nodeSize - 1,
    editor.state.schema.text(name),
  )
  tr.setMeta(PAGE_EDIT, true)
  // The page controls live outside the editor's text, so the save gate must hear about the edit.
  markEditorUserIntent(editor)
  if (state.active !== null) {
    tr.setMeta(notePagesKey, { enabled: true, index: state.active } satisfies NotePageChange)
  }
  editor.view.dispatch(tr)
  return true
}

/**
 * Deletes a page. With `keep`, only its heading goes: the text joins the end of the page before it, or the
 * top of the next page for the first one. One undo step brings it back.
 */
export function deleteNotePage(editor: Editor, index: number, keep: boolean): boolean {
  const state = notePagesKey.getState(editor.state)
  const page = state?.pages[index]
  if (!state || !page || state.pages.length < 2 || !editor.isEditable) return false
  const { doc } = editor.state
  const tr = editor.state.tr
  const headingSize = page.heading === null ? 0 : (doc.nodeAt(page.heading)?.nodeSize ?? 0)
  if (keep && index > 0) {
    if (page.heading === null) return false
    tr.delete(page.heading, page.heading + headingSize)
  } else if (keep) {
    const next = state.pages[1]
    if (next.heading === null) return false
    const nextHeading = doc.nodeAt(next.heading)
    if (!nextHeading) return false
    const start = page.heading === null ? page.from : page.heading + headingSize
    const content = doc.slice(start, page.to)
    // Insert below the next heading first: it lies after this page, so this page's positions hold.
    tr.insert(next.heading + nextHeading.nodeSize, content.content)
    tr.delete(page.from, page.to)
  } else {
    tr.delete(page.from, page.to)
  }
  // The cursor goes to the end of the text of the page that opens, never onto the boundary between pages.
  const target = tr.mapping.map(index === 0 ? page.to : page.from, -1)
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(target, tr.doc.content.size)), -1))
  tr.setMeta(PAGE_EDIT, true)
  // The page controls live outside the editor's text, so the save gate must hear about the edit.
  markEditorUserIntent(editor)
  tr.setMeta(notePagesKey, {
    enabled: true,
    index: Math.max(0, index - 1),
  } satisfies NotePageChange)
  editor.view.dispatch(tr)
  editor.view.focus()
  return true
}

/** Source-to-Live cursor restores can reveal the page that holds the cursor. */
export function revealNotePageAt(editor: Editor, position: number) {
  const state = notePagesKey.getState(editor.state)
  if (state?.enabled) setNotePages(editor, true, notePageAtPosition(editor.state, position))
}

/** The editable document remains intact, including its history and lossless Markdown metadata. */
/** Starts the text of an empty page: an empty line (or the typed text) right under its hidden heading. */
function startEmptyPage(view: EditorView, page: NotePage, text = ""): void {
  const { schema } = view.state
  const tr = view.state.tr.insert(
    page.to,
    schema.nodes.paragraph.create(null, text ? schema.text(text) : null),
  )
  tr.setSelection(TextSelection.create(tr.doc, page.to + 1 + text.length))
  markEditorUserIntent(editorOf(view))
  view.dispatch(tr.scrollIntoView())
}

/** Tiptap keeps its editor on the editable element. */
function editorOf(view: EditorView): Editor | undefined {
  return (view.dom as HTMLElement & { editor?: Editor }).editor
}

/**
 * @param emptyLabel The invitation shown on a page that has nothing under its heading.
 * @param hints What to write under a heading of a known name; an empty page of such a heading
 *   shows its hint instead of the generic invitation, so there is one line, not two.
 */
export function notePagesPlugin(
  level: NotePagesLevel = "top",
  emptyLabel = "",
  /** A function lets the hints change (a template read later) without registering the plugin
   *  again, which would close the open page. */
  hints?: ReadonlyMap<string, string> | (() => ReadonlyMap<string, string> | null) | null,
) {
  const hintsOf = () => (typeof hints === "function" ? hints() : hints)
  return new Plugin<NotePagesState>({
    key: notePagesKey,
    state: {
      init: (_, state) => ({ enabled: false, pages: pagesOf(state.doc, level), active: null }),
      apply: (transaction, previous) => {
        const control = transaction.getMeta(notePagesKey) as NotePageChange | undefined
        if (!control && !transaction.docChanged) return previous
        const pages = transaction.docChanged ? pagesOf(transaction.doc, level) : previous.pages
        const enabled = control?.enabled ?? previous.enabled
        if (!enabled || pages.length < 2) return { enabled, pages, active: null }
        const before = currentPage(previous)
        const followsSelection =
          !before || isHistoryTransaction(transaction) || transaction.getMeta("preventUpdate")
        const position = followsSelection
          ? transaction.selection.head
          : transaction.mapping.map(before.from, -1)
        return {
          enabled,
          pages,
          active: Math.min(
            Math.max(0, control?.index ?? pageAt(pages, position)),
            pages.length - 1,
          ),
        }
      },
    },
    filterTransaction: (transaction, state) => {
      const page = currentPage(notePagesKey.getState(state))
      if (
        !page ||
        !transaction.docChanged ||
        isHistoryTransaction(transaction) ||
        transaction.getMeta("preventUpdate") ||
        transaction.getMeta(PAGE_EDIT)
      )
        return true
      // Compare the complete sibling blocks on both sides. This catches joins, replacements,
      // marking commands and drag operations even when their step maps contain no changed range.
      const after = transaction.doc.content
      const before = state.doc.content
      const tail = before.size - page.to
      return (
        after.size >= page.body + tail &&
        before.cut(0, page.body).eq(after.cut(0, page.body)) &&
        before.cut(page.to).eq(after.cut(after.size - tail))
      )
    },
    appendTransaction: (_, __, state) => {
      const page = currentPage(notePagesKey.getState(state))
      if (!page) return null
      if (page.body >= page.to) {
        // An empty page: the cursor waits at the end of the hidden heading until text is typed.
        const end = page.to - 1
        if (state.selection.empty && state.selection.from === end) return null
        return state.tr
          .setSelection(TextSelection.create(state.doc, end))
          .setMeta("addToHistory", false)
      }
      if (state.selection.from >= page.body && state.selection.to <= page.to) return null
      const selection = Selection.findFrom(state.doc.resolve(page.body), 1)
      if (!selection || selection.to > page.to) return null
      return state.tr.setSelection(selection).setMeta("addToHistory", false)
    },
    view: () => ({
      update: (view, previous) => {
        const before = notePagesKey.getState(previous)
        const after = notePagesKey.getState(view.state)
        if (before?.active === after?.active || view.hasFocus()) return
        // WebKit keeps painting the caret where it stood when that line is hidden by another page.
        // Without focus the editor does not move the browser selection, so drop the stale one.
        const selection = view.dom.ownerDocument.getSelection()
        if (selection?.anchorNode && view.dom.contains(selection.anchorNode)) {
          selection.removeAllRanges()
        }
      },
    }),
    props: {
      decorations: (state) => {
        const page = currentPage(notePagesKey.getState(state))
        if (!page) return null
        const find = readFind(state)
        const match = find.matches[find.current]
        const decorations: Decoration[] = []
        state.doc.forEach((node, offset) => {
          if (offset === page.heading && match && match.from > offset && match.from < page.body)
            return
          if (offset < page.body || offset >= page.to) {
            decorations.push(
              Decoration.node(offset, offset + node.nodeSize, { "data-note-page-hidden": "" }),
            )
          }
        })
        if (page.body >= page.to) {
          const label = (page.title !== null && hintsOf()?.get(page.title.trim())) || emptyLabel
          decorations.push(
            Decoration.widget(
              page.to,
              (view) => {
                const line = document.createElement("p")
                line.setAttribute("data-note-page-empty", "")
                line.className = "amby-note-page-empty"
                line.textContent = label
                line.contentEditable = "false"
                line.addEventListener("mousedown", (event) => {
                  event.preventDefault()
                  const open = currentPage(notePagesKey.getState(view.state))
                  if (open && open.body >= open.to) startEmptyPage(view, open)
                  view.focus()
                })
                return line
              },
              { side: -1, key: `empty-${page.to}-${label}` },
            ),
          )
        }
        return DecorationSet.create(state.doc, decorations)
      },
      handleTextInput: (view, _from, _to, text) => {
        const page = currentPage(notePagesKey.getState(view.state))
        if (!page || page.body < page.to) return false
        startEmptyPage(view, page, text)
        return true
      },
      handleKeyDown: (view, event) => {
        const page = currentPage(notePagesKey.getState(view.state))
        if (page && page.body >= page.to && isEnterKey(event)) {
          startEmptyPage(view, page)
          return true
        }
        if (
          !page ||
          !(event.metaKey || event.ctrlKey) ||
          event.altKey ||
          event.shiftKey ||
          event.key.toLowerCase() !== "a"
        )
          return false
        const { doc, tr } = view.state
        const start = Selection.findFrom(doc.resolve(page.body), 1, true)
        const end = Selection.findFrom(doc.resolve(page.to), -1, true)
        if (start && end && start.from <= end.to && start.from >= page.body && end.to <= page.to) {
          view.dispatch(tr.setSelection(TextSelection.create(doc, start.from, end.to)))
        }
        return true
      },
    },
  })
}
