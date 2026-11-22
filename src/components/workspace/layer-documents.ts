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

/** Ignore an attached layer preference when the feature that exposes it is switched off. */
export function visibleDocumentLayer(
  tab: Pick<Tab, "kind"> | null | undefined,
  path: string | null | undefined,
  preferred: EditorLayer | undefined,
  supernotesEnabled: boolean,
  databasesEnabled: boolean,
): EditorLayer {
  const selected = preferred ?? naturalDocumentLayer(tab, path)
  if (supernotesEnabled && (databasesEnabled || selected !== "database")) return selected

  // A primary-layer preference can also have changed the tab kind. Prefer the actual file.
  if (path?.endsWith(".md")) return "editor"
  if (path?.endsWith(CANVAS_EXTENSION)) return "canvas"
  if (path?.endsWith(SKETCH_EXTENSION)) return "sketch"
  return naturalDocumentLayer(tab, path)
}
