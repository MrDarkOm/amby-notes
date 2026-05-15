"use client"

import * as React from "react"
import { EditorContent, useEditor } from "@tiptap/react"

import { buildExtensions } from "./extensions"
import { markdownToDoc, docToMarkdown } from "./markdown"
import { clamp, type EditorHandle } from "./constants"
import type { TagsWikilinksCallbacks } from "./tags-wikilinks"
import { BubbleToolbar } from "./BubbleToolbar"
import { BlockHandles } from "./BlockHandles"

interface TiptapEditorProps {
  value: string
  onChange: (value: string) => void
  editorRef?: React.RefObject<EditorHandle>
  placeholder?: string
  editable?: boolean
  onTagClick?: (tag: string) => void
  onWikiLinkClick?: (target: string) => void
}

interface MenuState {
  open: boolean
  left: number
  top: number
}

const MENU_WIDTH = 290
const MENU_HEIGHT = 44

// Shared rich-text editor used by both Live (editable) and Read (editable=false)
// modes. Markdown is the source of truth: `value` is parsed on the way in and
// re-serialized on every update.
export function TiptapEditor({
  value,
  onChange,
  editorRef,
  placeholder = "Начни писать...",
  editable = true,
  onTagClick,
  onWikiLinkClick,
}: TiptapEditorProps) {
  const valueRef = React.useRef(value)
  const onChangeRef = React.useRef(onChange)
  const callbacksRef = React.useRef<TagsWikilinksCallbacks>({ onTagClick, onWikiLinkClick })
  const [menu, setMenu] = React.useState<MenuState>({ open: false, left: 0, top: 0 })

  React.useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  React.useEffect(() => {
    callbacksRef.current = { onTagClick, onWikiLinkClick }
  }, [onTagClick, onWikiLinkClick])

  const extensions = React.useMemo(
    () => buildExtensions({ placeholder, callbacks: callbacksRef }),
    // placeholder is effectively static per mount; callbacks flow through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const closeMenu = React.useCallback(() => {
    setMenu(prev => (prev.open ? { ...prev, open: false } : prev))
  }, [])

  const editor = useEditor({
    editable,
    extensions,
    content: markdownToDoc(value),
    editorProps: {
      attributes: { class: "amby-tiptap-prose" },
    },
    onUpdate: ({ editor }) => {
      const markdown = docToMarkdown(editor.state.doc)
      if (markdown === valueRef.current) return
      valueRef.current = markdown
      onChangeRef.current(markdown)
    },
    onSelectionUpdate: ({ editor }) => {
      if (!editor.isEditable) return
      const { from, to, empty } = editor.state.selection
      if (empty) {
        closeMenu()
        return
      }
      const start = editor.view.coordsAtPos(from)
      const end = editor.view.coordsAtPos(to)
      const left = clamp(
        (start.left + end.right) / 2 - MENU_WIDTH / 2,
        8,
        window.innerWidth - MENU_WIDTH - 8
      )
      const below = Math.max(start.bottom, end.bottom) + 10
      const above = Math.min(start.top, end.top) - MENU_HEIGHT - 6
      // Prefer below; fall back to above if there is not enough room
      const top =
        below + MENU_HEIGHT < window.innerHeight - 8
          ? below
          : clamp(above, 8, window.innerHeight - MENU_HEIGHT - 8)
      setMenu({ open: true, left, top })
    },
    onBlur: () => {
      window.setTimeout(() => {
        // Don't close if focus moved into the floating bubble toolbar (e.g. an
        // input field for tag / link / wikilink panels).
        const floatingMenu = document.querySelector(".amby-floating-menu")
        if (floatingMenu?.contains(document.activeElement)) return
        closeMenu()
      }, 180)
    },
  })

  // Sync external `value` changes (e.g. switching tabs reuses the instance only
  // within a document; here it guards against parent-driven content resets).
  React.useEffect(() => {
    if (!editor) return
    if (value === valueRef.current) return
    valueRef.current = value
    editor.commands.setContent(markdownToDoc(value), { emitUpdate: false })
  }, [value, editor])

  // Toggle Live <-> Read in place without re-instantiating the editor.
  React.useEffect(() => {
    if (!editor) return
    if (editor.isEditable !== editable) editor.setEditable(editable)
    if (!editable) closeMenu()
  }, [editable, editor, closeMenu])

  // Expose undo/redo to the parent's floating widget.
  React.useEffect(() => {
    if (!editorRef || !editor) return
    ;(editorRef as React.MutableRefObject<EditorHandle>).current = {
      undo: () => editor.chain().focus().undo().run(),
      redo: () => editor.chain().focus().redo().run(),
    }
  }, [editor, editorRef])

  return (
    <div className="amby-tiptap relative min-h-[360px] pb-24">
      {editor && editable && menu.open && (
        <BubbleToolbar editor={editor} left={menu.left} top={menu.top} />
      )}
      {editor && editable && <BlockHandles editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  )
}
