"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowUpRight,
  Circle,
  Diamond,
  Eraser,
  FileText,
  Frame,
  Globe,
  Hand,
  Image as ImageIcon,
  Minus,
  MousePointer2,
  Pencil,
  Plus,
  Sparkles,
  Square,
  StickyNote,
  Type,
} from "lucide-react"
import { cn } from "@/lib/utils"

export type SketchShapeType = "rectangle" | "diamond" | "ellipse"

export interface SketchToolbarProps {
  activeTool?: string
  activeShape: SketchShapeType
  isShapeActive?: boolean
  onSelectTool?: (tool: string) => void
  onSelectShape: (shape: SketchShapeType) => void
  onAddTextCard: () => void
  onAddNoteCard: () => void
  className?: string
}

const SHAPE_CONFIG: Record<
  SketchShapeType,
  {
    icon: React.ComponentType<{ className?: string }>
    labelKey: string
  }
> = {
  rectangle: {
    icon: Square,
    labelKey: "sketch.rectangle",
  },
  diamond: {
    icon: Diamond,
    labelKey: "sketch.diamond",
  },
  ellipse: {
    icon: Circle,
    labelKey: "sketch.circle",
  },
}

const SHAPES_LIST: SketchShapeType[] = ["rectangle", "diamond", "ellipse"]

export function SketchToolbarButton({
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
          ? "bg-accent text-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        disabled && "opacity-40 cursor-not-allowed hover:bg-transparent",
        className,
      )}
    >
      {children}
    </button>
  )
}

export function SketchToolbar({
  activeTool,
  activeShape,
  isShapeActive: explicitShapeActive,
  onSelectTool,
  onSelectShape,
  onAddTextCard,
  onAddNoteCard,
  className,
}: SketchToolbarProps) {
  const { t } = useTranslation()

  // Shape flyout state (click-to-toggle)
  const [isShapeFlyoutOpen, setIsShapeFlyoutOpen] = React.useState(false)
  const shapeContainerRef = React.useRef<HTMLDivElement>(null)

  // Insert flyout state (click-to-toggle)
  const [isInsertFlyoutOpen, setIsInsertFlyoutOpen] = React.useState(false)
  const insertContainerRef = React.useRef<HTMLDivElement>(null)

  // Close flyouts on outside click
  React.useEffect(() => {
    if (!isShapeFlyoutOpen && !isInsertFlyoutOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        isShapeFlyoutOpen &&
        shapeContainerRef.current &&
        !shapeContainerRef.current.contains(target)
      ) {
        setIsShapeFlyoutOpen(false)
      }
      if (
        isInsertFlyoutOpen &&
        insertContainerRef.current &&
        !insertContainerRef.current.contains(target)
      ) {
        setIsInsertFlyoutOpen(false)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [isShapeFlyoutOpen, isInsertFlyoutOpen])

  const ActiveShapeIcon = SHAPE_CONFIG[activeShape]?.icon ?? Square

  const isShapeActive =
    explicitShapeActive ??
    (activeTool === activeShape ||
      (activeShape === "rectangle" && activeTool === "rectangle") ||
      (activeShape === "diamond" && activeTool === "diamond") ||
      (activeShape === "ellipse" && activeTool === "ellipse"))

  const isInsertActive = activeTool === "image" || activeTool === "embeddable"
  const InsertIcon = activeTool === "image" ? ImageIcon : activeTool === "embeddable" ? Globe : Plus

  const handleToggleShapeFlyout = () => {
    setIsInsertFlyoutOpen(false)
    setIsShapeFlyoutOpen((prev) => !prev)
    onSelectShape(activeShape)
  }

  const handleShapeClick = (shape: SketchShapeType) => {
    onSelectShape(shape)
    setIsShapeFlyoutOpen(false)
  }

  const handleToggleInsertFlyout = () => {
    setIsShapeFlyoutOpen(false)
    setIsInsertFlyoutOpen((prev) => !prev)
  }

  const handleToolClick = (tool: string) => {
    onSelectTool?.(tool)
    setIsInsertFlyoutOpen(false)
    setIsShapeFlyoutOpen(false)
  }

  const handleInsertNoteCard = () => {
    setIsInsertFlyoutOpen(false)
    setIsShapeFlyoutOpen(false)
    onAddNoteCard()
  }

  return (
    <div
      className={cn(
        "amby-sketch-custom-tools relative flex items-center gap-0.5 select-none",
        className,
      )}
    >
      {/* 1. Selection Tool */}
      <SketchToolbarButton
        title={t("sketch.selection")}
        active={activeTool === "selection"}
        onClick={() => handleToolClick("selection")}
        data-testid="sketch-tool-selection"
      >
        <MousePointer2 className="size-3.5" />
      </SketchToolbarButton>

      {/* 2. Hand (Pan) Tool */}
      <SketchToolbarButton
        title={t("sketch.hand")}
        active={activeTool === "hand"}
        onClick={() => handleToolClick("hand")}
        data-testid="sketch-tool-hand"
      >
        <Hand className="size-3.5" />
      </SketchToolbarButton>

      <div className="mx-0.5 h-3.5 w-px bg-border/80" />

      {/* 3. Object (Shapes dropdown / flyout, click to open) */}
      <div ref={shapeContainerRef} className="relative">
        <button
          type="button"
          title={`${t("sketch.object")} (${t(SHAPE_CONFIG[activeShape]?.labelKey ?? "sketch.rectangle")})`}
          aria-label={t("sketch.object")}
          data-testid="sketch-object-button"
          onClick={handleToggleShapeFlyout}
          className={cn(
            "flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            isShapeActive && "bg-accent text-accent-foreground font-medium",
          )}
        >
          <ActiveShapeIcon className="size-3.5" />
        </button>

        {/* Click Flyout for Shapes */}
        {isShapeFlyoutOpen && (
          <div className="absolute bottom-[calc(100%+0.5rem)] left-1/2 -translate-x-1/2 z-50 flex items-center gap-0.5 rounded-xl border border-border/80 bg-card/95 p-1 shadow-md backdrop-blur-md">
            {SHAPES_LIST.map((shape) => {
              const ShapeIcon = SHAPE_CONFIG[shape].icon
              const isSelected = activeShape === shape
              return (
                <button
                  key={shape}
                  type="button"
                  title={t(SHAPE_CONFIG[shape].labelKey)}
                  aria-label={t(SHAPE_CONFIG[shape].labelKey)}
                  data-testid={`sketch-shape-${shape}`}
                  onClick={() => handleShapeClick(shape)}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    isSelected && isShapeActive && "bg-accent text-accent-foreground font-medium",
                  )}
                >
                  <ShapeIcon className="size-3.5" />
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 4. Sticker (Text card) */}
      <SketchToolbarButton
        title={t("sketch.sticker")}
        onClick={onAddTextCard}
        data-testid="sketch-sticker-button"
      >
        <StickyNote className="size-3.5" />
      </SketchToolbarButton>

      <div className="mx-0.5 h-3.5 w-px bg-border/80" />

      {/* 5. Arrow Tool */}
      <SketchToolbarButton
        title={t("sketch.arrow")}
        active={activeTool === "arrow"}
        onClick={() => handleToolClick("arrow")}
        data-testid="sketch-tool-arrow"
      >
        <ArrowUpRight className="size-3.5" />
      </SketchToolbarButton>

      {/* 6. Line Tool */}
      <SketchToolbarButton
        title={t("sketch.line")}
        active={activeTool === "line"}
        onClick={() => handleToolClick("line")}
        data-testid="sketch-tool-line"
      >
        <Minus className="size-3.5" />
      </SketchToolbarButton>

      {/* 7. Draw / Pen Tool */}
      <SketchToolbarButton
        title={t("sketch.draw")}
        active={activeTool === "freedraw"}
        onClick={() => handleToolClick("freedraw")}
        data-testid="sketch-tool-draw"
      >
        <Pencil className="size-3.5" />
      </SketchToolbarButton>

      {/* 8. Text Tool */}
      <SketchToolbarButton
        title={t("sketch.text")}
        active={activeTool === "text"}
        onClick={() => handleToolClick("text")}
        data-testid="sketch-tool-text"
      >
        <Type className="size-3.5" />
      </SketchToolbarButton>

      <div className="mx-0.5 h-3.5 w-px bg-border/80" />

      {/* 9. Insert Tool (Flyout for Note, Image, Web embed) */}
      <div ref={insertContainerRef} className="relative">
        <button
          type="button"
          title={t("sketch.insert")}
          aria-label={t("sketch.insert")}
          data-testid="sketch-insert-button"
          onClick={handleToggleInsertFlyout}
          className={cn(
            "flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            isInsertActive && "bg-accent text-accent-foreground font-medium",
          )}
        >
          <InsertIcon className="size-3.5" />
        </button>

        {/* Click Flyout for Insert with labels */}
        {isInsertFlyoutOpen && (
          <div className="absolute bottom-[calc(100%+0.5rem)] left-1/2 -translate-x-1/2 z-50 flex flex-col gap-0.5 min-w-44 rounded-xl border border-border/80 bg-card/95 p-1 shadow-md backdrop-blur-md">
            {/* Note Card */}
            <button
              type="button"
              data-testid="sketch-insert-note-card"
              onClick={handleInsertNoteCard}
              className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg text-xs text-left text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <FileText className="size-3.5 shrink-0" />
              <span>{t("sketch.noteCard")}</span>
            </button>

            {/* Image */}
            <button
              type="button"
              data-testid="sketch-insert-image"
              onClick={() => handleToolClick("image")}
              className={cn(
                "flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg text-xs text-left text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                activeTool === "image" && "bg-accent text-accent-foreground font-medium",
              )}
            >
              <ImageIcon className="size-3.5 shrink-0" />
              <span>{t("sketch.image")}</span>
            </button>

            {/* Web Embed */}
            <button
              type="button"
              data-testid="sketch-insert-web-embed"
              onClick={() => handleToolClick("embeddable")}
              className={cn(
                "flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg text-xs text-left text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                activeTool === "embeddable" && "bg-accent text-accent-foreground font-medium",
              )}
            >
              <Globe className="size-3.5 shrink-0" />
              <span>{t("sketch.webEmbed")}</span>
            </button>
          </div>
        )}
      </div>

      {/* 10. Frame Tool */}
      <SketchToolbarButton
        title={t("sketch.frame")}
        active={activeTool === "frame"}
        onClick={() => handleToolClick("frame")}
        data-testid="sketch-tool-frame"
      >
        <Frame className="size-3.5" />
      </SketchToolbarButton>

      {/* 11. Laser Pointer Tool */}
      <SketchToolbarButton
        title={t("sketch.laser")}
        active={activeTool === "laser"}
        onClick={() => handleToolClick("laser")}
        data-testid="sketch-tool-laser"
      >
        <Sparkles className="size-3.5" />
      </SketchToolbarButton>

      <div className="mx-0.5 h-3.5 w-px bg-border/80" />

      {/* 12. Eraser Tool */}
      <SketchToolbarButton
        title={t("sketch.eraser")}
        active={activeTool === "eraser"}
        onClick={() => handleToolClick("eraser")}
        data-testid="sketch-tool-eraser"
      >
        <Eraser className="size-3.5" />
      </SketchToolbarButton>
    </div>
  )
}

export type SketchObjectsToolbarProps = SketchToolbarProps
export const SketchObjectsToolbar = SketchToolbar
