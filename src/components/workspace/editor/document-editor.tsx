"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, FilePlus, FolderOpen } from "lucide-react"

import type { EditorHandle } from "../tiptap/constants"
import type { MarkdownSelection } from "../tiptap/markdown-selection"
import type { HeaderTab } from "../header-tabs"
import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "../tiptap/floating-menu-events"
import type { TreeItem } from "../sidebar-tree"
import type { NoteProperties } from "@/lib/storage"
import { flattenTree, relativeToVault } from "./document-breadcrumbs-utils"
import { FilePickerModal, LayerConfirmDialog, type LayerKind } from "./document-actions"
import { DocumentHeader } from "./document-header"
import { DocumentBody } from "./document-body"
import { NotePdfExport, NotePdfExportDialog, type PdfExportOptions } from "./note-pdf-export"
import { noteEditingPolicy } from "./note-editing-policy"
import type { DocumentViewMode, EditorLayer } from "./use-document-view-mode"
import { Button } from "@/components/ui/button"
import { editorSurfaceLeases, type EditorSurface } from "../database/peek/editor-surface-lease"
import type { ContentWidth } from "../app-config"

export interface Document {
  id: string
  title: string
  content: string
  modified: string
  wordCount: number
  path: string
  noteProperties?: NoteProperties
  externallyDeleted?: boolean
}

export interface DocumentEditorProps {
  document: Document | null
  onContentChange?: (content: string, sourceDocumentId: string) => void
  onContentDirty?: (sourceDocumentId: string) => void
  onRestoreDeleted?: () => void | Promise<void>
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
  databasesEnabled?: boolean
  canCreateDatabaseLayer?: boolean
  viewMode?: DocumentViewMode
  onViewModeChange?: (mode: DocumentViewMode) => void
  contentWidth?: ContentWidth
  onContentWidthChange?: (width: ContentWidth) => void
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
  onCreateFolder?: (parentId: string | null, name: string) => void
  onMergeFile?: (targetId: string) => void
  onShowInExplorer?: () => void
  onDeleteFile?: () => void
  treeItems?: TreeItem[]
  onOpenItem?: (id: string) => void
  onUnlinkLayer?: (layer: LayerKind) => void
  onDeleteLayer?: (layer: LayerKind) => void
  canvasValue?: string
  onCanvasChange?: (json: string) => void
  onOpenCanvasNote?: (file: string) => void
  databaseBody?: React.ReactNode
  editorSurfaceOwner?: EditorSurface
  scrollPositionKey?: string
  scrollPosition?: number
  onScrollPositionChange?: (position: number) => void
}

export function DocumentEditor({
  document,
  onContentChange,
  onContentDirty,
  onRestoreDeleted,
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
  databasesEnabled = false,
  canCreateDatabaseLayer = false,
  viewMode = "live",
  onViewModeChange,
  contentWidth = "normal",
  onContentWidthChange,
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
  onCreateFolder,
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
  databaseBody,
  editorSurfaceOwner = "document",
  scrollPositionKey,
  scrollPosition,
  onScrollPositionChange,
}: DocumentEditorProps) {
  const [content, setContent] = React.useState(document?.content ?? "")
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [moreActionsOpen, setMoreActionsOpen] = React.useState(false)
  const [viewModeMenuOpen, setViewModeMenuOpen] = React.useState(false)
  const [filePickerMode, setFilePickerMode] = React.useState<"move" | "merge" | null>(null)
  const [filePickerQuery, setFilePickerQuery] = React.useState("")
  const [layerConfirm, setLayerConfirm] = React.useState<EditorLayer | null>(null)
  const [editorSelection, setEditorSelection] = React.useState<MarkdownSelection | null>(null)
  const [restoringDeleted, setRestoringDeleted] = React.useState(false)
  const [restoreError, setRestoreError] = React.useState(false)
  const [pdfExportDialogOpen, setPdfExportDialogOpen] = React.useState(false)
  const [pdfExportRequest, setPdfExportRequest] = React.useState<{
    id: number
    options: PdfExportOptions
  } | null>(null)
  const editorSelectionRef = React.useRef<MarkdownSelection | null>(null)
  const editorRef = React.useRef<EditorHandle>(null as unknown as EditorHandle)
  const { t } = useTranslation()
  const editingPolicy = noteEditingPolicy(document?.noteProperties)
  const documentId = document?.id
  const leaseToken = React.useId()
  const [hasEditorLease, setHasEditorLease] = React.useState(!documentId)
  React.useLayoutEffect(() => {
    if (!documentId) {
      setHasEditorLease(true)
      return
    }
    const acquired = editorSurfaceLeases.acquire(documentId, editorSurfaceOwner, leaseToken)
    setHasEditorLease(acquired)
    return () => editorSurfaceLeases.release(documentId, leaseToken)
  }, [documentId, editorSurfaceOwner, leaseToken])
  const effectiveLocked = isLocked || editingPolicy.readOnly || !hasEditorLease
  const effectiveViewMode = editingPolicy.sourceOnly ? "source" : viewMode

  const flatTreeItems = React.useMemo(() => flattenTree(treeItems ?? []), [treeItems])
  const pickerQuery = filePickerQuery.trim().toLocaleLowerCase()
  const pickerItems = React.useMemo(() => {
    const candidates = flatTreeItems.filter((item) =>
      filePickerMode === "move"
        ? item.type === "folder"
        : item.type === "file" && item.id !== document?.id,
    )
    return candidates.filter((item) => {
      if (!pickerQuery) return true
      const relativePath = vault ? relativeToVault(item.path, vault) : item.path
      return [item.name, relativePath].some((value) =>
        value.toLocaleLowerCase().includes(pickerQuery),
      )
    })
  }, [document?.id, filePickerMode, flatTreeItems, pickerQuery, vault])

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
    setRestoringDeleted(false)
    setRestoreError(false)
  }, [document?.id, document?.externallyDeleted])

  async function restoreDeletedDocument() {
    if (!onRestoreDeleted || restoringDeleted) return
    setRestoringDeleted(true)
    setRestoreError(false)
    try {
      await onRestoreDeleted()
    } catch {
      setRestoreError(true)
    } finally {
      setRestoringDeleted(false)
    }
  }

  const handleContentChange = (v: string) => {
    if (!document || effectiveLocked) return
    setContent(v)
    onContentChange?.(v, document.id)
  }

  const handleContentDirty = React.useCallback(() => {
    if (!document || effectiveLocked) return
    onContentDirty?.(document.id)
  }, [document, effectiveLocked, onContentDirty])

  const handleEditorSelectionChange = React.useCallback((next: MarkdownSelection) => {
    editorSelectionRef.current = next
  }, [])

  const requestPdfExport = React.useCallback(() => setPdfExportDialogOpen(true), [])
  const startPdfExport = React.useCallback((options: PdfExportOptions) => {
    setPdfExportDialogOpen(false)
    setPdfExportRequest((current) => ({ id: (current?.id ?? 0) + 1, options }))
  }, [])
  const finishPdfExport = React.useCallback(() => setPdfExportRequest(null), [])

  const handleEditorViewModeChange = React.useCallback(
    (mode: DocumentViewMode) => {
      if (editingPolicy.sourceOnly && mode !== "source") return
      editorRef.current?.flush()
      setEditorSelection(editorRef.current?.getMarkdownSelection() ?? editorSelectionRef.current)
      onViewModeChange?.(mode)
    },
    [onViewModeChange, editingPolicy.sourceOnly],
  )

  const headerElement = (
    <DocumentHeader
      hasDocument={Boolean(document)}
      docId={document?.id}
      docTitle={document?.title}
      docPath={document?.path}
      treeItems={treeItems}
      onOpenItem={onOpenItem}
      onBack={onBack}
      onForward={onForward}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      isFocusMode={isFocusMode}
      hideNavigation={hideNavigation}
      onToggleFocusMode={onToggleFocusMode}
      focusTabs={focusTabs}
      activeTabKey={activeTabKey}
      onFocusTabChange={onFocusTabChange}
      focusFavorites={focusFavorites}
      onFocusToggleFavorite={onFocusToggleFavorite}
      onFocusCloseAllTabs={onFocusCloseAllTabs}
      activeLayer={activeLayer}
      onLayerChange={onLayerChange}
      linkedLayers={linkedLayers}
      databasesEnabled={databasesEnabled}
      canCreateDatabaseLayer={canCreateDatabaseLayer}
      onUnlinkLayer={onUnlinkLayer}
      onDeleteLayer={onDeleteLayer}
      isLocked={effectiveLocked}
      isFavorite={isFavorite}
      onToggleFavorite={onToggleFavorite}
      onOpenInNewTab={onOpenInNewTab}
      viewMode={effectiveViewMode}
      onViewModeChange={handleEditorViewModeChange}
      contentWidth={contentWidth}
      onContentWidthChange={(width) => onContentWidthChange?.(width)}
      nestedNotes={nestedNotes}
      nestedNotesPlacement={nestedNotesPlacement}
      onNestedNotesPlacementChange={onNestedNotesPlacementChange}
      onRequestAttachLayer={setLayerConfirm}
      onRequestMove={() => {
        setFilePickerQuery("")
        setFilePickerMode("move")
      }}
      onRequestMerge={() => {
        setFilePickerQuery("")
        setFilePickerMode("merge")
      }}
      onCopyPath={copyPath}
      onExportPdf={requestPdfExport}
      onShowInExplorer={onShowInExplorer}
      onRequestRename={() => setEditingTitle(true)}
      onDeleteFile={onDeleteFile}
      moreActionsOpen={moreActionsOpen}
      onMoreActionsOpenChange={(open) => setExclusiveMenu("actions", open)}
    />
  )

  const deletedBanner = document?.externallyDeleted ? (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-950 dark:text-amber-100"
    >
      <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-300" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t("conflict.deletedBannerTitle")}</p>
        <p className="text-xs text-amber-900/75 dark:text-amber-100/75">
          {t("conflict.deletedBannerDescription")}
        </p>
        {restoreError && (
          <p className="mt-1 text-xs text-destructive">{t("conflict.restoreFailed")}</p>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={restoringDeleted}
        onClick={() => void restoreDeletedDocument()}
        className="shrink-0 border-amber-500/40 bg-transparent text-amber-950 hover:bg-amber-500/15 dark:text-amber-100"
      >
        {restoringDeleted ? t("conflict.saving") : t("conflict.restoreDeleted")}
      </Button>
    </div>
  ) : null

  const pdfExportDialog = document ? (
    <NotePdfExportDialog
      open={pdfExportDialogOpen}
      title={document.title}
      onOpenChange={setPdfExportDialogOpen}
      onExport={startPdfExport}
    />
  ) : null

  const pdfExport =
    pdfExportRequest !== null && document ? (
      <NotePdfExport
        key={pdfExportRequest.id}
        title={document.title}
        content={content}
        vaultPath={vault}
        notePath={document.path}
        options={pdfExportRequest.options}
        onFinished={finishPdfExport}
      />
    ) : null

  if (!document) {
    return (
      <div className="flex h-full flex-1 flex-col bg-background">
        {headerElement}
        <div className="flex flex-1 flex-col items-center justify-center gap-6">
          <div className="text-center">
            <p className="text-lg font-medium text-foreground">{t("docEditor.noNotes")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("docEditor.noNotesHint")}</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={onNewFile}
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-foreground hover:bg-accent hover:border-border"
            >
              <FilePlus className="size-4 text-muted-foreground" />
              {t("docEditor.createNote")}
            </button>
            <button
              onClick={onOpenVault}
              className="flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm text-muted-foreground hover:bg-card hover:text-foreground"
            >
              <FolderOpen className="size-4" />
              {t("docEditor.openVault")}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (activeLayer === "canvas") {
    return (
      <div className="relative flex h-full flex-1 flex-col bg-background">
        {headerElement}
        {deletedBanner}
        {editingPolicy.warningKey && (
          <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
            {t(editingPolicy.warningKey)}
          </p>
        )}
        <DocumentBody
          docId={document.id}
          docTitle={document.title}
          docPath={document.path}
          docModified={document.modified}
          content={content}
          onContentChange={handleContentChange}
          onContentDirty={handleContentDirty}
          activeLayer={activeLayer}
          viewMode={effectiveViewMode}
          onViewModeChange={handleEditorViewModeChange}
          contentWidth={contentWidth}
          isLocked={effectiveLocked}
          fileIcon={fileIcon}
          onFileIconChange={onFileIconChange}
          editingTitle={editingTitle}
          onEditingTitleChange={setEditingTitle}
          onRenameTitle={onRenameTitle}
          nestedNotes={nestedNotes}
          nestedNotesPlacement={nestedNotesPlacement}
          onNestedNotesPlacementChange={onNestedNotesPlacementChange}
          onOpenItem={onOpenItem}
          onOpenNestedNoteInNewTab={onOpenNestedNoteInNewTab}
          onTagClick={onTagClick}
          onWikiLinkClick={onWikiLinkClick}
          resolveWikiLinkTarget={resolveWikiLinkTarget}
          fetchTransclusion={fetchTransclusion}
          vault={vault}
          canvasValue={canvasValue}
          onCanvasChange={onCanvasChange}
          onOpenCanvasNote={onOpenCanvasNote}
          databaseBody={databaseBody}
          editorSelection={editorSelection}
          onEditorSelectionChange={handleEditorSelectionChange}
          editorRef={editorRef}
          scrollPositionKey={scrollPositionKey}
          scrollPosition={scrollPosition}
          onScrollPositionChange={onScrollPositionChange}
          viewModeMenuOpen={viewModeMenuOpen}
          onViewModeMenuOpenChange={(open) => setExclusiveMenu("view", open)}
        />
        {pdfExportDialog}
        {pdfExport}
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      <div
        className={`${isFocusMode ? "" : "mb-2"} mt-0 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/80 bg-[var(--note-surface)]`}
        style={{ boxShadow: "var(--note-surface-shadow)" }}
      >
        {headerElement}
        {deletedBanner}
        {editingPolicy.warningKey && (
          <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
            {t(editingPolicy.warningKey)}
          </p>
        )}
        <DocumentBody
          docId={document.id}
          docTitle={document.title}
          docPath={document.path}
          docModified={document.modified}
          content={content}
          onContentChange={handleContentChange}
          onContentDirty={handleContentDirty}
          activeLayer={activeLayer}
          viewMode={effectiveViewMode}
          onViewModeChange={handleEditorViewModeChange}
          contentWidth={contentWidth}
          isLocked={effectiveLocked}
          fileIcon={fileIcon}
          onFileIconChange={onFileIconChange}
          editingTitle={editingTitle}
          onEditingTitleChange={setEditingTitle}
          onRenameTitle={onRenameTitle}
          nestedNotes={nestedNotes}
          nestedNotesPlacement={nestedNotesPlacement}
          onNestedNotesPlacementChange={onNestedNotesPlacementChange}
          onOpenItem={onOpenItem}
          onOpenNestedNoteInNewTab={onOpenNestedNoteInNewTab}
          onTagClick={onTagClick}
          onWikiLinkClick={onWikiLinkClick}
          resolveWikiLinkTarget={resolveWikiLinkTarget}
          fetchTransclusion={fetchTransclusion}
          vault={vault}
          canvasValue={canvasValue}
          onCanvasChange={onCanvasChange}
          onOpenCanvasNote={onOpenCanvasNote}
          databaseBody={databaseBody}
          editorSelection={editorSelection}
          onEditorSelectionChange={handleEditorSelectionChange}
          editorRef={editorRef}
          scrollPositionKey={scrollPositionKey}
          scrollPosition={scrollPosition}
          onScrollPositionChange={onScrollPositionChange}
          viewModeMenuOpen={viewModeMenuOpen}
          onViewModeMenuOpenChange={(open) => setExclusiveMenu("view", open)}
        />
      </div>

      <LayerConfirmDialog
        layerConfirm={layerConfirm}
        onClose={() => setLayerConfirm(null)}
        onConfirm={(layer) => {
          onLayerChange?.(layer)
          setLayerConfirm(null)
        }}
      />

      <FilePickerModal
        filePickerMode={filePickerMode}
        onClose={() => {
          setFilePickerMode(null)
          setFilePickerQuery("")
        }}
        filePickerQuery={filePickerQuery}
        onQueryChange={setFilePickerQuery}
        pickerItems={pickerItems}
        vault={vault}
        onMoveFile={onMoveFile}
        onCreateFolder={onCreateFolder}
        onMergeFile={onMergeFile}
      />
      {pdfExportDialog}
      {pdfExport}
    </div>
  )
}
