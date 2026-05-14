"use client"

import * as React from "react"
import { EditorState, RangeSetBuilder } from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { markdown } from "@codemirror/lang-markdown"
import { tags } from "@lezer/highlight"

import { INLINE_TOKEN_RE, getWikiLinkParts, type EditorHandle } from "./tiptap/constants"

interface SourceEditorProps {
  value: string
  onChange: (value: string) => void
  onTagClick?: (tag: string) => void
  onWikiLinkClick?: (target: string) => void
  editorRef?: React.RefObject<EditorHandle>
  placeholder?: string
}

// Dark theme tuned to match the app shell (see index.css .amby-source-editor).
const theme = EditorView.theme(
  {
    "&": {
      color: "#d4d4d8",
      backgroundColor: "transparent",
      fontSize: "0.875rem",
    },
    ".cm-content": {
      fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
      lineHeight: "1.7",
      padding: "0.5rem 0 5rem",
      caretColor: "#22d3ee",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#22d3ee" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(56, 189, 248, 0.22)",
    },
    ".cm-line": { padding: "0" },
    ".cm-amby-tag": {
      borderRadius: "999px",
      backgroundColor: "rgba(139, 92, 246, 0.22)",
      color: "#c084fc",
      cursor: "pointer",
    },
    ".cm-amby-wikilink": {
      borderRadius: "3px",
      backgroundColor: "rgba(14, 165, 233, 0.18)",
      color: "#7dd3fc",
      borderBottom: "1px solid rgba(56, 189, 248, 0.45)",
      cursor: "pointer",
    },
  },
  { dark: true }
)

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "#fafafa", fontWeight: "700" },
  { tag: tags.strong, color: "#fafafa", fontWeight: "700" },
  { tag: tags.emphasis, color: "#a1a1aa", fontStyle: "italic" },
  { tag: tags.strikethrough, color: "#71717a", textDecoration: "line-through" },
  { tag: tags.monospace, color: "#a78bfa" },
  { tag: tags.link, color: "#7dd3fc" },
  { tag: tags.url, color: "#38bdf8" },
  { tag: tags.quote, color: "#b8bcc6" },
  { tag: tags.list, color: "#22d3ee" },
  { tag: tags.contentSeparator, color: "#52525b" },
  { tag: tags.processingInstruction, color: "#52525b" },
  { tag: tags.meta, color: "#71717a" },
])

// Decorates #tags and [[wikilinks]] in the raw markdown source.
function buildTokenDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const text = view.state.doc.toString()
  INLINE_TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INLINE_TOKEN_RE.exec(text)) !== null) {
    builder.add(
      match.index,
      match.index + match[0].length,
      Decoration.mark({ class: match[1] ? "cm-amby-tag" : "cm-amby-wikilink" })
    )
  }
  return builder.finish()
}

const tokenDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildTokenDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = buildTokenDecorations(update.view)
    }
  },
  { decorations: plugin => plugin.decorations }
)

// Raw-markdown editor for "Source" mode. Shows the file byte-exact with
// markdown syntax highlighting; #tags and [[wikilinks]] stay clickable.
export function SourceEditor({
  value,
  onChange,
  onTagClick,
  onWikiLinkClick,
  editorRef,
  placeholder,
}: SourceEditorProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const viewRef = React.useRef<EditorView | null>(null)
  const valueRef = React.useRef(value)
  const onChangeRef = React.useRef(onChange)
  const callbacksRef = React.useRef({ onTagClick, onWikiLinkClick })

  React.useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  React.useEffect(() => {
    callbacksRef.current = { onTagClick, onWikiLinkClick }
  }, [onTagClick, onWikiLinkClick])

  React.useEffect(() => {
    const parent = containerRef.current
    if (!parent) return

    // Navigate on click into a #tag / [[wikilink]] token.
    const clickHandler = EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos == null) return false
        const text = view.state.doc.toString()
        INLINE_TOKEN_RE.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = INLINE_TOKEN_RE.exec(text)) !== null) {
          const start = match.index
          const end = match.index + match[0].length
          if (pos < start || pos > end) continue
          event.preventDefault()
          const callbacks = callbacksRef.current
          if (match[1]) {
            callbacks.onTagClick?.(match[1])
          } else if (match[2]) {
            const { target } = getWikiLinkParts(match[2])
            if (target) callbacks.onWikiLinkClick?.(target)
          }
          return true
        }
        return false
      },
    })

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          syntaxHighlighting(markdownHighlight),
          theme,
          tokenDecorations,
          clickHandler,
          EditorView.lineWrapping,
          cmPlaceholder(placeholder ?? ""),
          EditorView.updateListener.of(update => {
            if (!update.docChanged) return
            const next = update.state.doc.toString()
            valueRef.current = next
            onChangeRef.current(next)
          }),
        ],
      }),
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Created once per mount; document switches remount via the React `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync external value changes without echoing our own edits.
  React.useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (value === valueRef.current) return
    valueRef.current = value
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    })
  }, [value])

  // Expose undo/redo to the parent's floating widget.
  React.useEffect(() => {
    if (!editorRef) return
    ;(editorRef as React.MutableRefObject<EditorHandle>).current = {
      undo: () => {
        const view = viewRef.current
        if (view) {
          undo(view)
          view.focus()
        }
      },
      redo: () => {
        const view = viewRef.current
        if (view) {
          redo(view)
          view.focus()
        }
      },
    }
  }, [editorRef])

  return <div ref={containerRef} className="amby-source-editor relative min-h-[360px]" />
}
