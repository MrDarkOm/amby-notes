import type { DatabaseRow, TextPropertyIds } from "@/lib/storage"

export interface Scene {
  characters: string[]
  pov: string | null
  places: string[]
  storyTime: string
}

export interface TimelineEntry {
  noteId: string
  storyTime: string
  /** The page is told through this character's eyes. */
  pov: boolean
}

export function readScene(_row: DatabaseRow, _properties: TextPropertyIds): Scene {
  throw new Error("not implemented")
}

export function characterTimeline(
  _characterId: string,
  _rows: DatabaseRow[],
  _properties: TextPropertyIds,
  _order: string[],
): TimelineEntry[] {
  throw new Error("not implemented")
}
