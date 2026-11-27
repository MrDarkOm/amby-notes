import type { PageCrumb } from "../page-chrome/page-chrome-types"
import { standaloneTargetId, universeTargetId, type ProjectTarget } from "./project-tree-model"

interface CrumbInput {
  target: ProjectTarget
  /** "Workshop": the root of every trail. */
  workshopLabel: string
  /** "Standalone stories". */
  standaloneLabel: string
  /** The name of the page itself (the story's, the universe's, the workshop's). */
  pageTitle: string
  /** A story's universe: its note ID and, once read, its name. */
  storyUniverse: { id: string; title: string | undefined } | null
  /** The name a universe has before its card is read. */
  universeFallback: string
  /** The section tab that is open, if any. */
  sectionName: string | null
  /** Goes to a page of the workshop (the overview of the project when no section is named). */
  open: (projectId: string) => void
}

/**
 * The trail of a workshop page: Workshop › (universe or standalone stories) › story › section.
 * Every crumb but the last opens its page; with a section open the page itself opens its overview.
 */
export function creativeCrumbs({
  target,
  workshopLabel,
  standaloneLabel,
  pageTitle,
  storyUniverse,
  universeFallback,
  sectionName,
  open,
}: CrumbInput): PageCrumb[] {
  const workshopId = target.workshop.workshopId
  const crumbs: PageCrumb[] = []
  const add = (key: string, label: string, projectId: string) =>
    crumbs.push({ key, label, onOpen: () => open(projectId) })

  if (target.kind !== "workshop") add("workshop", workshopLabel, workshopId)
  switch (target.kind) {
    case "workshop":
      add("page", workshopLabel, workshopId)
      break
    case "universe":
      add("page", pageTitle, universeTargetId(target.universeId))
      break
    case "standalone":
      add("page", standaloneLabel, standaloneTargetId(workshopId))
      break
    case "story":
      if (storyUniverse) {
        add(
          "parent",
          storyUniverse.title?.trim() || universeFallback,
          universeTargetId(storyUniverse.id),
        )
      } else {
        add("parent", standaloneLabel, standaloneTargetId(workshopId))
      }
      add("page", pageTitle, target.story.storyId)
      break
  }
  if (sectionName) crumbs.push({ key: "section", label: sectionName })
  // The last crumb is the page itself: it is never a link.
  const last = crumbs[crumbs.length - 1]
  if (last) crumbs[crumbs.length - 1] = { ...last, onOpen: undefined }
  return crumbs
}
