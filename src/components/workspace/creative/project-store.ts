import { create } from "zustand"
import type { ProjectCatalog } from "@/lib/storage"

export type ProjectCatalogStatus = "idle" | "loading" | "ready" | "disabled" | "error"

interface ProjectStoreState {
  status: ProjectCatalogStatus
  catalog: ProjectCatalog | null
  error: string | null
  /** Registered by the controller: re-reads the catalog (`true` re-reads the files first). */
  refresh: ((rebuild?: boolean) => Promise<void>) | null
  setRefresh: (refresh: ProjectStoreState["refresh"]) => void
  reset: () => void
  setLoading: () => void
  setCatalog: (catalog: ProjectCatalog) => void
  setError: (error: string) => void
  setDisabled: () => void
}

/** The creative projects of the open vault, as the Rust index last reported them. */
export const useProjectStore = create<ProjectStoreState>((set) => ({
  status: "idle",
  catalog: null,
  error: null,
  refresh: null,
  setRefresh: (refresh) => set({ refresh }),
  reset: () => set({ status: "idle", catalog: null, error: null }),
  // A refresh keeps the previous catalog on screen instead of flashing an empty list.
  setLoading: () => set((state) => ({ status: state.catalog ? state.status : "loading" })),
  setCatalog: (catalog) => set({ status: "ready", catalog, error: null }),
  setError: (error) => set({ status: "error", error }),
  setDisabled: () => set({ status: "disabled", catalog: null, error: null }),
}))
