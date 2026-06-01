import { create } from "zustand"
import type { DocumentViewMode } from "./document-editor"
import type { NoteLayers, LayerKind } from "@/lib/storage"

/** "editor" layer or any named layer kind (canvas / database / sketch). */
export type EditorLayer = "editor" | LayerKind

interface ViewStateStore {
  /** File ids the user has starred. */
  favorites: Set<string>
  /** Per-file editor view-mode override (source / editor / split). */
  viewModes: Record<string, DocumentViewMode>
  /** File ids the user has locked (read-only). */
  lockedFileIds: Set<string>
  /** Per-file emoji/icon overrides chosen by the user. */
  iconOverrides: Record<string, string>
  /** Currently active layer per open document (defaults to "editor"). */
  activeLayers: Record<string, EditorLayer>
  /** Cached layer presence for open documents (canvas / sketch / database). */
  linkedLayersByDoc: Record<string, NoteLayers>

  // ── Atomic setters ──────────────────────────────────────────────────────────

  toggleFavorite: (id: string) => void
  setIcon: (id: string, icon: string) => void
  setViewMode: (id: string, mode: DocumentViewMode) => void
  toggleLock: (id: string) => void
  setActiveLayer: (id: string, layer: EditorLayer) => void
  setLinkedLayers: (id: string, layers: NoteLayers) => void

  // ── Bulk operations ─────────────────────────────────────────────────────────

  /**
   * After a filesystem mutation, remove entries for deleted file ids from every
   * map/set. View-state keys are file ids (ULIDs in Tauri, paths in web-mode) —
   * they don't need path remapping; deleted files simply lose their view state.
   */
  applyMutation: (deletedIds: string[]) => void

  /**
   * Replace the entire view state from a restored session. Called by `loadVault`
   * after `applySessionRemap` has already filtered + remapped the persisted ids.
   */
  hydrateFromSession: (data: {
    icons: Record<string, string>
    favorites: string[]
    viewModes: Record<string, string>
    lockedFileIds: string[]
  }) => void
}

/**
 * Per-document view state that would otherwise live as five separate useState
 * calls in the Workspace component. Mirrors the shape of use-doc-store so that
 * `applyMutationResult` can fan out to both stores with the same deletedIds.
 */
export const useViewStateStore = create<ViewStateStore>((set) => ({
  favorites: new Set(),
  viewModes: {},
  lockedFileIds: new Set(),
  iconOverrides: {},
  activeLayers: {},
  linkedLayersByDoc: {},

  toggleFavorite: (id) =>
    set((s) => {
      const next = new Set(s.favorites)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { favorites: next }
    }),

  setIcon: (id, icon) => set((s) => ({ iconOverrides: { ...s.iconOverrides, [id]: icon } })),

  setViewMode: (id, mode) => set((s) => ({ viewModes: { ...s.viewModes, [id]: mode } })),

  toggleLock: (id) =>
    set((s) => {
      const next = new Set(s.lockedFileIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { lockedFileIds: next }
    }),

  setActiveLayer: (id, layer) => set((s) => ({ activeLayers: { ...s.activeLayers, [id]: layer } })),

  setLinkedLayers: (id, layers) =>
    set((s) => ({ linkedLayersByDoc: { ...s.linkedLayersByDoc, [id]: layers } })),

  applyMutation: (deletedIds) =>
    set((s) => {
      const deleted = new Set(deletedIds)

      const favorites = new Set<string>()
      for (const id of s.favorites) if (!deleted.has(id)) favorites.add(id)

      const lockedFileIds = new Set<string>()
      for (const id of s.lockedFileIds) if (!deleted.has(id)) lockedFileIds.add(id)

      const iconOverrides: Record<string, string> = {}
      for (const [id, icon] of Object.entries(s.iconOverrides))
        if (!deleted.has(id)) iconOverrides[id] = icon

      const activeLayers: Record<string, EditorLayer> = {}
      for (const [id, layer] of Object.entries(s.activeLayers))
        if (!deleted.has(id)) activeLayers[id] = layer

      const viewModes: Record<string, DocumentViewMode> = {}
      for (const [id, mode] of Object.entries(s.viewModes))
        if (!deleted.has(id)) viewModes[id] = mode

      return { favorites, lockedFileIds, iconOverrides, activeLayers, viewModes }
    }),

  hydrateFromSession: ({ icons, favorites, viewModes, lockedFileIds }) =>
    set({
      iconOverrides: icons,
      favorites: new Set(favorites),
      viewModes: viewModes as Record<string, DocumentViewMode>,
      lockedFileIds: new Set(lockedFileIds),
      // activeLayers and linkedLayersByDoc are not persisted — start fresh.
      activeLayers: {},
      linkedLayersByDoc: {},
    }),
}))
