"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Check,
  Code2,
  Eye,
  EyeOff,
  FileText,
  PanelBottom,
  PanelTop,
  PenLine,
  Redo2,
  SquareArrowOutUpRight,
  Undo2,
} from "lucide-react"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SourceEditor } from "../source-editor"
import { TiptapEditor } from "../tiptap/TiptapEditor"
import { CanvasEditor } from "../canvas-editor"
import type { EditorHandle } from "../tiptap/constants"
import type { MarkdownSelection } from "../tiptap/markdown-selection"
import { IconValue } from "../icon-value"
import type { TreeItem } from "../sidebar-tree"
import { stripMdExt } from "./document-breadcrumbs-utils"
import { DocumentTitle } from "./document-title"
import { LAYER_OPTIONS, type DocumentViewMode, type EditorLayer } from "./use-document-view-mode"

export interface DocumentBodyProps {
  docId: string
  docTitle: string
  docPath: string
  docModified: string
  content: string
  onContentChange: (content: string) => void
  activeLayer: EditorLayer
  viewMode: DocumentViewMode
  onViewModeChange: (mode: DocumentViewMode) => void
  isLocked: boolean
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
  editorSelection: MarkdownSelection | null
  onEditorSelectionChange: (selection: MarkdownSelection) => void
  editorRef: React.RefObject<EditorHandle>
  viewModeMenuOpen: boolean
  onViewModeMenuOpenChange: (open: boolean) => void
}

export function DocumentBody({
  docId,
  docTitle,
  docPath,
  docModified,
  content,
  onContentChange,
  activeLayer,
  viewMode,
  onViewModeChange,
  isLocked,
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
  editorSelection,
  onEditorSelectionChange,
  editorRef,
  viewModeMenuOpen,
  onViewModeMenuOpenChange,
}: DocumentBodyProps) {
  const { t } = useTranslation()

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

  if (activeLayer === "canvas") {
    return (
      <div className="flex-1 overflow-hidden">
        <CanvasEditor
          key={`${docId}:canvas`}
          value={canvasValue ?? "{}"}
          onChange={(json) => onCanvasChange?.(json)}
          vault={vault ?? null}
          notePath={docPath}
          onOpenNote={onOpenCanvasNote}
        />
      </div>
    )
  }

  const activeLayerMeta =
    LAYER_OPTIONS.find((option) => option.id === activeLayer) ?? LAYER_OPTIONS[0]
  const ActiveLayerIcon = activeLayerMeta.icon

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

  return (
    <>
      <div className="amby-editor-scroll mr-2 min-h-0 flex-1 overscroll-none overflow-y-auto">
        <div
          className="mx-auto px-4 pb-8 pt-5 sm:px-8 sm:pt-6 lg:px-10"
          style={{ maxWidth: "var(--content-max-width, 48rem)" }}
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
            <div className="mb-5" />
          )}

          {activeLayer !== "editor" ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 rounded border border-dashed border-border bg-background/40 text-center">
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
          ) : viewMode === "source" ? (
            <SourceEditor
              key={`${docId}:${isLocked}`}
              value={content}
              onChange={onContentChange}
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

      {/* Floating stats widget */}
      <div className="pointer-events-none absolute bottom-4 right-4 z-10">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-background/90 px-3 py-1.5 shadow-sm backdrop-blur-sm">
          <span className="text-[11px] text-muted-foreground">{docModified}</span>
          <span className="text-border">·</span>
          <span className="text-[11px] text-muted-foreground">
            {t("docEditor.wordCount", { count: liveWordCount })}
          </span>
          <div className="mx-1 h-3 w-px bg-accent" />
          <DropdownMenu open={viewModeMenuOpen} onOpenChange={onViewModeMenuOpenChange}>
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
                  onSelect={() => onViewModeChange(mode)}
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
    </>
  )
}
