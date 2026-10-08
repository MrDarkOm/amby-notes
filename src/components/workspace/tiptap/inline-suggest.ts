import { Extension, type Editor, type Range } from "@tiptap/core"
import type { ResolvedPos } from "@tiptap/pm/model"
import { PluginKey } from "@tiptap/pm/state"
import Suggestion, { exitSuggestion, type SuggestionMatch } from "@tiptap/suggestion"

import { INLINE_TOKEN_RE } from "./constants"
import { suggestNotes, suggestTags, type SuggestItem } from "./link-suggestions"

// Suggestions while typing `[[` (notes) and `#` (existing tags), on the same Suggestion
// mechanism as the slash menu. The editor keeps the focus: the list is drawn by
// `InlineSuggestPanel` from this extension's storage and driven by the keys below.

export type InlineSuggestKind = "wikilink" | "tag"

export interface InlineSuggestState {
  open: boolean
  kind: InlineSuggestKind | null
  items: SuggestItem[]
  index: number
  rect: DOMRect | null
  /** Picks an item of the open list (a click in the panel). */
  select: (index: number) => void
  /** Bumped on every change so React subscribers re-render. */
  version: number
}

export const INLINE_SUGGEST_EVENT = "amby:inline-suggest"

const wikilinkKey = new PluginKey("ambyWikilinkSuggest")
const tagKey = new PluginKey("ambyTagSuggest")

// `[[` and what follows it up to the cursor: a name being typed, not yet an alias or an
// anchor, and not a link that is already closed.
const WIKILINK_TRIGGER = /\[\[([^[\]|#^\n]*)$/u
// `#` at the start of a word and the tag characters after it.
const TAG_TRIGGER = /(?:^|[\s([{>])#([\p{L}\p{N}_/-]*)$/u

/** The trigger and the query in the text between the start of the block and the cursor. */
export function matchTrigger($position: ResolvedPos, kind: InlineSuggestKind): SuggestionMatch {
  if (!$position.parent.isTextblock || $position.parent.type.spec.code) return null
  // A leaf (an image, a hard break) counts as one character, as it does in positions.
  const before = $position.parent.textBetween(0, $position.parentOffset, undefined, "￼")
  const match = (kind === "wikilink" ? WIKILINK_TRIGGER : TAG_TRIGGER).exec(before)
  if (!match) return null
  const query = match[1] ?? ""
  const text = kind === "wikilink" ? `[[${query}` : `#${query}`
  const to = $position.pos
  return { range: { from: to - text.length, to }, query, text }
}

function inInlineCode($position: ResolvedPos): boolean {
  return $position.marks().some((mark) => mark.type.spec.code)
}

/** Tags already written in the note, the one under the cursor excluded by the caller. */
function tagsInNote(editor: Editor): string[] {
  const tags: string[] = []
  editor.state.doc.descendants((node) => {
    if (!node.isText || !node.text) return
    INLINE_TOKEN_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = INLINE_TOKEN_RE.exec(node.text)) !== null) if (match[1]) tags.push(match[1])
  })
  return tags
}

function getStorage(editor: Editor): InlineSuggestState {
  return (editor.storage as unknown as { inlineSuggest: InlineSuggestState }).inlineSuggest
}

export function readInlineSuggest(editor: Editor): InlineSuggestState | null {
  return (editor.storage as unknown as { inlineSuggest?: InlineSuggestState }).inlineSuggest ?? null
}

function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(INLINE_SUGGEST_EVENT))
}

function close(editor: Editor) {
  const state = getStorage(editor)
  if (!state.open && state.items.length === 0) return
  state.open = false
  state.kind = null
  state.items = []
  state.index = 0
  state.rect = null
  state.select = () => {}
  state.version++
  notify()
}

/** Closes the list and stops the trigger under the cursor from opening it again. */
export function dismissInlineSuggest(editor: Editor) {
  if (editor.isDestroyed) return
  for (const key of [wikilinkKey, tagKey]) {
    const state = key.getState(editor.state) as { active?: boolean } | undefined
    if (state?.active) exitSuggestion(editor.view, key)
  }
  close(editor)
}

function suggestion(editor: Editor, kind: InlineSuggestKind) {
  const show = (props: {
    items: SuggestItem[]
    clientRect?: (() => DOMRect | null) | null
    command: (item: SuggestItem) => void
  }) => {
    const state = getStorage(editor)
    state.open = props.items.length > 0
    state.kind = kind
    state.items = props.items
    state.index = Math.min(state.index, Math.max(0, props.items.length - 1))
    state.rect = props.clientRect?.() ?? null
    state.select = (index) => {
      const item = props.items[index]
      if (item) props.command(item)
    }
    state.version++
    notify()
  }

  return Suggestion<SuggestItem, SuggestItem>({
    pluginKey: kind === "wikilink" ? wikilinkKey : tagKey,
    editor,
    char: kind === "wikilink" ? "[[" : "#",
    findSuggestionMatch: ({ $position }) => matchTrigger($position, kind),
    allow: ({ state, range }) => !inInlineCode(state.doc.resolve(range.to)),
    items: ({ query, editor }) =>
      kind === "wikilink" ? suggestNotes(query) : suggestTags(query, tagsInNote(editor)),
    command: ({ editor, range, props }) => {
      const text = kind === "wikilink" ? `[[${props.value}]]` : `#${props.value} `
      insertSuggestion(editor, range, text)
    },
    render: () => ({
      onStart: (props) => {
        getStorage(editor).index = 0
        show(props)
      },
      onUpdate: show,
      onKeyDown: ({ event }) => {
        const state = getStorage(editor)
        // With nothing to offer every key belongs to the note.
        if (!state.open || state.items.length === 0) return false
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const step = event.key === "ArrowDown" ? 1 : -1
          state.index = (state.index + step + state.items.length) % state.items.length
          state.version++
          notify()
          return true
        }
        if (event.key === "Enter" || event.key === "Tab") {
          state.select(state.index)
          return true
        }
        if (event.key === "Escape") {
          dismissInlineSuggest(editor)
          return true
        }
        return false
      },
      onExit: () => close(editor),
    }),
  })
}

/** Writes the chosen note or tag over the typed trigger; the cursor ends up after it. */
export function insertSuggestion(editor: Editor, range: Range, text: string) {
  const tr = editor.state.tr.insertText(text, range.from, range.to)
  editor.view.dispatch(tr.setMeta("uiEvent", "suggest").scrollIntoView())
  editor.view.focus()
}

export const InlineSuggest = Extension.create({
  name: "inlineSuggest",

  addStorage(): InlineSuggestState {
    return {
      open: false,
      kind: null,
      items: [],
      index: 0,
      rect: null,
      select: () => {},
      version: 0,
    }
  },

  addProseMirrorPlugins() {
    return [suggestion(this.editor, "wikilink"), suggestion(this.editor, "tag")]
  },
})
