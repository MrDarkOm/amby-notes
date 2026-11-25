import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  applyDatabaseValueBatch,
  updateDatabaseRelationValue,
  type DatabaseRow,
  type EnsuredPlotLinks,
  type StorySummary,
  type TextPropertyIds,
  type WorkshopSummary,
} from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { ShownError } from "@/lib/operation-errors"
import type { EnsurePlot } from "./use-plot-binding"
import { relationTargetsOf } from "./workshop-model"

/** The scene links of a text page (format §6): who is in it, whose eyes, where, and when. */
export type ScenePart = "characters" | "pov" | "places" | "storyTime"

const ENSURED_ID: Record<ScenePart, keyof EnsuredPlotLinks> = {
  characters: "charactersPropertyId",
  pov: "povPropertyId",
  places: "placesPropertyId",
  storyTime: "storyTimePropertyId",
}

/** The recorded property of a scene part in a story's text, or `null` before its first use. */
export function scenePropertyOf(story: StorySummary | null, part: ScenePart): string | null {
  const properties: TextPropertyIds | undefined = story?.text?.properties
  return properties?.[part] ?? null
}

/** The next list of a relation after adding or removing one target; a point of view holds one. */
export function nextTargets(
  current: readonly string[],
  part: ScenePart,
  targetId: string,
  add: boolean,
): string[] {
  if (!add) return current.filter((id) => id !== targetId)
  if (part === "pov") return [targetId]
  return current.includes(targetId) ? [...current] : [...current, targetId]
}

export interface SceneLinks {
  /** Adds or removes one target of a relation part on a page of the text. */
  toggle: (input: {
    workshop: WorkshopSummary
    story: StorySummary
    row: DatabaseRow
    part: Exclude<ScenePart, "storyTime">
    targetId: string
    add: boolean
  }) => Promise<void>
  /** Writes (or, with an empty text, clears) the story time of a page. */
  setStoryTime: (input: {
    workshop: WorkshopSummary
    story: StorySummary
    row: DatabaseRow
    value: string
  }) => Promise<void>
}

/**
 * Writes the scene links of a page of a story's text. A part the text does not have yet is made
 * first, alone (`ensure_plot_links` with `parts`), so a story gets only what its author uses.
 * Values go through the database's own edits with the row's revision, so a page changed in the
 * meantime is refused instead of being overwritten.
 */
export function useSceneLinks(ensure: EnsurePlot): SceneLinks {
  const { t } = useTranslation()
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)

  const propertyFor = React.useCallback(
    async (workshop: WorkshopSummary, story: StorySummary, part: ScenePart) => {
      const known = scenePropertyOf(story, part)
      if (known) return known
      const ensured = await ensure({ target: "story", workshop, story, parts: [part] })
      const made = ensured[ENSURED_ID[part]]
      if (typeof made !== "string") throw new ShownError(t("creative.scene.unavailable"))
      return made
    },
    [ensure, t],
  )

  const toggle = React.useCallback<SceneLinks["toggle"]>(
    async ({ workshop, story, row, part, targetId, add }) => {
      const databaseId = story.text?.databaseId
      if (!databaseId || vaultGeneration === null) {
        throw new ShownError(t("creative.scene.unavailable"))
      }
      const propertyId = await propertyFor(workshop, story, part)
      const current = relationTargetsOf(row.valuesJson, propertyId)
      const next = nextTargets(current, part, targetId, add)
      if (next.length === current.length && next.every((id, index) => id === current[index])) {
        return
      }
      await updateDatabaseRelationValue({
        expectedGeneration: vaultGeneration,
        operationId: `scene-${crypto.randomUUID()}`,
        expectedRevision: row.rowRevision,
        databaseId,
        noteId: row.noteId,
        propertyId,
        targetNoteIds: next,
      })
    },
    [propertyFor, t, vaultGeneration],
  )

  const setStoryTime = React.useCallback<SceneLinks["setStoryTime"]>(
    async ({ workshop, story, row, value }) => {
      const databaseId = story.text?.databaseId
      if (!databaseId || vaultGeneration === null) {
        throw new ShownError(t("creative.scene.unavailable"))
      }
      const propertyId = await propertyFor(workshop, story, "storyTime")
      const text = value.trim()
      await applyDatabaseValueBatch({
        expectedGeneration: vaultGeneration,
        databaseId,
        operationId: `scene-${crypto.randomUUID()}`,
        cells: [
          {
            noteId: row.noteId,
            propertyId,
            // No value clears the cell.
            valueJson: text ? JSON.stringify({ type: "text", value: text }) : undefined,
            expectedRevision: row.rowRevision,
          },
        ],
      })
    },
    [propertyFor, t, vaultGeneration],
  )

  return { toggle, setStoryTime }
}
