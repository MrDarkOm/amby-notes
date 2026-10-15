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
}

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
