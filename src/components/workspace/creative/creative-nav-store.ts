import { create } from "zustand"
import type { WorksSection, WorldScope } from "./workshop/workshop-model"

export const OVERVIEW_SECTION = "overview"

interface PageRequest {
  /** The story the page is asked for in, or `null` to let the dialog choose. */
  storyId: string | null
  /** Changes with every request, so asking twice for the same story opens it twice. */
  id: number
}

interface EntityRequest {
  /** The world category (`workshop-model` tab key) a page is asked for in. */
  categoryKey: string
  id: number
}

interface CreativeNavState {
  /** The section each project's page shows: `overview` or a section id. */
  sectionByProject: Record<string, string>
  /** Folded nodes of the sidebar, by project ID or `story:`/`page:` key. */
  collapsed: Record<string, boolean>
  showSection: (projectId: string, sectionId: string) => void
  toggleCollapsed: (key: string) => void
  /** The collection the sidebar shows, `null` for the stand-alone stories, `undefined` before a choice. */
  scope: string | null | undefined
  setScope: (scope: string | null | undefined) => void
  /** Which folding parts of the works tab are unfolded: text, anchors, notes. */
  worksOpen: Record<WorksSection, boolean>
  setWorksOpen: (open: Record<WorksSection, boolean>) => void
  toggleWorksSection: (section: WorksSection) => void
  /** The story chosen in the works list; `null` until one is chosen (the first is shown). */
  storyFilter: string | null
  setStoryFilter: (storyId: string | null) => void
  /** Whether the world lists this story's pages or the whole universe's. */
  worldScope: WorldScope
  setWorldScope: (scope: WorldScope) => void
  /** The one search above the tabs: it looks through every list at once. Not remembered. */
  search: string
  setSearch: (search: string) => void
  /** Bumped after a write so the lists read the databases again. */
  dataNonce: number
  bumpData: () => void
  pageRequest: PageRequest | null
  requestPage: (storyId: string | null) => void
  /** A page of a world category asked for from outside the lists (the "Create" button). */
  entityRequest: EntityRequest | null
  requestEntity: (categoryKey: string) => void
  /** A project to create, asked for from outside the panel (the empty tab); the panel clears it. */
  createRequest: "story" | "universe" | null
  requestCreate: (kind: "story" | "universe") => void
  clearCreateRequest: () => void
}

export const useCreativeNavStore = create<CreativeNavState>((set) => ({
  sectionByProject: {},
  collapsed: {},
  scope: undefined,
  setScope: (scope) => set({ scope }),
  worksOpen: { text: true, anchors: false, notes: false },
  setWorksOpen: (worksOpen) => set({ worksOpen }),
  toggleWorksSection: (section) =>
    set((state) => ({ worksOpen: { ...state.worksOpen, [section]: !state.worksOpen[section] } })),
  storyFilter: null,
  setStoryFilter: (storyFilter) => set({ storyFilter }),
  worldScope: "story",
  setWorldScope: (worldScope) => set({ worldScope }),
  search: "",
  setSearch: (search) => set({ search }),
  dataNonce: 0,
  bumpData: () => set((state) => ({ dataNonce: state.dataNonce + 1 })),
  pageRequest: null,
  entityRequest: null,
  requestEntity: (categoryKey) =>
    set((state) => ({
      entityRequest: { categoryKey, id: (state.entityRequest?.id ?? 0) + 1 },
    })),
  createRequest: null,
  requestCreate: (createRequest) => set({ createRequest }),
  clearCreateRequest: () => set({ createRequest: null }),
  requestPage: (storyId) =>
    set((state) => ({ pageRequest: { storyId, id: (state.pageRequest?.id ?? 0) + 1 } })),
  showSection: (projectId, sectionId) =>
    set((state) => ({ sectionByProject: { ...state.sectionByProject, [projectId]: sectionId } })),
  toggleCollapsed: (key) =>
    set((state) => ({ collapsed: { ...state.collapsed, [key]: !state.collapsed[key] } })),
}))
