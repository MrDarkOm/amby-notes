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
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(AmbyImageView)
  },
})
