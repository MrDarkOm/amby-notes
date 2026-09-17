"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Handle, Position, NodeResizer, type NodeProps } from "@xyflow/react"
import {
  FileText,
  FileX,
  Image as ImageIcon,
  Paintbrush,
  SquareArrowOutUpRight,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  colorToCss,
  type FileNodeData,
  type GroupNodeData,
  type TextNodeData,
} from "@/lib/canvas-format"
import { toAssetUrl, readFile } from "@/lib/storage"
import { useCanvasCtx } from "./canvas-context"
import { IMAGE_RE, pathStem, renderCardHtml, resolveVaultFilePath } from "./canvas-markdown"
import { useViewStateStore } from "../use-view-state-store"
import { TreeIcon } from "../tree/tree-icons"

const SIDES: Array<{ side: "top" | "right" | "bottom" | "left"; pos: Position }> = [
  { side: "top", pos: Position.Top },
  { side: "right", pos: Position.Right },
  { side: "bottom", pos: Position.Bottom },
  { side: "left", pos: Position.Left },
]

export function SideHandles({ visible }: { visible: boolean }) {
  const base = cn(
    "!size-2.5 !rounded-full !border-2 !border-background !bg-muted-foreground",
    visible ? "!opacity-100" : "!opacity-0 pointer-events-none",
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
  const { updateNodeData, onOpenNote, isLocked, connectorMode } = useCanvasCtx()
  const [editing, setEditing] = React.useState(false)
  const [hover, setHover] = React.useState(false)
  const accent = colorToCss(d.color)
  const html = React.useMemo(() => renderCardHtml(d.text ?? ""), [d.text])

  return (
    <div
      className={cn(
        "group relative flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card text-foreground shadow-xs",
        selected
          ? "border-primary/50 ring-2 ring-primary/40 shadow-md"
          : "border-border/80 hover:border-border hover:shadow-xs",
      )}
      style={accent ? { borderLeftWidth: 4, borderLeftColor: accent } : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (!isLocked) setEditing(true)
      }}
    >
      <NodeResizer
        minWidth={140}
        minHeight={80}
        isVisible={!isLocked && !!selected}
        lineClassName="!border-primary/60"
        handleClassName="!size-2.5 !bg-primary !border-background !rounded-full"
      />
      <SideHandles visible={!isLocked && (hover || !!selected || !!connectorMode)} />
      {editing ? (
        <textarea
          autoFocus
          value={d.text ?? ""}
          placeholder={t("canvas.textPlaceholder")}
          className="nodrag nowheel h-full w-full resize-none bg-transparent p-3 text-sm text-foreground outline-none placeholder:text-muted-foreground font-sans leading-relaxed"
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
          className="canvas-md nowheel h-full w-full overflow-auto p-3 text-sm leading-relaxed text-foreground"
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
        <div className="flex h-full w-full items-center justify-center p-3 text-xs text-muted-foreground">
          {t("canvas.doubleClickText")}
        </div>
      )}
    </div>
  )
}

export function FileNode({ data, selected }: NodeProps) {
  const { t } = useTranslation()
  const d = data as FileNodeData
  const { vault, onOpenNote, isLocked, connectorMode } = useCanvasCtx()
  const [hover, setHover] = React.useState(false)
  const accent = colorToCss(d.color)
  const file = d.file ?? ""
  const title = file ? pathStem(file) : ""
  const isImage = IMAGE_RE.test(file)
  const isSketch = file.endsWith(".excalidraw")
  const [imgUrl, setImgUrl] = React.useState<string | null>(null)

  // Asynchronous note preview state
  const [previewState, setPreviewState] = React.useState<{
    loading: boolean
    exists: boolean
    html: string
  }>({
    loading: !isImage && !isSketch && !!file,
    exists: true,
    html: "",
  })

  // Lookup note icon override
  const iconOverride = useViewStateStore(
    (s) => s.iconOverrides[file] ?? s.iconOverrides[title] ?? undefined,
  )

  React.useEffect(() => {
    let cancelled = false
    if (isImage && file) {
      const abs = resolveVaultFilePath(file, vault)
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

  // Read note preview text safely via storage
  React.useEffect(() => {
    if (isImage || isSketch || !file) {
      setPreviewState({ loading: false, exists: true, html: "" })
      return
    }

    let cancelled = false
    const abs = resolveVaultFilePath(file, vault)

    readFile(abs)
      .then((raw) => {
        if (cancelled) return
        // Strip YAML frontmatter
        const body = raw.replace(/^---[\s\S]*?---\n?/u, "").trim()
        // Take first ~250 characters for clean preview
        const truncated = body.length > 250 ? body.slice(0, 250) + "…" : body
        const rendered = renderCardHtml(truncated)
        setPreviewState({ loading: false, exists: true, html: rendered })
      })
      .catch(() => {
        if (cancelled) return
        setPreviewState({ loading: false, exists: false, html: "" })
      })

    return () => {
      cancelled = true
    }
  }, [file, isImage, isSketch, vault])

  const handleOpen = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!isImage && file && previewState.exists) {
      onOpenNote?.(file)
    }
  }

  return (
    <div
      className={cn(
        "group relative flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card text-foreground shadow-xs",
        selected
          ? "border-primary/50 ring-2 ring-primary/40 shadow-md"
          : "border-border/80 hover:border-border hover:shadow-xs",
        !previewState.exists && "border-destructive/40 bg-destructive/5",
      )}
      style={accent ? { borderLeftWidth: 4, borderLeftColor: accent } : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={handleOpen}
      title={file}
    >
      <NodeResizer
        minWidth={160}
        minHeight={100}
        isVisible={!isLocked && !!selected}
        lineClassName="!border-primary/60"
        handleClassName="!size-2.5 !bg-primary !border-background !rounded-full"
      />
      <SideHandles visible={!isLocked && (hover || !!selected || !!connectorMode)} />

      {isImage ? (
        imgUrl ? (
          <div className="flex h-full w-full flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
              <span className="truncate">{title}</span>
              <ImageIcon className="size-3.5 shrink-0" />
            </div>
            <div className="flex flex-1 items-center justify-center overflow-hidden p-1">
              <img
                src={imgUrl}
                alt={title}
                className="h-full w-full object-contain"
                draggable={false}
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 p-3 text-center text-muted-foreground">
            <ImageIcon className="size-6" />
            <span className="truncate text-xs">{title}</span>
          </div>
        )
      ) : (
        <div className="flex h-full w-full flex-col overflow-hidden">
          {/* Note Card Header */}
          <div className="flex items-center justify-between border-b border-border/50 bg-muted/30 px-3 py-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              {previewState.exists ? (
                isSketch ? (
                  <Paintbrush className="size-3.5 shrink-0 text-primary" />
                ) : iconOverride ? (
                  <TreeIcon icon={iconOverride} className="size-3.5 shrink-0" />
                ) : (
                  <FileText className="size-3.5 shrink-0 text-primary" />
                )
              ) : (
                <FileX className="size-3.5 shrink-0 text-destructive" />
              )}
              <span
                className={cn(
                  "truncate text-xs font-semibold",
                  !previewState.exists && "text-muted-foreground line-through",
                )}
              >
                {title || t("canvas.noteNotSelected")}
              </span>
            </div>

            {file && previewState.exists ? (
              <button
                type="button"
                onClick={handleOpen}
                title={t("canvas.openNote")}
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <SquareArrowOutUpRight className="size-3" />
              </button>
            ) : null}
          </div>

          {/* Note Card Content Preview */}
          <div className="flex-1 overflow-hidden p-3">
            {!previewState.exists ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-xs text-destructive">
                <FileX className="size-5" />
                <span className="font-medium">{t("canvas.fileNotFound")}</span>
                <span className="truncate max-w-[90%] text-[10px] text-muted-foreground">
                  {file}
                </span>
              </div>
            ) : isSketch ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                <div className="flex size-10 items-center justify-center rounded-xl bg-muted/60 text-primary">
                  <Paintbrush className="size-5" />
                </div>
                <span className="text-xs font-medium text-foreground">{title}</span>
                <span className="text-[10px] text-muted-foreground">
                  {t("canvas.doubleClickOpen")}
                </span>
              </div>
            ) : previewState.loading ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t("canvas.loadingNote")}
              </div>
            ) : previewState.html ? (
              <div
                className="canvas-md nowheel h-full w-full overflow-hidden text-xs leading-relaxed text-muted-foreground"
                dangerouslySetInnerHTML={{ __html: previewState.html }}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {file ? t("canvas.doubleClickOpen") : t("canvas.noteNotSelected")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function GroupNode({ id, data, selected }: NodeProps) {
  const { t } = useTranslation()
  const d = data as GroupNodeData
  const { updateNodeData, isLocked, connectorMode } = useCanvasCtx()
  const [editing, setEditing] = React.useState(false)
  const [hover, setHover] = React.useState(false)
  const customAccent = colorToCss(d.color)

  return (
    <div
      className={cn(
        "group relative flex h-full w-full flex-col rounded-xl border border-dashed bg-muted/5",
        customAccent ? "" : "border-border/70",
        selected && "ring-2 ring-primary/40 border-primary/60",
      )}
      style={
        customAccent
          ? {
              borderColor: customAccent,
              backgroundColor: `${customAccent}08`,
            }
          : undefined
      }
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (!isLocked) setEditing(true)
      }}
    >
      <NodeResizer
        minWidth={180}
        minHeight={140}
        isVisible={!isLocked && !!selected}
        color={customAccent ?? undefined}
        handleClassName="!size-2.5 !border-background !rounded-full"
      />
      <SideHandles visible={!isLocked && (hover || !!selected || !!connectorMode)} />

      <div className="flex items-center px-3 py-1.5">
        {editing ? (
          <input
            autoFocus
            value={d.label ?? ""}
            placeholder={t("canvas.groupPlaceholder")}
            className="nodrag rounded bg-background/90 px-2 py-0.5 text-xs font-medium text-foreground outline-none ring-1 ring-ring"
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
            className="truncate text-xs font-medium tracking-wide text-muted-foreground group-hover:text-foreground"
            style={customAccent ? { color: customAccent } : undefined}
          >
            {d.label || t("canvas.groupFallback")}
          </span>
        )}
      </div>
    </div>
  )
}
