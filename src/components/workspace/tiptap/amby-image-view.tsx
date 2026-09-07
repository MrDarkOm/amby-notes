import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { motion } from "motion/react"

import { motionTransitions } from "@/lib/motion-config"
import { resolveAssetSrc } from "./asset-resolver"

export function AmbyImageView({ node, selected, editor }: NodeViewProps) {
  const src = node.attrs.src as string
  const resolved = resolveAssetSrc(editor ?? null, src)
  const alt = (node.attrs.alt as string | undefined) ?? ""
  const title = (node.attrs.title as string | undefined) ?? undefined
  const align = (node.attrs.align as string | undefined) ?? null
  const alignClass = align ? ` amby-image-wrap--${align}` : ""
  return (
    <NodeViewWrapper
      as="div"
      className={`amby-image-wrap${alignClass}${selected ? " is-selected" : ""}`}
      data-asset-src={src}
    >
      <motion.img
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
        onError={(event) => {
          event.currentTarget.classList.add("is-broken")
        }}
      />
    </NodeViewWrapper>
  )
}
