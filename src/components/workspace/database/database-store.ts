import { create } from "zustand"
import type {
  DatabaseDiagnostic,
  DatabaseModuleState,
  DatabaseRow,
  DatabaseSummary,
  ProjectionVersion,
} from "@/lib/storage"

export type DatabaseCatalogStatus = "idle" | "loading" | "ready" | "disabled" | "error"
export type DatabaseHostKind = "tab" | "layer" | "block"

export interface DatabaseHostSession {
  key: string
  kind: DatabaseHostKind
  databaseId: string
  viewId: string | null
  status: "idle" | "loading" | "ready" | "error"
  rows: DatabaseRow[]
  projection: ProjectionVersion | null
  diagnostics: DatabaseDiagnostic[]
  error: string | null
  nextCursor: string | null
}

export interface DatabaseStoreState {
  vaultGeneration: number | null
  runtime: DatabaseModuleState | null
  catalogStatus: DatabaseCatalogStatus
  databases: DatabaseSummary[]
  diagnostics: DatabaseDiagnostic[]
  error: string | null
  hosts: Record<string, DatabaseHostSession>
  reset: (vaultGeneration: number | null) => void
  setRuntime: (runtime: DatabaseModuleState | null) => void
  setCatalogLoading: () => void
  setCatalog: (databases: DatabaseSummary[], diagnostics?: DatabaseDiagnostic[]) => void
  setCatalogError: (error: string) => void
  setCatalogDisabled: () => void
  setHost: (session: DatabaseHostSession) => void
}

export function databaseHostKey(
  kind: DatabaseHostKind,
  databaseId: string,
  viewId: string | null = null,
): string {
  return `${kind}:${databaseId}:${viewId ?? "default"}`
}

export function emptyDatabaseHost(
  kind: DatabaseHostKind,
  databaseId: string,
  viewId: string | null = null,
): DatabaseHostSession {
  return {
    key: databaseHostKey(kind, databaseId, viewId),
    kind,
    databaseId,
    viewId,
    status: "idle",
    rows: [],
    projection: null,
    diagnostics: [],
    error: null,
    nextCursor: null,
  }
}

export const useDatabaseStore = create<DatabaseStoreState>((set) => ({
  vaultGeneration: null,
  runtime: null,
  catalogStatus: "idle",
  databases: [],
  diagnostics: [],
  error: null,
  hosts: {},
  reset: (vaultGeneration) =>
    set({
      vaultGeneration,
      runtime: null,
      catalogStatus: "idle",
      databases: [],
      diagnostics: [],
      error: null,
      hosts: {},
    }),
  setRuntime: (runtime) => set({ runtime }),
  setCatalogLoading: () => set({ catalogStatus: "loading", error: null }),
  setCatalog: (databases, diagnostics = []) =>
    set({ catalogStatus: "ready", databases, diagnostics, error: null }),
  setCatalogError: (error) => set({ catalogStatus: "error", error }),
  setCatalogDisabled: () =>
    set({ catalogStatus: "disabled", databases: [], diagnostics: [], error: null }),
  setHost: (session) => set((state) => ({ hosts: { ...state.hosts, [session.key]: session } })),
}))

export const selectDatabaseHost = (key: string) => (state: DatabaseStoreState) => state.hosts[key]
