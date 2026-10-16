import * as React from "react"
import type {
  DatabaseRow,
  StorySummary,
  WorkshopSectionSummary,
  WorkshopSummary,
} from "@/lib/storage"
import { useCreativeNavStore } from "../creative-nav-store"
import { bucketAnchors, universeEvents } from "./plot-views"
import { useAnchorOrder } from "./use-anchor-order"
import { useDatabaseRows } from "./use-database-rows"
import {
  buildMembership,
  entityItemsOf,
  relationTargetsOf,
  scopeEntities,
  scopeSections,
  storiesInScope,
  storySection,
  type Membership,
  type PanelFilter,
} from "./workshop-model"

/** One list of the scope: the pages of a section that belong here. */
export interface ScopeList {
  section: WorkshopSectionSummary
  shown: DatabaseRow[]
  /** Only for the standalone stories: pages that are in no story at all. */
  withoutStory: DatabaseRow[]
}

export interface ScopeData {
  /** The rows are still being read (or have not been asked for). */
  loading: boolean
  failed: boolean
  /** Rows by database ID: the stories, every list of the scope and the text of the stories read. */
  rows: Readonly<Record<string, DatabaseRow[]>>
  /** The stories the filter holds: the one story, the universe's, or those no universe holds. */
  stories: StorySummary[]
  membership: Membership
  /** The anchors that name the universe, in the author's order; none for any other scope. */
  events: DatabaseRow[]
  /** The lists of the scope, in tab order (`scopeSections`). */
  lists: ScopeList[]
}

const NONE: Record<string, DatabaseRow[]> = {}

/**
 * What the page of a story, of a universe or of the standalone stories lists: the rows of the
 * stories base, of every list the page can open and of the text of the stories that decide who
 * belongs where. It is the panel's filter (`PanelFilter`, `buildMembership`) on rows read in one
 * go, so the page and the panel never disagree about what belongs to a place. With no filter
 * nothing is read.
 */
export function useScopeData(
  workshop: WorkshopSummary | null,
  filter: PanelFilter | null,
): ScopeData {
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const storiesSection = workshop?.sections.find(
    (section) => section.role === "stories" && section.state !== "missing",
  )
  const anchorsSection = storySection(workshop, "anchors")
  const sections = React.useMemo(() => scopeSections(workshop), [workshop])
  // A story's page needs only its own text; the other two decide by every story's card and text.
  const textStories = React.useMemo(() => {
    const all = workshop?.stories ?? []
    return filter?.kind === "story" ? all.filter((story) => story.storyId === filter.storyId) : all
  }, [filter, workshop?.stories])
  const databaseIds = React.useMemo(
    () =>
      filter === null
        ? []
        : [
            ...(storiesSection ? [storiesSection.databaseId] : []),
            ...sections.map((section) => section.databaseId),
            ...textStories.flatMap((story) => (story.databaseId ? [story.databaseId] : [])),
          ],
    [filter, sections, storiesSection, textStories],
  )
  const data = useDatabaseRows(databaseIds, dataNonce)
  const anchorOrder = useAnchorOrder(filter ? anchorsSection?.databaseId : null, dataNonce)

  const membership = React.useMemo(
    () =>
      buildMembership({
        stories: textStories,
        sections: workshop?.sections ?? [],
        rows: data.rows,
      }),
    [data.rows, textStories, workshop?.sections],
  )
  const stories = React.useMemo(() => {
    if (filter === null) return []
    if (filter.kind === "story") return textStories
    return storiesInScope(
      workshop?.stories ?? [],
      membership,
      filter.kind === "universe" ? filter.universeId : null,
    )
  }, [filter, membership, textStories, workshop?.stories])

  // The universe an anchor names in its own relation.
  const universeOfAnchor = React.useMemo(() => {
    const property = anchorsSection?.universePropertyId
    const anchors = anchorsSection ? (data.rows[anchorsSection.databaseId] ?? []) : []
    const named = new Map(
      anchors.map((row) => [
        row.noteId,
        property ? (relationTargetsOf(row.valuesJson, property)[0] ?? null) : null,
      ]),
    )
    return (noteId: string) => named.get(noteId) ?? null
  }, [anchorsSection, data.rows])

  const events = React.useMemo(() => {
    if (filter?.kind !== "universe" || !anchorsSection?.universePropertyId) return []
    return universeEvents({
      anchors: data.rows[anchorsSection.databaseId] ?? [],
      universeId: filter.universeId,
      universeOf: universeOfAnchor,
      manualOrder: anchorOrder.order,
      createdOf: (noteId) => anchorOrder.created[noteId],
    })
  }, [anchorOrder.created, anchorOrder.order, anchorsSection, data.rows, filter, universeOfAnchor])

  const lists = React.useMemo<ScopeList[]>(() => {
    if (filter === null || !workshop) return []
    return sections.map((section) => {
      const rows = data.rows[section.databaseId] ?? []
      if (section.role === "anchors") {
        // The anchors keep the author's order and the rule of the panel's anchors part.
        const buckets = bucketAnchors({
          anchors: rows,
          filter,
          membership,
          universeOf: universeOfAnchor,
          manualOrder: anchorOrder.order,
          createdOf: (noteId) => anchorOrder.created[noteId],
        })
        return {
          section,
          shown: [...buckets.events, ...buckets.shown],
          withoutStory: buckets.withoutStory,
        }
      }
      const byId = new Map(rows.map((row) => [row.noteId, row]))
      const scoped = scopeEntities(
        entityItemsOf(rows, section.databaseId, workshop.workshopId),
        filter,
        membership,
      )
      const rowsOf = (items: { noteId: string }[]) =>
        items.flatMap((item) => byId.get(item.noteId) ?? [])
      return { section, shown: rowsOf(scoped.shown), withoutStory: rowsOf(scoped.withoutStory) }
    })
  }, [
    anchorOrder.created,
    anchorOrder.order,
    data.rows,
    filter,
    sections,
    membership,
    universeOfAnchor,
    workshop,
  ])

  return {
    loading: databaseIds.length > 0 && (data.status === "loading" || data.status === "idle"),
    failed: data.status === "error",
    rows: filter === null ? NONE : data.rows,
    stories,
    membership,
    events,
    lists,
  }
}
