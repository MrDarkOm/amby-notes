import type { Editor } from "@tiptap/react"

import { attachmentKind, localFileKind } from "./attachment-kind"

/** One picture of the note, as the viewer needs it. */
export interface LightboxPicture {
  /** The address in the note. */
  src: string
  /** The address the picture is drawn from. */
  shownSrc: string
}

/** The note's pictures in reading order, and the index of the one at `pos`. */
export function collectPictures(
  editor: Editor,
  pos: number,
): { pictures: LightboxPicture[]; index: number } {
  const pictures: LightboxPicture[] = []
  let index = 0
  editor.state.doc.descendants((node, nodePos) => {
    if (node.type.name !== "image") return true
    const src = String(node.attrs.src ?? "")
    if (!src || attachmentKind(src) || localFileKind(src)) return false
    const dom = editor.view.nodeDOM(nodePos)
    const img = dom instanceof HTMLElement ? dom.querySelector("img") : null
    const shownSrc = img?.currentSrc || img?.src
    if (!shownSrc) return false
    if (nodePos === pos) index = pictures.length
    pictures.push({ src, shownSrc })
    return false
  })
  return { pictures, index }
}
