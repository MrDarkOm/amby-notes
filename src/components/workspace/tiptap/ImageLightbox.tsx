"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/react"
import { ChevronLeft, ChevronRight, Download, Minimize2, Minus, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"

import type { LightboxPicture } from "./image-gallery"
import { saveNoteImage } from "./image-save"

const MIN_SCALE = 0.1
const MAX_SCALE = 8
const STEP = 1.25

/** A picture over the whole window: zoom, move, step through the note's pictures, save. */
export function ImageLightbox({
  editor,
  pictures,
  start,
  onClose,
}: {
  editor: Editor
  pictures: LightboxPicture[]
  start: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [index, setIndex] = React.useState(start)
  const [scale, setScale] = React.useState(1)
  const [offset, setOffset] = React.useState({ x: 0, y: 0 })
  const imageRef = React.useRef<HTMLImageElement>(null)
  const dragRef = React.useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(
    null,
  )
  const picture = pictures[index]

  /** The scale at which the whole picture fits the window (never above its own size). */
  const fitScale = React.useCallback(() => {
    const image = imageRef.current
    if (!image?.naturalWidth) return 1
    return Math.min(
      1,
      (window.innerWidth * 0.9) / image.naturalWidth,
      (window.innerHeight * 0.8) / image.naturalHeight,
    )
  }, [])

  const fit = React.useCallback(() => {
    setScale(fitScale())
    setOffset({ x: 0, y: 0 })
  }, [fitScale])

  const zoomBy = React.useCallback((factor: number) => {
    setScale((current) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, current * factor)))
  }, [])

  const step = React.useCallback(
    (direction: -1 | 1) => {
      if (pictures.length < 2) return
      setIndex((current) => (current + direction + pictures.length) % pictures.length)
    },
    [pictures.length],
  )

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const handled = ["Escape", "ArrowLeft", "ArrowRight", "+", "=", "-", "_", "0"]
      if (!handled.includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === "Escape") onClose()
      else if (event.key === "ArrowLeft") step(-1)
      else if (event.key === "ArrowRight") step(1)
      else if (event.key === "0") fit()
      else if (event.key === "-" || event.key === "_") zoomBy(1 / STEP)
      else zoomBy(STEP)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [fit, onClose, step, zoomBy])

  if (!picture) return null

  return createPortal(
    <div
      className="amby-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t("editorToolbar.imageOpen")}
      data-image-lightbox
      onMouseDown={(event) => {
        // A press on the backdrop, not on the picture or the bar, closes the viewer.
        if (event.target === event.currentTarget) onClose()
      }}
      onWheel={(event) => zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1)}
    >
      <img
        key={picture.shownSrc}
        ref={imageRef}
        src={picture.shownSrc}
        alt=""
        draggable={false}
        className="amby-lightbox-image"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        onLoad={fit}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          dragRef.current = { x: event.clientX, y: event.clientY, from: offset }
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag) return
          setOffset({
            x: drag.from.x + event.clientX - drag.x,
            y: drag.from.y + event.clientY - drag.y,
          })
        }}
        onPointerUp={() => (dragRef.current = null)}
        onPointerCancel={() => (dragRef.current = null)}
        onDoubleClick={fit}
      />
      {pictures.length > 1 && (
        <>
          <button
            type="button"
            className="amby-lightbox-arrow amby-lightbox-arrow--previous"
            aria-label={t("attachmentsPanel.previous")}
            onClick={() => step(-1)}
          >
            <ChevronLeft className="size-5" />
          </button>
          <button
            type="button"
            className="amby-lightbox-arrow amby-lightbox-arrow--next"
            aria-label={t("attachmentsPanel.next")}
            onClick={() => step(1)}
          >
            <ChevronRight className="size-5" />
          </button>
        </>
      )}
      <div className="amby-lightbox-bar">
        <button
          type="button"
          className="amby-lightbox-button"
          title={t("lightbox.zoomOut")}
          aria-label={t("lightbox.zoomOut")}
          onClick={() => zoomBy(1 / STEP)}
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          className="amby-lightbox-percent"
          title={t("lightbox.fit")}
          aria-label={t("lightbox.fit")}
          onClick={fit}
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          className="amby-lightbox-button"
          title={t("lightbox.zoomIn")}
          aria-label={t("lightbox.zoomIn")}
          onClick={() => zoomBy(STEP)}
        >
          <Plus className="size-4" />
        </button>
        <span className="amby-lightbox-divider" />
        {pictures.length > 1 && (
          <span className="amby-lightbox-counter">
            {index + 1} / {pictures.length}
          </span>
        )}
        <button
          type="button"
          className="amby-lightbox-button"
          title={t("editorToolbar.imageSave")}
          aria-label={t("editorToolbar.imageSave")}
          onClick={() => void saveNoteImage(editor, picture.src, picture.shownSrc)}
        >
          <Download className="size-4" />
        </button>
        <span className="amby-lightbox-divider" />
        <button
          type="button"
          className="amby-lightbox-button"
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <Minimize2 className="size-4" />
        </button>
      </div>
    </div>,
    document.body,
  )
}
