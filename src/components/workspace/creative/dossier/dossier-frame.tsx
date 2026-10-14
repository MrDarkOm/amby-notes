import * as React from "react"
import { cn } from "@/lib/utils"
import { DossierAside } from "./dossier-aside"
import { hasPlotSections } from "./dossier-model"
import { DossierHeader } from "./dossier-header"
import { TextPageAside } from "./text-page-aside"
import { useNotePlace } from "./use-note-dossier"

/** Side by side only where the text keeps a readable column next to the blocks. */
const SIDE_BY_SIDE_MIN_WIDTH = 640

/** The width of the pane this frame is in. The window's width says nothing when sidebars are open. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const update = () => setWidth(element.clientWidth)
    update()
    if (typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

export interface DossierFrameProps {
  noteId: string
  /** The page's Markdown. */
  content: string
  /** Scrolls the page to its n-th heading. */
  scrollToHeading: (index: number) => void
  /** Headings can be jumped to only where they are on screen (not in the source editor). */
  canJump: boolean
  onOpenNote?: (noteId: string) => void
  /** The editor. It stays in the same place of the tree whether or not the page is a dossier. */
  children: React.ReactNode
}

/**
 * Wraps a note's editor. For a page of a creative world section it adds the dossier header
 * above the text and the blocks beside it (under it on a narrow window); for a page of a story's
 * text, in a workshop that has anchors or arcs, the plot of the page beside it; for any other
 * note it adds nothing visible. The structure is the same either way, so the editor is never
 * remounted when the answer arrives.
 */
export function DossierFrame({
  noteId,
  content,
  scrollToHeading,
  canJump,
  onOpenNote,
  children,
}: DossierFrameProps) {
  const place = useNotePlace(noteId)
  const dossier = place?.kind === "world" ? place.dossier : null
  const textPlace =
    place?.kind === "text" && hasPlotSections(place.text.workshop) ? place.text : null
  const framed = dossier !== null || textPlace !== null
  const frameRef = React.useRef<HTMLDivElement>(null)
  const sideBySide = useWidth(frameRef) >= SIDE_BY_SIDE_MIN_WIDTH
  return (
    <div ref={frameRef} className="min-w-0">
      {dossier ? <DossierHeader dossier={dossier} /> : null}
      <div
        className={cn(
          framed ? "flex gap-6" : "contents",
          framed && !sideBySide && "flex-col",
          framed && sideBySide && "items-start",
        )}
      >
        <div className={framed ? "min-w-0 flex-1" : "contents"}>{children}</div>
        {dossier ? (
          <DossierAside
            dossier={dossier}
            content={content}
            canJump={canJump}
            onJump={scrollToHeading}
            onOpenNote={onOpenNote}
            sideBySide={sideBySide}
          />
        ) : textPlace ? (
          <TextPageAside
            workshop={textPlace.workshop}
            story={textPlace.story}
            noteId={noteId}
            onOpenNote={onOpenNote}
            sideBySide={sideBySide}
          />
        ) : null}
      </div>
    </div>
  )
}
