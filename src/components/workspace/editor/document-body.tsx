"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Check, EyeOff, FileText, PanelBottom, PanelTop, SquareArrowOutUpRight } from "lucide-react"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { SourceEditor } from "../source-editor"
import { TiptapEditor } from "../tiptap/TiptapEditor"
import { CanvasEditor } from "../canvas-editor"
import { SketchEditor } from "../sketch-editor"
import type { EditorHandle } from "../tiptap/constants"
import type { MarkdownSelection } from "../tiptap/markdown-selection"
import { IconValue } from "../icon-value"
import { KNOWN_ICONS } from "../tree/tree-types"
import type { TreeItem } from "../sidebar-tree"
import { stripMdExt } from "./document-breadcrumbs-utils"
import { DocumentTitle } from "./document-title"
import { DocumentAreaControls } from "./document-area-controls"
import { LAYER_OPTIONS, type DocumentViewMode, type EditorLayer } from "./use-document-view-mode"
import { useViewStateStore, isLayerLocked } from "../use-view-state-store"
import { EDITOR_CONTENT_WIDTH } from "@/lib/themes"
import type { ContentWidth } from "../app-config"
import { CANONICAL_EMPTY_CANVAS } from "@/lib/canvas-format"
import { defaultSketchJson } from "@/lib/sketch-format"

export interface DocumentBodyProps {
  docId: string
  docTitle: string
  docPath: string
  docModified: string
  content: string
  onContentChange: (content: string) => void
  onContentDirty?: () => void
  activeLayer: EditorLayer
  viewMode: DocumentViewMode
  onViewModeChange: (mode: DocumentViewMode) => void
  contentWidth: ContentWidth
  onContentWidthChange?: (width: ContentWidth) => void
  isLocked: boolean
  onToggleLock?: () => void
  fileIcon?: string
  onFileIconChange?: (icon: string) => void
  editingTitle: boolean
  onEditingTitleChange: (editing: boolean) => void
  onRenameTitle?: (newName: string) => void
  nestedNotes: TreeItem[]
  nestedNotesPlacement: "top" | "bottom" | "hidden"
  onNestedNotesPlacementChange?: (placement: "top" | "bottom" | "hidden") => void
  onOpenItem?: (id: string) => void
  onOpenNestedNoteInNewTab?: (id: string) => void
  onTagClick?: (tag: string) => void
  onWikiLinkClick?: (target: string) => void
  resolveWikiLinkTarget?: (target: string) => string | null
  fetchTransclusion?: (target: string) => Promise<string | null>
  vault?: string
  canvasValue?: string
  onCanvasChange?: (json: string) => void
  onOpenCanvasNote?: (file: string) => void
  sketchValue?: string
  onSketchChange?: (json: string) => void
  databaseBody?: React.ReactNode
  editorSelection: MarkdownSelection | null
  onEditorSelectionChange: (selection: MarkdownSelection) => void
  editorRef: React.RefObject<EditorHandle>
  scrollPositionKey?: string
  scrollPosition?: number
  onScrollPositionChange?: (position: number) => void
  viewModeMenuOpen: boolean
  onViewModeMenuOpenChange: (open: boolean) => void
  treeItems?: TreeItem[]
}

export function DocumentBody({
  docId,
  docTitle,
  docPath,
  docModified,
  content,
  onContentChange,
  onContentDirty,
  activeLayer,
  viewMode,
  onViewModeChange,
  contentWidth,
  onContentWidthChange,
  isLocked,
  onToggleLock,
  fileIcon,
  onFileIconChange,
  editingTitle,
  onEditingTitleChange,
  onRenameTitle,
  nestedNotes,
  nestedNotesPlacement,
  onNestedNotesPlacementChange,
  onOpenItem,
  onOpenNestedNoteInNewTab,
  onTagClick,
  onWikiLinkClick,
  resolveWikiLinkTarget,
  fetchTransclusion,
  vault,
  canvasValue,
  onCanvasChange,
  onOpenCanvasNote,
  sketchValue,
  onSketchChange,
  databaseBody,
  editorSelection,
  onEditorSelectionChange,
  editorRef,
  scrollPositionKey,
  scrollPosition,
  onScrollPositionChange,
  viewModeMenuOpen,
  onViewModeMenuOpenChange,
  treeItems,
}: DocumentBodyProps) {
  const { t } = useTranslation()
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const lastScrollTopRef = React.useRef(scrollPosition ?? 0)
  const onScrollPositionChangeRef = React.useRef(onScrollPositionChange)

  React.useEffect(() => {
    onScrollPositionChangeRef.current = onScrollPositionChange
  }, [onScrollPositionChange])

  React.useEffect(() => {
    if (scrollPosition !== undefined) lastScrollTopRef.current = Math.max(0, scrollPosition)
  }, [scrollPosition])

  React.useLayoutEffect(() => {
    if (activeLayer !== "editor") return
    const element = scrollRef.current
    if (!element) return
    const top = Math.max(0, scrollPosition ?? lastScrollTopRef.current)
    element.scrollTop = top
    const frame = requestAnimationFrame(() => {
      element.scrollTop = top
    })
    return () => cancelAnimationFrame(frame)
  }, [scrollPositionKey, activeLayer, scrollPosition])

  const deferredContent = React.useDeferredValue(content)
  const liveWordCount = React.useMemo(
    () =>
      deferredContent
        .split("\n")
        .map((line) => line.replace(/^\s{0,3}#{1,6}\s+/u, ""))
        .join(" ")
        .split(/\s+/)
        .filter(Boolean).length,
    [deferredContent],
  )

  const [visitedLayers, setVisitedLayers] = React.useState<Set<EditorLayer>>(
    () => new Set([activeLayer]),
  )
  const prevDocIdRef = React.useRef(docId)
  if (prevDocIdRef.current !== docId) {
    prevDocIdRef.current = docId
    setVisitedLayers(new Set([activeLayer]))
  }

  React.useEffect(() => {
    setVisitedLayers((prev) => {
      if (prev.has(activeLayer)) return prev
      const next = new Set(prev)
      next.add(activeLayer)
      return next
    })
  }, [activeLayer])

  const viewModes = useViewStateStore((s) => s.viewModes)
  const lockedFileIds = useViewStateStore((s) => s.lockedFileIds)
  const canvasLocked = isLayerLocked(lockedFileIds, viewModes, docId, "canvas")
  const sketchLocked = isLayerLocked(lockedFileIds, viewModes, docId, "sketch")

  const activeLayerMeta =
    LAYER_OPTIONS.find((option) => option.id === activeLayer) ?? LAYER_OPTIONS[0]
  const ActiveLayerIcon = activeLayerMeta.icon

  const nestedNotesBar =
    nestedNotes.length > 0 && nestedNotesPlacement !== "hidden" ? (
      <div
        className={
          nestedNotesPlacement === "bottom" ? "mt-8 border-t border-border pt-4" : "mb-2 -mt-1"
        }
      >
        <div className="flex flex-wrap gap-2">
          {nestedNotes.map((note) => {
            const icon =
              note.icon && !KNOWN_ICONS.has(note.icon)
                ? note.icon
                : note.type === "canvas"
                  ? "🗺️"
                  : note.type === "sketch"
                    ? "✏️"
                    : note.type === "database"
                      ? "🗄️"
                      : "📄"
            return (
              <ContextMenu key={note.id}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-accent/45 px-3 py-2 text-sm text-foreground shadow-sm hover:border-primary/40 hover:bg-accent"
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

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {/* Editor Layer */}
      <div
        aria-hidden={activeLayer !== "editor"}
        className={
          activeLayer === "editor"
            ? "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            : "hidden"
        }
      >
        <div
          ref={scrollRef}
          className="amby-editor-scroll mr-2 min-h-0 min-w-0 flex-1 overscroll-none overflow-y-auto"
          onScroll={(event) => {
            // A display:none transition or inactive layer can emit a synthetic scroll event
            // with scrollTop=0. Never let that overwrite the user's saved position.
            if (
              activeLayer !== "editor" ||
              event.currentTarget.clientHeight === 0 ||
              event.currentTarget.offsetParent === null
            )
              return
            lastScrollTopRef.current = event.currentTarget.scrollTop
            onScrollPositionChangeRef.current?.(lastScrollTopRef.current)
          }}
        >
          <div
            className="mx-auto min-w-0 px-3 pb-8 pt-5 sm:px-8 sm:pt-6 lg:px-10"
            style={{ maxWidth: EDITOR_CONTENT_WIDTH[contentWidth] }}
          >
            <DocumentTitle
              title={docTitle}
              fileIcon={fileIcon}
              editingTitle={editingTitle}
              onEditingTitleChange={onEditingTitleChange}
              onRenameTitle={onRenameTitle}
              onFileIconChange={onFileIconChange}
            />

            {nestedNotesPlacement === "top" && nestedNotesBar ? (
              nestedNotesBar
            ) : (
              <div className="mb-2" />
            )}

            {viewMode === "source" ? (
              <SourceEditor
                key={`${docId}:${isLocked}`}
                value={content}
                onChange={onContentChange}
                onLocalEdit={onContentDirty}
                onTagClick={onTagClick}
                onWikiLinkClick={onWikiLinkClick}
                editorRef={editorRef}
                placeholder={t("editor.placeholder")}
                selection={editorSelection}
                onSelectionChange={onEditorSelectionChange}
                editable={!isLocked}
              />
            ) : (
              <TiptapEditor
                key={docId}
                value={content}
                onChange={onContentChange}
                onContentDirty={onContentDirty}
                editorRef={editorRef}
                editable={viewMode === "live" && !isLocked}
                isReadOnly={viewMode === "read"}
                onTagClick={onTagClick}
                onWikiLinkClick={onWikiLinkClick}
                resolveWikiLinkTarget={resolveWikiLinkTarget}
                fetchTransclusion={fetchTransclusion}
                placeholder={t("editor.placeholder")}
                vaultPath={vault}
                notePath={docPath}
                selection={editorSelection}
                onSelectionChange={onEditorSelectionChange}
              />
            )}
            {nestedNotesPlacement === "bottom" && nestedNotesBar}
          </div>
        </div>

        {/* Floating Area Controls widget (Canvas benchmark style) */}
        <DocumentAreaControls
          docModified={docModified}
          wordCount={liveWordCount}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          viewModeMenuOpen={viewModeMenuOpen}
          onViewModeMenuOpenChange={onViewModeMenuOpenChange}
          isLocked={isLocked}
          onToggleLock={onToggleLock}
          onUndo={() => editorRef.current?.undo()}
          onRedo={() => editorRef.current?.redo()}
          contentWidth={contentWidth}
          onContentWidthChange={onContentWidthChange}
          nestedNotes={nestedNotes}
          nestedNotesPlacement={nestedNotesPlacement}
          onNestedNotesPlacementChange={onNestedNotesPlacementChange}
        />
      </div>

      {/* Database Layer */}
      {visitedLayers.has("database") &&
        (databaseBody ? (
          <div
            aria-hidden={activeLayer !== "database"}
            className={
              activeLayer === "database"
                ? "relative mr-2 flex min-h-0 min-w-0 flex-1 overflow-hidden"
                : "hidden"
            }
          >
            {databaseBody}
          </div>
        ) : activeLayer === "database" ? (
          <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-8">
            <div className="flex min-h-[360px] w-full max-w-md flex-col items-center justify-center gap-3 rounded border border-dashed border-border bg-background/40 text-center">
              <div className="flex size-12 items-center justify-center rounded border border-border bg-card text-foreground">
                <ActiveLayerIcon className="size-5" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{t(activeLayerMeta.labelKey)}</p>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  {t("docEditor.layerCreated")}
                </p>
              </div>
            </div>
          </div>
        ) : null)}

      {/* Canvas Layer */}
      {visitedLayers.has("canvas") && (
        <div
          aria-hidden={activeLayer !== "canvas"}
          className={
            activeLayer === "canvas"
              ? "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              : "hidden"
          }
        >
          <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <CanvasEditor
              key={`${docId}:canvas`}
              value={canvasValue ?? CANONICAL_EMPTY_CANVAS}
              onChange={(json) => onCanvasChange?.(json)}
              onLocalEdit={onContentDirty}
              vault={vault ?? null}
              notePath={docPath}
              onOpenNote={onOpenCanvasNote}
              treeItems={treeItems}
              isLocked={canvasLocked}
              onToggleLock={onToggleLock}
            />
          </div>
        </div>
      )}

      {/* Sketch Layer */}
      {visitedLayers.has("sketch") && (
        <div
          aria-hidden={activeLayer !== "sketch"}
          className={
            activeLayer === "sketch"
              ? "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              : "hidden"
          }
        >
          <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <SketchEditor
              key={`${docId}:sketch`}
              value={sketchValue ?? defaultSketchJson()}
              onChange={(json) => onSketchChange?.(json)}
              onLocalEdit={onContentDirty}
              vault={vault ?? null}
              notePath={docPath}
              isLocked={sketchLocked}
              onToggleLock={onToggleLock}
            />
          </div>
        </div>
      )}
    </div>
  )
}
