import * as React from "react"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { motion } from "motion/react"

import { motionTransitions } from "@/lib/motion-config"
import {
  getAssetResolverRevision,
  primeAssetConverter,
  resolveAssetSrcCandidates,
  subscribeAssetResolver,
} from "./asset-resolver"

export function AmbyImageView({ node, selected, editor }: NodeViewProps) {
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
  // Images are configured as inline ProseMirror nodes. Keeping the wrapper
  // inline avoids invalid div-inside-paragraph DOM, which can detach the
  // image and confuse the block handle after a reflow.
  return (
    <NodeViewWrapper
      as="span"
      className={`amby-image-wrap${alignClass}${selected ? " is-selected" : ""}`}
      data-asset-src={src}
    >
      <motion.img
        key={resolved}
        src={resolved}
        alt={alt}
        title={title}
        draggable={false}
        animate={{
          borderColor: selected
            ? "var(--image-selected-border)"
            : "var(--image-border, var(--border))",
          boxShadow: selected ? "var(--image-selected-shadow)" : "var(--image-shadow)",
        }}
        transition={motionTransitions.default}
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
    </NodeViewWrapper>
  )
}
