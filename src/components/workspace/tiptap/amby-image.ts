import { Image } from "@tiptap/extension-image"
import { ReactNodeViewRenderer } from "@tiptap/react"

import { AmbyImageView } from "./amby-image-view"

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
  addNodeView() {
    return ReactNodeViewRenderer(AmbyImageView)
  },
})
