"use client"

import * as React from "react"
import { EditorState } from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
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
import { normalizeMarkdownSelection, type MarkdownSelection } from "./tiptap/markdown-selection"

interface SourceEditorProps {
  value: string
  onChange: (value: string) => void
  onTagClick?: (tag: string) => void
  onWikiLinkClick?: (target: string) => void
  editorRef?: React.RefObject<EditorHandle>
  placeholder?: string
  selection?: MarkdownSelection | null
  onSelectionChange?: (selection: MarkdownSelection) => void
  editable?: boolean
}

// Theme-aware source editor. The values intentionally come from the shared
// CSS palette so Source mode follows the same light/dark theme and accent as
// the rest of the application.
const theme = EditorView.theme(
  {
    "&": {
      color: "var(--editor-fg)",
      backgroundColor: "transparent",
      fontSize: "0.875rem",
    },
    ".cm-content": {
      fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
      lineHeight: "1.7",
      padding: "0.5rem 0 5rem",
      caretColor: "var(--editor-caret-color, var(--caret-color))",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--editor-caret-color, var(--caret-color))",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "hsl(var(--primary) / 0.22)",
    },
    ".cm-line": { padding: "0" },
    ".cm-amby-tag": {
      borderRadius: "999px",
      backgroundColor: "var(--tag-bg)",
      color: "var(--tag-fg)",
      cursor: "pointer",
    },
    ".cm-amby-wikilink": {
      borderRadius: "3px",
      backgroundColor: "var(--wikilink-bg)",
      color: "var(--wikilink-fg)",
      borderBottom: "1px solid var(--wikilink-underline)",
      cursor: "pointer",
    },
  },
  { dark: true },
)

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--editor-heading)", fontWeight: "700" },
  { tag: tags.strong, color: "var(--editor-strong)", fontWeight: "700" },
  { tag: tags.emphasis, color: "var(--editor-em)", fontStyle: "italic" },
  { tag: tags.strikethrough, color: "var(--editor-del)", textDecoration: "line-through" },
  { tag: tags.monospace, color: "var(--code-fg)" },
  { tag: tags.link, color: "var(--link-color)" },
  { tag: tags.url, color: "var(--link-hover-color)" },
  { tag: tags.quote, color: "var(--blockquote-fg)" },
  { tag: tags.list, color: "var(--primary)" },
  { tag: tags.contentSeparator, color: "var(--panel-section-fg)" },
  { tag: tags.processingInstruction, color: "var(--panel-section-fg)" },
  { tag: tags.meta, color: "var(--panel-hint-fg)" },
])

// Decorates #tags and [[wikilinks]] in the raw markdown source. MatchDecorator
// rematches only changed/visible lines instead of scanning the entire document
// after every keystroke, which keeps long source notes responsive.
const tokenDecorator = new MatchDecorator({
  regexp: INLINE_TOKEN_RE,
  decoration: (match) => Decoration.mark({ class: match[1] ? "cm-amby-tag" : "cm-amby-wikilink" }),
  maxLength: 4000,
})

const tokenDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = tokenDecorator.createDeco(view)
    }
    update(update: ViewUpdate) {
      this.decorations = tokenDecorator.updateDeco(update, this.decorations)
    }
  },
  { decorations: (plugin) => plugin.decorations },
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
  selection,
  onSelectionChange,
  editable = true,
}: SourceEditorProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const viewRef = React.useRef<EditorView | null>(null)
  const valueRef = React.useRef(value)
  const applyingExternalValueRef = React.useRef(false)
  const onChangeRef = React.useRef(onChange)
  const onSelectionChangeRef = React.useRef(onSelectionChange)
  const callbacksRef = React.useRef({ onTagClick, onWikiLinkClick })

  React.useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  React.useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange
  }, [onSelectionChange])

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
            // Pass full raw inner content so the handler can scroll to anchors.
            if (target) callbacks.onWikiLinkClick?.(match[2])
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
        selection: (() => {
          const initialSelection = normalizeMarkdownSelection(selection, value)
          return initialSelection
            ? { anchor: initialSelection.from, head: initialSelection.to }
            : undefined
        })(),
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable),
          syntaxHighlighting(markdownHighlight),
          theme,
          tokenDecorations,
          clickHandler,
          EditorView.lineWrapping,
          cmPlaceholder(placeholder ?? ""),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet) {
              const range = update.state.selection.main
              onSelectionChangeRef.current?.({ from: range.from, to: range.to })
            }
            if (!update.docChanged) return
            const next = update.state.doc.toString()
            valueRef.current = next
            if (applyingExternalValueRef.current) return
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
    // Created once per mount; document/lock switches remount via the React `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync external value changes without echoing our own edits.
  React.useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (value === valueRef.current) return
    valueRef.current = value
    applyingExternalValueRef.current = true
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      })
    } finally {
      applyingExternalValueRef.current = false
    }
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
