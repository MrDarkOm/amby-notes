"use client"

import { NodeSelection } from "@tiptap/pm/state"
import * as React from "react"
import { createPortal } from "react-dom"
import { Link2Off } from "lucide-react"
import i18n from "@/lib/i18n"
import { EditorContent, useEditor, type Editor } from "@tiptap/react"

import { buildExtensions } from "./extensions"
import { requestSourceRewriteSnapshot } from "../autosave/source-rewrite"
import { composeMarkdown, markdownToDoc, restoreSourceFormatting } from "./markdown"
import { clamp, type EditorHandle } from "./constants"
import {
  docSelectionToMarkdownSelection,
  markdownSelectionToDocSelection,
  type MarkdownSelection,
} from "./markdown-selection"
import {
  WIKILINK_CONTEXT_EVENT,
  inlineTokenRange,
  type TagsWikilinksCallbacks,
  type WikiLinkContextDetail,
} from "./tags-wikilinks"
import { BubbleToolbar } from "./BubbleToolbar"
import { ImageToolbar } from "./ImageToolbar"
import { ImageCropHost, type CropRequest } from "./ImageCropDialog"
import { ImageLightbox } from "./ImageLightbox"
import { collectPictures, type LightboxPicture } from "./image-gallery"
import { CROP_IMAGE_EVENT, OPEN_IMAGE_VIEWER_EVENT } from "./image-commands"
import { attachmentKind, localFileKind } from "./attachment-kind"
import { TextSelection } from "@tiptap/pm/state"
import { selectEndOfNote } from "./line-after-block"
import { isClickInInterlineGap, nearestLinePos } from "./nearest-line"
import { isImageLinePos } from "./image-line"
import { BlockHandles } from "./BlockHandles"
import { BlockInsertPanel } from "./BlockInsertPanel"
import { WikiLinkContextMenu } from "./WikiLinkContextMenu"
import { primeAssetConverter, setAssetContext } from "./asset-resolver"
import { setTransclusionFetcher } from "./transclusion-context"
import { bindTauriFileDrop, getTauriDropPosForView } from "./media-drop"
import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "./floating-menu-events"
import { registerEditorSerialization } from "./editor-serialization-lifecycle"
import { OPEN_LINK_PANEL_EVENT } from "./block-shortcuts"
import { InlineSuggestPanel } from "./InlineSuggestPanel"
import { dismissInlineSuggest } from "./inline-suggest"
import { FindBar } from "./FindBar"
import { TableControls } from "./TableControls"
import { OPEN_FIND_EVENT } from "./find-in-note"
import {
  SLASH_TRIGGER_EVENT,
  dismissSlashMenu,
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
  noteId?: string
  /** Resolve a wiki-link target to its markdown content for transclusion embeds. */
  fetchTransclusion?: (target: string) => Promise<string | null>
  selection?: MarkdownSelection | null
  onSelectionChange?: (selection: MarkdownSelection) => void
  /** Read uses the same Tiptap instance but must not inherit Live layout styles. */
  isReadOnly?: boolean
  onContentDirty?: () => void
  onContentClean?: () => void
}

interface MenuState {
  open: boolean
  /**
   * The left and right edge of what the toolbar belongs to (the selection, or the picture): the
   * toolbar starts at the left edge, or ends at the right edge when it would run out of the
   * window.
   */
  left: number
  right: number
  top: number
  /** What the toolbar belongs to has scrolled out of sight: the toolbar is kept but not shown. */
  hidden?: boolean
  /** The toolbar of a selected picture, not the text toolbar. */
  image?: boolean
  /** Set when the toolbar was called for its link panel; a new value reopens it. */
  linkRequest?: number
}

interface InlineUnlinkState {
  from: number
  to: number
  /** The token as it is written in the note; checked again before it is replaced. */
  source: string
  replacement: string
  left: number
  top: number
}

const MENU_HEIGHT = 44

/** The box of the picture drawn by a node (its wrapper, not the inline box around it). */
function pictureBox(dom: HTMLElement): DOMRect {
  return (dom.querySelector(".amby-image-wrap") ?? dom).getBoundingClientRect()
}

/** Where the toolbar of a picture with this box goes: as for text, under it, or above it with no room. */
function pictureMenuPlacement(rect: DOMRect) {
  return { left: rect.left, right: rect.right, top: menuTop(rect.top, rect.bottom, MENU_HEIGHT) }
}

/** The box in which the note scrolls: what is outside it is not on screen. */
function visibleBounds(editorDom: HTMLElement): { top: number; bottom: number } {
  for (let node = editorDom.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) {
      const rect = node.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom }
    }
  }
  return { top: 0, bottom: window.innerHeight }
}

/**
 * Where a toolbar of `height` goes for a selection spanning `selectionTop`..`selectionBottom`:
 * under it, or above it when there is no room under it (the text is at the bottom of the window).
 */
function menuTop(selectionTop: number, selectionBottom: number, height: number): number {
  const below = selectionBottom + 8
  if (below + height + 8 <= window.innerHeight) return below
  return Math.max(8, selectionTop - height - 8)
}

// Shared rich-text editor used by both Live (editable) and Read (editable=false)
// modes. Markdown is the source of truth: `value` is parsed on the way in and
// re-serialized on every update.
/** How far a press may move and still count as a click, in pixels. */
const DRAG_DISTANCE = 4

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
  noteId,
  fetchTransclusion,
  selection,
  onSelectionChange,
  isReadOnly = false,
  onContentDirty,
  onContentClean,
}: TiptapEditorProps) {
  const valueRef = React.useRef(value)
  const originalValueRef = React.useRef(value)
  const onChangeRef = React.useRef(onChange)
  const onContentDirtyRef = React.useRef(onContentDirty)
  const onContentCleanRef = React.useRef(onContentClean)
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
  const noteIdRef = React.useRef(noteId)
  // One request per loaded text: the first save that may rewrite a block's source.
  const rewriteSnapshotRequestedRef = React.useRef(false)
  const userInteractedRef = React.useRef(false)
  const [menu, setMenu] = React.useState<MenuState>({ open: false, left: 0, right: 0, top: 0 })
  const [cropRequest, setCropRequest] = React.useState<CropRequest | null>(null)
  const [lightbox, setLightbox] = React.useState<{
    pictures: LightboxPicture[]
    start: number
  } | null>(null)
  const [wikiLinkContext, setWikiLinkContext] = React.useState<WikiLinkContextDetail | null>(null)
  const [inlineUnlink, setInlineUnlink] = React.useState<InlineUnlinkState | null>(null)
  const unlinkCloseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // Serializing is O(doc size); running it on every keystroke lags large notes.
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
    const composed = composeMarkdown(ed.state.doc)
    const markdown = restoreSourceFormatting(composed.markdown, originalValueRef.current)
    documentDirtyRef.current = false
    if (markdown === valueRef.current) {
      onContentCleanRef.current?.()
      return
    }
    // The note holds text the editor would spell differently, and this edit may be the
    // one that rewrites it: the file being replaced must stay recoverable from history.
    if (composed.mayRewriteSource && noteIdRef.current && !rewriteSnapshotRequestedRef.current) {
      rewriteSnapshotRequestedRef.current = true
      requestSourceRewriteSnapshot(noteIdRef.current)
    }
    valueRef.current = markdown
    originalValueRef.current = markdown
    onChangeRef.current(markdown)
  }, [])

  React.useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  React.useEffect(() => {
    noteIdRef.current = noteId
  }, [noteId])

  React.useEffect(() => {
    onContentDirtyRef.current = onContentDirty
  }, [onContentDirty])

  React.useEffect(() => {
    onContentCleanRef.current = onContentClean
  }, [onContentClean])

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
  // Parsing Markdown is proportional to the whole note size. The component is
  // kept mounted per document, so only parse its initial value once; external
  // content replacements are handled by the guarded effect below. Passing
  // markdownToDoc(value) inline to useEditor made every parent render parse a
  // large note again, including a simple tab activation.
  const [initialContent] = React.useState(() => markdownToDoc(value))
  // useEditor compares option references on every React render. An inline
  // editorProps object reapplies DOM props and editor state even when only
  // autosave metadata changed. Leave the focused editor DOM untouched.
  const editorProps = React.useMemo(() => ({ attributes: { class: "amby-tiptap-prose" } }), [])

  const pointerSelectingRef = React.useRef(false)
  const selectionSettleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const closeMenu = React.useCallback(() => {
    if (selectionSettleTimerRef.current) {
      clearTimeout(selectionSettleTimerRef.current)
      selectionSettleTimerRef.current = null
    }
    setMenu((prev) => (prev.open ? { ...prev, open: false } : prev))
  }, [])

  const computeSelectionAnchor = React.useCallback((ed: Editor) => {
    const sel = typeof window !== "undefined" ? window.getSelection() : null
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed && ed.view.dom.contains(sel.anchorNode)) {
      const rects = Array.from(sel.getRangeAt(0).getClientRects()).filter(
        (r) => r.width > 0 && r.height > 0,
      )
      if (rects.length > 0) {
        const minLeft = Math.min(...rects.map((r) => r.left))
        const maxRight = Math.max(...rects.map((r) => r.right))
        const minTop = Math.min(...rects.map((r) => r.top))
        const maxBottom = Math.max(...rects.map((r) => r.bottom))
        return {
          left: minLeft,
          right: maxRight,
          top: minTop,
          bottom: maxBottom,
        }
      }
    }
    const { from, to } = ed.state.selection
    const start = ed.view.coordsAtPos(from)
    const end = ed.view.coordsAtPos(to)
    return {
      left: Math.min(start.left, end.left),
      right: Math.max(start.right, end.right),
      top: Math.min(start.top, end.top),
      bottom: Math.max(start.bottom, end.bottom),
    }
  }, [])

  const openSelectionMenu = React.useCallback(
    (ed: Editor) => {
      if (ed.isDestroyed || !ed.isEditable) return
      const { empty } = ed.state.selection
      const selection = ed.state.selection
      if (
        empty ||
        (selection instanceof NodeSelection && selection.node.type.name === "ambyBlock")
      ) {
        closeMenu()
        return
      }
      window.dispatchEvent(new Event(CLOSE_BLOCK_MENUS_EVENT))
      setWikiLinkContext(null)
      dismissSlashMenu(ed)
      // A selected picture has its own toolbar, above the picture; a player or a card
      // drawn from an image node has no text to format and no picture to copy.
      if (selection instanceof NodeSelection && selection.node.type.name === "image") {
        const src = selection.node.attrs.src as string | null
        const dom = ed.view.nodeDOM(selection.from)
        if (attachmentKind(src) || localFileKind(src) || !(dom instanceof HTMLElement)) {
          closeMenu()
          return
        }
        setMenu({ open: true, image: true, ...pictureMenuPlacement(pictureBox(dom)) })
        return
      }
      const { left, right, top: selectionTop, bottom } = computeSelectionAnchor(ed)
      const top = menuTop(selectionTop, bottom, MENU_HEIGHT)
      setMenu((prev) => ({
        open: true,
        left,
        right,
        top,
        linkRequest: prev.open && !prev.image ? prev.linkRequest : undefined,
      }))
    },
    [closeMenu, computeSelectionAnchor],
  )

  const editor = useEditor({
    editable,
    extensions,
    content: initialContent,
    onCreate: ({ editor }) => {
      // Make the asset context available before image NodeViews paint. The
      // effect below still handles vault/note changes for a mounted editor.
      setAssetContext(editor, { vaultPath: vaultPath ?? "", notePath: notePath ?? "", noteId })
    },
    editorProps,
    onTransaction: ({ transaction }) => {
      if (transaction.getMeta("uiEvent") || transaction.getMeta("pointer")) {
        userInteractedRef.current = true
      }
    },
    onUpdate: ({ editor, transaction }) => {
      const isUserAction =
        userInteractedRef.current ||
        Boolean(transaction.getMeta("uiEvent") || transaction.getMeta("pointer"))
      if (!isUserAction) return
      documentDirtyRef.current = true
      onContentDirtyRef.current?.()
      if (serializeTimerRef.current) clearTimeout(serializeTimerRef.current)
      serializeTimerRef.current = setTimeout(() => flushSerialize(editor), 200)
    },
    onSelectionUpdate: ({ editor }) => {
      if (!editor.isEditable) return
      if (suppressSelectionMenuRef.current) {
        closeMenu()
        return
      }
      const { empty } = editor.state.selection
      const selection = editor.state.selection
      // A selected database block has no text to format.
      if (
        empty ||
        (selection instanceof NodeSelection && selection.node.type.name === "ambyBlock")
      ) {
        closeMenu()
        return
      }
      // While dragging the pointer to select text, wait until pointerup before showing the toolbar.
      if (pointerSelectingRef.current) {
        return
      }
      if (selectionSettleTimerRef.current) {
        clearTimeout(selectionSettleTimerRef.current)
      }
      selectionSettleTimerRef.current = setTimeout(() => {
        selectionSettleTimerRef.current = null
        openSelectionMenu(editor)
      }, 160)
    },
    onBlur: ({ editor }) => {
      flushSerialize(editor)
      setInlineUnlink(null)
      window.setTimeout(() => {
        // Don't close if focus moved into the floating bubble toolbar (e.g. an
        // input field for tag / link / wikilink panels).
        const floatingMenu = document.querySelector(".amby-floating-menu")
        if (floatingMenu?.contains(document.activeElement)) return
        // The focus came back (a field of the toolbar handed it over): the menu stays.
        if (!editor.isDestroyed && editor.view.hasFocus()) return
        closeMenu()
      }, 180)
    },
  })

  React.useEffect(() => {
    const onContextMenu = (event: Event) => {
      const detail = (event as CustomEvent<WikiLinkContextDetail>).detail
      if (!detail) return
      window.dispatchEvent(new Event(CLOSE_BLOCK_MENUS_EVENT))
      if (editor) dismissSlashMenu(editor)
      closeMenu()
      setWikiLinkContext(detail)
    }
    window.addEventListener(WIKILINK_CONTEXT_EVENT, onContextMenu)
    return () => window.removeEventListener(WIKILINK_CONTEXT_EVENT, onContextMenu)
  }, [closeMenu, editor])

  // The viewer and the crop dialog of a picture are opened by the toolbar of a selected picture
  // and by the block menu of its line, through events on the editor.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const dom = editor.view.dom
    const onViewer = (event: Event) => {
      const { pos } = (event as CustomEvent<{ pos: number }>).detail
      const { pictures, index } = collectPictures(editor, pos)
      closeMenu()
      if (pictures.length > 0) setLightbox({ pictures, start: index })
    }
    const onCrop = (event: Event) => {
      closeMenu()
      setCropRequest((event as CustomEvent<CropRequest>).detail)
    }
    dom.addEventListener(OPEN_IMAGE_VIEWER_EVENT, onViewer)
    dom.addEventListener(CROP_IMAGE_EVENT, onCrop)
    return () => {
      dom.removeEventListener(OPEN_IMAGE_VIEWER_EVENT, onViewer)
      dom.removeEventListener(CROP_IMAGE_EVENT, onCrop)
    }
  }, [closeMenu, editor])

  // The toolbar is fixed to the window, so it follows what it belongs to when the note scrolls
  // (or the window changes), and is not shown while that is out of sight.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed || !menu.open) return
    let frame = 0
    const follow = () => {
      frame = 0
      if (editor.isDestroyed) return
      const selection = editor.state.selection
      let placement: { left: number; right: number; top: number }
      let anchorTop: number
      let anchorBottom: number
      if (selection instanceof NodeSelection && selection.node.type.name === "image") {
        const dom = editor.view.nodeDOM(selection.from)
        if (!(dom instanceof HTMLElement)) return
        const rect = pictureBox(dom)
        placement = pictureMenuPlacement(rect)
        anchorTop = rect.top
        anchorBottom = rect.bottom
      } else {
        const anchor = computeSelectionAnchor(editor)
        placement = {
          left: anchor.left,
          right: anchor.right,
          top: menuTop(anchor.top, anchor.bottom, MENU_HEIGHT),
        }
        anchorTop = anchor.top
        anchorBottom = anchor.bottom
      }
      const bounds = visibleBounds(editor.view.dom)
      const hidden = anchorBottom < bounds.top || anchorTop > bounds.bottom
      setMenu((prev) =>
        prev.left === placement.left &&
        prev.right === placement.right &&
        prev.top === placement.top &&
        Boolean(prev.hidden) === hidden
          ? prev
          : { ...prev, ...placement, hidden },
      )
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(follow)
    }
    window.addEventListener("scroll", schedule, true)
    window.addEventListener("resize", schedule)
    return () => {
      window.removeEventListener("scroll", schedule, true)
      window.removeEventListener("resize", schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [computeSelectionAnchor, editor, menu.open])

  // Mod-K: the toolbar opens on its link panel, also when nothing is selected. The cursor
  // inside a link selects that link, so the panel edits it.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const editorDom = editor.view.dom
    const openLinkPanel = () => {
      if (!editor.isEditable) return
      if (editor.state.selection.empty && editor.isActive("link")) {
        editor.commands.extendMarkRange("link")
      }
      window.dispatchEvent(new Event(CLOSE_BLOCK_MENUS_EVENT))
      setWikiLinkContext(null)
      dismissSlashMenu(editor)
      const { left, right, top: selectionTop, bottom } = computeSelectionAnchor(editor)
      const top = menuTop(selectionTop, bottom, MENU_HEIGHT)
      setMenu((prev) => ({
        open: true,
        left,
        right,
        top,
        linkRequest: (prev.linkRequest ?? 0) + 1,
      }))
    }
    editorDom.addEventListener(OPEN_LINK_PANEL_EVENT, openLinkPanel)
    return () => editorDom.removeEventListener(OPEN_LINK_PANEL_EVENT, openLinkPanel)
  }, [computeSelectionAnchor, editor])

  // Find in note (Mod-F), in Live and in Read. The selected text, when it is on one line,
  // is what the bar starts with.
  const [find, setFind] = React.useState<{ request: number; query: string } | null>(null)
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const openFind = React.useCallback(() => {
    if (!editor || editor.isDestroyed) return
    const { from, to } = editor.state.selection
    const selected = editor.state.doc.textBetween(from, to, "\n")
    const query = selected && !selected.includes("\n") ? selected : ""
    setFind((prev) => ({ request: (prev?.request ?? 0) + 1, query: query || (prev?.query ?? "") }))
  }, [editor])
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const editorDom = editor.view.dom
    editorDom.addEventListener(OPEN_FIND_EVENT, openFind)
    // The same key when the focus is not in the text: nowhere, or elsewhere in this
    // editor. Another editor or a field that has the focus keeps the key for itself.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return
      const wrapper = wrapperRef.current
      if (!wrapper || wrapper.offsetParent === null) return
      const target = event.target instanceof Element ? event.target : null
      const inside = Boolean(target && wrapper.contains(target))
      const elsewhere = target?.closest(
        "input, textarea, select, [contenteditable=true], .cm-editor, .amby-tiptap",
      )
      if (!inside && elsewhere) return
      // With the focus nowhere, the first editor on screen answers (tabs in the
      // background stay mounted but are not displayed).
      const onScreen = Array.from(document.querySelectorAll<HTMLElement>(".amby-tiptap")).find(
        (element) => element.offsetParent !== null,
      )
      if (!inside && onScreen !== wrapper) return
      event.preventDefault()
      openFind()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      editorDom.removeEventListener(OPEN_FIND_EVENT, openFind)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [editor, openFind])

  // Sync external `value` changes when a mounted tab changes its document
  // (history navigation) or a parent-driven content reset arrives.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (value === valueRef.current) return
    userInteractedRef.current = false
    documentDirtyRef.current = false
    if (serializeTimerRef.current) {
      clearTimeout(serializeTimerRef.current)
      serializeTimerRef.current = null
    }
    valueRef.current = value
    originalValueRef.current = value
    rewriteSnapshotRequestedRef.current = false
    setInlineUnlink(null)
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

  // Lifecycle boundaries (window close, visibility hide, vault switch) happen
  // before React unmounts this component, so register the same guarded flush
  // independently of the unmount cleanup above.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    return registerEditorSerialization({ flush: () => flushSerialize(editor) })
  }, [editor, flushSerialize])

  // Toggle Live <-> Read in place without re-instantiating the editor.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (editor.isEditable !== editable) editor.setEditable(editable)
    if (!editable) {
      closeMenu()
      setInlineUnlink(null)
    }
  }, [editable, editor, closeMenu])

  // Where the last press began. A drag across several lines ends in a click on their common
  // parent, which reads as a click in the empty page; a press that moved is a drag, and the text
  // it selected must stay selected. Also defers the floating selection toolbar until pointerup.
  const pressRef = React.useRef<{ x: number; y: number } | null>(null)
  React.useEffect(() => {
    const onPress = (event: PointerEvent) => {
      pressRef.current = { x: event.clientX, y: event.clientY }
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest(".amby-floating-menu")) return
      if (wrapperRef.current?.contains(target)) {
        pointerSelectingRef.current = true
        closeMenu()
      }
    }
    const onRelease = () => {
      if (!pointerSelectingRef.current) return
      pointerSelectingRef.current = false
      requestAnimationFrame(() => {
        if (!editor || editor.isDestroyed || !editor.isEditable) return
        if (suppressSelectionMenuRef.current) return
        if (!editor.state.selection.empty) {
          openSelectionMenu(editor)
        }
      })
    }
    document.addEventListener("pointerdown", onPress, true)
    window.addEventListener("pointerup", onRelease, true)
    window.addEventListener("pointercancel", onRelease, true)
    return () => {
      document.removeEventListener("pointerdown", onPress, true)
      window.removeEventListener("pointerup", onRelease, true)
      window.removeEventListener("pointercancel", onRelease, true)
    }
  }, [closeMenu, editor, openSelectionMenu])

  // Click in the empty page: the cursor goes to the nearest line, or to the end of the note.
  const focusAtPoint = React.useCallback(
    (x: number, y: number) => {
      if (editor.isDestroyed || !editor.isEditable) return
      const press = pressRef.current
      if (press && Math.hypot(x - press.x, y - press.y) > DRAG_DISTANCE) return
      const children = Array.from(editor.view.dom.children)
      if (children.length === 0) return
      const top = children[0].getBoundingClientRect().top
      const bottom = Math.max(...children.map((child) => child.getBoundingClientRect().bottom))
      if (y < top) return
      if (y > bottom) {
        editor.view.dispatch(selectEndOfNote(editor.state))
      } else {
        const pos = nearestLinePos(editor.view, y, x)
        // Beside a picture alone on its line there is nothing to put the cursor on.
        if (pos === null || isImageLinePos(editor.state, pos)) return
        editor.view.dispatch(
          editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)),
        )
      }
      editor.view.focus()
    },
    [editor],
  )

  // Expose undo/redo to the parent's floating widget.
  React.useEffect(() => {
    if (!editorRef || !editor) return
    ;(editorRef as React.MutableRefObject<EditorHandle>).current = {
      undo: () => {
        userInteractedRef.current = true
        editor.chain().focus().undo().run()
      },
      redo: () => {
        userInteractedRef.current = true
        editor.chain().focus().redo().run()
      },
      flush: () => flushSerialize(editor),
      getMarkdownSelection: () =>
        docSelectionToMarkdownSelection(editor.state.doc, valueRef.current, editor.state.selection),
      focusAtPoint,
      focus: (position?: "start" | "end") => {
        if (!editor || editor.isDestroyed || !editor.isEditable) return
        if (position === "end") {
          // A note ending with a database gets an empty line to write on.
          editor.view.dispatch(selectEndOfNote(editor.state))
          editor.view.focus()
          return
        }
        editor.chain().focus("start").run()
      },
    }
  }, [editor, editorRef, flushSerialize, focusAtPoint])

  // Make vault/note paths reachable from inside extensions/node views.
  React.useEffect(() => {
    if (!editor) return
    setAssetContext(editor, { vaultPath: vaultPath ?? "", notePath: notePath ?? "", noteId })
  }, [editor, vaultPath, notePath, noteId])

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
    const controller = new AbortController()
    const view = editor.view
    void bindTauriFileDrop(
      view,
      (clientX, clientY) => {
        if (editor.isDestroyed) return null
        return getTauriDropPosForView(view, clientX, clientY)
      },
      controller.signal,
    ).then((unsub) => {
      if (cancelled) unsub()
      else dispose = unsub
    })
    return () => {
      cancelled = true
      controller.abort()
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

  // The Suggestion plugin can keep its range active after a pointer click
  // moves focus away from the editor. Close both the React panel and the
  // plugin at the same boundary so the next key cannot reopen the old slash
  // command.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed || !editable || !slashState?.open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(".amby-block-panel--insert")) return
      dismissSlashMenu(editor)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [editable, editor, slashState?.open])

  React.useEffect(() => {
    const closeEditorMenus = () => {
      suppressSelectionMenuRef.current = true
      closeMenu()
      setWikiLinkContext(null)
      setInlineUnlink(null)
      if (editor && !editor.isDestroyed) {
        dismissSlashMenu(editor)
        dismissInlineSuggest(editor)
      }
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

  const keepInlineUnlinkOpen = React.useCallback(() => {
    if (!unlinkCloseTimerRef.current) return
    clearTimeout(unlinkCloseTimerRef.current)
    unlinkCloseTimerRef.current = null
  }, [])

  const closeInlineUnlinkSoon = React.useCallback(() => {
    keepInlineUnlinkOpen()
    unlinkCloseTimerRef.current = setTimeout(() => setInlineUnlink(null), 160)
  }, [keepInlineUnlinkOpen])

  React.useEffect(() => {
    if (!editor || editor.isDestroyed || !editable) return
    const editorDom = editor.view.dom
    const onPointerOver = (event: PointerEvent) => {
      const source = event.target
      if (!(source instanceof Element)) return
      const token = source.closest<HTMLElement>("[data-amby-inline-unlink=true]")
      if (!token || !editorDom.contains(token)) return
      keepInlineUnlinkOpen()
      const range = inlineTokenRange(editor.view, token)
      const replacement = token.dataset.ambyReplacement
      const written = token.dataset.ambySource
      if (!range || replacement == null || written == null) return
      const rect = token.getBoundingClientRect()
      setInlineUnlink({
        from: range.from,
        to: range.to,
        source: written,
        replacement,
        left: clamp((rect.left + rect.right) / 2, 70, window.innerWidth - 70),
        top: Math.min(rect.bottom + 6, window.innerHeight - 38),
      })
    }
    const onPointerOut = (event: PointerEvent) => {
      const source = event.target
      if (!(source instanceof Element)) return
      const token = source.closest<HTMLElement>("[data-amby-inline-unlink=true]")
      if (!token) return
      const next = event.relatedTarget
      if (next instanceof Node && token.contains(next)) return
      closeInlineUnlinkSoon()
    }
    editorDom.addEventListener("pointerover", onPointerOver)
    editorDom.addEventListener("pointerout", onPointerOut)
    return () => {
      editorDom.removeEventListener("pointerover", onPointerOver)
      editorDom.removeEventListener("pointerout", onPointerOut)
      keepInlineUnlinkOpen()
    }
  }, [closeInlineUnlinkSoon, editable, editor, keepInlineUnlinkOpen])

  function unlinkInlineToken() {
    if (!editor || editor.isDestroyed || !inlineUnlink) return
    const { from, to, source, replacement } = inlineUnlink
    if (
      from < 0 ||
      to <= from ||
      to > editor.state.doc.content.size ||
      // The note changed since the control appeared: never replace other text.
      editor.state.doc.textBetween(from, to) !== source
    ) {
      setInlineUnlink(null)
      return
    }
    userInteractedRef.current = true
    editor.view.dispatch(editor.state.tr.insertText(replacement, from, to))
    editor.view.focus()
    setInlineUnlink(null)
  }

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
      ref={wrapperRef}
      className="amby-tiptap relative min-h-[360px] pb-24"
      data-editor-readonly={isReadOnly ? "true" : "false"}
      onClick={(event) => {
        // The empty page inside the editor (under the last block, beside columns, or in
        // the inter-line gap between text lines): the cursor goes to the nearest line at X,
        // or to the end of the note.
        if (!editor || editor.isDestroyed || !editor.isEditable || event.button !== 0) return
        const target = event.target as HTMLElement
        const isContainerGap =
          target === event.currentTarget ||
          target === editor.view.dom ||
          target.classList.contains("amby-column-content")
        const isInterline =
          !isContainerGap &&
          editor.state.selection.empty &&
          isClickInInterlineGap(editor.view, target, event.clientX, event.clientY)
        if (!isContainerGap && !isInterline) return
        focusAtPoint(event.clientX, event.clientY)
      }}
      onKeyDownCapture={() => {
        userInteractedRef.current = true
      }}
      onInputCapture={() => {
        userInteractedRef.current = true
      }}
      onPasteCapture={() => {
        userInteractedRef.current = true
      }}
      onCutCapture={() => {
        userInteractedRef.current = true
      }}
      onDropCapture={() => {
        userInteractedRef.current = true
      }}
    >
      {editor && find && (
        <FindBar
          editor={editor}
          initialQuery={find.query}
          request={find.request}
          onClose={() => setFind(null)}
        />
      )}
      {editor && editable && menu.open && menu.image && (
        <ImageToolbar
          editor={editor}
          left={menu.left}
          right={menu.right}
          top={menu.top}
          hidden={menu.hidden}
        />
      )}
      {editor && editable && menu.open && !menu.image && (
        <BubbleToolbar
          key={menu.linkRequest ?? 0}
          editor={editor}
          left={menu.left}
          right={menu.right}
          top={menu.top}
          hidden={menu.hidden}
          initialPanel={menu.linkRequest ? "link" : null}
        />
      )}
      {editor &&
        editable &&
        inlineUnlink &&
        createPortal(
          <button
            type="button"
            className="fixed z-[85] flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs font-medium text-foreground shadow-lg hover:bg-accent"
            style={{ left: inlineUnlink.left, top: inlineUnlink.top }}
            onPointerEnter={keepInlineUnlinkOpen}
            onPointerLeave={closeInlineUnlinkSoon}
            onMouseDown={(event) => event.preventDefault()}
            onClick={unlinkInlineToken}
          >
            <Link2Off className="size-3.5 text-muted-foreground" />
            {i18n.t("editor.unlink")}
          </button>,
          document.body,
        )}
      {editor && editable && !isReadOnly && (
        <BlockHandles editor={editor} vaultPath={vaultPath} notePath={notePath} />
      )}
      <EditorContent editor={editor} />
      {editor && lightbox && (
        <ImageLightbox
          editor={editor}
          pictures={lightbox.pictures}
          start={lightbox.start}
          onClose={() => setLightbox(null)}
        />
      )}
      {editor && editable && (
        <ImageCropHost editor={editor} request={cropRequest} onClose={() => setCropRequest(null)} />
      )}
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
      {editor && editable && <InlineSuggestPanel editor={editor} />}
      {editor && editable && !isReadOnly && <TableControls editor={editor} />}
      {editor && editable && slashState?.open && slashState.range && slashAnchor && (
        <BlockInsertPanel
          editor={editor}
          vaultPath={vaultPath}
          notePath={notePath}
          source="slash"
          range={slashState.range}
          slashQuery={slashState.query}
          anchorRect={slashAnchor}
          onClose={() => dismissSlashMenu(editor)}
        />
      )}
    </div>
  )
}
