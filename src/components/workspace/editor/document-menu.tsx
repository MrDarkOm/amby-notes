import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Archive,
  Code2,
  Columns2,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileDown,
  Files,
  FileText,
  FolderInput,
  FolderOpen,
  GitMerge,
  Layers,
  LayoutGrid,
  PanelBottom,
  PanelTop,
  PenLine,
  Plus,
  Rows2,
  SquareArrowOutUpRight,
  Star,
  Trash2,
  Unlink,
  ArrowLeftRight,
} from "lucide-react"

import type { TreeItem } from "../sidebar-tree"
import { useSettingsStore } from "../use-settings-store"
import type { ContentWidth } from "../app-config"
import { bottomBarMenuItem, contentWidthMenuItem } from "../page-chrome/page-menu-items"
import type { PageMenuGroup, PageMenuItem } from "../page-chrome/page-chrome-types"
import type { DocumentViewMode, EditorLayer } from "./use-document-view-mode"
import type { LayerKind } from "./document-actions"

const MUTED = "size-3.5 text-muted-foreground"

export interface DocumentMenuArgs {
  hasDocument: boolean
  activeLayer: EditorLayer
  onLayerChange?: (layer: EditorLayer) => void
  onUnlinkLayer?: (layer: LayerKind) => void
  onDeleteLayer?: (layer: LayerKind) => void
  docPath?: string
  primaryLayer?: EditorLayer
  onSetPrimaryLayer?: (layer: EditorLayer) => void
  databasesEnabled?: boolean
  canvasEnabled?: boolean
  sketchEnabled?: boolean
  isLocked: boolean
  onToggleLock?: () => void
  viewMode: DocumentViewMode
  onViewModeChange: (mode: DocumentViewMode) => void
  contentWidth: ContentWidth
  onContentWidthChange: (width: ContentWidth) => void
  nestedNotes: TreeItem[]
  nestedNotesPlacement: "top" | "bottom" | "hidden"
  onNestedNotesPlacementChange?: (placement: "top" | "bottom" | "hidden") => void
  linkedLayers?: { note?: boolean; canvas: boolean; sketch: boolean; database: boolean }
  canCreateDatabaseLayer?: boolean
  onRequestAttachLayer: (layer: EditorLayer) => void
  isFavorite?: boolean
  onToggleFavorite?: () => void
  onOpenInNewTab?: () => void
  onSplitRight?: () => void
  onSplitDown?: () => void
  onRequestMove: () => void
  onRequestMerge: () => void
  onCopyPath: (kind: "app" | "vault" | "absolute") => void
  onExportPdf: () => void
  onExportCsv?: () => void
  onExportSqlite?: () => void
  onExportImage?: (format: "png" | "jpg") => void
  onShowInExplorer?: () => void
  onRequestRename: () => void
  onDeleteFile?: (mode?: "archive") => void
}

/**
 * The note's "⋯" menu as groups of rows for the shared page header: the view modes and width, the
 * nested notes, the layers, the tab actions, the file actions and the ones that remove.
 */
export function useDocumentMenuGroups({
  hasDocument,
  activeLayer,
  onLayerChange,
  onUnlinkLayer,
  onDeleteLayer,
  docPath,
  primaryLayer,
  onSetPrimaryLayer,
  databasesEnabled = false,
  canvasEnabled = true,
  sketchEnabled = true,
  isLocked,
  onToggleLock,
  viewMode,
  onViewModeChange,
  contentWidth,
  onContentWidthChange,
  nestedNotes,
  nestedNotesPlacement,
  onNestedNotesPlacementChange,
  linkedLayers,
  canCreateDatabaseLayer = false,
  onRequestAttachLayer,
  isFavorite,
  onToggleFavorite,
  onOpenInNewTab,
  onSplitRight,
  onSplitDown,
  onRequestMove,
  onRequestMerge,
  onCopyPath,
  onExportPdf,
  onExportCsv,
  onExportSqlite,
  onExportImage,
  onShowInExplorer,
  onRequestRename,
  onDeleteFile,
}: DocumentMenuArgs): PageMenuGroup[] {
  const { t } = useTranslation()
  const showAreaControls = useSettingsStore((s) => s.prefs.editor.showAreaControls ?? true)

  const hasNote = Boolean(
    linkedLayers?.note ||
    activeLayer === "editor" ||
    (!linkedLayers?.canvas && !linkedLayers?.sketch && !linkedLayers?.database),
  )
  const hasDatabase = Boolean(
    databasesEnabled && (linkedLayers?.database || activeLayer === "database"),
  )
  const hasCanvas = Boolean(canvasEnabled && (linkedLayers?.canvas || activeLayer === "canvas"))
  const hasSketch = Boolean(sketchEnabled && (linkedLayers?.sketch || activeLayer === "sketch"))

  const totalLayersCount =
    (hasNote ? 1 : 0) + (hasDatabase ? 1 : 0) + (hasCanvas ? 1 : 0) + (hasSketch ? 1 : 0)

  const canAttachNote = !hasNote
  const canAttachDatabase = canCreateDatabaseLayer && !hasDatabase
  const canAttachCanvas = Boolean(canvasEnabled && !hasCanvas)
  const canAttachSketch = Boolean(sketchEnabled && !hasSketch)
  const hasAttachableLayers =
    canAttachNote || canAttachDatabase || canAttachCanvas || canAttachSketch

  const naturalDefaultLayer: EditorLayer = docPath?.endsWith(".canvas")
    ? "canvas"
    : docPath?.endsWith(".excalidraw")
      ? "sketch"
      : docPath?.endsWith(".json")
        ? "database"
        : "editor"
  const effectivePrimaryLayer = primaryLayer ?? naturalDefaultLayer

  const detachableLayers: Array<{
    kind: LayerKind
    icon: React.ComponentType<{ className?: string }>
    deleteLabel: string
    detachLabel: string
  }> = []

  if (totalLayersCount > 1) {
    if (linkedLayers?.database) {
      detachableLayers.push({
        kind: "database",
        icon: Database,
        deleteLabel: t("docEditor.deleteDatabase"),
        detachLabel: t("docEditor.detachDatabase"),
      })
    }
    if (linkedLayers?.canvas) {
      detachableLayers.push({
        kind: "canvas",
        icon: LayoutGrid,
        deleteLabel: t("docEditor.deleteCanvas"),
        detachLabel: t("docEditor.detachCanvas"),
      })
    }
    if (linkedLayers?.sketch) {
      detachableLayers.push({
        kind: "sketch",
        icon: PenLine,
        deleteLabel: t("docEditor.deleteSketch"),
        detachLabel: t("docEditor.detachSketch"),
      })
    }
    if (linkedLayers?.note && docPath && !docPath.endsWith(".md")) {
      detachableLayers.push({
        kind: "note",
        icon: FileText,
        deleteLabel: t("docEditor.deleteNote"),
        detachLabel: t("docEditor.detachNote"),
      })
    }
  }

  const hasLayerActions = totalLayersCount > 1 || hasAttachableLayers
  const icon = (Icon: React.ComponentType<{ className?: string }>) => <Icon className={MUTED} />
  const off = !hasDocument

  // The layers present, in the order the menu lists them.
  const layerChoices: Array<{ layer: EditorLayer; Icon: typeof FileText; label: string }> = [
    ...(hasNote
      ? [{ layer: "editor" as const, Icon: FileText, label: t("docEditor.markdownEditor") }]
      : []),
    ...(hasDatabase
      ? [{ layer: "database" as const, Icon: Database, label: t("docEditor.databaseLayer") }]
      : []),
    ...(hasCanvas
      ? [{ layer: "canvas" as const, Icon: LayoutGrid, label: t("docEditor.canvasLayer") }]
      : []),
    ...(hasSketch
      ? [{ layer: "sketch" as const, Icon: PenLine, label: t("docEditor.sketchLayer") }]
      : []),
  ]
  const layerChoice = (
    prefix: string,
    current: EditorLayer,
    onChoose: ((layer: EditorLayer) => void) | undefined,
  ): PageMenuItem[] =>
    layerChoices.map(({ layer, Icon, label }) => ({
      id: `${prefix}-${layer}`,
      label,
      icon: icon(Icon),
      checked: current === layer,
      checkStyle: "icon" as const,
      disabled: off,
      onSelect: () => onChoose?.(layer),
    }))

  const modeRows: PageMenuItem[] =
    activeLayer === "editor"
      ? (
          [
            ["live", PenLine, "docEditor.viewLive"],
            ["source", Code2, "docEditor.viewSource"],
            ["read", Eye, "docEditor.viewRead"],
          ] as const
        ).map(([mode, Icon, labelKey]) => ({
          id: `view-${mode}`,
          label: t(labelKey),
          icon: icon(Icon),
          checked: viewMode === mode,
          disabled: off,
          onSelect: () => onViewModeChange(mode),
        }))
      : [
          {
            id: "view-live",
            label: t("docEditor.viewLive"),
            icon: icon(PenLine),
            checked: !isLocked && viewMode !== "read",
            disabled: off,
            onSelect: () => {
              if (isLocked) onToggleLock?.()
              if (viewMode === "read") onViewModeChange("live")
            },
          },
          {
            id: "view-read",
            label: t("docEditor.viewRead"),
            icon: icon(Eye),
            checked: isLocked || viewMode === "read",
            disabled: off,
            onSelect: () => {
              if (!isLocked) onToggleLock?.()
              onViewModeChange("read")
            },
          },
        ]

  const viewGroup: PageMenuItem[] = [...modeRows]
  if (activeLayer === "editor" || activeLayer === "database") {
    viewGroup.push(contentWidthMenuItem(t, contentWidth, onContentWidthChange, off))
  }
  if (activeLayer === "editor") {
    viewGroup.push(bottomBarMenuItem(t, showAreaControls, off))
  }

  const nestedGroup: PageMenuItem[] =
    activeLayer === "editor" && nestedNotes.length > 0
      ? [
          {
            id: "nested-notes",
            label: t("docEditor.nestedNotesDisplay"),
            icon: icon(Files),
            submenuWidth: "w-48",
            submenu: [
              (["top", "bottom", "hidden"] as const).map((placement) => ({
                id: `nested-${placement}`,
                label: t(`docEditor.nestedNotes_${placement}`),
                icon: icon(
                  placement === "top" ? PanelTop : placement === "bottom" ? PanelBottom : EyeOff,
                ),
                checked: nestedNotesPlacement === placement,
                onSelect: () => onNestedNotesPlacementChange?.(placement),
              })),
            ],
          },
        ]
      : []

  const layerGroup: PageMenuItem[] = []
  if (hasLayerActions) {
    if (totalLayersCount > 1) {
      layerGroup.push({
        id: "primary-layer",
        label: t("docEditor.primaryLayer"),
        icon: icon(Layers),
        submenuWidth: "w-48",
        submenu: [layerChoice("primary", effectivePrimaryLayer, onSetPrimaryLayer)],
      })
      layerGroup.push({
        id: "switch-layer",
        label: t("docEditor.switchLayer"),
        icon: icon(ArrowLeftRight),
        submenuWidth: "w-48",
        submenu: [layerChoice("switch", activeLayer, onLayerChange)],
      })
    }
    if (hasAttachableLayers) {
      const attachable: Array<[boolean, EditorLayer, typeof FileText, string]> = [
        [canAttachNote, "editor", FileText, t("docEditor.markdownEditor")],
        [canAttachDatabase, "database", Database, t("docEditor.databaseLayer")],
        [canAttachCanvas, "canvas", LayoutGrid, t("docEditor.canvasLayer")],
        [canAttachSketch, "sketch", PenLine, t("docEditor.sketchLayer")],
      ]
      layerGroup.push({
        id: "add-layer",
        label: t("docEditor.addLayer"),
        icon: icon(Plus),
        submenuWidth: "w-52",
        submenu: [
          attachable
            .filter(([can]) => can)
            .map(([, layer, Icon, label]) => ({
              id: `attach-${layer}`,
              label,
              icon: icon(Icon),
              onSelect: () => onRequestAttachLayer(layer),
            })),
        ],
      })
    }
    if (totalLayersCount > 1 && detachableLayers.length > 0) {
      layerGroup.push({
        id: "remove-layer",
        label: t("docEditor.removeLayer"),
        icon: icon(Unlink),
        submenuWidth: "w-56",
        submenu: detachableLayers.map((layer) => {
          const LayerIcon = layer.icon
          return [
            {
              id: `delete-${layer.kind}`,
              label: <span>{layer.deleteLabel}</span>,
              icon: <LayerIcon className="size-3.5 text-red-400" />,
              destructive: true,
              onSelect: () => onDeleteLayer?.(layer.kind),
            },
            {
              id: `detach-${layer.kind}`,
              label: <span>{layer.detachLabel}</span>,
              icon: icon(LayerIcon),
              onSelect: () => onUnlinkLayer?.(layer.kind),
            },
          ]
        }),
      })
    }
  }

  const tabGroup: PageMenuItem[] = [
    {
      id: "favorite",
      label: isFavorite ? t("tree.removeBookmark") : t("tree.addBookmark"),
      icon: isFavorite ? <Star className="size-3.5 fill-current text-primary" /> : icon(Star),
      disabled: off || !onToggleFavorite,
      onSelect: onToggleFavorite,
    },
    {
      id: "open-in-new-tab",
      label: t("tree.openInNewTab"),
      icon: icon(SquareArrowOutUpRight),
      disabled: off || !onOpenInNewTab,
      onSelect: onOpenInNewTab,
    },
    ...(onSplitRight
      ? [
          {
            id: "split-right",
            label: t("tabs.splitRight"),
            icon: icon(Columns2),
            disabled: off,
            onSelect: onSplitRight,
          },
        ]
      : []),
    ...(onSplitDown
      ? [
          {
            id: "split-down",
            label: t("tabs.splitDown"),
            icon: icon(Rows2),
            disabled: off,
            onSelect: onSplitDown,
          },
        ]
      : []),
  ]

  const exportRow: PageMenuItem =
    activeLayer === "editor"
      ? {
          id: "export-pdf",
          label: t("docEditor.exportPdf"),
          icon: icon(FileDown),
          disabled: off,
          onSelect: onExportPdf,
        }
      : {
          id: "export",
          label: t("docEditor.export"),
          icon: icon(FileDown),
          disabled: off,
          submenuWidth: "w-48",
          submenu: [
            activeLayer === "database"
              ? [
                  {
                    id: "export-csv",
                    label: t("docEditor.exportCsv"),
                    icon: icon(FileDown),
                    onSelect: onExportCsv,
                  },
                  {
                    id: "export-sqlite",
                    label: t("docEditor.exportSqlite"),
                    icon: icon(FileDown),
                    onSelect: onExportSqlite,
                  },
                ]
              : [
                  {
                    id: "export-png",
                    label: t("docEditor.exportPng"),
                    icon: icon(FileDown),
                    onSelect: () => onExportImage?.("png"),
                  },
                  {
                    id: "export-jpg",
                    label: t("docEditor.exportJpg"),
                    icon: icon(FileDown),
                    onSelect: () => onExportImage?.("jpg"),
                  },
                ],
          ],
        }

  const fileGroup: PageMenuItem[] = [
    {
      id: "move",
      label: t("docEditor.moveFile"),
      icon: icon(FolderInput),
      onSelect: onRequestMove,
    },
    {
      id: "merge",
      label: t("docEditor.mergeWith"),
      icon: icon(GitMerge),
      onSelect: onRequestMerge,
    },
    {
      id: "copy-path",
      label: t("docEditor.copyPath"),
      icon: icon(Copy),
      submenuWidth: "w-56",
      submenu: [
        (["app", "vault", "absolute"] as const).map((kind) => ({
          id: `copy-path-${kind}`,
          label: t(`docEditor.copyPath_${kind}`),
          icon: icon(Copy),
          onSelect: () => onCopyPath(kind),
        })),
      ],
    },
    exportRow,
  ]

  const removeGroup: PageMenuItem[] = [
    {
      id: "show-in-explorer",
      label: t("tree.showInExplorer"),
      icon: icon(FolderOpen),
      disabled: off || !onShowInExplorer,
      onSelect: onShowInExplorer,
    },
    {
      id: "rename",
      label: t("tree.rename"),
      icon: icon(PenLine),
      disabled: off,
      onSelect: onRequestRename,
    },
    {
      id: "archive",
      label: t("workspace.archive"),
      icon: icon(Archive),
      disabled: off || !onDeleteFile,
      onSelect: () => onDeleteFile?.("archive"),
    },
    {
      id: "delete",
      label: t("docEditor.deleteFile"),
      icon: <Trash2 className="size-3.5" />,
      destructive: true,
      disabled: off || !onDeleteFile,
      onSelect: () => onDeleteFile?.(),
    },
  ]

  return [viewGroup, nestedGroup, layerGroup, tabGroup, fileGroup, removeGroup]
}
