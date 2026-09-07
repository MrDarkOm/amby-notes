import { create } from "zustand"
import type { DocumentViewMode } from "./document-editor"
import type { ContentWidth } from "./app-config"
import type { NoteLayers, LayerKind } from "@/lib/storage"
import type { TreeItem } from "./sidebar-tree"

/** "editor" layer or any named layer kind (canvas / database / sketch). */
export type EditorLayer = "editor" | LayerKind
export type NestedNotesPlacement = "top" | "bottom" | "hidden"

interface ViewStateStore {
  /** Collapsed folders and note bundles in the vault tree. */
  closedTreeIds: Set<string>
  toggleTreeItem: (id: string) => void
  expandTreeItem: (id: string) => void
  setTreeExpanded: (items: TreeItem[], expanded: boolean) => void
  /** File ids the user has starred. */
  favorites: Set<string>
  /** Per-file editor view-mode override (source / editor / split). */
  viewModes: Record<string, DocumentViewMode>
  /** Per-page content width overrides; keys are note ids or database ids. */
  contentWidths: Record<string, ContentWidth>
  /** Custom labels for the title column on database pages. */
  databaseTitleLabels: Record<string, string>
  nestedNotesPlacements: Record<string, NestedNotesPlacement>
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
  setContentWidth: (id: string, width: ContentWidth) => void
  setDatabaseTitleLabel: (id: string, label: string) => void
  setNestedNotesPlacement: (id: string, placement: NestedNotesPlacement) => void
  toggleLock: (id: string) => void
  setActiveLayer: (id: string, layer: EditorLayer) => void
  setLinkedLayers: (id: string, layers: NoteLayers) => void

  // ── Bulk operations ─────────────────────────────────────────────────────────

  /**
   * After a filesystem mutation, remove entries for deleted file ids from every
   * map/set. Also remap collapsed tree IDs that use paths (folders and web
   * notes); desktop note IDs remain stable across renames and moves.
   */
  applyMutation: (deletedIds: string[], remapPath?: (path: string) => string) => void

  /**
   * Replace the entire view state from a restored session. Called by `loadVault`
   * after `applySessionRemap` has already filtered + remapped the persisted ids.
   */
  hydrateFromSession: (data: {
    icons: Record<string, string>
    favorites: string[]
    viewModes: Record<string, string>
    contentWidths?: Record<string, string>
    databaseTitleLabels?: Record<string, string>
    nestedNotesPlacements?: Record<string, string>
    lockedFileIds: string[]
    closedTreeIds?: string[]
  }) => void
}

/**
 * Per-document view state that would otherwise live as five separate useState
 * calls in the Workspace component. Mirrors the shape of use-doc-store so that
 * `applyMutationResult` can fan out to both stores with the same deletedIds.
 */
function createViewStateStore() {
  return create<ViewStateStore>((set) => ({
    closedTreeIds: new Set(),
    toggleTreeItem: (id) =>
      set((s) => {
        const closedTreeIds = new Set(s.closedTreeIds)
        if (closedTreeIds.has(id)) closedTreeIds.delete(id)
        else closedTreeIds.add(id)
        return { closedTreeIds }
      }),
    expandTreeItem: (id) =>
      set((s) => {
        if (!s.closedTreeIds.has(id)) return s
        const closedTreeIds = new Set(s.closedTreeIds)
        closedTreeIds.delete(id)
        return { closedTreeIds }
      }),
    setTreeExpanded: (items, expanded) =>
      set(() => {
        const closedTreeIds = new Set<string>()
        function collect(list: TreeItem[]) {
          for (const item of list) {
            if (item.type === "folder" || item.children?.length) closedTreeIds.add(item.id)
            if (item.children) collect(item.children)
          }
        }
        if (!expanded) collect(items)
        return { closedTreeIds }
      }),
    favorites: new Set(),
    viewModes: {},
    contentWidths: {},
    databaseTitleLabels: {},
    nestedNotesPlacements: {},
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

    setContentWidth: (id, width) =>
      set((s) => ({ contentWidths: { ...(s.contentWidths ?? {}), [id]: width } })),

    setDatabaseTitleLabel: (id, label) =>
      set((s) => ({
        databaseTitleLabels: { ...(s.databaseTitleLabels ?? {}), [id]: label },
      })),

    setNestedNotesPlacement: (id, placement) =>
      set((s) => ({
        nestedNotesPlacements: { ...s.nestedNotesPlacements, [id]: placement },
      })),

    toggleLock: (id) =>
      set((s) => {
        const next = new Set(s.lockedFileIds)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return { lockedFileIds: next }
      }),

    setActiveLayer: (id, layer) =>
      set((s) => ({ activeLayers: { ...s.activeLayers, [id]: layer } })),

    setLinkedLayers: (id, layers) =>
      set((s) => ({ linkedLayersByDoc: { ...s.linkedLayersByDoc, [id]: layers } })),

    applyMutation: (deletedIds, remapPath = (path) => path) =>
      set((s) => {
        const deleted = new Set(deletedIds)
        const closedTreeIds = new Set<string>()
        for (const id of s.closedTreeIds) {
          if (deleted.has(id)) continue
          closedTreeIds.add(
            id.startsWith("folder:") ? `folder:${remapPath(id.slice(7))}` : remapPath(id),
          )
        }

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

        const contentWidths: Record<string, ContentWidth> = {}
        for (const [id, width] of Object.entries(s.contentWidths ?? {}))
          if (!deleted.has(id)) contentWidths[id] = width

        const databaseTitleLabels: Record<string, string> = {}
        for (const [id, label] of Object.entries(s.databaseTitleLabels ?? {}))
          if (!deleted.has(id) && !(id.startsWith("database:") && deleted.has(id.slice(9)))) {
            databaseTitleLabels[id] = label
          }

        const nestedNotesPlacements: Record<string, NestedNotesPlacement> = {}
        for (const [id, placement] of Object.entries(s.nestedNotesPlacements))
          if (!deleted.has(id)) nestedNotesPlacements[id] = placement

        return {
          closedTreeIds,
          favorites,
          lockedFileIds,
          iconOverrides,
          activeLayers,
          viewModes,
          contentWidths,
          databaseTitleLabels,
          nestedNotesPlacements,
        }
      }),

    hydrateFromSession: ({
      icons,
      favorites,
      viewModes,
      contentWidths = {},
      databaseTitleLabels = {},
      nestedNotesPlacements = {},
      lockedFileIds,
      closedTreeIds = [],
    }) =>
      set({
        closedTreeIds: new Set(closedTreeIds),
        iconOverrides: icons,
        favorites: new Set(favorites),
        viewModes: viewModes as Record<string, DocumentViewMode>,
        contentWidths: Object.fromEntries(
          Object.entries(contentWidths).filter((entry): entry is [string, ContentWidth] =>
            ["normal", "wide", "full"].includes(entry[1]),
          ),
        ),
        databaseTitleLabels: Object.fromEntries(
          Object.entries(databaseTitleLabels).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === "string" && entry[1].trim().length > 0,
          ),
        ),
        nestedNotesPlacements: Object.fromEntries(
          Object.entries(nestedNotesPlacements).filter(
            (entry): entry is [string, NestedNotesPlacement] =>
              ["top", "bottom", "hidden"].includes(entry[1]),
          ),
        ),
        lockedFileIds: new Set(lockedFileIds),
        // activeLayers and linkedLayersByDoc are not persisted — start fresh.
        activeLayers: {},
        linkedLayersByDoc: {},
      }),
  }))
}

type ViewStateHook = ReturnType<typeof createViewStateStore>
const viewStateGlobal = globalThis as typeof globalThis & {
  __ambyViewStateStore?: ViewStateHook
}

// Vite can reload this module while the desktop app stays open. Keep the same
// store instance so file emojis and other session state do not blink away or
// get persisted as an empty map during development HMR.
export const useViewStateStore = viewStateGlobal.__ambyViewStateStore ?? createViewStateStore()
if (import.meta.env.DEV) {
  // Keep a running desktop session compatible with stores created before a
  // newly added action was introduced. Vite preserves the global store during
  // HMR, so the old object may otherwise expose the field as undefined until
  // the application is restarted.
  const current = useViewStateStore.getState()
  if (typeof current.setContentWidth !== "function") {
    useViewStateStore.setState({
      setContentWidth: (id, width) =>
        useViewStateStore.setState((state) => ({
          contentWidths: { ...(state.contentWidths ?? {}), [id]: width },
        })),
    })
  }
  if (typeof current.setDatabaseTitleLabel !== "function") {
    useViewStateStore.setState({
      setDatabaseTitleLabel: (id, label) =>
        useViewStateStore.setState((state) => ({
          databaseTitleLabels: { ...(state.databaseTitleLabels ?? {}), [id]: label },
        })),
    })
  }
  viewStateGlobal.__ambyViewStateStore = useViewStateStore
}
