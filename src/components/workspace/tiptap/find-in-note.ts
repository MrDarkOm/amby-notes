import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import { Extension } from "@tiptap/core"

// Find in note for Live and Read: matches are decorations, so the note itself and its
// selection are not touched while searching.

export interface FindMatch {
  from: number
  to: number
}

export interface FindState {
  query: string
  matches: FindMatch[]
  /** Index of the match the user is on; -1 when there is none. */
  current: number
  decorations: DecorationSet
}

type FindAction =
  { type: "query"; query: string } | { type: "step"; by: 1 | -1 } | { type: "clear" }

export const findKey = new PluginKey<FindState>("ambyFindInNote")

const EMPTY: FindState = { query: "", matches: [], current: -1, decorations: DecorationSet.empty }

/** Every place the query is written, searched block by block, ignoring case. */
export function findMatches(doc: PMNode, query: string): FindMatch[] {
  const matches: FindMatch[] = []
  if (!query) return matches
  const needle = query.toLowerCase()
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return
    // A leaf (an image, a line break) is one character, as it is one position.
    const text = node.textBetween(0, node.content.size, undefined, "￼")
    const lower = text.toLowerCase()
    // Lowering can change the length of a few characters; then the case must match.
    const haystack = lower.length === text.length ? lower : text
    const wanted = lower.length === text.length ? needle : query
    let at = haystack.indexOf(wanted)
    while (at !== -1) {
      matches.push({ from: pos + 1 + at, to: pos + 1 + at + wanted.length })
      at = haystack.indexOf(wanted, at + wanted.length)
    }
    return false
  })
  return matches
}

function withDecorations(doc: PMNode, state: Omit<FindState, "decorations">): FindState {
  return {
    ...state,
    decorations: DecorationSet.create(
      doc,
      state.matches.map((match, index) =>
        Decoration.inline(match.from, match.to, {
          class: index === state.current ? "amby-find-match amby-find-current" : "amby-find-match",
        }),
      ),
    ),
  }
}

export function readFind(state: EditorState): FindState {
  return findKey.getState(state) ?? EMPTY
}

/** Sets what is searched for; the first match at or after the cursor becomes current. */
export function setFindQuery(view: EditorView, query: string) {
  view.dispatch(view.state.tr.setMeta(findKey, { type: "query", query } satisfies FindAction))
}

export function stepFind(view: EditorView, by: 1 | -1) {
  view.dispatch(view.state.tr.setMeta(findKey, { type: "step", by } satisfies FindAction))
}

/** Ends the search; the cursor is put at the match the user was on. */
export function clearFind(view: EditorView) {
  const { matches, current } = readFind(view.state)
  const tr = view.state.tr.setMeta(findKey, { type: "clear" } satisfies FindAction)
  const match = matches[current]
  if (match) tr.setSelection(TextSelection.create(tr.doc, match.from))
  view.dispatch(tr)
}

export const OPEN_FIND_EVENT = "amby:open-find"

export const FindInNote = Extension.create({
  name: "findInNote",

  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => EMPTY,
          apply(tr, value, _oldState, newState) {
            const action = tr.getMeta(findKey) as FindAction | undefined
            if (action?.type === "clear") return EMPTY
            if (action?.type === "query") {
              const matches = findMatches(newState.doc, action.query)
              const caret = newState.selection.from
              const next = matches.findIndex((match) => match.to >= caret)
              const current = matches.length === 0 ? -1 : next === -1 ? 0 : next
              return withDecorations(newState.doc, { query: action.query, matches, current })
            }
            if (action?.type === "step" && value.matches.length > 0) {
              const count = value.matches.length
              const current = (value.current + action.by + count) % count
              return withDecorations(newState.doc, { ...value, current })
            }
            if (tr.docChanged && value.query) {
              const matches = findMatches(newState.doc, value.query)
              const current =
                matches.length === 0 ? -1 : Math.min(Math.max(value.current, 0), matches.length - 1)
              return withDecorations(newState.doc, { query: value.query, matches, current })
            }
            return value
          },
        },
        props: {
          decorations: (state) => readFind(state).decorations,
        },
      }),
    ]
  },

  addKeyboardShortcuts() {
    return {
      "Mod-f": ({ editor }) => {
        editor.view.dom.dispatchEvent(new CustomEvent(OPEN_FIND_EVENT, { bubbles: true }))
        return true
      },
    }
  },
})
