"use client"

import * as React from "react"
import type { Editor } from "@tiptap/react"
import { NodeSelection } from "@tiptap/pm/state"
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Captions,
  Check,
  Copy,
  Crop,
  Download,
  Maximize,
  Replace,
  RotateCcw,
  Trash2,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { isVaultImage } from "./image-actions"
import {
  canEditImageFiles,
  copyImageAt,
  replaceImageAt,
  requestImageCrop,
  requestImageViewer,
  saveImageAt,
} from "./image-commands"
import { refocusPicture, updateImageNode, type ImagePatch } from "./image-edit"

interface ImageToolbarProps {
  editor: Editor
  /** The left and right edge of the picture the toolbar belongs to. */
  left: number
  right: number
  top: number
  /** Out of sight with the picture: kept, not shown. */
  hidden?: boolean
}

type Panel = "caption" | "align" | null

function ToolbarButton({
  title,
  onClick,
  active,
  children,
}: {
  title: string
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={`flex size-7 items-center justify-center rounded ${
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

const ALIGNMENTS = [
  { id: "left", Icon: AlignLeft, labelKey: "editorToolbar.imageAlignLeft" },
  { id: "center", Icon: AlignCenter, labelKey: "editorToolbar.imageAlignCenter" },
  { id: "right", Icon: AlignRight, labelKey: "editorToolbar.imageAlignRight" },
] as const

/** The floating toolbar of a selected picture: what is done with a picture, not with text. */
export function ImageToolbar({ editor, left, right, top, hidden = false }: ImageToolbarProps) {
  const { t } = useTranslation()
  const toolbarRef = React.useRef<HTMLDivElement>(null)
  const captionRef = React.useRef<HTMLInputElement>(null)
  const [width, setWidth] = React.useState(160)
  const [copied, setCopied] = React.useState(false)
  const [panel, setPanel] = React.useState<Panel>(null)
  const copiedTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const selection = editor.state.selection
  const picked = selection instanceof NodeSelection ? selection : null
  const attrs = picked?.node.attrs ?? {}
  const src = String(attrs.src ?? "")
  const pos = picked?.from ?? -1
  const hasCustomSize = Boolean(attrs.width || attrs.height)
  const [caption, setCaption] = React.useState(String(attrs.title ?? ""))
  const canReplace = canEditImageFiles(editor)

  React.useLayoutEffect(() => {
    if (toolbarRef.current && toolbarRef.current.offsetWidth > 0) {
      setWidth(toolbarRef.current.offsetWidth)
    }
  }, [left, right, top, panel, hasCustomSize])
  React.useEffect(() => {
    if (panel === "caption") captionRef.current?.focus()
  }, [panel])
  React.useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    },
    [],
  )

  function patch(change: ImagePatch) {
    updateImageNode(editor, pos, src, change)
  }

  const copy = async () => {
    if (!(await copyImageAt(editor, pos))) return
    setCopied(true)
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1400)
  }

  function applyCaption() {
    patch({ title: caption.trim() || null })
    setPanel(null)
    refocusPicture(editor, pos)
  }

  function togglePanel(next: Exclude<Panel, null>) {
    if (next === "caption") setCaption(String(attrs.title ?? ""))
    setPanel((current) => (current === next ? null : next))
  }

  // It starts at the left edge of the picture; where that would run it out of the window it
  // ends at the right edge of the picture instead.
  const overflows = left + width > window.innerWidth - 8
  const resolvedLeft = Math.max(
    8,
    Math.min(overflows ? right - width : left, window.innerWidth - width - 8),
  )
  const activeAlign = (attrs.align as string | null) ?? "left"

  return (
    <div
      ref={toolbarRef}
      data-image-toolbar
      className="amby-floating-menu fixed z-50 flex items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-xl backdrop-blur"
      style={{ left: resolvedLeft, top, visibility: hidden ? "hidden" : undefined }}
      onMouseDown={(event) => {
        // Keep the editor focused when a button is pressed; the caption field takes the focus.
        if (!(event.target instanceof HTMLInputElement)) event.preventDefault()
      }}
    >
      <ToolbarButton
        title={t("editorToolbar.imageOpen")}
        onClick={() => requestImageViewer(editor, pos)}
      >
        <Maximize className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title={t("editorToolbar.imageCaption")}
        active={panel === "caption" || Boolean(attrs.title)}
        onClick={() => togglePanel("caption")}
      >
        <Captions className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title={t("editorToolbar.imageAlign")}
        active={panel === "align"}
        onClick={() => togglePanel("align")}
      >
        {activeAlign === "center" ? (
          <AlignCenter className="size-3.5" />
        ) : activeAlign === "right" ? (
          <AlignRight className="size-3.5" />
        ) : (
          <AlignLeft className="size-3.5" />
        )}
      </ToolbarButton>
      {canReplace && (
        <>
          <ToolbarButton
            title={t("editorToolbar.imageReplace")}
            onClick={() => void replaceImageAt(editor, pos, src)}
          >
            <Replace className="size-3.5" />
          </ToolbarButton>
          {isVaultImage(src) && (
            <ToolbarButton
              title={t("editorToolbar.imageCrop")}
              onClick={() => requestImageCrop(editor, pos, src)}
            >
              <Crop className="size-3.5" />
            </ToolbarButton>
          )}
        </>
      )}
      <div className="mx-1 h-5 w-px bg-accent" />
      <ToolbarButton title={t("editorToolbar.imageCopy")} onClick={() => void copy()}>
        {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
      </ToolbarButton>
      <ToolbarButton
        title={t("editorToolbar.imageSave")}
        onClick={() => void saveImageAt(editor, pos, src)}
      >
        <Download className="size-3.5" />
      </ToolbarButton>
      {hasCustomSize && (
        <ToolbarButton
          title={t("editorToolbar.imageResetSize")}
          onClick={() => patch({ width: null, height: null })}
        >
          <RotateCcw className="size-3.5" />
        </ToolbarButton>
      )}
      <div className="mx-1 h-5 w-px bg-accent" />
      <ToolbarButton
        title={t("editorToolbar.imageDelete")}
        onClick={() => editor.chain().focus().deleteSelection().run()}
      >
        <Trash2 className="size-3.5" />
      </ToolbarButton>

      {panel && (
        <div className="absolute left-0 top-[calc(100%+6px)] rounded-md border border-border bg-popover p-1 shadow-xl">
          {panel === "caption" && (
            <div className="flex w-72 flex-col gap-1 p-1">
              <input
                ref={captionRef}
                value={caption}
                placeholder={t("editorToolbar.imageCaptionPlaceholder")}
                onChange={(event) => setCaption(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.key === "Enter") {
                    event.preventDefault()
                    applyCaption()
                  }
                  if (event.key === "Escape") {
                    setPanel(null)
                    refocusPicture(editor, pos)
                  }
                }}
                className="h-8 w-full rounded border border-border bg-background px-2 text-[13px] text-foreground outline-none focus:ring-1 focus:ring-ring"
              />
              <span className="px-0.5 text-[10px] text-muted-foreground">
                {t("editorToolbar.linkHint")}
              </span>
            </div>
          )}
          {panel === "align" && (
            <div className="flex gap-1">
              {ALIGNMENTS.map(({ id, Icon, labelKey }) => (
                <ToolbarButton
                  key={id}
                  title={t(labelKey)}
                  active={activeAlign === id}
                  onClick={() => {
                    // Left is how a picture stands anyway: it is written as no alignment.
                    patch({ align: id === "left" ? null : id })
                    setPanel(null)
                  }}
                >
                  <Icon className="size-3.5" />
                </ToolbarButton>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
