"use client"

import * as React from "react"
import i18n from "@/lib/i18n"
import { EditorContent, useEditor, type Editor } from "@tiptap/react"

import { buildExtensions } from "./extensions"
import { markdownToDoc, docToMarkdown, restoreSourceFormatting } from "./markdown"
import { clamp, type EditorHandle } from "./constants"
import {
  docSelectionToMarkdownSelection,
  markdownSelectionToDocSelection,
  type MarkdownSelection,
} from "./markdown-selection"
import {
  WIKILINK_CONTEXT_EVENT,
  type TagsWikilinksCallbacks,
  type WikiLinkContextDetail,
} from "./tags-wikilinks"
import { BubbleToolbar } from "./BubbleToolbar"
import { BlockHandles } from "./BlockHandles"
import { BlockInsertPanel } from "./BlockInsertPanel"
import { WikiLinkContextMenu } from "./WikiLinkContextMenu"
import { primeAssetConverter, setAssetContext } from "./asset-resolver"
import { setTransclusionFetcher } from "./transclusion-context"
import { bindTauriFileDrop } from "./media-drop"
import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "./floating-menu-events"
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
  resolveWikiLinkTarget?: (target: string) => string | null
  vaultPath?: string
  notePath?: string
  /** Resolve a wiki-link target to its markdown content for transclusion embeds. */
  fetchTransclusion?: (target: string) => Promise<string | null>
  selection?: MarkdownSelection | null
  onSelectionChange?: (selection: MarkdownSelection) => void
  /** Read uses the same Tiptap instance but must not inherit Live layout styles. */
  isReadOnly?: boolean
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
  resolveWikiLinkTarget,
  vaultPath,
  notePath,
  fetchTransclusion,
  selection,
  onSelectionChange,
  isReadOnly = false,
}: TiptapEditorProps) {
  const valueRef = React.useRef(value)
  const originalValueRef = React.useRef(value)
  const onChangeRef = React.useRef(onChange)
  const onSelectionChangeRef = React.useRef(onSelectionChange)
  const restoredSelectionRef = React.useRef(false)
  const suppressSelectionMenuRef = React.useRef(false)
  const callbacksRef = React.useRef<TagsWikilinksCallbacks>({
    onTagClick,
    onWikiLinkClick,
    resolveWikiLinkTarget,
  })
  const serializeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const documentDirtyRef = React.useRef(false)
  const [menu, setMenu] = React.useState<MenuState>({ open: false, left: 0, top: 0 })
  const [wikiLinkContext, setWikiLinkContext] = React.useState<WikiLinkContextDetail | null>(null)

  // docToMarkdown is O(doc size); running it on every keystroke lags large notes.
  // Debounce it, and flush on blur/unmount so the save path never loses edits.
  const flushSerialize = React.useCallback((ed: Editor) => {
    if (serializeTimerRef.current) {
      clearTimeout(serializeTimerRef.current)
      serializeTimerRef.current = null
    }
    // Source/Live switches and React Fast Refresh both unmount this component.
    // Serializing an untouched editor during those transitions can persist a
    // transient ProseMirror document and repeatedly materialise blank blocks.
    // Only a real editor update authorises a Markdown write.
    if (!documentDirtyRef.current) return
    if (ed.isDestroyed) return
    const markdown = restoreSourceFormatting(docToMarkdown(ed.state.doc), originalValueRef.current)
    documentDirtyRef.current = false
    if (markdown === valueRef.current) return
    valueRef.current = markdown
    onChangeRef.current(markdown)
  }, [])

  React.useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  React.useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange
  }, [onSelectionChange])

  React.useEffect(() => {
    callbacksRef.current = { onTagClick, onWikiLinkClick, resolveWikiLinkTarget }
  }, [onTagClick, onWikiLinkClick, resolveWikiLinkTarget])

  const extensions = React.useMemo(
    () =>
      buildExtensions({
        placeholder,
        callbacks: callbacksRef,
      }),
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
      documentDirtyRef.current = true
      if (serializeTimerRef.current) clearTimeout(serializeTimerRef.current)
      serializeTimerRef.current = setTimeout(() => flushSerialize(editor), 200)
    },
    onSelectionUpdate: ({ editor }) => {
      onSelectionChangeRef.current?.(
        docSelectionToMarkdownSelection(editor.state.doc, valueRef.current, editor.state.selection),
      )
      if (!editor.isEditable) return
      if (suppressSelectionMenuRef.current) {
        closeMenu()
        return
      }
      const { from, to, empty } = editor.state.selection
      if (empty) {
        closeMenu()
        return
      }
      window.dispatchEvent(new Event(CLOSE_BLOCK_MENUS_EVENT))
      setWikiLinkContext(null)
      closeSlashMenu(editor)
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

  React.useEffect(() => {
    const onContextMenu = (event: Event) => {
      const detail = (event as CustomEvent<WikiLinkContextDetail>).detail
      if (!detail) return
      window.dispatchEvent(new Event(CLOSE_BLOCK_MENUS_EVENT))
      if (editor) closeSlashMenu(editor)
      closeMenu()
      setWikiLinkContext(detail)
    }
    window.addEventListener(WIKILINK_CONTEXT_EVENT, onContextMenu)
    return () => window.removeEventListener(WIKILINK_CONTEXT_EVENT, onContextMenu)
  }, [closeMenu, editor])

  // Sync external `value` changes (e.g. switching tabs reuses the instance only
  // within a document; here it guards against parent-driven content resets).
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (value === valueRef.current) return
    documentDirtyRef.current = false
    if (serializeTimerRef.current) {
      clearTimeout(serializeTimerRef.current)
      serializeTimerRef.current = null
    }
    valueRef.current = value
    originalValueRef.current = value
    editor.commands.setContent(markdownToDoc(value), { emitUpdate: false })
  }, [value, editor])

  // A Source <-> Live transition remounts the editor. Restore the source
  // offset once, after parsing, without feeding a selection transaction back
  // through the document or its undo history.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed || restoredSelectionRef.current) return
    restoredSelectionRef.current = true
    const mapped = markdownSelectionToDocSelection(editor.state.doc, value, selection)
    if (!mapped) return
    editor.commands.setTextSelection(mapped)
  }, [editor, selection, value])

  // Flush any pending serialization before this editor instance goes away
  // (document switch, view-mode toggle, tab close) so the latest edit is saved.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    return () => flushSerialize(editor)
  }, [editor, flushSerialize])

  // Toggle Live <-> Read in place without re-instantiating the editor.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
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
    if (!editor || editor.isDestroyed || !fetchTransclusion) return
    setTransclusionFetcher(editor, fetchTransclusion)
  }, [editor, fetchTransclusion])

  React.useEffect(() => {
    void primeAssetConverter()
  }, [])

  React.useEffect(() => {
    if (!editor || editor.isDestroyed || !editable) return
    let dispose: (() => void) | undefined
    let cancelled = false
    const view = editor.view
    void bindTauriFileDrop(view, (clientX, clientY) => {
      if (editor.isDestroyed) return null
      const rect = view.dom.getBoundingClientRect()
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        return null
      }
      const coords = view.posAtCoords({ left: clientX, top: clientY })
      return coords?.pos ?? null
    }).then((unsub) => {
      if (cancelled) unsub()
      else dispose = unsub
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [editor, editable])

  // ── Slash-trigger subscription: render a single BlockInsertPanel when the
  // SlashMenu extension publishes state to editor.storage.slashMenu. ─────────
  const [slashState, setSlashState] = React.useState<SlashTriggerState | null>(null)
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const read = () => {
      if (editor.isDestroyed) return
      const s = readSlashStorage(editor)
      if (!s) {
        setSlashState(null)
        return
      }
      if (s.open) {
        window.dispatchEvent(new Event(CLOSE_BLOCK_MENUS_EVENT))
        closeMenu()
        setWikiLinkContext(null)
      }
      // Snapshot so React diff fires.
      setSlashState({ ...s })
    }
    read()
    window.addEventListener(SLASH_TRIGGER_EVENT, read)
    return () => window.removeEventListener(SLASH_TRIGGER_EVENT, read)
  }, [closeMenu, editor])

  React.useEffect(() => {
    const closeEditorMenus = () => {
      suppressSelectionMenuRef.current = true
      closeMenu()
      setWikiLinkContext(null)
      if (editor && !editor.isDestroyed) closeSlashMenu(editor)
    }
    window.addEventListener(CLOSE_EDITOR_MENUS_EVENT, closeEditorMenus)
    return () => window.removeEventListener(CLOSE_EDITOR_MENUS_EVENT, closeEditorMenus)
  }, [closeMenu, editor])

  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const editorDom = editor.view.dom
    const resetSelectionMenuSuppression = (event: MouseEvent) => {
      // A normal primary click begins a new text interaction. Ctrl+click on
      // macOS is reserved for the block context menu and must stay suppressed.
      if (event.button === 0 && !event.ctrlKey) suppressSelectionMenuRef.current = false
    }
    editorDom.addEventListener("mousedown", resetSelectionMenuSuppression, true)
    return () => editorDom.removeEventListener("mousedown", resetSelectionMenuSuppression, true)
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
    <div
      className="amby-tiptap relative min-h-[360px] pb-24"
      data-editor-readonly={isReadOnly ? "true" : "false"}
    >
      {editor && editable && menu.open && (
        <BubbleToolbar editor={editor} left={menu.left} top={menu.top} />
      )}
      {editor && editable && !isReadOnly && (
        <BlockHandles editor={editor} vaultPath={vaultPath} notePath={notePath} />
      )}
      <EditorContent editor={editor} />
      {editor && (
        <WikiLinkContextMenu
          editor={editor}
          context={wikiLinkContext}
          onNavigate={(raw) => {
            setWikiLinkContext(null)
            onWikiLinkClick?.(raw)
          }}
          onClose={() => setWikiLinkContext(null)}
        />
      )}
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
