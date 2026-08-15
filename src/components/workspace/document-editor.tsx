"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Bookmark,
  BookmarkCheck,
  BookOpenText,
  Check,
  Code2,
  Copy,
  Database,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  Files,
  FilePlus,
  FolderInput,
  FolderOpen,
  GitMerge,
  LayoutGrid,
  Link as LinkIcon,
  Maximize2,
  Minimize2,
  MoreVertical,
  Redo2,
  Search,
  SmilePlus,
  PenLine,
  PanelBottom,
  PanelTop,
  SquareArrowOutUpRight,
  Trash2,
  Undo2,
} from "lucide-react"
import { SourceEditor } from "./source-editor"
import { TiptapEditor } from "./tiptap/TiptapEditor"
import { CanvasEditor } from "./canvas-editor"
import type { EditorHandle } from "./tiptap/constants"
import type { MarkdownSelection } from "./tiptap/markdown-selection"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TabsMenu, type HeaderTab } from "./header-tabs"
import { IconValue } from "./icon-value"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isTauri, type NoteProperties } from "@/lib/storage"
import { EmojiPickerPanel } from "./tiptap/EmojiPickerPanel"
import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "./tiptap/floating-menu-events"
import type { TreeItem } from "./sidebar-tree"
import { isSuperNoteItem } from "./workspace-tree-utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

interface Document {
  id: string
  title: string
  content: string
  modified: string
  wordCount: number
  path: string
  noteProperties?: NoteProperties
}

interface DocumentEditorProps {
  document: Document | null
  onContentChange?: (content: string, sourceDocumentId: string) => void
  onBack?: () => void
  onForward?: () => void
  canGoBack?: boolean
  canGoForward?: boolean
  onRenameTitle?: (newName: string) => void
  vault?: string
  isFocusMode?: boolean
  hideNavigation?: boolean
  onToggleFocusMode?: () => void
  focusTabs?: HeaderTab[]
  activeTabKey?: string
  onFocusTabChange?: (key: string) => void
  focusFavorites?: Set<string>
  onFocusToggleFavorite?: (id: string) => void
  onFocusCloseAllTabs?: () => void
  fileIcon?: string
  onNewFile?: () => void
  onOpenVault?: () => void
  onTagClick?: (tag: string) => void
  onWikiLinkClick?: (target: string) => void
  resolveWikiLinkTarget?: (target: string) => string | null
  fetchTransclusion?: (target: string) => Promise<string | null>
  activeLayer?: EditorLayer
  onLayerChange?: (layer: EditorLayer) => void
  viewMode?: DocumentViewMode
  onViewModeChange?: (mode: DocumentViewMode) => void
  onFileIconChange?: (emoji: string) => void
  linkedLayers?: { canvas: boolean; sketch: boolean; database: boolean }
  isLocked?: boolean
  onToggleLock?: () => void
  isFavorite?: boolean
  onToggleFavorite?: () => void
  onOpenInNewTab?: () => void
  nestedNotes?: TreeItem[]
  nestedNotesPlacement?: "top" | "bottom" | "hidden"
  onNestedNotesPlacementChange?: (placement: "top" | "bottom" | "hidden") => void
  onOpenNestedNoteInNewTab?: (id: string) => void
  onMoveFile?: (targetFolderId: string | null) => void
  onMergeFile?: (targetId: string) => void
  onShowInExplorer?: () => void
  onDeleteFile?: () => void
  treeItems?: TreeItem[]
  onOpenItem?: (id: string) => void
  onUnlinkLayer?: (layer: "canvas" | "database" | "sketch") => void
  onDeleteLayer?: (layer: "canvas" | "database" | "sketch") => void
  canvasValue?: string
  onCanvasChange?: (json: string) => void
  onOpenCanvasNote?: (file: string) => void
}

type EditorLayer = "editor" | "canvas" | "database" | "sketch"
export type DocumentViewMode = "source" | "live" | "read"

const LAYER_OPTIONS: Array<{
  id: EditorLayer
  labelKey: string
  icon: React.ElementType
}> = [
  { id: "editor", labelKey: "docEditor.markdownEditor", icon: FileText },
  { id: "canvas", labelKey: "docEditor.canvasLayer", icon: LayoutGrid },
  {
    id: "database",
    labelKey: "docEditor.databaseLayer",
    icon: Database,
  },
  { id: "sketch", labelKey: "docEditor.sketchLayer", icon: PenLine },
]

interface BreadcrumbSegment {
  id: string
  name: string
  kind: "file" | "folder"
}

function stripMdExt(name: string): string {
  return name.replace(/\.md$/iu, "")
}

function relativeToVault(path: string, vault: string): string {
  const normalizedPath = path.replace(/\\/gu, "/")
  const normalizedVault = vault.replace(/\\/gu, "/").replace(/\/+$/u, "")
  return normalizedPath.startsWith(`${normalizedVault}/`)
    ? normalizedPath.slice(normalizedVault.length + 1)
    : normalizedPath
}

function findBreadcrumbTrail(items: TreeItem[], targetId: string): TreeItem[] | null {
  for (const item of items) {
    if (item.id === targetId) return [item]
    if (item.children) {
      const sub = findBreadcrumbTrail(item.children, targetId)
      if (sub) return [item, ...sub]
    }
  }
  return null
}

function flattenTree(items: TreeItem[]): TreeItem[] {
  const result: TreeItem[] = []
  for (const item of items) {
    result.push(item)
    if (item.children) result.push(...flattenTree(item.children))
  }
  return result
}

function buildBreadcrumb(
  treeItems: TreeItem[] | undefined,
  docId: string | undefined,
): BreadcrumbSegment[] {
  if (!treeItems || !docId) return []
  const trail = findBreadcrumbTrail(treeItems, docId)
  if (!trail) return []
  const segments: BreadcrumbSegment[] = []
  for (let i = 0; i < trail.length; i++) {
    const item = trail[i]
    const next = trail[i + 1]
    // Bundle collapse: folder whose name matches the next (file) child's name.
    // The sidebar effectively presents these as one entry.
    if (
      next &&
      item.type === "folder" &&
      next.type === "file" &&
      stripMdExt(item.name) === stripMdExt(next.name)
    ) {
      continue
    }
    segments.push({
      id: item.id,
      name: stripMdExt(item.name),
      kind: item.type === "folder" ? "folder" : "file",
    })
  }
  return segments
}

function handleDragStart(e: React.MouseEvent) {
  if (e.button !== 0) return
  if (isTauri()) {
    e.preventDefault()
    getCurrentWindow()
      .startDragging()
      .catch(() => {})
  }
}

export function DocumentEditor({
  document,
  onContentChange,
  onBack,
  onForward,
  canGoBack = false,
  canGoForward = false,
  onRenameTitle,
  vault,
  isFocusMode = false,
  hideNavigation = false,
  onToggleFocusMode,
  focusTabs = [],
  activeTabKey,
  onFocusTabChange,
  focusFavorites,
  onFocusToggleFavorite,
  onFocusCloseAllTabs,
  fileIcon,
  onNewFile,
  onOpenVault,
  onTagClick,
  onWikiLinkClick,
  resolveWikiLinkTarget,
  fetchTransclusion,
  activeLayer = "editor",
  onLayerChange,
  viewMode = "live",
  onViewModeChange,
  onFileIconChange,
  linkedLayers,
  isLocked = false,
  isFavorite = false,
  onToggleFavorite,
  onOpenInNewTab,
  nestedNotes = [],
  nestedNotesPlacement = "top",
  onNestedNotesPlacementChange,
  onOpenNestedNoteInNewTab,
  onMoveFile,
  onMergeFile,
  onShowInExplorer,
  onDeleteFile,
  treeItems,
  onOpenItem,
  onUnlinkLayer,
  onDeleteLayer,
  canvasValue,
  onCanvasChange,
  onOpenCanvasNote,
}: DocumentEditorProps) {
  const [content, setContent] = React.useState(document?.content ?? "")
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [titleValue, setTitleValue] = React.useState(document?.title ?? "")
  const [emojiPickerOpen, setEmojiPickerOpen] = React.useState(false)
  const [moreActionsOpen, setMoreActionsOpen] = React.useState(false)
  const [viewModeMenuOpen, setViewModeMenuOpen] = React.useState(false)
  const [filePickerMode, setFilePickerMode] = React.useState<"move" | "merge" | null>(null)
  const [filePickerQuery, setFilePickerQuery] = React.useState("")
  const emojiSlotRef = React.useRef<HTMLDivElement>(null)
  const [layerConfirm, setLayerConfirm] = React.useState<EditorLayer | null>(null)
  const [editorSelection, setEditorSelection] = React.useState<MarkdownSelection | null>(null)
  const editorSelectionRef = React.useRef<MarkdownSelection | null>(null)
  const editorRef = React.useRef<EditorHandle>(null as unknown as EditorHandle)
  const { t } = useTranslation()
  const titleInputRef = React.useRef<HTMLInputElement>(null)
  const flatTreeItems = React.useMemo(() => flattenTree(treeItems ?? []), [treeItems])
  const moveFolders = flatTreeItems.filter((item) => item.type === "folder")
  const mergeFiles = flatTreeItems.filter(
    (item) => item.type === "file" && item.id !== document?.id,
  )
  const pickerItems = (filePickerMode === "move" ? moveFolders : mergeFiles).filter((item) =>
    item.name.toLocaleLowerCase().includes(filePickerQuery.trim().toLocaleLowerCase()),
  )

  const copyPath = React.useCallback(
    async (kind: "app" | "vault" | "absolute") => {
      if (!document) return
      const value =
        kind === "app"
          ? `${window.location.origin}${window.location.pathname}?ambyFile=${encodeURIComponent(document.id)}`
          : kind === "vault" && vault
            ? relativeToVault(document.path, vault)
            : document.path
      await navigator.clipboard.writeText(value)
    },
    [document, vault],
  )

  const setExclusiveMenu = React.useCallback((menu: "actions" | "view", open: boolean) => {
    if (open) {
      window.dispatchEvent(new Event(CLOSE_BLOCK_MENUS_EVENT))
      window.dispatchEvent(new Event(CLOSE_EDITOR_MENUS_EVENT))
    }
    if (menu === "actions") setMoreActionsOpen(open)
    else setViewModeMenuOpen(open)
  }, [])

  React.useEffect(() => {
    const closeDocumentMenus = () => {
      setMoreActionsOpen(false)
      setViewModeMenuOpen(false)
    }
    window.addEventListener(CLOSE_EDITOR_MENUS_EVENT, closeDocumentMenus)
    return () => window.removeEventListener(CLOSE_EDITOR_MENUS_EVENT, closeDocumentMenus)
  }, [])

  React.useEffect(() => {
    setEditingTitle(false)
    editorSelectionRef.current = null
    setEditorSelection(null)
  }, [document?.id])

  React.useEffect(() => {
    setContent(document?.content ?? "")
  }, [document?.content])

  React.useEffect(() => {
    setTitleValue(document?.title ?? "")
  }, [document?.title])

  React.useEffect(() => {
    if (editingTitle)
      setTimeout(() => {
        titleInputRef.current?.select()
        titleInputRef.current?.focus()
      }, 0)
  }, [editingTitle])

  function commitTitleRename() {
    const trimmed = titleValue.trim()
    if (trimmed && trimmed !== document?.title) onRenameTitle?.(trimmed)
    setEditingTitle(false)
  }

  function handleTitleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") commitTitleRename()
    if (e.key === "Escape") {
      setTitleValue(document?.title ?? "")
      setEditingTitle(false)
    }
  }

  const handleContentChange = (v: string) => {
    if (!document) return
    setContent(v)
    // Carry the editor's document identity with every change. A delayed child
    // callback from a document that is being unmounted must never be accepted
    // by the newly active tab.
    onContentChange?.(v, document.id)
  }

  // Cursor movement is frequent. Keep the latest source offset in a ref so it
  // does not re-render the whole document surface on every arrow key/keystroke.
  // Copy it into state only when a view transition needs to remount an editor.
  const handleEditorSelectionChange = React.useCallback((next: MarkdownSelection) => {
    editorSelectionRef.current = next
  }, [])

  const handleEditorViewModeChange = React.useCallback(
    (mode: DocumentViewMode) => {
      setEditorSelection(editorSelectionRef.current)
      onViewModeChange?.(mode)
    },
    [onViewModeChange],
  )

  // Keep non-essential statistics out of the urgent typing path for large notes.
  const deferredContent = React.useDeferredValue(content)
  const liveWordCount = React.useMemo(
    () => deferredContent.split(/\s+/).filter(Boolean).length,
    [deferredContent],
  )

  const breadcrumb = React.useMemo(
    () => buildBreadcrumb(treeItems, document?.id),
    [treeItems, document?.id],
  )
  const hasPageEmoji = Boolean(
    fileIcon && !/^(folder|file|page|workspace|canvas|draft|brain)$/.test(fileIcon),
  )
  const isSuperNote = Boolean(document && isSuperNoteItem({ path: document.path, type: "file" }))
  const nestedNotesBar =
    nestedNotes.length > 0 && nestedNotesPlacement !== "hidden" ? (
      <div
        className={
          nestedNotesPlacement === "bottom" ? "mt-8 border-t border-border pt-4" : "mb-5 -mt-1"
        }
      >
        <div className="flex flex-wrap gap-2">
          {nestedNotes.map((note) => {
            const icon =
              note.icon && !/^(folder|file|supernote|page)$/u.test(note.icon) ? note.icon : "📄"
            return (
              <ContextMenu key={note.id}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-accent/45 px-3 py-2 text-sm text-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-accent"
                    onClick={() => onOpenItem?.(note.id)}
                  >
                    <span className="flex size-5 items-center justify-center" aria-hidden="true">
                      <IconValue value={icon} className="size-5" />
                    </span>
                    <span className="truncate">{stripMdExt(note.name)}</span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-56">
                  <ContextMenuItem onSelect={() => onOpenItem?.(note.id)}>
                    <FileText className="mr-2 size-4" />
                    {t("docEditor.openNestedNote")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onOpenNestedNoteInNewTab?.(note.id)}>
                    <SquareArrowOutUpRight className="mr-2 size-4" />
                    {t("tree.openInNewTab")}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  {(["top", "bottom", "hidden"] as const).map((placement) => (
                    <ContextMenuItem
                      key={placement}
                      onSelect={() => onNestedNotesPlacementChange?.(placement)}
                    >
                      {placement === "top" ? (
                        <PanelTop className="mr-2 size-4" />
                      ) : placement === "bottom" ? (
                        <PanelBottom className="mr-2 size-4" />
                      ) : (
                        <EyeOff className="mr-2 size-4" />
                      )}
                      <span className="flex-1">{t(`docEditor.nestedNotes_${placement}`)}</span>
                      {nestedNotesPlacement === placement && <Check className="size-4" />}
                    </ContextMenuItem>
                  ))}
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
      </div>
    ) : null

  const breadcrumbTrail =
    breadcrumb.length > 0 ? (
      breadcrumb.map((seg, idx) => {
        const isLast = idx === breadcrumb.length - 1
        const isClickable = !isLast && seg.kind === "file" && !!onOpenItem
        return (
          <React.Fragment key={seg.id}>
            {isClickable ? (
              <button
                type="button"
                className="max-w-[200px] truncate rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => onOpenItem?.(seg.id)}
                title={seg.name}
              >
                {seg.name}
              </button>
            ) : (
              <span
                className={`max-w-[260px] truncate px-1 ${isLast ? "text-foreground" : "text-muted-foreground"}`}
                title={seg.name}
              >
                {seg.name}
              </span>
            )}
            {!isLast && <span className="shrink-0 text-muted-foreground">›</span>}
          </React.Fragment>
        )
      })
    ) : document ? (
      <span className="truncate text-muted-foreground">{document.title}</span>
    ) : null
  const breadcrumbContent = document ? (
    <>
      {breadcrumbTrail}
      {isSuperNote ? (
        <BookOpenText
          className="ml-1 size-3.5 shrink-0 text-muted-foreground"
          aria-label={t("docEditor.supernote")}
        />
      ) : (
        <FileText
          className="ml-1 size-3.5 shrink-0 text-muted-foreground"
          aria-label={t("docEditor.note")}
        />
      )}
    </>
  ) : null

  const navBar = hideNavigation ? null : (
    <>
      <div
        className={`h-10 shrink-0 items-center px-2 ${
          isFocusMode
            ? "z-30 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] bg-transparent"
            : "flex justify-between bg-transparent"
        }`}
      >
        {/* Left: back/forward and, in focus mode, the document path. */}
        <div className="flex min-w-0 items-center gap-0.5">
          {isFocusMode && <div className="h-10 w-6 cursor-default" onMouseDown={handleDragStart} />}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
            onClick={onBack}
            disabled={!canGoBack}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
            onClick={onForward}
            disabled={!canGoForward}
          >
            <ChevronRight className="size-3.5" />
          </Button>
          {isFocusMode && (
            <div className="ml-1 flex min-w-0 items-center gap-1 overflow-hidden text-xs">
              {breadcrumbContent}
            </div>
          )}
        </div>

        {/* Center: current tab menu in focus mode; breadcrumb otherwise. */}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-1 overflow-hidden px-2 text-xs">
          {isFocusMode ? (
            <TabsMenu
              trigger={
                <button
                  type="button"
                  className="flex max-w-[320px] items-center gap-1 rounded-md px-2 py-1 font-medium text-foreground transition-colors hover:bg-accent"
                  title={t("tabs.tabMenu")}
                >
                  <span className="truncate">{document?.title ?? ""}</span>
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              }
              tabs={focusTabs}
              activeTabKey={activeTabKey ?? ""}
              activeFileId={document?.id}
              favorites={focusFavorites}
              onTabChange={(key) => onFocusTabChange?.(key)}
              onToggleFavorite={onFocusToggleFavorite}
              onCloseAllTabs={onFocusCloseAllTabs}
              align="center"
            />
          ) : (
            breadcrumbContent
          )}
        </div>

        {/* Right: layer + focus + more */}
        <div className={`flex items-center gap-0.5 ${isFocusMode ? "justify-self-end" : ""}`}>
          {document && (
            <div className="mr-1 flex items-center gap-1 rounded-full bg-background/70 p-0.5 shadow-sm">
              {/* Editor layer — always visible */}
              <button
                type="button"
                title={t("docEditor.markdownEditor")}
                onClick={() => onLayerChange?.("editor")}
                className={`flex size-7 items-center justify-center rounded-full transition-colors ${
                  activeLayer === "editor"
                    ? "bg-accent text-foreground"
                    : "bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <FileText className="size-3.5" />
              </button>
              {/* Only show attached (linked) layers — right-click for unlink/delete */}
              {linkedLayers?.canvas && (
                <LayerButton
                  layer="canvas"
                  title={t("docEditor.canvasLayer")}
                  icon={<LayoutGrid className="size-3.5" />}
                  active={activeLayer === "canvas"}
                  onActivate={() => onLayerChange?.("canvas")}
                  onUnlink={onUnlinkLayer}
                  onDelete={onDeleteLayer}
                />
              )}
              {linkedLayers?.database && (
                <LayerButton
                  layer="database"
                  title={t("docEditor.databaseLayer")}
                  icon={<Database className="size-3.5" />}
                  active={activeLayer === "database"}
                  onActivate={() => onLayerChange?.("database")}
                  onUnlink={onUnlinkLayer}
                  onDelete={onDeleteLayer}
                />
              )}
              {linkedLayers?.sketch && (
                <LayerButton
                  layer="sketch"
                  title={t("docEditor.sketchLayer")}
                  icon={<PenLine className="size-3.5" />}
                  active={activeLayer === "sketch"}
                  onActivate={() => onLayerChange?.("sketch")}
                  onUnlink={onUnlinkLayer}
                  onDelete={onDeleteLayer}
                />
              )}
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={`size-7 hover:bg-accent ${isFocusMode ? "text-foreground" : "text-muted-foreground hover:text-white"}`}
            onClick={onToggleFocusMode}
            title={isFocusMode ? t("docEditor.focusModeExit") : t("docEditor.focusModeEnter")}
          >
            {isFocusMode ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </Button>
          <DropdownMenu
            open={moreActionsOpen}
            onOpenChange={(open) => setExclusiveMenu("actions", open)}
          >
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("docEditor.moreActions")}
                className="size-7 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <MoreVertical className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-64 border-border bg-popover text-foreground"
            >
              {/* Zone 1: editor presentation. */}
              {(
                [
                  ["live", PenLine, "docEditor.viewLive"],
                  ["source", Code2, "docEditor.viewSource"],
                  ["read", Eye, "docEditor.viewRead"],
                ] as const
              ).map(([mode, Icon, labelKey]) => (
                <DropdownMenuItem
                  key={mode}
                  disabled={!document || activeLayer !== "editor" || (mode === "live" && isLocked)}
                  className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                  onSelect={() => handleEditorViewModeChange(mode)}
                >
                  <Icon className="size-3.5 text-muted-foreground" />
                  <span className="flex-1">{t(labelKey)}</span>
                  {viewMode === mode && <Check className="size-3.5 text-primary" />}
                </DropdownMenuItem>
              ))}

              <DropdownMenuSeparator className="bg-accent" />

              {nestedNotes.length > 0 && (
                <>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent">
                      <Files className="size-3.5 text-muted-foreground" />
                      {t("docEditor.nestedNotesDisplay")}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-48 border-border bg-popover text-foreground">
                      {(["top", "bottom", "hidden"] as const).map((placement) => (
                        <DropdownMenuItem
                          key={placement}
                          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                          onSelect={() => onNestedNotesPlacementChange?.(placement)}
                        >
                          {placement === "top" ? (
                            <PanelTop className="size-3.5 text-muted-foreground" />
                          ) : placement === "bottom" ? (
                            <PanelBottom className="size-3.5 text-muted-foreground" />
                          ) : (
                            <EyeOff className="size-3.5 text-muted-foreground" />
                          )}
                          <span className="flex-1">{t(`docEditor.nestedNotes_${placement}`)}</span>
                          {nestedNotesPlacement === placement && <Check className="size-3.5" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator className="bg-accent" />
                </>
              )}

              {/* Zone 2: attachments and opening. */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent">
                  <LinkIcon className="size-3.5 text-muted-foreground" />
                  {t("docEditor.attach")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-52 border-border bg-popover text-foreground">
                  <DropdownMenuItem
                    disabled={linkedLayers?.canvas}
                    className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                    onSelect={() => setLayerConfirm("canvas")}
                  >
                    <LayoutGrid className="size-3.5 text-muted-foreground" />
                    {t("docEditor.attachCanvas")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={linkedLayers?.database}
                    className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                    onSelect={() => setLayerConfirm("database")}
                  >
                    <Database className="size-3.5 text-muted-foreground" />
                    {t("docEditor.attachDatabase")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={linkedLayers?.sketch}
                    className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                    onSelect={() => setLayerConfirm("sketch")}
                  >
                    <PenLine className="size-3.5 text-muted-foreground" />
                    {t("docEditor.attachSketch")}
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem
                disabled={!document || !onToggleFavorite}
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={onToggleFavorite}
              >
                {isFavorite ? (
                  <BookmarkCheck className="size-3.5 text-amber-400" />
                ) : (
                  <Bookmark className="size-3.5 text-muted-foreground" />
                )}
                {isFavorite ? t("tree.removeBookmark") : t("tree.addBookmark")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!document || !onOpenInNewTab}
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={onOpenInNewTab}
              >
                <SquareArrowOutUpRight className="size-3.5 text-muted-foreground" />
                {t("tree.openInNewTab")}
              </DropdownMenuItem>

              <DropdownMenuSeparator className="bg-accent" />

              {/* Zone 3: location, merge and path copies. */}
              <DropdownMenuItem
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={() => {
                  setFilePickerQuery("")
                  setFilePickerMode("move")
                }}
              >
                <FolderInput className="size-3.5 text-muted-foreground" />
                {t("docEditor.moveFile")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={() => {
                  setFilePickerQuery("")
                  setFilePickerMode("merge")
                }}
              >
                <GitMerge className="size-3.5 text-muted-foreground" />
                {t("docEditor.mergeWith")}
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent">
                  <Copy className="size-3.5 text-muted-foreground" />
                  {t("docEditor.copyPath")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56 border-border bg-popover text-foreground">
                  {(["app", "vault", "absolute"] as const).map((kind) => (
                    <DropdownMenuItem
                      key={kind}
                      className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                      onSelect={() => void copyPath(kind)}
                    >
                      <Copy className="size-3.5 text-muted-foreground" />
                      {t(`docEditor.copyPath_${kind}`)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuSeparator className="bg-accent" />

              {/* Zone 4: filesystem actions. */}
              <DropdownMenuItem
                disabled={!document || !onShowInExplorer}
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={onShowInExplorer}
              >
                <FolderOpen className="size-3.5 text-muted-foreground" />
                {t("tree.showInExplorer")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!document}
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={() => setEditingTitle(true)}
              >
                <PenLine className="size-3.5 text-muted-foreground" />
                {t("tree.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!document || !onDeleteFile}
                className="flex items-center gap-2 text-[13px] text-red-400 focus:bg-accent focus:text-red-300"
                onSelect={onDeleteFile}
              >
                <Trash2 className="size-3.5" />
                {t("docEditor.deleteFile")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {/* Layer attachment confirmation dialog */}
      <Dialog
        open={layerConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setLayerConfirm(null)
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="w-72 border-border bg-popover p-4 text-foreground sm:max-w-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              if (layerConfirm) {
                onLayerChange?.(layerConfirm)
                setLayerConfirm(null)
              }
            }
          }}
        >
          <p className="text-[13px] leading-snug">
            {layerConfirm === "canvas"
              ? t("docEditor.confirmCreateCanvas")
              : layerConfirm === "sketch"
                ? t("docEditor.confirmCreateSketch")
                : t("docEditor.confirmCreateDatabase")}
          </p>
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              className="rounded border border-border px-2.5 py-1 text-xs text-foreground hover:bg-card"
              onClick={() => setLayerConfirm(null)}
            >
              {t("docEditor.cancel")}
            </button>
            <button
              type="button"
              autoFocus
              className="rounded bg-foreground px-2.5 py-1 text-xs font-medium text-background hover:bg-foreground/90"
              onClick={() => {
                if (layerConfirm) {
                  onLayerChange?.(layerConfirm)
                  setLayerConfirm(null)
                }
              }}
            >
              {t("docEditor.create")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )

  if (!document) {
    return (
      <div className="flex h-full flex-1 flex-col bg-background">
        {navBar}
        <div className="flex flex-1 flex-col items-center justify-center gap-6">
          <div className="text-center">
            <p className="text-lg font-medium text-foreground">{t("docEditor.noNotes")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("docEditor.noNotesHint")}</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={onNewFile}
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-foreground transition-colors hover:bg-accent hover:border-border"
            >
              <FilePlus className="size-4 text-muted-foreground" />
              {t("docEditor.createNote")}
            </button>
            <button
              onClick={onOpenVault}
              className="flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
            >
              <FolderOpen className="size-4" />
              {t("docEditor.openVault")}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Canvas layer: borderless, full-bleed infinite canvas (no title / scroll column).
  if (activeLayer === "canvas") {
    return (
      <div className="relative flex h-full flex-1 flex-col bg-background">
        {navBar}
        <div className="flex-1 overflow-hidden">
          <CanvasEditor
            key={`${document.id}:canvas`}
            value={canvasValue ?? "{}"}
            onChange={(json) => onCanvasChange?.(json)}
            vault={vault ?? null}
            notePath={document.path}
            onOpenNote={onOpenCanvasNote}
          />
        </div>
      </div>
    )
  }

  const activeLayerMeta =
    LAYER_OPTIONS.find((option) => option.id === activeLayer) ?? LAYER_OPTIONS[0]
  const ActiveLayerIcon = activeLayerMeta.icon

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-[var(--workspace-bg)]">
      <div
        className={`${isFocusMode ? "" : "mb-2"} mt-0 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/80 bg-[var(--note-surface)]`}
        style={{ boxShadow: "var(--note-surface-shadow)" }}
      >
        {navBar}
        <div className="amby-editor-scroll mr-2 min-h-0 flex-1 overscroll-none overflow-y-auto">
          <div
            className="mx-auto px-4 pb-8 pt-5 sm:px-8 sm:pt-6 lg:px-10"
            style={{ maxWidth: "var(--content-max-width, 48rem)" }}
          >
            {/* Title */}
            <div className="amby-page-title relative mb-4 flex items-center gap-3">
              <div
                ref={emojiSlotRef}
                className={hasPageEmoji ? "relative shrink-0" : "absolute -left-10 top-0"}
              >
                {hasPageEmoji ? (
                  <button
                    type="button"
                    className="text-3xl leading-none transition-transform hover:scale-110 focus:outline-none"
                    title={t("docEditor.changeIcon")}
                    onClick={() => {
                      if (emojiPickerOpen) {
                        setEmojiPickerOpen(false)
                      } else {
                        window.dispatchEvent(new Event(CLOSE_BLOCK_MENUS_EVENT))
                        window.dispatchEvent(new Event(CLOSE_EDITOR_MENUS_EVENT))
                        setEmojiPickerOpen(true)
                      }
                    }}
                  >
                    <IconValue value={fileIcon} className="size-8 rounded-md" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="amby-page-emoji-add flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-all hover:bg-accent hover:text-foreground focus:outline-none"
                    title={t("docEditor.changeIcon")}
                    aria-label={t("docEditor.changeIcon")}
                    onClick={() => {
                      if (emojiPickerOpen) {
                        setEmojiPickerOpen(false)
                      } else {
                        window.dispatchEvent(new Event(CLOSE_BLOCK_MENUS_EVENT))
                        window.dispatchEvent(new Event(CLOSE_EDITOR_MENUS_EVENT))
                        setEmojiPickerOpen(true)
                      }
                    }}
                  >
                    <SmilePlus className="size-5" />
                  </button>
                )}
                {emojiPickerOpen && (
                  <div className="absolute left-0 top-full z-50 mt-1">
                    <EmojiPickerPanel
                      triggerRef={emojiSlotRef}
                      onSelect={(emojiData) => {
                        onFileIconChange?.(emojiData.native)
                        setEmojiPickerOpen(false)
                      }}
                      onClear={() => {
                        onFileIconChange?.("file")
                        setEmojiPickerOpen(false)
                      }}
                      clearLabel={t("tree.resetIcon")}
                      onClose={() => setEmojiPickerOpen(false)}
                    />
                  </div>
                )}
              </div>
              {editingTitle ? (
                <input
                  ref={titleInputRef}
                  value={titleValue}
                  onChange={(e) => setTitleValue(e.target.value)}
                  onBlur={commitTitleRename}
                  onKeyDown={handleTitleKeyDown}
                  className="h-8 flex-1 border-0 bg-transparent p-0 text-2xl font-semibold leading-none tracking-tight text-foreground outline-none sm:h-10 sm:text-3xl"
                />
              ) : (
                <h1
                  className="cursor-text text-2xl font-semibold leading-none tracking-tight text-foreground hover:text-primary sm:text-3xl"
                  onClick={() => {
                    setTitleValue(document.title)
                    setEditingTitle(true)
                  }}
                >
                  {document.title}
                </h1>
              )}
            </div>

            {nestedNotesPlacement === "top" && nestedNotesBar ? (
              nestedNotesBar
            ) : (
              <div className="mb-5" />
            )}

            {activeLayer !== "editor" ? (
              <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 rounded border border-dashed border-border bg-background/40 text-center">
                <div className="flex size-12 items-center justify-center rounded border border-border bg-card text-foreground">
                  <ActiveLayerIcon className="size-5" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t(activeLayerMeta.labelKey)}
                  </p>
                  <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                    {t("docEditor.layerCreated")}
                  </p>
                </div>
              </div>
            ) : viewMode === "source" ? (
              <SourceEditor
                key={`${document.id}:${isLocked}`}
                value={content}
                onChange={handleContentChange}
                onTagClick={onTagClick}
                onWikiLinkClick={onWikiLinkClick}
                editorRef={editorRef}
                placeholder={t("editor.placeholder")}
                selection={editorSelection}
                onSelectionChange={handleEditorSelectionChange}
                editable={!isLocked}
              />
            ) : (
              <TiptapEditor
                key={document.id}
                value={content}
                onChange={handleContentChange}
                editorRef={editorRef}
                editable={viewMode === "live" && !isLocked}
                isReadOnly={viewMode === "read"}
                onTagClick={onTagClick}
                onWikiLinkClick={onWikiLinkClick}
                resolveWikiLinkTarget={resolveWikiLinkTarget}
                fetchTransclusion={fetchTransclusion}
                placeholder={t("editor.placeholder")}
                vaultPath={vault}
                notePath={document.path}
                selection={editorSelection}
                onSelectionChange={handleEditorSelectionChange}
              />
            )}
            {nestedNotesPlacement === "bottom" && nestedNotesBar}
          </div>
        </div>
      </div>

      {/* Floating stats widget */}
      <div className="pointer-events-none absolute bottom-4 right-4 z-10">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-background/90 px-3 py-1.5 shadow-sm backdrop-blur-sm">
          <span className="text-[11px] text-muted-foreground">{document.modified}</span>
          <span className="text-border">·</span>
          <span className="text-[11px] text-muted-foreground">
            {t("docEditor.wordCount", { count: liveWordCount })}
          </span>
          <div className="mx-1 h-3 w-px bg-accent" />
          <DropdownMenu
            open={viewModeMenuOpen}
            onOpenChange={(open) => setExclusiveMenu("view", open)}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={t("docEditor.viewMode")}
                aria-label={t("docEditor.viewMode")}
                disabled={activeLayer !== "editor" || isLocked}
                className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                onMouseDown={(e) => e.preventDefault()}
              >
                {viewMode === "source" ? (
                  <Code2 className="size-3" />
                ) : viewMode === "read" ? (
                  <Eye className="size-3" />
                ) : (
                  <PenLine className="size-3" />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-40 border-border bg-popover text-foreground"
            >
              {(
                [
                  ["live", PenLine, "docEditor.viewLive"],
                  ["read", Eye, "docEditor.viewRead"],
                  ["source", Code2, "docEditor.viewSource"],
                ] as const
              ).map(([mode, Icon, labelKey]) => (
                <DropdownMenuItem
                  key={mode}
                  className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                  onSelect={() => handleEditorViewModeChange(mode)}
                >
                  <Icon className="size-3.5 text-muted-foreground" />
                  <span className="flex-1">{t(labelKey)}</span>
                  {viewMode === mode && <span className="text-primary">✓</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="mx-1 h-3 w-px bg-accent" />
          <button
            title={t("docEditor.undo")}
            className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onMouseDown={(e) => {
              e.preventDefault()
              editorRef.current?.undo()
            }}
          >
            <Undo2 className="size-3" />
          </button>
          <button
            title={t("docEditor.redo")}
            className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onMouseDown={(e) => {
              e.preventDefault()
              editorRef.current?.redo()
            }}
          >
            <Redo2 className="size-3" />
          </button>
        </div>
      </div>

      <Dialog
        open={filePickerMode !== null}
        onOpenChange={(open) => !open && setFilePickerMode(null)}
      >
        <DialogContent className="max-w-sm gap-3 p-4">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {filePickerMode === "move" ? t("docEditor.moveFile") : t("docEditor.mergeWith")}
            </DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={filePickerQuery}
              onChange={(event) => setFilePickerQuery(event.target.value)}
              placeholder={t("docEditor.filePickerSearch")}
              className="h-9 pl-8 text-xs"
            />
          </div>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {filePickerMode === "move" &&
              t("docEditor.vaultRoot")
                .toLocaleLowerCase()
                .includes(filePickerQuery.trim().toLocaleLowerCase()) && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:bg-accent"
                  onClick={() => {
                    onMoveFile?.(null)
                    setFilePickerMode(null)
                  }}
                >
                  <FolderOpen className="size-4 text-muted-foreground" />
                  {t("docEditor.vaultRoot")}
                </button>
              )}
            {pickerItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:bg-accent"
                onClick={() => {
                  if (filePickerMode === "move") onMoveFile?.(item.id)
                  else onMergeFile?.(item.id)
                  setFilePickerMode(null)
                }}
              >
                {filePickerMode === "move" ? (
                  <FolderOpen className="size-4 text-muted-foreground" />
                ) : (
                  <FileText className="size-4 text-muted-foreground" />
                )}
                <span className="truncate">{item.name}</span>
              </button>
            ))}
            {pickerItems.length === 0 && filePickerMode === "merge" && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t("docEditor.noMergeTargets")}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

type LayerKind = "canvas" | "database" | "sketch"

function LayerButton({
  layer,
  title,
  icon,
  active,
  onActivate,
  onUnlink,
  onDelete,
}: {
  layer: LayerKind
  title: string
  icon: React.ReactNode
  active: boolean
  onActivate: () => void
  onUnlink?: (layer: LayerKind) => void
  onDelete?: (layer: LayerKind) => void
}) {
  const { t } = useTranslation()
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          title={title}
          onClick={onActivate}
          className={`flex size-7 items-center justify-center rounded-full transition-colors ${
            active
              ? "bg-accent text-foreground"
              : "bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
        >
          {icon}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => onUnlink?.(layer)}>
          {t("docEditor.detach")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => onDelete?.(layer)}
          className="text-red-400 focus:text-red-300"
        >
          {t("docEditor.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
