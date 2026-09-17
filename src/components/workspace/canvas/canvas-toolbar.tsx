"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  Cable,
  Copy,
  FileText,
  FolderPlus,
  Hand,
  Image as ImageIcon,
  Lock,
  Maximize2,
  Minus,
  MousePointer2,
  MoveHorizontal,
  MoveRight,
  Network,
  Paintbrush,
  Palette,
  Redo2,
  Settings2,
  StickyNote,
  Tag,
  Trash2,
  Undo2,
  Unlock,
  ZoomIn,
  ZoomOut,
} from "lucide-react"

import { BackgroundVariant } from "@xyflow/react"
import { cn } from "@/lib/utils"
import { PRESET_COLOR_KEYS, colorToCss } from "@/lib/canvas-format"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import type { AlignmentType, DistributionAxis } from "./canvas-alignment"

export function ColorSwatches({ onPick }: { onPick: (key: string | undefined) => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1.5 px-2 py-1">
      <button
        type="button"
        title={t("canvas.reset")}
        onClick={() => onPick(undefined)}
        className="size-4 rounded-full border border-border bg-transparent hover:scale-110"
      />
      {PRESET_COLOR_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => onPick(key)}
          className="size-4 rounded-full border border-foreground/20 hover:scale-110"
          style={{ backgroundColor: colorToCss(key) }}
        />
      ))}
    </div>
  )
}

export interface MenuState {
  x: number
  y: number
  kind: "pane" | "node" | "edge"
  targetId?: string
  flow: { x: number; y: number }
}

export function MenuItem({
  onClick,
  children,
  danger,
}: {
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent",
        danger ? "text-destructive hover:text-destructive" : "text-foreground",
      )}
    >
      {children}
    </button>
  )
}

export function ToolbarButton({
  title,
  onClick,
  active,
  disabled,
  children,
  className,
  onMouseDown,
  ...props
}: {
  title: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  children: React.ReactNode
  className?: string
  onMouseDown?: (e: React.MouseEvent) => void
  [key: string]: unknown
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={onMouseDown}
      {...props}
      className={cn(
        "flex size-7 items-center justify-center rounded-lg select-none",
        active
          ? "bg-primary text-primary-foreground shadow-2xs font-medium"
          : "text-foreground hover:bg-accent hover:text-accent-foreground",
        disabled && "opacity-40 cursor-not-allowed hover:bg-transparent",
        className,
      )}
    >
      {children}
    </button>
  )
}

export interface CanvasObjectsToolbarProps {
  mode: "select" | "hand"
  onModeChange: (mode: "select" | "hand") => void
  connectorActive?: boolean
  onToggleConnector?: () => void
  onAddText: () => void
  onAddNote: () => void
  onAddBrush: () => void
  onAddImage: () => void
  onAddGroup: () => void
  onOpenTemplates?: (kind: "process" | "topic" | "project") => void
  onOpenMermaid?: () => void
  onAutoLayout?: () => void
}

export function CanvasObjectsToolbar({
  mode,
  onModeChange,
  connectorActive,
  onToggleConnector,
  onAddText,
  onAddNote,
  onAddBrush,
  onAddImage,
  onAddGroup,
}: CanvasObjectsToolbarProps) {
  const { t } = useTranslation()

  return (
    <div className="absolute bottom-2 left-4 z-10 flex items-center gap-1 rounded-xl border border-border/80 bg-card/90 p-1 shadow-md backdrop-blur-md">
      {/* Group 1: Cursor, Hand, Brush */}
      <ToolbarButton
        title={t("canvas.modeSelect")}
        active={mode === "select" && !connectorActive}
        onClick={() => onModeChange("select")}
      >
        <MousePointer2 className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title={t("canvas.modeHand")}
        active={mode === "hand" && !connectorActive}
        onClick={() => onModeChange("hand")}
      >
        <Hand className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton title={t("canvas.brush")} onClick={onAddBrush}>
        <Paintbrush className="size-3.5" />
      </ToolbarButton>

      <div className="mx-1 h-4 w-px bg-border/80" />

      {/* Group 2: Connector, Object, Note, Image, Group */}
      {onToggleConnector ? (
        <ToolbarButton
          title={t("canvas.connector")}
          active={connectorActive}
          onClick={onToggleConnector}
        >
          <Cable className="size-3.5" />
        </ToolbarButton>
      ) : null}
      <ToolbarButton title={t("canvas.cardObject")} onClick={onAddText}>
        <StickyNote className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton title={t("canvas.noteCard")} onClick={onAddNote}>
        <FileText className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton title={t("canvas.insertImage")} onClick={onAddImage}>
        <ImageIcon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton title={t("canvas.group")} onClick={onAddGroup}>
        <FolderPlus className="size-3.5" />
      </ToolbarButton>
    </div>
  )
}

export type CanvasToolbarProps = CanvasObjectsToolbarProps
export const CanvasToolbar = CanvasObjectsToolbar

export interface CanvasAreaControlsProps {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset?: () => void
  onFitView: () => void
  isLocked?: boolean
  onToggleLock?: () => void
  snapGrid?: boolean
  onSnapGridChange?: (snap: boolean) => void
  snapGuides?: boolean
  onSnapGuidesChange?: (guides: boolean) => void
  bgVariant?: BackgroundVariant | "none"
  onBgVariantChange?: (variant: BackgroundVariant | "none") => void
  onOpenHelp?: () => void
}

export function CanvasAreaControls({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onFitView,
  isLocked = false,
  onToggleLock,
  snapGrid = false,
  onSnapGridChange,
  snapGuides = true,
  onSnapGuidesChange,
  bgVariant = BackgroundVariant.Dots,
  onBgVariantChange,
}: CanvasAreaControlsProps) {
  const { t } = useTranslation()

  return (
    <div className="absolute bottom-2 right-4 z-10 flex items-center select-none">
      {/* Consolidated Area Controls Block */}
      <div className="flex items-center gap-0.5 rounded-xl border border-border/80 bg-card/90 p-1 shadow-md backdrop-blur-md">
        <ToolbarButton title={t("canvas.zoomOut")} onClick={onZoomOut}>
          <ZoomOut className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton title={t("canvas.zoomIn")} onClick={onZoomIn}>
          <ZoomIn className="size-3.5" />
        </ToolbarButton>

        <div className="mx-0.5 h-3.5 w-px bg-border/80" />

        <ToolbarButton title={t("canvas.fitView")} onClick={onFitView}>
          <Maximize2 className="size-3.5" />
        </ToolbarButton>

        {!isLocked && (
          <>
            <div className="mx-0.5 h-3.5 w-px bg-border/80" />
            <ToolbarButton title={`${t("canvas.undo")} (⌘Z)`} disabled={!canUndo} onClick={onUndo}>
              <Undo2 className="size-3.5" />
            </ToolbarButton>
            <ToolbarButton title={`${t("canvas.redo")} (⇧⌘Z)`} disabled={!canRedo} onClick={onRedo}>
              <Redo2 className="size-3.5" />
            </ToolbarButton>
          </>
        )}

        <div className="mx-0.5 h-3.5 w-px bg-border/80" />

        {onToggleLock ? (
          <ToolbarButton
            title={isLocked ? t("docEditor.editMode") : t("docEditor.viewMode")}
            active={isLocked}
            onClick={onToggleLock}
          >
            {isLocked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
          </ToolbarButton>
        ) : null}

        {onSnapGridChange && onBgVariantChange ? (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                title={t("canvas.settings")}
                className="flex size-7 items-center justify-center rounded-lg text-foreground hover:bg-accent"
              >
                <Settings2 className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="end"
              sideOffset={13}
              alignOffset={-5}
              className="w-56 rounded-xl border border-border/80 bg-popover/95 p-2.5 text-foreground shadow-lg backdrop-blur-md"
            >
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-foreground">
                  {t("canvas.settings")}
                </span>

                <div className="flex items-center justify-between gap-2 py-0.5">
                  <span className="text-xs text-foreground/90">{t("canvas.snapGrid")}</span>
                  <Switch checked={snapGrid} onCheckedChange={onSnapGridChange} />
                </div>

                {onSnapGuidesChange ? (
                  <div className="flex items-center justify-between gap-2 py-0.5">
                    <span className="text-xs text-foreground/90">{t("canvas.snapGuides")}</span>
                    <Switch checked={snapGuides} onCheckedChange={onSnapGuidesChange} />
                  </div>
                ) : null}

                <div className="pt-2 border-t border-border/70">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {t("canvas.bgStyle")}
                  </span>
                  <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                    <button
                      type="button"
                      title={t("canvas.bgDots")}
                      onClick={() => onBgVariantChange(BackgroundVariant.Dots)}
                      className={cn(
                        "flex h-8 items-center justify-center rounded-lg border",
                        bgVariant === BackgroundVariant.Dots
                          ? "border-primary bg-primary text-primary-foreground shadow-xs font-semibold"
                          : "border-border/60 text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
                        <circle cx="3" cy="3" r="1.2" />
                        <circle cx="8" cy="3" r="1.2" />
                        <circle cx="13" cy="3" r="1.2" />
                        <circle cx="3" cy="8" r="1.2" />
                        <circle cx="8" cy="8" r="1.2" />
                        <circle cx="13" cy="8" r="1.2" />
                        <circle cx="3" cy="13" r="1.2" />
                        <circle cx="8" cy="13" r="1.2" />
                        <circle cx="13" cy="13" r="1.2" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      title={t("canvas.bgLines")}
                      onClick={() => onBgVariantChange(BackgroundVariant.Lines)}
                      className={cn(
                        "flex h-8 items-center justify-center rounded-lg border",
                        bgVariant === BackgroundVariant.Lines
                          ? "border-primary bg-primary text-primary-foreground shadow-xs font-semibold"
                          : "border-border/60 text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <svg
                        className="size-4"
                        viewBox="0 0 16 16"
                        stroke="currentColor"
                        strokeWidth="1.2"
                      >
                        <line x1="1" y1="5.5" x2="15" y2="5.5" />
                        <line x1="1" y1="10.5" x2="15" y2="10.5" />
                        <line x1="5.5" y1="1" x2="5.5" y2="15" />
                        <line x1="10.5" y1="1" x2="10.5" y2="15" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      title={t("canvas.bgCross")}
                      onClick={() => onBgVariantChange(BackgroundVariant.Cross)}
                      className={cn(
                        "flex h-8 items-center justify-center rounded-lg border",
                        bgVariant === BackgroundVariant.Cross
                          ? "border-primary bg-primary text-primary-foreground shadow-xs font-semibold"
                          : "border-border/60 text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <svg
                        className="size-4"
                        viewBox="0 0 16 16"
                        stroke="currentColor"
                        strokeWidth="1.2"
                      >
                        <line x1="2" y1="4" x2="6" y2="4" />
                        <line x1="4" y1="2" x2="4" y2="6" />
                        <line x1="10" y1="4" x2="14" y2="4" />
                        <line x1="12" y1="2" x2="12" y2="6" />
                        <line x1="6" y1="12" x2="10" y2="12" />
                        <line x1="8" y1="10" x2="8" y2="14" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      title={t("canvas.bgNone")}
                      onClick={() => onBgVariantChange("none")}
                      className={cn(
                        "flex h-8 items-center justify-center rounded-lg border",
                        bgVariant === "none"
                          ? "border-primary bg-primary text-primary-foreground shadow-xs font-semibold"
                          : "border-border/60 text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <svg
                        className="size-4"
                        viewBox="0 0 16 16"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        fill="none"
                      >
                        <rect x="2.5" y="2.5" width="11" height="11" rx="2" strokeDasharray="2 2" />
                        <line x1="3" y1="13" x2="13" y2="3" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    </div>
  )
}

export type CanvasBottomControlsProps = CanvasAreaControlsProps
export const CanvasBottomControls = CanvasAreaControls

export interface CanvasSelectionBarProps {
  selectedNodeCount: number
  selectedEdgeCount: number
  onSetColor: (color?: string) => void
  onGroupSelection: () => void
  onAlign: (type: AlignmentType) => void
  onDistribute: (axis: DistributionAxis) => void
  onDuplicate: () => void
  onBringToFront: () => void
  onSendToBack: () => void
  onDelete: () => void
  // For edge:
  edgeId?: string
  edgeLabel?: string
  onEditEdgeLabel?: () => void
  onCycleArrows?: (mode: "to" | "both" | "none") => void
}

export function CanvasSelectionBar({
  selectedNodeCount,
  selectedEdgeCount,
  onSetColor,
  onGroupSelection,
  onAlign,
  onDistribute,
  onDuplicate,
  onBringToFront,
  onSendToBack,
  onDelete,
  onEditEdgeLabel,
  onCycleArrows,
}: CanvasSelectionBarProps) {
  const { t } = useTranslation()

  if (selectedNodeCount === 0 && selectedEdgeCount === 0) return null

  return (
    <div className="absolute bottom-14 left-4 z-20 flex items-center gap-1.5 rounded-xl border border-border/80 bg-card/95 p-1.5 shadow-xl backdrop-blur-md">
      {/* Node selection tools */}
      {selectedNodeCount > 0 ? (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-lg text-foreground hover:bg-accent"
              >
                <Palette className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="p-1">
              <ColorSwatches onPick={onSetColor} />
            </DropdownMenuContent>
          </DropdownMenu>

          {selectedNodeCount >= 2 ? (
            <>
              <ToolbarButton title={t("canvas.groupSelection")} onClick={onGroupSelection}>
                <FolderPlus className="size-3.5" />
              </ToolbarButton>

              {/* Align Dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    title={t("canvas.align")}
                    className="flex size-7 items-center justify-center rounded-lg text-foreground hover:bg-accent"
                  >
                    <AlignCenter className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-44 text-xs">
                  <DropdownMenuItem onClick={() => onAlign("left")}>
                    <AlignLeft className="mr-2 size-3.5" />
                    {t("canvas.alignLeft")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onAlign("center")}>
                    <AlignCenter className="mr-2 size-3.5" />
                    {t("canvas.alignCenter")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onAlign("right")}>
                    <AlignRight className="mr-2 size-3.5" />
                    {t("canvas.alignRight")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onAlign("top")}>
                    {t("canvas.alignTop")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onAlign("middle")}>
                    {t("canvas.alignMiddle")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onAlign("bottom")}>
                    {t("canvas.alignBottom")}
                  </DropdownMenuItem>

                  {selectedNodeCount >= 3 ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => onDistribute("horizontal")}>
                        {t("canvas.distributeHorizontal")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onDistribute("vertical")}>
                        {t("canvas.distributeVertical")}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}

          <ToolbarButton title={t("canvas.duplicate")} onClick={onDuplicate}>
            <Copy className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton title={t("canvas.bringToFront")} onClick={onBringToFront}>
            <ArrowUpToLine className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton title={t("canvas.sendToBack")} onClick={onSendToBack}>
            <ArrowDownToLine className="size-3.5" />
          </ToolbarButton>
        </>
      ) : null}

      {/* Edge selection tools */}
      {selectedEdgeCount > 0 && selectedNodeCount === 0 ? (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-lg text-foreground hover:bg-accent"
              >
                <Palette className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="p-1">
              <ColorSwatches onPick={onSetColor} />
            </DropdownMenuContent>
          </DropdownMenu>

          <ToolbarButton title={t("canvas.arrowRight")} onClick={() => onCycleArrows?.("to")}>
            <MoveRight className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton title={t("canvas.arrowBoth")} onClick={() => onCycleArrows?.("both")}>
            <MoveHorizontal className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton title={t("canvas.noArrows")} onClick={() => onCycleArrows?.("none")}>
            <Minus className="size-3.5" />
          </ToolbarButton>

          {onEditEdgeLabel ? (
            <ToolbarButton title={t("canvas.editLabel")} onClick={onEditEdgeLabel}>
              <Tag className="size-3.5" />
            </ToolbarButton>
          ) : null}
        </>
      ) : null}

      <div className="mx-0.5 h-4 w-px bg-border/80" />

      <ToolbarButton title={t("canvas.delete")} onClick={onDelete}>
        <Trash2 className="size-3.5 text-destructive" />
      </ToolbarButton>
    </div>
  )
}

export function CanvasContextMenu({
  menu,
  onClose,
  onAddNode,
  hasClipboard,
  onPasteClipboard,
  onDuplicateNode,
  onBringToFront,
  onSendToBack,
  onSetNodeColor,
  onRemoveNode,
  onCycleArrows,
  onSetEdgeColor,
  onRemoveEdge,
  onAutoLayout,
}: {
  menu: MenuState | null
  onClose: () => void
  onAddNode: (type: "text" | "file" | "group", flowPos: { x: number; y: number }) => void
  hasClipboard: boolean
  onPasteClipboard: () => void
  onDuplicateNode: (id: string) => void
  onBringToFront: (id: string) => void
  onSendToBack: (id: string) => void
  onSetNodeColor: (id: string, color?: string) => void
  onRemoveNode: (id: string) => void
  onCycleArrows: (id: string, mode: "to" | "both" | "none") => void
  onSetEdgeColor: (id: string, color?: string) => void
  onRemoveEdge: (id: string) => void
  onAutoLayout?: () => void
}) {
  const { t } = useTranslation()
  if (!menu) return null

  return (
    <>
      <div
        className="fixed inset-0 z-20"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="fixed z-30 min-w-[190px] overflow-hidden rounded-xl border border-border bg-card py-1 shadow-xl backdrop-blur-md"
        style={{ left: menu.x, top: menu.y }}
      >
        {menu.kind === "pane" ? (
          <>
            <MenuItem
              onClick={() => {
                onAddNode("text", menu.flow)
                onClose()
              }}
            >
              <StickyNote className="size-3.5 text-muted-foreground" />
              {t("canvas.textCard")}
            </MenuItem>
            <MenuItem
              onClick={() => {
                onAddNode("file", menu.flow)
                onClose()
              }}
            >
              <FileText className="size-3.5 text-muted-foreground" />
              {t("canvas.noteCard")}
            </MenuItem>
            <MenuItem
              onClick={() => {
                onAddNode("group", menu.flow)
                onClose()
              }}
            >
              <FolderPlus className="size-3.5 text-muted-foreground" />
              {t("canvas.group")}
            </MenuItem>
            {hasClipboard ? (
              <MenuItem
                onClick={() => {
                  onPasteClipboard()
                  onClose()
                }}
              >
                <Copy className="size-3.5 text-muted-foreground" />
                {t("canvas.paste")}
              </MenuItem>
            ) : null}
            {onAutoLayout ? (
              <>
                <div className="my-1 border-t border-border" />
                <MenuItem
                  onClick={() => {
                    onAutoLayout()
                    onClose()
                  }}
                >
                  <Network className="size-3.5 text-muted-foreground" />
                  {t("canvas.autoLayout")}
                </MenuItem>
              </>
            ) : null}
          </>
        ) : menu.kind === "node" && menu.targetId ? (
          <>
            <MenuItem
              onClick={() => {
                onDuplicateNode(menu.targetId!)
                onClose()
              }}
            >
              <Copy className="size-3.5 text-muted-foreground" />
              {t("canvas.duplicate")}
            </MenuItem>
            <MenuItem
              onClick={() => {
                onBringToFront(menu.targetId!)
                onClose()
              }}
            >
              <ArrowUpToLine className="size-3.5 text-muted-foreground" />
              {t("canvas.bringToFront")}
            </MenuItem>
            <MenuItem
              onClick={() => {
                onSendToBack(menu.targetId!)
                onClose()
              }}
            >
              <ArrowDownToLine className="size-3.5 text-muted-foreground" />
              {t("canvas.sendToBack")}
            </MenuItem>
            <div className="flex items-center gap-1 border-t border-border px-1 pt-1 text-muted-foreground">
              <Palette className="ml-1.5 size-3.5" />
              <ColorSwatches
                onPick={(c) => {
                  onSetNodeColor(menu.targetId!, c)
                  onClose()
                }}
              />
            </div>
            <div className="border-t border-border" />
            <MenuItem
              danger
              onClick={() => {
                onRemoveNode(menu.targetId!)
                onClose()
              }}
            >
              <Trash2 className="size-3.5" />
              {t("canvas.delete")}
            </MenuItem>
          </>
        ) : menu.kind === "edge" && menu.targetId ? (
          <>
            <MenuItem
              onClick={() => {
                onCycleArrows(menu.targetId!, "to")
                onClose()
              }}
            >
              <MoveRight className="size-3.5 text-muted-foreground" />
              {t("canvas.arrowRight")}
            </MenuItem>
            <MenuItem
              onClick={() => {
                onCycleArrows(menu.targetId!, "both")
                onClose()
              }}
            >
              <MoveHorizontal className="size-3.5 text-muted-foreground" />
              {t("canvas.arrowBoth")}
            </MenuItem>
            <MenuItem
              onClick={() => {
                onCycleArrows(menu.targetId!, "none")
                onClose()
              }}
            >
              <Minus className="size-3.5 text-muted-foreground" />
              {t("canvas.noArrows")}
            </MenuItem>
            <div className="flex items-center gap-1 border-t border-border px-1 pt-1 text-muted-foreground">
              <Palette className="ml-1.5 size-3.5" />
              <ColorSwatches
                onPick={(c) => {
                  onSetEdgeColor(menu.targetId!, c)
                  onClose()
                }}
              />
            </div>
            <div className="border-t border-border" />
            <MenuItem
              danger
              onClick={() => {
                onRemoveEdge(menu.targetId!)
                onClose()
              }}
            >
              <Trash2 className="size-3.5" />
              {t("canvas.delete")}
            </MenuItem>
          </>
        ) : null}
      </div>
    </>
  )
}
