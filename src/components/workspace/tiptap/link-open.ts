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
 * Cmd (macOS) or Ctrl (elsewhere) and a click on a link opens it: a web address in the
 * browser, a link to a PDF, audio or video file of the vault with the system's program.
 * On a bookmark card the click may be anywhere on the card. A plain click only places
 * the cursor, so a link can still be edited. What may be opened is decided by the
 * backend, as for the buttons; here only the address of the clicked link is read.
 */
export const LinkOpen = Extension.create({
  name: "linkOpen",

  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        props: {
          handleClick: (_view, _pos, event) => {
            if (!(event.metaKey || event.ctrlKey) || !(event.target instanceof Element))
              return false
            const anchor =
              event.target.closest("a[href]") ??
              event.target.closest("p.amby-bookmark")?.querySelector("a[href]") ??
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
