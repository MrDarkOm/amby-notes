"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Code2,
  Database,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  FilePlus,
  FolderOpen,
  LayoutGrid,
  Lock,
  Maximize2,
  Minimize2,
  MoreVertical,
  Redo2,
  PenLine,
  Undo2,
} from "lucide-react"
import { SourceEditor } from "./source-editor"
import { TiptapEditor } from "./tiptap/TiptapEditor"
import { CanvasEditor } from "./canvas-editor"
import type { EditorHandle } from "./tiptap/constants"
import type { MarkdownSelection } from "./tiptap/markdown-selection"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent } from "@/components/ui/dialog"

import { Button } from "@/components/ui/button"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isTauri } from "@/lib/storage"
import { EmojiPickerPanel } from "./tiptap/EmojiPickerPanel"
import type { TreeItem } from "./sidebar-tree"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

interface Document {
  id: string
  title: string
  content: string
  modified: string
  wordCount: number
  path: string
}

interface DocumentEditorProps {
  document: Document | null
  onContentChange?: (content: string) => void
  onBack?: () => void
  onForward?: () => void
  canGoBack?: boolean
  canGoForward?: boolean
  onRenameTitle?: (newName: string) => void
  vault?: string
  isFocusMode?: boolean
  onToggleFocusMode?: () => void
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
  onToggleFocusMode,
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
  onToggleLock,
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
  const [layerConfirm, setLayerConfirm] = React.useState<EditorLayer | null>(null)
  const [editorSelection, setEditorSelection] = React.useState<MarkdownSelection | null>(null)
  const editorSelectionRef = React.useRef<MarkdownSelection | null>(null)
  const editorRef = React.useRef<EditorHandle>(null as unknown as EditorHandle)
  const { t } = useTranslation()
  const titleInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    setContent(document?.content ?? "")
    setTitleValue(document?.title ?? "")
    setEditingTitle(false)
    editorSelectionRef.current = null
    setEditorSelection(null)
  }, [document?.id])

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
    setContent(v)
    onContentChange?.(v)
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

  const navBar = (
    <>
      <div
        className={`flex h-10 shrink-0 items-center justify-between px-2 ${isFocusMode ? "bg-background/80 backdrop-blur-sm" : "bg-transparent"}`}
      >
        {/* Left: back/forward + drag zone for focus mode */}
        <div className="flex items-center gap-0.5">
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
        </div>

        {/* Center: breadcrumb mirroring the tree */}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-1 overflow-hidden px-2 text-xs">
          {breadcrumb.length > 0 ? (
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
          ) : null}
        </div>

        {/* Right: layer + focus + more */}
        <div className="flex items-center gap-0.5">
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <MoreVertical className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-52 border-border bg-popover text-foreground"
            >
              <DropdownMenuCheckboxItem
                checked={viewMode === "source"}
                disabled={!document || activeLayer !== "editor" || isLocked}
                onCheckedChange={() =>
                  handleEditorViewModeChange(viewMode === "source" ? "live" : "source")
                }
                className="text-[13px] focus:bg-accent focus:text-white"
              >
                <Code2 className="size-3.5" />
                {t("docEditor.sourceMarkdown")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={isLocked}
                disabled={!document}
                onCheckedChange={() => onToggleLock?.()}
                className="text-[13px] focus:bg-accent focus:text-white"
              >
                <Lock className="size-3.5" />
                {t("docEditor.lock")}
              </DropdownMenuCheckboxItem>
              {/* Attach layer options — only shown for layers not yet linked */}
              {document &&
                (!linkedLayers?.canvas || !linkedLayers?.database || !linkedLayers?.sketch) && (
                  <>
                    <DropdownMenuSeparator className="bg-accent" />
                    {!linkedLayers?.canvas && (
                      <DropdownMenuItem
                        className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                        onSelect={() => setLayerConfirm("canvas")}
                      >
                        <LayoutGrid className="size-3.5 text-muted-foreground" />
                        {t("docEditor.attachCanvas")}
                      </DropdownMenuItem>
                    )}
                    {!linkedLayers?.database && (
                      <DropdownMenuItem
                        className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                        onSelect={() => setLayerConfirm("database")}
                      >
                        <Database className="size-3.5 text-muted-foreground" />
                        {t("docEditor.attachDatabase")}
                      </DropdownMenuItem>
                    )}
                    {!linkedLayers?.sketch && (
                      <DropdownMenuItem
                        className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                        onSelect={() => setLayerConfirm("sketch")}
                      >
                        <PenLine className="size-3.5 text-muted-foreground" />
                        {t("docEditor.attachSketch")}
                      </DropdownMenuItem>
                    )}
                  </>
                )}
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
        className="mb-2 mt-0 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/80 bg-[var(--note-surface)]"
        style={{ boxShadow: "var(--note-surface-shadow)" }}
      >
        {navBar}
        <div className="amby-editor-scroll mr-2 min-h-0 flex-1 overscroll-none overflow-y-auto">
          <div
            className="mx-auto px-4 pb-8 pt-5 sm:px-8 sm:pt-6 lg:px-10"
            style={{ maxWidth: "var(--content-max-width, 48rem)" }}
          >
            {/* Title */}
            <div className="mb-4 flex items-center gap-3">
              {fileIcon && !/^(folder|file|workspace|canvas|draft|brain)$/.test(fileIcon) && (
                <div className="relative shrink-0">
                  <button
                    type="button"
                    className="text-3xl leading-none transition-transform hover:scale-110 focus:outline-none"
                    title={t("docEditor.changeIcon")}
                    onClick={() => setEmojiPickerOpen((v) => !v)}
                  >
                    {fileIcon}
                  </button>
                  {emojiPickerOpen && (
                    <div className="absolute left-0 top-full z-50 mt-1">
                      <EmojiPickerPanel
                        onSelect={(emojiData) => {
                          onFileIconChange?.(emojiData.native)
                          setEmojiPickerOpen(false)
                        }}
                        onClose={() => setEmojiPickerOpen(false)}
                      />
                    </div>
                  )}
                </div>
              )}
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

            <div className="mb-5" />

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
                key={document.id}
                value={content}
                onChange={handleContentChange}
                onTagClick={onTagClick}
                onWikiLinkClick={onWikiLinkClick}
                editorRef={editorRef}
                placeholder={t("editor.placeholder")}
                selection={editorSelection}
                onSelectionChange={handleEditorSelectionChange}
              />
            ) : (
              <TiptapEditor
                key={document.id}
                value={content}
                onChange={handleContentChange}
                editorRef={editorRef}
                editable={viewMode === "live" && !isLocked}
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
          <button
            type="button"
            title={viewMode === "read" ? t("docEditor.switchToLive") : t("docEditor.switchToRead")}
            disabled={activeLayer !== "editor" || viewMode === "source" || isLocked}
            className="flex size-5 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleEditorViewModeChange(viewMode === "read" ? "live" : "read")}
          >
            {viewMode === "read" ? <Eye className="size-3" /> : <PenLine className="size-3" />}
          </button>
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
