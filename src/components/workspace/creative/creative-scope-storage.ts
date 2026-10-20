import type { DeskItem } from "./desk/desk-layout-model"

const WORKSHOP_STORAGE_KEY = "amby:creative-workshop"

/** What the lists remember per vault: the story and the universe chosen and the parts unfolded. */
export interface WorkshopPrefs {
  story?: string | null
  /** The universe chosen, or `"standalone"`. A universe that is gone is dropped on reading. */
  universe?: string | null
  /**
   * The folding parts of the works tab that were unfolded: "text", "anchors", "notes". Older
   * saves hold "books" and "arcs", which are read as "text" (`worksSectionsFromPrefs`).
   */
  works?: string[]
  /** The filter of the story cards on the workshop's page (`parseStoryFilter` reads it). */
  storyFilter?: string
  /** The sort of the story cards on the workshop's page (`parseStorySort` reads it). */
  storySort?: string
  /**
   * The layout of a story's desk: one for every story of the vault. It is reconciled with the
   * widgets a story can show before use (`reconcileDeskLayout`), so any saved value is safe.
   */
  deskLayout?: DeskItem[]
  /** The choices on the page of a universe and on that of the standalone stories. */
  scopes?: Partial<Record<ScopePrefsKind, ScopePrefs>>
}

/** What the page of a universe or of the standalone stories remembers (each kept apart). */
export interface ScopePrefs {
  /** The filter of the story cards (`parseStoryFilter` reads it). */
  filter?: string
  /** The sort of the story cards (`parseStorySort` reads it). */
  sort?: string
  /** `cards` or `timeline`. */
  view?: string
  /** The section ID of the tab of the world that was open. */
  tab?: string
}

export type ScopePrefsKind = "universe" | "standalone"

export function readWorkshopPrefs(vault: string): WorkshopPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(WORKSHOP_STORAGE_KEY) ?? "{}") as Record<
      string,
      WorkshopPrefs
    >
    const prefs = saved[vault]
    return prefs && typeof prefs === "object" ? prefs : {}
  } catch {
    return {}
  }
}

export function writeWorkshopPrefs(vault: string, patch: WorkshopPrefs) {
  try {
    const saved = JSON.parse(localStorage.getItem(WORKSHOP_STORAGE_KEY) ?? "{}") as Record<
      string,
      WorkshopPrefs
    >
    localStorage.setItem(
      WORKSHOP_STORAGE_KEY,
      JSON.stringify({ ...saved, [vault]: { ...saved[vault], ...patch } }),
    )
  } catch {
    // Remembering is a convenience: the lists work without it.
  }
}

export function readScopePrefs(vault: string, kind: ScopePrefsKind): ScopePrefs {
  return readWorkshopPrefs(vault).scopes?.[kind] ?? {}
}

export function writeScopePrefs(vault: string, kind: ScopePrefsKind, patch: ScopePrefs) {
  const scopes = readWorkshopPrefs(vault).scopes ?? {}
  writeWorkshopPrefs(vault, { scopes: { ...scopes, [kind]: { ...scopes[kind], ...patch } } })
}
