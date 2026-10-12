const CREATIVE_SCOPE_STORAGE_KEY = "amby:creative-scope"

/** The scope last chosen in a vault, stored as `{ [vaultPath]: scope }`. */
export function readStoredScope(vault: string): string | null | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(CREATIVE_SCOPE_STORAGE_KEY) ?? "{}") as Record<
      string,
      unknown
    >
    const scope = saved[vault]
    return typeof scope === "string" || scope === null ? scope : undefined
  } catch {
    return undefined
  }
}

export function writeStoredScope(vault: string, scope: string | null) {
  try {
    const saved = JSON.parse(localStorage.getItem(CREATIVE_SCOPE_STORAGE_KEY) ?? "{}") as Record<
      string,
      unknown
    >
    localStorage.setItem(CREATIVE_SCOPE_STORAGE_KEY, JSON.stringify({ ...saved, [vault]: scope }))
  } catch {
    // Remembering the scope is a convenience: the sidebar works without it.
  }
}

const WORKSHOP_STORAGE_KEY = "amby:creative-workshop"

/** What the lists remember per vault: the tab, the story filter and how they group. */
export interface WorkshopPrefs {
  story?: string | null
  /** Whether the world showed the chosen story's pages or the whole universe's. */
  world?: "story" | "universe"
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
