import type { EditorLayer } from "./use-view-state-store"
import type { Tab } from "./use-tabs-store"

type LayerTab = Pick<Tab, "kind" | "fileId">

const CANVAS_EXTENSION = ".canvas"
const SKETCH_EXTENSION = ".excalidraw"

/**
 * A tab whose document is not a plain note buffer: a canvas, a sketch or a database, by the tab's
 * kind or by the file name of the tab or of the buffer behind it. Such a document has no text to
 * read from the disk the way a note has.
 */
export function isLayerDocument(tab: LayerTab | null | undefined, path?: string | null): boolean {
  if (!tab) return false
  return (
    tab.kind === "canvas" ||
    tab.kind === "sketch" ||
    tab.kind === "database" ||
    tab.fileId.endsWith(CANVAS_EXTENSION) ||
    tab.fileId.endsWith(SKETCH_EXTENSION) ||
    Boolean(path?.endsWith(CANVAS_EXTENSION)) ||
    Boolean(path?.endsWith(SKETCH_EXTENSION))
  )
}

/** The layer a document opens on when nothing says otherwise: its own kind, else the editor. */
export function naturalDocumentLayer(
  tab: Pick<Tab, "kind"> | null | undefined,
  path: string | null | undefined,
): EditorLayer {
  if (tab?.kind === "canvas" || path?.endsWith(CANVAS_EXTENSION)) return "canvas"
  if (tab?.kind === "sketch" || path?.endsWith(SKETCH_EXTENSION)) return "sketch"
  if (tab?.kind === "database") return "database"
  return "editor"
}
