import type * as React from "react"
import type { PageCrumb } from "../page-chrome/page-chrome-types"
import type { NoteTrailProps } from "../editor/document-header"
import { useNoteTrail } from "./use-note-trail"
import type { TrailStep } from "./note-trail"

/** The step as a crumb: it opens its workshop page, or a page of the text, in place. */
function crumbOf(
  step: TrailStep,
  isLast: boolean,
  props: Pick<NoteTrailProps, "onOpenPage" | "onOpenNote">,
  icon: React.ReactNode,
): PageCrumb {
  const to = step.to
  return {
    key: step.key,
    label: step.label,
    icon: isLast ? icon : undefined,
    onOpen:
      isLast || !to
        ? undefined
        : to.kind === "page"
          ? () => props.onOpenPage?.(to.projectId, to.sectionId)
          : () => props.onOpenNote?.(to.noteId),
  }
}

/**
 * Hands the note's header the logical path of a note of the workshop in place of its folders. It
 * keeps the folder crumbs until the path is known, so the header never flashes, and for every
 * note that is not in the workshop.
 */
export function CreativeNoteTrail({
  noteId,
  folderCrumbs,
  onOpenPage,
  onOpenNote,
  render,
}: NoteTrailProps) {
  const steps = useNoteTrail(noteId)
  if (!steps) return render(folderCrumbs)
  const icon = folderCrumbs[folderCrumbs.length - 1]?.icon
  return render(
    steps.map((step, index) =>
      crumbOf(step, index === steps.length - 1, { onOpenPage, onOpenNote }, icon),
    ),
  )
}
