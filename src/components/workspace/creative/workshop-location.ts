import type { ProjectCatalog, ProjectDiagnostic, WorkshopSummary } from "@/lib/storage"

/**
 * Where the vault's one workshop lives (`moduleSettings.creative.workshopPath`) and which of the
 * workshop markers found in the vault is that workshop. The catalog still lists every marker;
 * this decides which one the module works with. Nothing here writes.
 */

/** The code of the diagnostic the module adds for a marker that is not the workshop. */
export const OTHER_WORKSHOP_CODE = "otherWorkshop"

/**
 * A folder path as the settings keep it: vault-relative, `/`-separated, without empty or `.`
 * parts. `null` for a path that cannot be a workshop folder (empty, outside the vault, hidden),
 * so the setting never holds one the backend would refuse at the first look.
 */
export function normalizeWorkshopPath(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null
  const parts = input
    .replace(/\\/gu, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== ".")
  if (parts.length === 0) return null
  if (parts.some((part) => part === ".." || part.startsWith("."))) return null
  return parts.join("/")
}

function samePath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

export interface WorkshopPlace {
  /** The workshop the module works with, if one is found. */
  active: WorkshopSummary | null
  /** The other markers found in the vault: reported, never read or changed. */
  others: WorkshopSummary[]
  /** Where the workshop is, or would be made: the setting, else the language's default. */
  path: string
  /** Whether the setting was written (a path the author chose), not left to the default. */
  configured: boolean
}

/**
 * Which workshop is active. With a path set, the workshop whose folder is that path (and none
 * when there is none: the panel offers to initialize there). Without one, the only workshop
 * found; of several, the one in the default folder.
 */
export function resolveWorkshopPlace(
  workshops: WorkshopSummary[],
  saved: string | null | undefined,
  fallback: string,
): WorkshopPlace {
  const configured = normalizeWorkshopPath(saved)
  const path = configured ?? normalizeWorkshopPath(fallback) ?? fallback
  let active: WorkshopSummary | null = null
  if (configured) {
    active = workshops.find((workshop) => samePath(workshop.path, configured)) ?? null
  } else if (workshops.length === 1) {
    active = workshops[0] ?? null
  } else {
    active = workshops.find((workshop) => samePath(workshop.path, path)) ?? null
  }
  return {
    active,
    others: workshops.filter((workshop) => workshop !== active),
    path,
    configured: configured !== null,
  }
}

/**
 * The catalog the module's screens read: only the active workshop, and a diagnostic for each
 * marker that was left out.
 */
export function activeCatalog(
  raw: ProjectCatalog,
  saved: string | null | undefined,
  fallback: string,
): ProjectCatalog {
  const place = resolveWorkshopPlace(raw.workshops, saved, fallback)
  const left: ProjectDiagnostic[] = place.others.map((workshop) => ({
    code: OTHER_WORKSHOP_CODE,
    severity: "warning",
    path: workshop.path ? `${workshop.path}/amby-workshop.json` : "amby-workshop.json",
    workshopId: workshop.workshopId,
    storyId: null,
    detail: null,
  }))
  return {
    ...raw,
    workshops: place.active ? [place.active] : [],
    diagnostics: [...raw.diagnostics, ...left],
  }
}
