import type { WorkshopSectionSummary, WorkshopSummary } from "@/lib/storage"

/** The bases a whole workshop has beyond the three of the first stages, in the order made. */
export const COMPLETABLE_ROLES = ["universes", "arcs", "anchors", "notes"] as const

export interface WorkshopGaps {
  /** Roles of the bases the workshop lacks (those "Create the missing sections" makes). */
  roles: string[]
  /** What the links lack, as short codes (`stories:<section>`, `universe`, `anchors:arcs`, …). */
  links: string[]
}

function usable(section: WorkshopSectionSummary | undefined): section is WorkshopSectionSummary {
  return section !== undefined && section.state !== "missing"
}

/**
 * What a workshop lacks of a whole one: bases absent, and links between bases and to the texts of
 * its stories absent where both ends exist. Pure and read-only; nothing is written to learn it.
 * A section whose database was not found is left out (it cannot be linked) and a workshop of an
 * unknown format has none (it is never written).
 */
export function workshopGaps(workshop: WorkshopSummary): WorkshopGaps {
  if (workshop.readOnly) return { roles: [], links: [] }
  const byRole = (role: string) => workshop.sections.find((section) => section.role === role)
  const roles = COMPLETABLE_ROLES.filter((role) => byRole(role) === undefined)
  const links: string[] = []

  for (const section of workshop.sections) {
    if (!usable(section)) continue
    if (section.role !== "stories" && section.role !== "universes" && !section.storiesPropertyId) {
      links.push(`stories:${section.id}`)
    }
  }
  const stories = byRole("stories")
  const universes = byRole("universes")
  const anchors = byRole("anchors")
  const arcs = byRole("arcs")
  if (usable(stories) && usable(universes) && !stories.universePropertyId) links.push("universe")
  if (usable(anchors)) {
    if (usable(arcs) && !anchors.arcsPropertyId) links.push("anchors:arcs")
    if (usable(universes) && !anchors.universePropertyId) links.push("anchors:universe")
  }
  for (const story of workshop.stories) {
    const properties = story.text?.properties
    if (!story.databaseId || !properties) continue
    if (usable(anchors) && !properties.anchors) links.push(`text:${story.storyId}:anchors`)
    if (usable(arcs) && !properties.arcs) links.push(`text:${story.storyId}:arcs`)
  }
  return { roles: [...roles], links }
}

export function hasGaps(gaps: WorkshopGaps): boolean {
  return gaps.roles.length > 0 || gaps.links.length > 0
}
