import { Extension } from "@tiptap/core"
import { Plugin } from "@tiptap/pm/state"

import { attachmentKind } from "./attachment-kind"
import { getAssetContext } from "./asset-resolver"
import {
  attachmentFilePath,
  openAttachmentWithSystem,
  openWebAddressInBrowser,
} from "./external-open"

/**
 * A click on a link opens it: a web address in the browser, a link to a PDF, audio or
 * video file of the vault with the system's program. Cmd (macOS) or Ctrl and a click does
 * the same anywhere on a bookmark card, not only on its link. Shift and Alt are left for
 * selecting and are not clicks on a link. A link is edited from the keyboard (arrow keys
 * into it) or by clicking next to it. What may be opened is decided by the backend, as for
 * the buttons; here only the address of the clicked link is read.
 */
export const LinkOpen = Extension.create({
  name: "linkOpen",

  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        props: {
          handleClick: (_view, _pos, event) => {
            if (event.shiftKey || event.altKey || !(event.target instanceof Element)) return false
            const anywhereOnCard = event.metaKey || event.ctrlKey
            const anchor =
              event.target.closest("a[href]") ??
              (anywhereOnCard
                ? event.target.closest("p.amby-bookmark")?.querySelector("a[href]")
                : null) ??
              null
            const href = anchor?.getAttribute("href")
            if (!href) return false
            if (/^https?:\/\//iu.test(href)) {
              event.preventDefault()
              void openWebAddressInBrowser(href)
              return true
            }
            const notePath = getAssetContext(editor)?.notePath
            if (notePath && !/^[a-z][a-z0-9+.-]+:/iu.test(href) && attachmentKind(href)) {
              event.preventDefault()
              void openAttachmentWithSystem(notePath, attachmentFilePath(href))
              return true
            }
            return false
          },
        },
      }),
    ]
  },
})
