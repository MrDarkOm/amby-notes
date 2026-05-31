"use client"

import * as React from "react"
import i18n from "@/lib/i18n"
import { EditorContent, useEditor, type Editor } from "@tiptap/react"

import { buildExtensions } from "./extensions"
import { markdownToDoc, docToMarkdown } from "./markdown"
import { clamp, type EditorHandle } from "./constants"
import type { TagsWikilinksCallbacks } from "./tags-wikilinks"
import { BubbleToolbar } from "./BubbleToolbar"
import { BlockHandles } from "./BlockHandles"
import { BlockInsertPanel } from "./BlockInsertPanel"
import { primeAssetConverter, setAssetContext } from "./asset-resolver"
import { setTransclusionFetcher } from "./transclusion-context"
import { bindTauriFileDrop } from "./media-drop"
import {
  SLASH_TRIGGER_EVENT,
  closeSlashMenu,
  readSlashStorage,
  type SlashTriggerState,
} from "./slash-menu"

interface TiptapEditorProps {
  value: string
  onChange: (value: string) => void
  editorRef?: React.RefObject<EditorHandle>
  placeholder?: string
  editable?: boolean
  onTagClick?: (tag: string) => void
  onWikiLinkClick?: (target: string) => void
  vaultPath?: string
  notePath?: string
  /** Resolve a wiki-link target to its markdown content for transclusion embeds. */
  fetchTransclusion?: (target: string) => Promise<string | null>
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
  placeholder = i18n.t("editor.placeholder"),
  editable = true,
  onTagClick,
  onWikiLinkClick,
  vaultPath,
  notePath,
  fetchTransclusion,
}: TiptapEditorProps) {
  const valueRef = React.useRef(value)
  const onChangeRef = React.useRef(onChange)
  const callbacksRef = React.useRef<TagsWikilinksCallbacks>({ onTagClick, onWikiLinkClick })
  const serializeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [menu, setMenu] = React.useState<MenuState>({ open: false, left: 0, top: 0 })

  // docToMarkdown is O(doc size); running it on every keystroke lags large notes.
  // Debounce it, and flush on blur/unmount so the save path never loses edits.
  const flushSerialize = React.useCallback((ed: Editor) => {
    if (serializeTimerRef.current) {
      clearTimeout(serializeTimerRef.current)
      serializeTimerRef.current = null
    }
    const markdown = docToMarkdown(ed.state.doc)
    if (markdown === valueRef.current) return
    valueRef.current = markdown
    onChangeRef.current(markdown)
  }, [])

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
    [],
  )

  const closeMenu = React.useCallback(() => {
    setMenu((prev) => (prev.open ? { ...prev, open: false } : prev))
  }, [])

  const editor = useEditor({
    editable,
    extensions,
    content: markdownToDoc(value),
    editorProps: {
      attributes: { class: "amby-tiptap-prose" },
    },
    onUpdate: ({ editor }) => {
      if (serializeTimerRef.current) clearTimeout(serializeTimerRef.current)
      serializeTimerRef.current = setTimeout(() => flushSerialize(editor), 200)
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
        window.innerWidth - MENU_WIDTH - 8,
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
    onBlur: ({ editor }) => {
      flushSerialize(editor)
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

  // Flush any pending serialization before this editor instance goes away
  // (document switch, view-mode toggle, tab close) so the latest edit is saved.
  React.useEffect(() => {
    if (!editor) return
    return () => flushSerialize(editor)
  }, [editor, flushSerialize])

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

  // Make vault/note paths reachable from inside extensions/node views.
  React.useEffect(() => {
    if (!editor) return
    setAssetContext(editor, { vaultPath: vaultPath ?? "", notePath: notePath ?? "" })
  }, [editor, vaultPath, notePath])

  // Register the transclusion content fetcher so TransclusionNode NodeViews can
  // resolve note content without prop-drilling through the extension system.
  React.useEffect(() => {
    if (!editor || !fetchTransclusion) return
    setTransclusionFetcher(editor, fetchTransclusion)
  }, [editor, fetchTransclusion])

  React.useEffect(() => {
    void primeAssetConverter()
  }, [])

  React.useEffect(() => {
    if (!editor || !editable) return
    let dispose: (() => void) | undefined
    void bindTauriFileDrop(editor.view, (clientX, clientY) => {
      const coords = editor.view.posAtCoords({ left: clientX, top: clientY })
      return coords?.pos ?? null
    }).then((unsub) => {
      dispose = unsub
    })
    return () => {
      dispose?.()
    }
  }, [editor, editable])

  // ── Slash-trigger subscription: render a single BlockInsertPanel when the
  // SlashMenu extension publishes state to editor.storage.slashMenu. ─────────
  const [slashState, setSlashState] = React.useState<SlashTriggerState | null>(null)
  React.useEffect(() => {
    if (!editor) return
    const read = () => {
      const s = readSlashStorage(editor)
      if (!s) {
        setSlashState(null)
        return
      }
      // Snapshot so React diff fires.
      setSlashState({ ...s })
    }
    read()
    window.addEventListener(SLASH_TRIGGER_EVENT, read)
    return () => window.removeEventListener(SLASH_TRIGGER_EVENT, read)
  }, [editor])

  const slashAnchor = React.useMemo(() => {
    const r = slashState?.rect
    if (!r) return null
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    }
  }, [slashState])

  return (
    <div className="amby-tiptap relative min-h-[360px] pb-24">
      {editor && editable && menu.open && (
        <BubbleToolbar editor={editor} left={menu.left} top={menu.top} />
      )}
      {editor && editable && (
        <BlockHandles editor={editor} vaultPath={vaultPath} notePath={notePath} />
      )}
      <EditorContent editor={editor} />
      {editor && editable && slashState?.open && slashState.range && slashAnchor && (
        <BlockInsertPanel
          editor={editor}
          vaultPath={vaultPath}
          notePath={notePath}
          source="slash"
          range={slashState.range}
          anchorRect={slashAnchor}
          onClose={() => closeSlashMenu(editor)}
        />
      )}
    </div>
  )
}
