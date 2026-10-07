import { create } from "zustand"

export const OVERVIEW_SECTION = "overview"

interface CreativeNavState {
  /** The section each project's page shows: `overview` or a section id. */
  sectionByProject: Record<string, string>
  /** Folded nodes of the sidebar tree, by project ID. */
  collapsed: Record<string, boolean>
  showSection: (projectId: string, sectionId: string) => void
  toggleCollapsed: (projectId: string) => void
}

export const useCreativeNavStore = create<CreativeNavState>((set) => ({
  sectionByProject: {},
  collapsed: {},
  showSection: (projectId, sectionId) =>
    set((state) => ({ sectionByProject: { ...state.sectionByProject, [projectId]: sectionId } })),
  toggleCollapsed: (projectId) =>
    set((state) => ({
      collapsed: { ...state.collapsed, [projectId]: !state.collapsed[projectId] },
    })),
}))
