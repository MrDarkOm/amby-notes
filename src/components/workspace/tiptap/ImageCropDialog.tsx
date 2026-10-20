"use client"

import * as React from "react"
import type { Editor } from "@tiptap/react"
import { Check, ChevronDown, Shapes } from "lucide-react"
import { useTranslation } from "react-i18next"

import { importAssetBytes, showErrorMessage } from "@/lib/storage"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getAssetContext } from "./asset-resolver"
import { blobBytes, imageSaveFormat, imageSourceBlob } from "./image-actions"
import { updateImageNode } from "./image-edit"
import {
  dragCropRect,
  fitCropRatio,
  scaleCropRect,
  type CropHandle,
  type CropRect,
} from "./image-crop"

interface ImageCropDialogProps {
  /** The address the picture is shown from; the dialog is open while it is set. */
  src: string | null
  onCancel: () => void
  /** The part to keep, in the picture's own pixels, and whether it is cut to an ellipse. */
  onApply: (crop: CropRect, circle: boolean) => Promise<void>
}

/** The shapes the frame can be held to: `ratio` is width over height. */
const ASPECTS = [
  { id: "free", labelKey: "crop.freeform" },
  { id: "circle", labelKey: "crop.circle", ratio: 1, circle: true },
  { id: "square", labelKey: "crop.square", ratio: 1 },
  { id: "5:4", label: "5:4", ratio: 5 / 4 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "7:5", label: "7:5", ratio: 7 / 5 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "5:3", label: "5:3", ratio: 5 / 3 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
] as const

type AspectId = (typeof ASPECTS)[number]["id"]

const CORNERS = ["nw", "ne", "se", "sw"] as const
const EDGES = ["n", "e", "s", "w"] as const

/** A picture with a frame over it: what is inside the frame is what stays. */
export function ImageCropDialog({ src, onCancel, onApply }: ImageCropDialogProps) {
  const { t } = useTranslation()
  const imageRef = React.useRef<HTMLImageElement>(null)
  const [rect, setRect] = React.useState<CropRect | null>(null)
  const [aspectId, setAspectId] = React.useState<AspectId>("free")
  const [busy, setBusy] = React.useState(false)
  // The picture as it is shown (its own size, brought within the window) and what the window
  // around it needs.
  const [shown, setShown] = React.useState<{ width: number; height: number } | null>(null)
  const dragRef = React.useRef<{
    handle: CropHandle
    x: number
    y: number
    start: CropRect
  } | null>(null)
  const aspect = ASPECTS.find((candidate) => candidate.id === aspectId) ?? ASPECTS[0]
  const ratio = "ratio" in aspect ? aspect.ratio : undefined
  const circle = "circle" in aspect

  // A new picture starts with the whole of it framed, once it has been laid out.
  React.useEffect(() => {
    setRect(null)
    setShown(null)
    setBusy(false)
    setAspectId("free")
  }, [src])

  // Once the picture has its size, the whole of it is framed.
  React.useEffect(() => {
    const image = imageRef.current
    if (!shown || !image) return
    setRect({ x: 0, y: 0, width: image.clientWidth, height: image.clientHeight })
  }, [shown])

  function fitPicture() {
    const image = imageRef.current
    if (!image?.naturalWidth) return
    const scale = Math.min(
      1,
      (window.innerWidth - 144) / image.naturalWidth,
      (window.innerHeight * 0.6) / image.naturalHeight,
    )
    setShown({
      width: Math.max(1, Math.round(image.naturalWidth * scale)),
      height: Math.max(1, Math.round(image.naturalHeight * scale)),
    })
  }

  function bounds() {
    const image = imageRef.current
    return image ? { width: image.clientWidth, height: image.clientHeight } : null
  }

  function chooseAspect(id: AspectId) {
    setAspectId(id)
    const next = ASPECTS.find((candidate) => candidate.id === id)
    const size = bounds()
    if (size && next && "ratio" in next) setRect(fitCropRatio(size, next.ratio))
  }

  function startDrag(handle: CropHandle, event: React.PointerEvent<HTMLElement>) {
    if (!rect) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { handle, x: event.clientX, y: event.clientY, start: rect }
  }

  function moveDrag(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current
    const size = bounds()
    if (!drag || !size) return
    setRect(
      dragCropRect(
        drag.start,
        drag.handle,
        event.clientX - drag.x,
        event.clientY - drag.y,
        size,
        ratio,
      ),
    )
  }

  function endDrag() {
    dragRef.current = null
  }

  async function apply() {
    const image = imageRef.current
    if (!image || !rect || busy) return
    setBusy(true)
    const scale = image.naturalWidth / image.clientWidth
    try {
      await onApply(
        scaleCropRect(rect, scale, {
          x: 0,
          y: 0,
          width: image.naturalWidth,
          height: image.naturalHeight,
        }),
        circle,
      )
    } finally {
      setBusy(false)
    }
  }

  // As wide as the picture needs, within the window and not narrower than the bar above it.
  const dialogWidth = Math.min(window.innerWidth - 32, Math.max(560, (shown?.width ?? 0) + 80))

  const aspectLabel = (candidate: (typeof ASPECTS)[number]) =>
    "labelKey" in candidate ? t(candidate.labelKey) : candidate.label

  return (
    <Dialog open={src !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent
        showCloseButton={false}
        className="amby-crop-dialog gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-2rem)]"
        style={{ width: dialogWidth }}
      >
        <div className="amby-crop-header">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="amby-crop-shape-button"
                title={t("crop.shape")}
                aria-label={t("crop.shape")}
              >
                <Shapes className="size-4" />
                <ChevronDown className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-44">
              {ASPECTS.map((candidate) => (
                <React.Fragment key={candidate.id}>
                  <DropdownMenuItem
                    className="justify-between gap-6 text-[13px]"
                    onSelect={() => chooseAspect(candidate.id)}
                  >
                    {aspectLabel(candidate)}
                    {candidate.id === aspectId && <Check className="size-4" />}
                  </DropdownMenuItem>
                  {candidate.id === "free" && <DropdownMenuSeparator />}
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DialogTitle className="amby-crop-title">{t("editorToolbar.cropTitle")}</DialogTitle>
          <DialogDescription className="sr-only">{t("editorToolbar.cropTitle")}</DialogDescription>
          <div className="amby-crop-actions">
            <button type="button" className="amby-crop-cancel" onClick={onCancel} disabled={busy}>
              {t("common.cancel")}
            </button>
            <Button size="sm" onClick={() => void apply()} disabled={busy || !rect}>
              {t("common.save")}
            </Button>
          </div>
        </div>
        <div className="amby-crop-stage">
          {src && (
            <div className="relative inline-block max-w-full select-none">
              <img
                ref={imageRef}
                src={src}
                crossOrigin="anonymous"
                alt=""
                draggable={false}
                className="block"
                style={shown ?? { maxHeight: "60vh", maxWidth: "calc(100vw - 9rem)" }}
                onLoad={fitPicture}
              />
              {rect && (
                <div
                  data-crop-frame
                  className={`amby-crop-frame absolute cursor-move${circle ? " is-circle" : ""}`}
                  style={{
                    left: rect.x,
                    top: rect.y,
                    width: rect.width,
                    height: rect.height,
                    touchAction: "none",
                  }}
                  onPointerDown={(event) => startDrag("move", event)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                >
                  {CORNERS.map((handle) => (
                    <span
                      key={handle}
                      data-crop-handle={handle}
                      className={`amby-crop-corner amby-crop-corner--${handle}`}
                      onPointerDown={(event) => startDrag(handle, event)}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                    />
                  ))}
                  {EDGES.map((handle) => (
                    <span
                      key={handle}
                      data-crop-handle={handle}
                      className={`amby-crop-edge amby-crop-edge--${handle}`}
                      onPointerDown={(event) => startDrag(handle, event)}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The picture a crop was asked for: where it is, and the addresses it is known by. */
export interface CropRequest {
  pos: number
  /** The picture's address in the note. */
  src: string
  /** The address the picture is drawn from (the asset URL of the desktop app). */
  shownSrc: string
}

/**
 * Opens the crop dialog for a request and, on apply, saves the kept part as a new file of the
 * note's assets and points the picture at it. The original file is left as it was.
 */
export function ImageCropHost({
  editor,
  request,
  onClose,
}: {
  editor: Editor
  request: CropRequest | null
  onClose: () => void
}) {
  const { t } = useTranslation()

  async function apply(crop: CropRect, circle: boolean) {
    if (!request) return
    const context = getAssetContext(editor)
    try {
      if (!context?.vaultPath || !context.notePath) throw new Error("No note to save into")
      // A circle leaves transparent corners, which only PNG keeps.
      const format = circle ? "png" : imageSaveFormat(request.src)
      const blob = await imageSourceBlob(request.shownSrc, format, crop, circle)
      const asset = await importAssetBytes(
        context.vaultPath,
        context.notePath,
        await blobBytes(blob),
        format === "jpeg" ? "jpg" : "png",
      )
      if (!asset) throw new Error("The cropped picture was not saved")
      updateImageNode(editor, request.pos, request.src, {
        src: asset.relPath,
        width: null,
        height: null,
      })
      onClose()
    } catch {
      void showErrorMessage(t("editorToolbar.imageFailed"))
    }
  }

  return <ImageCropDialog src={request?.shownSrc ?? null} onCancel={onClose} onApply={apply} />
}
