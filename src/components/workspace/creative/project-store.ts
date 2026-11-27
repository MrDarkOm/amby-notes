import { create } from "zustand"
import type { PathChange, ProjectCatalog } from "@/lib/storage"
import { remapPath } from "../workspace-mutations"
import { activeCatalog } from "./workshop-location"

export type ProjectCatalogStatus = "idle" | "loading" | "ready" | "disabled" | "error"

interface ProjectStoreState {
  status: ProjectCatalogStatus
  /** What the screens read: the active workshop only, plus a diagnostic per marker left out. */
  catalog: ProjectCatalog | null
  /** Every marker the index found, as the backend reported it. */
  rawCatalog: ProjectCatalog | null
  /** The workshop folder setting (`null` = not set) and the default folder of the language. */
  workshopSetting: string | null
  defaultFolder: string
  error: string | null
  /** Registered by the controller: re-reads the catalog (`true` re-reads the files first). */
  refresh: ((rebuild?: boolean) => Promise<void>) | null
  setRefresh: (refresh: ProjectStoreState["refresh"]) => void
  reset: () => void
  setLoading: () => void
  setCatalog: (catalog: ProjectCatalog) => void
  /** Changes which marker is the workshop (the setting or the language changed). */
  setPlace: (workshopSetting: string | null, defaultFolder: string) => void
  setError: (error: string) => void
  setDisabled: () => void
}

/** The creative workshop of the open vault, as the Rust index last reported it. */
export const useProjectStore = create<ProjectStoreState>((set) => ({
  status: "idle",
  catalog: null,
  rawCatalog: null,
  workshopSetting: null,
  defaultFolder: "",
  error: null,
  refresh: null,
  setRefresh: (refresh) => set({ refresh }),
  reset: () => set({ status: "idle", catalog: null, rawCatalog: null, error: null }),
  // A refresh keeps the previous catalog on screen instead of flashing an empty list.
  setLoading: () => set((state) => ({ status: state.catalog ? state.status : "loading" })),
  setCatalog: (rawCatalog) =>
    set((state) => ({
      status: "ready",
      rawCatalog,
      catalog: activeCatalog(rawCatalog, state.workshopSetting, state.defaultFolder),
      error: null,
    })),
  setPlace: (workshopSetting, defaultFolder) =>
    set((state) => ({
      workshopSetting,
      defaultFolder,
      catalog: state.rawCatalog
        ? activeCatalog(state.rawCatalog, workshopSetting, defaultFolder)
        : state.catalog,
    })),
  setError: (error) => set({ status: "error", error }),
  setDisabled: () => set({ status: "disabled", catalog: null, rawCatalog: null, error: null }),
}))

/** App-originated renames suppress watcher events. Refresh from their committed path changes. */
export function refreshAfterWorkshopMove(vault: string, changes: PathChange[]) {
  const { catalog, refresh } = useProjectStore.getState()
  const active = catalog?.workshops[0]
  if (!active || !refresh || changes.length === 0) return
  const root = vault.replace(/\\/gu, "/").replace(/\/+$/u, "")
  const marker = `${active.path}/amby-workshop.json`
  const absolute = `${root}/${marker}`
  if (remapPath(absolute, changes) !== absolute || remapPath(marker, changes) !== marker) {
    void refresh(true)
  }
}
