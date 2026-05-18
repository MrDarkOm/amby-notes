import { Image } from "@tiptap/extension-image"
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react"

import { resolveAssetSrc } from "./asset-resolver"

function AmbyImageView({ node, selected, editor }: NodeViewProps) {
  const src = node.attrs.src as string
  const resolved = resolveAssetSrc(editor ?? null, src)
  const alt = (node.attrs.alt as string | undefined) ?? ""
  const title = (node.attrs.title as string | undefined) ?? undefined
  const align = (node.attrs.align as string | undefined) ?? null
  const alignClass = align ? ` amby-image-wrap--${align}` : ""
  return (
    <NodeViewWrapper
      as="div"
      className={"amby-image-wrap" + alignClass + (selected ? " is-selected" : "")}
      data-asset-src={src}
    >
      <img
        src={resolved}
        alt={alt}
        title={title}
        draggable={false}
        onError={e => {
          e.currentTarget.classList.add("is-broken")
        }}
      />
    </NodeViewWrapper>
  )
}

export const AmbyImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      align: {
        default: null as string | null,
        rendered: false,
      },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(AmbyImageView)
  },
})
