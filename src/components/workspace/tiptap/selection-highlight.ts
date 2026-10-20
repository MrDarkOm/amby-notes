import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"

/**
 * Draws the text selection from a range instead of leaving it to the browser.
 *
 * WebKit (the macOS webview) fills the gaps between selected blocks: the space between two
 * paragraphs is painted as one more selected line, and an image or a block end gets a band
 * to the right edge. A range registered with the CSS Custom Highlight API is painted from the
 * text's own line boxes only, so exactly the selected text is tinted. The native paint is
 * hidden on the editor while the range is drawn (`amby-custom-selection`).
 *
 * The range is drawn only while the editor has the focus: a selection left in an editor the
 * user has clicked out of is not shown as if it were still live. Without the Highlight API the
 * browser's own selection stays as it was.
 */

export const SELECTION_HIGHLIGHT_NAME = "amby-selection"
export const SELECTION_ACTIVE_CLASS = "amby-custom-selection"
/** Set on the wrapper of a picture that lies inside the selected text. */
export const SELECTED_IMAGE_ATTRIBUTE = "data-in-selection"

const views = new Set<EditorView>()
let painted: EditorView | null = null
let listening = false
/** Pictures inside the drawn selection; a range paints no picture, so they are marked. */
let markedImages: HTMLElement[] = []

function highlightSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
}

function unmarkImages() {
  for (const image of markedImages) image.removeAttribute(SELECTED_IMAGE_ATTRIBUTE)
  markedImages = []
}

function clear() {
  unmarkImages()
  if (highlightSupported()) CSS.highlights.delete(SELECTION_HIGHLIGHT_NAME)
  painted?.dom.classList.remove(SELECTION_ACTIVE_CLASS)
  painted = null
}

/** The editor that owns the document's selection range, if it is one to draw. */
function ownerOf(range: Range): EditorView | null {
  for (const view of views) {
    if (view.isDestroyed || !view.dom.contains(range.commonAncestorContainer)) continue
    // A selected node or cell hides the browser's selection on purpose.
    if (view.dom.classList.contains("ProseMirror-hideselection")) return null
    if (view.editable && !view.hasFocus()) return null
    return view
  }
  return null
}

/** Draws the document's current selection range, or removes the drawing. */
export function refreshSelectionHighlight() {
  if (!highlightSupported()) return
  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    clear()
    return
  }
  const range = selection.getRangeAt(0)
  const owner = ownerOf(range)
  if (!owner) {
    clear()
    return
  }
  if (painted && painted !== owner) painted.dom.classList.remove(SELECTION_ACTIVE_CLASS)
  painted = owner
  owner.dom.classList.add(SELECTION_ACTIVE_CLASS)
  CSS.highlights.set(SELECTION_HIGHLIGHT_NAME, new Highlight(range.cloneRange()))
  unmarkImages()
  owner.dom.querySelectorAll<HTMLElement>(".amby-image-wrap").forEach((image) => {
    if (!selection.containsNode(image)) return
    image.setAttribute(SELECTED_IMAGE_ATTRIBUTE, "")
    markedImages.push(image)
  })
}

function register(view: EditorView) {
  views.add(view)
  if (!listening) {
    listening = true
    document.addEventListener("selectionchange", refreshSelectionHighlight)
  }
}

function unregister(view: EditorView) {
  views.delete(view)
  if (painted === view) clear()
  if (views.size === 0 && listening) {
    listening = false
    document.removeEventListener("selectionchange", refreshSelectionHighlight)
  }
}

const selectionHighlightKey = new PluginKey("selectionHighlight")

export const SelectionHighlight = Extension.create({
  name: "selectionHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: selectionHighlightKey,
        view(view) {
          register(view)
          return {
            // A selected node or cell changes the editor's class without moving the range.
            update: () => refreshSelectionHighlight(),
            destroy: () => unregister(view),
          }
        },
        props: {
          handleDOMEvents: {
            focus() {
              refreshSelectionHighlight()
              return false
            },
            blur() {
              refreshSelectionHighlight()
              return false
            },
          },
        },
      }),
    ]
  },
})
