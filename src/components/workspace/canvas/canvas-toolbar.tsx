"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Copy,
  FileText,
  Group as GroupIcon,
  Minus,
  MoveHorizontal,
  MoveRight,
  Palette,
  Plus,
  StickyNote,
  Trash2,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { PRESET_COLOR_KEYS, colorToCss } from "@/lib/canvas-format"

export function ColorSwatches({ onPick }: { onPick: (key: string | undefined) => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1 px-2 py-1">
      <button
        type="button"
        title={t("canvas.reset")}
        onClick={() => onPick(undefined)}
        className="size-4 rounded-full border border-border bg-transparent"
      />
      {PRESET_COLOR_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => onPick(key)}
          className="size-4 rounded-full border border-black/30"
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
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-accent",
        danger ? "text-red-400 hover:text-red-300" : "text-foreground",
      )}
    >
      {children}
    </button>
  )
}

export function ToolbarButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-foreground hover:bg-accent hover:text-accent-foreground"
    >
      {children}
    </button>
  )
}

export function CanvasToolbar({
  onAddText,
  onAddFile,
  onAddGroup,
}: {
  onAddText: () => void
  onAddFile: () => void
  onAddGroup: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-md border border-border bg-card/90 p-1 shadow backdrop-blur">
      <ToolbarButton title={t("canvas.textCard")} onClick={onAddText}>
        <StickyNote className="size-4" />
      </ToolbarButton>
      <ToolbarButton title={t("canvas.noteCard")} onClick={onAddFile}>
        <FileText className="size-4" />
      </ToolbarButton>
      <ToolbarButton title={t("canvas.group")} onClick={onAddGroup}>
        <GroupIcon className="size-4" />
      </ToolbarButton>
      <div className="px-1 text-[10px] text-muted-foreground">
        <Plus className="size-3" />
      </div>
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
        className="fixed z-30 min-w-[180px] overflow-hidden rounded-md border border-border bg-card py-1 shadow-xl"
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
              <GroupIcon className="size-3.5 text-muted-foreground" />
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
