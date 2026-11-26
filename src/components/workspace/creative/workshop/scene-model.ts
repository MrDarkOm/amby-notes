import type { DatabaseRow, TextPropertyIds } from "@/lib/storage"
import { relationTargetsOf } from "./workshop-model"

/** Who is on a page of the text, whose eyes it is told through, where and when it happens. */
export interface Scene {
  characters: string[]
  pov: string | null
  places: string[]
  storyTime: string
}

function textValueOf(valuesJson: string, propertyId: string | null): string {
  if (!propertyId) return ""
  try {
    const values = JSON.parse(valuesJson) as Record<string, { type?: string; value?: unknown }>
    const value = values[propertyId]
    return value?.type === "text" && typeof value.value === "string" ? value.value : ""
  } catch {
    return ""
  }
}

function targets(row: DatabaseRow, propertyId: string | null): string[] {
  return propertyId ? relationTargetsOf(row.valuesJson, propertyId) : []
}

/** The scene of a page as its row holds it; a part the text does not have yet is empty. */
export function readScene(row: DatabaseRow, properties: TextPropertyIds): Scene {
  return {
    characters: targets(row, properties.characters),
    pov: targets(row, properties.pov)[0] ?? null,
    places: targets(row, properties.places),
    storyTime: textValueOf(row.valuesJson, properties.storyTime),
  }
}
