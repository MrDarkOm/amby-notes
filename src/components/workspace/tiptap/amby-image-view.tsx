import * as React from "react"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"

import { attachmentKind, localFileKind } from "./attachment-kind"
import { AttachmentImageView } from "./attachment-view"
import {
  getAssetResolverRevision,
  primeAssetConverter,
  resolveAssetSrcCandidates,
  subscribeAssetResolver,
} from "./asset-resolver"

/** An image node shows a player or a card when its address is an audio, video or PDF file. */
export function AmbyImageView(props: NodeViewProps) {
  const src = props.node.attrs.src as string | null
  const kind = attachmentKind(src) ?? localFileKind(src)
  return kind ? <AttachmentImageView {...props} kind={kind} /> : <AmbyImageContent {...props} />
}

function AmbyImageContent({ node, selected, editor, updateAttributes }: NodeViewProps) {
  // The editor context and Tauri's file URL converter are registered just
  // after the first editor render. Subscribe so a relative source is retried
  // immediately instead of waiting for a selection/click to refresh it.
  const assetEditor = editor ?? null
  const subscribe = React.useCallback(
    (listener: () => void) => subscribeAssetResolver(assetEditor, listener),
    [assetEditor],
  )
  const getSnapshot = React.useCallback(() => getAssetResolverRevision(assetEditor), [assetEditor])
  React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  React.useEffect(() => {
    void primeAssetConverter()
  }, [])

  const src = node.attrs.src as string
  const candidates = resolveAssetSrcCandidates(editor ?? null, src)
  const [candidateIndex, setCandidateIndex] = React.useState(0)
  React.useEffect(() => {
    setCandidateIndex(0)
  }, [src, editor])
  const resolved = candidates[Math.min(candidateIndex, candidates.length - 1)] ?? src
  const alt = (node.attrs.alt as string | undefined) ?? ""
  const title = (node.attrs.title as string | undefined) ?? undefined
  const align = (node.attrs.align as string | undefined) ?? null
  const alignClass = align ? ` amby-image-wrap--${align}` : ""

  const nodeWidth = node.attrs.width as number | string | null | undefined
  const parsedWidth =
    typeof nodeWidth === "number"
      ? nodeWidth
      : nodeWidth
        ? parseInt(String(nodeWidth), 10) || null
        : null

  const [resizingWidth, setResizingWidth] = React.useState<number | null>(null)
  const [isResizing, setIsResizing] = React.useState(false)
  const imgRef = React.useRef<HTMLImageElement>(null)

  const displayWidth = resizingWidth ?? parsedWidth

  const handleResizeStart = (e: React.PointerEvent, handle: "right" | "left") => {
    if (!editor?.isEditable) return
    e.preventDefault()
    e.stopPropagation()
    const img = imgRef.current
    if (!img) return

    const startX = e.clientX
    const startWidth = img.getBoundingClientRect().width
    setIsResizing(true)
    setResizingWidth(startWidth)

    let currentWidth = startWidth

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX
      const factor = align === "center" ? 2 : 1
      let newWidth: number
      if (handle === "right") {
        newWidth = startWidth + deltaX * factor
      } else {
        newWidth = startWidth - deltaX * factor
      }
      newWidth = Math.max(60, Math.min(1600, Math.round(newWidth)))
      currentWidth = newWidth
      setResizingWidth(newWidth)
    }

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      setIsResizing(false)
      setResizingWidth(null)
      updateAttributes({ width: Math.round(currentWidth) })
    }

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
  }

  const handleResetSize = (e: React.MouseEvent) => {
    if (!editor?.isEditable) return
    e.preventDefault()
    e.stopPropagation()
    setResizingWidth(null)
    updateAttributes({ width: null, height: null })
  }

  // Images are configured as inline ProseMirror nodes. Keeping the wrapper
  // inline avoids invalid div-inside-paragraph DOM, which can detach the
  // image and confuse the block handle after a reflow.
  return (
    <NodeViewWrapper
      as="span"
      className={`amby-image-wrap${alignClass}${selected ? " is-selected" : ""}${isResizing ? " is-resizing" : ""}`}
      data-asset-src={src}
    >
      <span className="amby-image-container">
        <img
          ref={imgRef}
          key={resolved}
          src={resolved}
          alt={alt}
          title={title}
          draggable={false}
          style={{
            width: displayWidth ? `${displayWidth}px` : undefined,
          }}
          onLoad={(event) => {
            event.currentTarget.classList.remove("is-broken")
          }}
          onError={(event) => {
            if (candidateIndex < candidates.length - 1) {
              setCandidateIndex((index) => index + 1)
            } else {
              event.currentTarget.classList.add("is-broken")
            }
          }}
        />
        {editor?.isEditable && (
          <>
            <span
              className="amby-image-resizer amby-image-resizer--right"
              onPointerDown={(e) => handleResizeStart(e, "right")}
              onDoubleClick={handleResetSize}
            />
            <span
              className="amby-image-resizer amby-image-resizer--left"
              onPointerDown={(e) => handleResizeStart(e, "left")}
              onDoubleClick={handleResetSize}
            />
            {isResizing && displayWidth && (
              <span className="amby-image-size-badge">{`${Math.round(displayWidth)}px`}</span>
            )}
          </>
        )}
      </span>
    </NodeViewWrapper>
  )
}
