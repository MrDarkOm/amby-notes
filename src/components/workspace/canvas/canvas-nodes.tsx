"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Handle, Position, NodeResizer, type NodeProps } from "@xyflow/react"
import { FileText, Image as ImageIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { CANVAS_UI_COLORS } from "@/lib/themes"
import {
  colorToCss,
  type FileNodeData,
  type GroupNodeData,
  type TextNodeData,
} from "@/lib/canvas-format"
import { toAssetUrl, isTauri } from "@/lib/storage"
import { useCanvasCtx } from "./canvas-context"
import { IMAGE_RE, pathStem, renderCardHtml } from "./canvas-markdown"

const SIDES: Array<{ side: "top" | "right" | "bottom" | "left"; pos: Position }> = [
  { side: "top", pos: Position.Top },
  { side: "right", pos: Position.Right },
  { side: "bottom", pos: Position.Bottom },
  { side: "left", pos: Position.Left },
]

export function SideHandles({ visible }: { visible: boolean }) {
  const base = cn(
    "!size-3 !border-2 !border-muted-foreground !bg-accent transition-opacity",
    visible ? "!opacity-100" : "!opacity-0",
  )
  return (
    <>
      {SIDES.map(({ side, pos }) => (
        <React.Fragment key={side}>
          <Handle id={`t-${side}`} type="target" position={pos} className={base} />
          <Handle id={`s-${side}`} type="source" position={pos} className={base} />
        </React.Fragment>
      ))}
    </>
  )
}

export function TextNode({ id, data, selected }: NodeProps) {
  const { t } = useTranslation()
  const d = data as TextNodeData
  const { updateNodeData, onOpenNote } = useCanvasCtx()
  const [editing, setEditing] = React.useState(false)
  const [hover, setHover] = React.useState(false)
  const accent = colorToCss(d.color)
  const html = React.useMemo(() => renderCardHtml(d.text ?? ""), [d.text])

  return (
    <div
      className={cn(
        "group relative flex h-full w-full flex-col overflow-hidden rounded-md border bg-card text-foreground shadow",
        selected ? "border-foreground/30" : "border-border",
      )}
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
    >
      <NodeResizer minWidth={120} minHeight={60} isVisible={!!selected} />
      <SideHandles visible={hover || !!selected} />
      {editing ? (
        <textarea
          autoFocus
          value={d.text ?? ""}
          placeholder={t("canvas.textPlaceholder")}
          className="nodrag nowheel h-full w-full resize-none bg-transparent p-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          onChange={(e) => updateNodeData(id, { text: e.target.value })}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault()
              setEditing(false)
            }
          }}
        />
      ) : html ? (
        <div
          className="canvas-md nowheel h-full w-full overflow-auto p-2 text-sm leading-snug text-foreground"
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={(e) => {
            const el = (e.target as HTMLElement).closest("[data-wikilink]") as HTMLElement | null
            if (el) {
              e.stopPropagation()
              onOpenNote?.(el.getAttribute("data-wikilink") ?? "")
            }
          }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center p-2 text-xs text-muted-foreground">
          {t("canvas.doubleClickText")}
        </div>
      )}
    </div>
  )
}

export function FileNode({ data, selected }: NodeProps) {
  const { t } = useTranslation()
  const d = data as FileNodeData
  const { vault, onOpenNote } = useCanvasCtx()
  const [hover, setHover] = React.useState(false)
  const accent = colorToCss(d.color)
  const file = d.file ?? ""
  const title = file ? pathStem(file) : ""
  const isImage = IMAGE_RE.test(file)
  const [imgUrl, setImgUrl] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    if (isImage && file) {
      const abs = isTauri() && vault ? `${vault}/${file}` : file
      toAssetUrl(abs).then((u) => {
        if (!cancelled) setImgUrl(u)
      })
    } else {
      setImgUrl(null)
    }
    return () => {
      cancelled = true
    }
  }, [file, isImage, vault])

  return (
    <div
      className={cn(
        "group relative flex h-full w-full flex-col overflow-hidden rounded-md border bg-card text-foreground shadow",
        selected ? "border-foreground/30" : "border-border",
      )}
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (!isImage && file) onOpenNote?.(file)
      }}
      title={file}
    >
      <NodeResizer minWidth={120} minHeight={80} isVisible={!!selected} />
      <SideHandles visible={hover || !!selected} />
      {isImage && imgUrl ? (
        <img src={imgUrl} alt={title} className="h-full w-full object-contain" draggable={false} />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center">
          {isImage ? (
            <ImageIcon className="size-5 text-muted-foreground" />
          ) : (
            <FileText className="size-5 text-muted-foreground" />
          )}
          <span className="line-clamp-3 text-sm font-medium text-foreground">
            {title || t("canvas.noteNotSelected")}
          </span>
          {file && !isImage ? (
            <span className="text-[10px] text-muted-foreground">{t("canvas.doubleClickOpen")}</span>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function GroupNode({ id, data, selected }: NodeProps) {
  const { t } = useTranslation()
  const d = data as GroupNodeData
  const { updateNodeData } = useCanvasCtx()
  const [editing, setEditing] = React.useState(false)
  const [hover, setHover] = React.useState(false)
  const accent = colorToCss(d.color) ?? CANVAS_UI_COLORS.fallbackAccent
  return (
    <div
      className="group relative flex h-full w-full flex-col rounded-md border-2 border-dashed"
      style={{ borderColor: accent, backgroundColor: `${accent}14` }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
    >
      <NodeResizer minWidth={160} minHeight={120} isVisible={!!selected} color={accent} />
      <SideHandles visible={hover || !!selected} />
      {editing ? (
        <input
          autoFocus
          value={d.label ?? ""}
          placeholder={t("canvas.groupPlaceholder")}
          className="nodrag m-1 w-fit max-w-[90%] rounded bg-card/80 px-1 text-xs font-medium text-foreground outline-none"
          onChange={(e) => updateNodeData(id, { label: e.target.value })}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault()
              setEditing(false)
            }
          }}
        />
      ) : (
        <span
          className="m-1 max-w-[90%] truncate px-1 text-xs font-medium"
          style={{ color: accent }}
        >
          {d.label || t("canvas.groupFallback")}
        </span>
      )}
    </div>
  )
}
