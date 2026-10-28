import { Image } from "@tiptap/extension-image"
import { ReactNodeViewRenderer } from "@tiptap/react"

import { AmbyImageView } from "./amby-image-view"
import { attachmentKind, isRemoteAddress } from "./attachment-kind"

export const AmbyImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      align: {
        default: null as string | null,
        rendered: false,
      },
      width: {
        default: null as number | string | null,
        parseHTML: (element) => element.getAttribute("width") || null,
        renderHTML: (attributes) => {
          if (!attributes.width) return {}
          return { width: attributes.width }
        },
      },
      height: {
        default: null as number | string | null,
        parseHTML: (element) => element.getAttribute("height") || null,
        renderHTML: (attributes) => {
          if (!attributes.height) return {}
          return { height: attributes.height }
        },
      },
      hasPipe: {
        default: false,
        rendered: false,
      },
    }
  },
  parseHTML() {
    return [
      { tag: "a[data-amby-remote-attachment][src]", priority: 1000 },
      ...(this.parent?.() ?? []),
    ]
  },
  renderHTML({ node, HTMLAttributes }) {
    const src = typeof HTMLAttributes.src === "string" ? HTMLAttributes.src : ""
    if (attachmentKind(src) && isRemoteAddress(src)) {
      // React StrictMode can briefly remove node views. The ProseMirror fallback
      // must not create an <img> that fetches a remote audio/video/PDF address.
      const href = /^(?:https?:)?\/\//iu.test(src) ? src : undefined
      return [
        "a",
        { ...HTMLAttributes, ...(href ? { href } : {}), "data-amby-remote-attachment": "" },
        typeof HTMLAttributes.alt === "string" && HTMLAttributes.alt ? HTMLAttributes.alt : src,
      ]
    }
    return this.parent?.({ node, HTMLAttributes }) ?? ["img", HTMLAttributes]
  },
  addNodeView() {
    return ReactNodeViewRenderer(AmbyImageView)
  },
})
